import * as fs from "fs";
import * as path from "path";
import * as N3 from "n3";

// --- Well-known namespace URIs ---

const WELL_KNOWN_NS: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  vann: "http://purl.org/vocab/vann/",
  schema_http: "http://schema.org/",
  schema: "https://schema.org/",
  prov: "http://www.w3.org/ns/prov#",
  wgs84_pos: "http://www.w3.org/2003/01/geo/wgs84_pos#",
};

// --- Supported ontology file extensions ---

const SUPPORTED_EXTENSIONS = [".owl", ".xml", ".ttl", ".rdf", ".n3", ".jsonld"];

// --- Types ---

interface OntologyClass {
  uri: string;
  label: string;
  definition: string;
  comment: string;
  superClasses: string[];
  equivalentClasses: string[];
  examples: string[];
}

interface ObjectProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string[];
  superProperties: string[];
  inverseOf: string;
}

interface DataProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string;
}

interface ExternalVocabulary {
  prefix: string;
  namespace: string;
  classes: string[];
  properties: string[];
}

interface OntologyMetadata {
  title: string;
  version: string;
  description: string;
  sourceFiles: string[];
  namespaces: Record<string, string>;
}

interface MappingPattern {
  scenario: string;
  ontologyClass: string;
  requiredProperties: string[];
  optionalProperties: string[];
  relationships: string[];
}

interface OntologyStructure {
  metadata: OntologyMetadata;
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
  externalVocabularies: ExternalVocabulary[];
}

interface MappingGuide {
  commonPatterns: MappingPattern[];
  allowedNamespaces: string[];
  constraints: string[];
}

interface QuickReference {
  coreClasses: Array<{ prefixed: string; label: string; definition: string }>;
  keyObjectProperties: Array<{ prefixed: string; label: string; domain: string; range: string }>;
  keyDataProperties: Array<{ prefixed: string; label: string; domain: string; range: string }>;
  allowedNamespaces: string[];
  ontologyVersion: string;
}

// --- Namespace registry (built dynamically from parsed files) ---

let discoveredNamespaces: Record<string, string> = { ...WELL_KNOWN_NS };

// --- File discovery ---

const discoverOntologyFiles = (ontologyDir: string): string[] => {
  if (!fs.existsSync(ontologyDir)) {
    console.error(`ERROR: Ontology directory not found: ${ontologyDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(ontologyDir)
    .filter((f) => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => path.resolve(ontologyDir, f));

  if (files.length === 0) {
    console.error(`ERROR: No ontology files found in ${ontologyDir}`);
    console.error(`  Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}`);
    process.exit(1);
  }

  console.log(`\n  Found ${files.length} ontology file(s):`);
  for (const f of files) {
    const ext = path.extname(f);
    const size = (fs.statSync(f).size / 1024).toFixed(1);
    console.log(`    - ${path.basename(f)} (${ext}, ${size} KB)`);
  }
  console.log("");

  return files;
};

// --- N3 parsing ---

const extractPrefixesFromContent = (content: string): void => {
  // Extract PREFIX declarations from Turtle/N3/SPARQL content
  const prefixRe = /PREFIX\s+([a-zA-Z_][\w.-]*)?:\s*<([^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = prefixRe.exec(content)) !== null) {
    const prefix = match[1] || "";
    const nsUri = match[2];
    if (nsUri) {
      const key = prefix === "" ? "geo" : prefix;
      discoveredNamespaces[key] = nsUri;
    }
  }

  // Also extract @prefix declarations (Turtle)
  const atPrefixRe = /@prefix\s+([a-zA-Z_][\w.-]*)?:\s*<([^>]+)>/gi;
  while ((match = atPrefixRe.exec(content)) !== null) {
    const prefix = match[1] || "";
    const nsUri = match[2];
    if (nsUri) {
      const key = prefix === "" ? "geo" : prefix;
      discoveredNamespaces[key] = nsUri;
    }
  }

  // Extract BASE declaration
  const baseRe = /BASE\s+<([^>]+)>/gi;
  while ((match = baseRe.exec(content)) !== null) {
    // Store base URI — will be used as geo namespace if no empty prefix found
    if (!discoveredNamespaces["geo"]) {
      discoveredNamespaces["geo"] = match[1] + "#";
    }
  }

  // Extract vann:preferredNamespacePrefix
  const vannPrefix = content.match(/vann:preferredNamespacePrefix\s+"([^"]+)"/);
  if (vannPrefix) {
    const prefName = vannPrefix[1];
    const vannNs = content.match(/vann:preferredNamespaceUri\s+"([^"]+)"/);
    if (vannNs) {
      discoveredNamespaces[prefName] = vannNs[1];
    } else if (discoveredNamespaces["geo"]) {
      discoveredNamespaces[prefName] = discoveredNamespaces["geo"];
    }
  }
};

const parseOntologyFile = (filePath: string): N3.Quad[] => {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf-8");

  // Extract prefixes from content before parsing (since sync parse doesn't return them)
  extractPrefixesFromContent(content);

  const parser = new N3.Parser({
    format: ext === ".ttl" ? "Turtle" : ext === ".n3" ? "N3" : undefined,
  });

  try {
    const quads = parser.parse(content);
    console.log(`  Parsed ${quads.length} triples from ${path.basename(filePath)}`);
    return quads;
  } catch (err: any) {
    console.error(`  WARNING: Error parsing ${path.basename(filePath)}: ${err.message}`);
    console.error(`  Attempting partial recovery...`);
    return [];
  }
};

// --- Store abstraction using N3.Store ---

const buildStore = (allQuads: N3.Quad[]): N3.Store => {
  const store = new N3.Store();
  store.addQuads(allQuads);
  return store;
};

// --- Store query helpers ---

const { namedNode } = N3.DataFactory;

const getObjects = (store: N3.Store, subjectUri: string, predicateUri: string): string[] => {
  const quads = store.getQuads(namedNode(subjectUri), namedNode(predicateUri), null, null);
  return quads
    .map((q) => {
      if (q.object.termType === "NamedNode") return q.object.value;
      if (q.object.termType === "Literal") return q.object.value;
      return "";
    })
    .filter(Boolean);
};

const getFirst = (store: N3.Store, subjectUri: string, predicateUri: string): string =>
  getObjects(store, subjectUri, predicateUri)[0] ?? "";

const getFirstLiteral = (store: N3.Store, subjectUri: string, predicateUri: string): string => {
  const quads = store.getQuads(namedNode(subjectUri), namedNode(predicateUri), null, null);
  const literal = quads.find((q) => q.object.termType === "Literal");
  if (literal) return literal.object.value;
  const named = quads.find((q) => q.object.termType === "NamedNode");
  return named ? named.object.value : "";
};

const getSubjects = (store: N3.Store, predicateUri: string, objectUri: string): string[] => {
  const quads = store.getQuads(null, namedNode(predicateUri), namedNode(objectUri), null);
  return quads
    .filter((q) => q.subject.termType === "NamedNode")
    .map((q) => q.subject.value);
};

const isNamedUri = (value: string): boolean =>
  value.startsWith("http://") || value.startsWith("https://");

// --- URI prefixing ---

const prefixUri = (uri: string): string => {
  const sorted = Object.entries(discoveredNamespaces).sort(
    (a, b) => b[1].length - a[1].length
  );
  for (const [prefix, nsUri] of sorted) {
    if (uri.startsWith(nsUri)) {
      return `${prefix}:${uri.slice(nsUri.length)}`;
    }
  }
  return uri;
};

// --- Label/description helpers that check multiple vocabularies ---

const getLabel = (store: N3.Store, uri: string): string => {
  const NS = discoveredNamespaces;
  return (
    getFirstLiteral(store, uri, `${NS.rdfs}label`) ||
    getFirstLiteral(store, uri, `${NS.schema}name`) ||
    getFirstLiteral(store, uri, `${NS.schema_http}name`) ||
    getFirstLiteral(store, uri, `${NS.skos}prefLabel`) ||
    getFirstLiteral(store, uri, `${NS.dc}title`) ||
    getFirstLiteral(store, uri, `${NS.dcterms}title`) ||
    uri.split(/[#/]/).pop() ||
    uri
  );
};

const getDescription = (store: N3.Store, uri: string): string => {
  const NS = discoveredNamespaces;
  return (
    getFirstLiteral(store, uri, `${NS.skos}definition`) ||
    getFirstLiteral(store, uri, `${NS.schema}description`) ||
    getFirstLiteral(store, uri, `${NS.schema_http}description`) ||
    getFirstLiteral(store, uri, `${NS.rdfs}comment`) ||
    getFirstLiteral(store, uri, `${NS.dc}description`) ||
    getFirstLiteral(store, uri, `${NS.dcterms}description`) ||
    ""
  );
};

// --- Extraction functions ---

const extractMetadata = (store: N3.Store, sourceFiles: string[]): OntologyMetadata => {
  const NS = discoveredNamespaces;

  // Find owl:Ontology nodes
  const ontologyQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}Ontology`), null);
  const ontologyNodes = ontologyQuads
    .filter((q) => q.subject.termType === "NamedNode")
    .map((q) => q.subject.value);

  let title = "";
  let version = "";
  let description = "";

  for (const uri of ontologyNodes) {
    if (!title) title = getFirstLiteral(store, uri, `${NS.schema}name`);
    if (!title) title = getFirstLiteral(store, uri, `${NS.schema_http}name`);
    if (!title) title = getFirstLiteral(store, uri, `${NS.dc}title`);
    if (!title) title = getFirstLiteral(store, uri, `${NS.dcterms}title`);
    if (!title) title = getFirstLiteral(store, uri, `${NS.rdfs}label`);
    if (!version) version = getFirstLiteral(store, uri, `${NS.owl}versionInfo`);
    if (!description) description = getFirstLiteral(store, uri, `${NS.schema}description`);
    if (!description) description = getFirstLiteral(store, uri, `${NS.schema_http}description`);
    if (!description) description = getFirstLiteral(store, uri, `${NS.dc}description`);
    if (!description) description = getFirstLiteral(store, uri, `${NS.dcterms}description`);
    if (!description) description = getFirstLiteral(store, uri, `${NS.rdfs}comment`);
  }

  const namespaces: Record<string, string> = {};
  for (const [prefix, uri] of Object.entries(discoveredNamespaces)) {
    namespaces[prefix] = uri;
  }

  return {
    title: title || "Unknown Ontology",
    version: version || "unknown",
    description: description || "",
    sourceFiles: sourceFiles.map((f) => path.basename(f)),
    namespaces,
  };
};

const extractClasses = (store: N3.Store): OntologyClass[] => {
  const NS = discoveredNamespaces;

  // owl:Class
  const owlClassQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}Class`), null);
  const owlClasses = owlClassQuads
    .filter((q) => q.subject.termType === "NamedNode")
    .map((q) => q.subject.value);

  // rdfs:Class
  const rdfsClassQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.rdfs}Class`), null);
  const rdfsClasses = rdfsClassQuads
    .filter((q) => q.subject.termType === "NamedNode")
    .map((q) => q.subject.value);

  const allClassUris = [...new Set([...owlClasses, ...rdfsClasses])].filter(isNamedUri);

  return allClassUris.map((uri: string) => {
    const superClasses = getObjects(store, uri, `${NS.rdfs}subClassOf`).filter(isNamedUri);
    const equivalentClasses = getObjects(store, uri, `${NS.owl}equivalentClass`).filter(isNamedUri);
    const examples = getObjects(store, uri, `${NS.skos}example`);

    const comments = [
      ...getObjects(store, uri, `${NS.rdfs}comment`),
      ...getObjects(store, uri, `${NS.skos}scopeNote`),
      ...getObjects(store, uri, `${NS.skos}note`),
    ].filter(Boolean);

    return {
      uri,
      label: getLabel(store, uri),
      definition: getDescription(store, uri),
      comment: comments.join(" | "),
      superClasses: superClasses.map(prefixUri),
      equivalentClasses: equivalentClasses.map(prefixUri),
      examples,
    };
  });
};

const extractObjectProperties = (store: N3.Store): ObjectProperty[] => {
  const NS = discoveredNamespaces;

  const propQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}ObjectProperty`), null);
  const propNodes = propQuads.filter((q) => q.subject.termType === "NamedNode");

  return propNodes.map((quad) => {
    const uri = quad.subject.value;
    const domains = getObjects(store, uri, `${NS.rdfs}domain`).filter(isNamedUri);
    const ranges = getObjects(store, uri, `${NS.rdfs}range`).filter(isNamedUri);
    const superProps = getObjects(store, uri, `${NS.rdfs}subPropertyOf`).filter(isNamedUri);
    const inverseOf = getObjects(store, uri, `${NS.owl}inverseOf`).filter(isNamedUri);
    const equivalentProps = getObjects(store, uri, `${NS.owl}equivalentProperty`).filter(isNamedUri);

    return {
      uri,
      label: getLabel(store, uri),
      definition: getDescription(store, uri),
      domain: domains.map(prefixUri),
      range: ranges.map(prefixUri),
      superProperties: superProps.map(prefixUri),
      inverseOf: inverseOf.length > 0
        ? prefixUri(inverseOf[0])
        : equivalentProps.length > 0 ? `eq:${prefixUri(equivalentProps[0])}` : "",
    };
  });
};

const extractDataProperties = (store: N3.Store): DataProperty[] => {
  const NS = discoveredNamespaces;

  const propQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}DatatypeProperty`), null);
  const propNodes = propQuads.filter((q) => q.subject.termType === "NamedNode");

  return propNodes.map((quad) => {
    const uri = quad.subject.value;
    const domains = getObjects(store, uri, `${NS.rdfs}domain`).filter(isNamedUri);
    const ranges = getObjects(store, uri, `${NS.rdfs}range`).filter(isNamedUri);

    return {
      uri,
      label: getLabel(store, uri),
      definition: getDescription(store, uri),
      domain: domains.map(prefixUri),
      range: ranges.length > 0 ? prefixUri(ranges[0]) : "xsd:string",
    };
  });
};

const extractRdfProperties = (
  store: N3.Store,
  objectPropUris: Set<string>,
  dataPropUris: Set<string>
): { objectProps: ObjectProperty[]; dataProps: DataProperty[] } => {
  const NS = discoveredNamespaces;

  const rdfPropQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.rdf}Property`), null);
  const rdfPropNodes = rdfPropQuads
    .filter((q) => q.subject.termType === "NamedNode")
    .filter((q) => !objectPropUris.has(q.subject.value) && !dataPropUris.has(q.subject.value));

  const additionalObjProps: ObjectProperty[] = [];
  const additionalDataProps: DataProperty[] = [];

  for (const quad of rdfPropNodes) {
    const uri = quad.subject.value;
    if (!isNamedUri(uri)) continue;

    const domains = getObjects(store, uri, `${NS.rdfs}domain`).filter(isNamedUri);
    const ranges = getObjects(store, uri, `${NS.rdfs}range`).filter(isNamedUri);
    const superProps = getObjects(store, uri, `${NS.rdfs}subPropertyOf`).filter(isNamedUri);
    const inverseOf = getObjects(store, uri, `${NS.owl}inverseOf`).filter(isNamedUri);
    const hasLiteralRange = ranges.some((r: string) =>
      r.startsWith(NS.xsd) || r === `${NS.rdfs}Literal`
    );

    // Also check if it's already typed as DatatypeProperty or ObjectProperty (dual-typed)
    const isAlsoDatatypeProp = store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}DatatypeProperty`), null).length > 0;
    const isAlsoObjectProp = store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}ObjectProperty`), null).length > 0;

    if (isAlsoDatatypeProp || isAlsoObjectProp) continue; // Already captured

    if (hasLiteralRange) {
      additionalDataProps.push({
        uri,
        label: getLabel(store, uri),
        definition: getDescription(store, uri),
        domain: domains.map(prefixUri),
        range: ranges.length > 0 ? prefixUri(ranges[0]) : "xsd:string",
      });
    } else {
      additionalObjProps.push({
        uri,
        label: getLabel(store, uri),
        definition: getDescription(store, uri),
        domain: domains.map(prefixUri),
        range: ranges.map(prefixUri),
        superProperties: superProps.map(prefixUri),
        inverseOf: inverseOf.length > 0 ? prefixUri(inverseOf[0]) : "",
      });
    }
  }

  return { objectProps: additionalObjProps, dataProps: additionalDataProps };
};

// --- External vocabulary extraction ---

const extractExternalVocabularies = (
  store: N3.Store,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): ExternalVocabulary[] => {
  const NS = discoveredNamespaces;

  // Determine which namespaces are the ontology's "own" (primary)
  const primaryNamespaces = new Set<string>();
  const ontologyQuads = store.getQuads(null, namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}Ontology`), null);
  const ontologyNodes = ontologyQuads
    .filter((q) => q.subject.termType === "NamedNode")
    .map((q) => q.subject.value);

  for (const uri of ontologyNodes) {
    primaryNamespaces.add(uri);
    primaryNamespaces.add(uri + "/");
    primaryNamespaces.add(uri + "#");
  }

  const externalNs: Record<
    string,
    { prefix: string; namespace: string; classes: Set<string>; properties: Set<string> }
  > = {};

  // Meta-ontology namespaces and primary ontology namespaces to exclude
  const metaNs = new Set([NS.rdf, NS.rdfs, NS.owl, NS.xsd]);

  for (const [prefix, nsUri] of Object.entries(NS)) {
    if (metaNs.has(nsUri)) continue;
    if (primaryNamespaces.has(nsUri)) continue;
    externalNs[prefix] = { prefix, namespace: nsUri, classes: new Set(), properties: new Set() };
  }

  // Scan all quads for external namespace references
  const seenUris = new Set<string>();
  for (const quad of store.getQuads(null, null, null, null)) {
    for (const term of [quad.subject, quad.predicate, quad.object]) {
      if (term.termType !== "NamedNode") continue;
      const uri = term.value;
      if (seenUris.has(uri)) continue;
      seenUris.add(uri);

      for (const [prefix, data] of Object.entries(externalNs)) {
        if (uri.startsWith(data.namespace) && uri !== data.namespace) {
          const localName = uri.slice(data.namespace.length);
          if (!localName) continue;

          const isClass =
            getSubjects(store, `${NS.rdf}type`, uri).length > 0 ||
            getSubjects(store, `${NS.rdfs}subClassOf`, uri).length > 0 ||
            getSubjects(store, `${NS.owl}equivalentClass`, uri).length > 0 ||
            store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}Class`), null).length > 0 ||
            store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.rdfs}Class`), null).length > 0;

          const isProperty =
            store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.rdf}Property`), null).length > 0 ||
            store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}ObjectProperty`), null).length > 0 ||
            store.getQuads(namedNode(uri), namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}DatatypeProperty`), null).length > 0 ||
            getSubjects(store, `${NS.rdfs}subPropertyOf`, uri).length > 0 ||
            getObjects(store, uri, `${NS.rdfs}subPropertyOf`).length > 0;

          if (isClass) data.classes.add(`${prefix}:${localName}`);
          if (isProperty) data.properties.add(`${prefix}:${localName}`);
        }
      }
    }
  }

  return Object.values(externalNs)
    .filter((v) => v.classes.size > 0 || v.properties.size > 0)
    .map((v) => ({
      prefix: v.prefix,
      namespace: v.namespace,
      classes: [...v.classes].sort(),
      properties: [...v.properties].sort(),
    }));
};

// --- Property connection analysis ---

const extractPropertyConnections = (
  objectProperties: ObjectProperty[],
  rdfObjectProperties: ObjectProperty[]
): Array<{ property: string; fromClass: string; toClass: string; description: string }> => {
  const connections: Array<{
    property: string;
    fromClass: string;
    toClass: string;
    description: string;
  }> = [];

  for (const prop of [...objectProperties, ...rdfObjectProperties]) {
    if (prop.domain.length > 0 && prop.range.length > 0) {
      for (const d of prop.domain) {
        for (const r of prop.range) {
          connections.push({
            property: prefixUri(prop.uri),
            fromClass: d,
            toClass: r,
            description: prop.definition || prop.label,
          });
        }
      }
    }
  }

  return connections;
};

// --- Class connectivity analysis ---

const analyzeClassConnectivity = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  connections: Array<{ property: string; fromClass: string; toClass: string }>
): Array<{ classUri: string; label: string; connectionCount: number; role: string }> => {
  const connectionCounts: Record<string, number> = {};
  for (const cls of classes) {
    const prefixed = prefixUri(cls.uri);
    connectionCounts[prefixed] = 0;
  }

  for (const conn of connections) {
    if (connectionCounts[conn.fromClass] !== undefined) connectionCounts[conn.fromClass]++;
    if (connectionCounts[conn.toClass] !== undefined) connectionCounts[conn.toClass]++;
  }

  for (const dp of dataProperties) {
    for (const d of dp.domain) {
      if (connectionCounts[d] !== undefined) connectionCounts[d]++;
    }
  }

  return classes
    .map((cls) => {
      const prefixed = prefixUri(cls.uri);
      const count = connectionCounts[prefixed] || 0;
      const hasSubClasses = classes.some((c) =>
        c.superClasses.includes(prefixed)
      );

      let role = "auxiliary";
      if (count >= 5) role = "core";
      else if (count >= 2 || hasSubClasses) role = "important";

      return { classUri: prefixed, label: cls.label, connectionCount: count, role };
    })
    .sort((a, b) => b.connectionCount - a.connectionCount);
};

// --- Mapping guide generation ---

const generateMappingGuide = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  connections: Array<{ property: string; fromClass: string; toClass: string; description: string }>,
  connectivity: Array<{ classUri: string; label: string; connectionCount: number; role: string }>
): MappingGuide => {
  const patterns: MappingPattern[] = [];

  const significantClasses = connectivity.filter(
    (c) => c.role === "core" || c.role === "important"
  );

  for (const classInfo of significantClasses) {
    const cls = classes.find((c) => prefixUri(c.uri) === classInfo.classUri);
    if (!cls) continue;

    const requiredProps: string[] = [];
    const optionalProps: string[] = [];
    const relationships: string[] = [];

    for (const dp of dataProperties) {
      if (dp.domain.includes(classInfo.classUri)) {
        optionalProps.push(prefixUri(dp.uri));
      }
    }

    for (const op of objectProperties) {
      if (op.domain.includes(classInfo.classUri)) {
        const rangeStr = op.range.join(" | ") || "(any)";
        relationships.push(`${prefixUri(op.uri)} -> ${rangeStr}`);
      }
      if (op.range.includes(classInfo.classUri)) {
        const domainStr = op.domain.join(" | ") || "(any)";
        relationships.push(`${domainStr} -> ${prefixUri(op.uri)} -> ${classInfo.classUri}`);
      }
    }

    patterns.push({
      scenario: `${cls.label || classInfo.classUri} (${classInfo.role} entity, ${classInfo.connectionCount} connections)`,
      ontologyClass: classInfo.classUri,
      requiredProperties: requiredProps,
      optionalProperties: optionalProps.slice(0, 20),
      relationships: relationships.slice(0, 15),
    });
  }

  const constraints: string[] = [
    "ONLY use classes and properties defined in or referenced by the parsed ontology files",
    "Do NOT invent custom classes or properties outside the ontology namespaces",
    "Respect rdfs:domain and rdfs:range constraints on all properties",
    "Use rdfs:subClassOf hierarchies to choose the most specific applicable class",
    "Properties with owl:FunctionalProperty type should have at most one value",
    "Inverse property pairs (owl:inverseOf) should be consistently applied",
    "owl:equivalentProperty pairs should be treated as interchangeable",
    "owl:disjointWith constraints must not be violated (e.g., Feature disjoint with Geometry)",
    "owl:Restriction with owl:allValuesFrom constraints must be respected for collection membership",
  ];

  const allowedNamespaces = Object.entries(discoveredNamespaces)
    .map(([prefix, uri]) => `${prefix}: (${uri})`);

  return { commonPatterns: patterns, allowedNamespaces, constraints };
};

// --- Quick reference generation ---

const generateQuickReference = (
  structure: OntologyStructure,
  connectivity: Array<{ classUri: string; label: string; connectionCount: number; role: string }>
): QuickReference => {
  const coreClasses = connectivity
    .filter((c) => c.role === "core" || c.role === "important")
    .map((c) => {
      const cls = structure.classes.find((cl) => prefixUri(cl.uri) === c.classUri);
      const def = cls?.definition || cls?.comment || "";
      const shortDef = def.length > 200 ? def.slice(0, 197) + "..." : def;
      return {
        prefixed: c.classUri,
        label: c.label,
        definition: shortDef,
      };
    });

  const keyObjectProperties = structure.objectProperties
    .filter((p) => p.domain.length > 0 || p.range.length > 0)
    .slice(0, 40)
    .map((p) => ({
      prefixed: prefixUri(p.uri),
      label: p.label,
      domain: p.domain.join(", ") || "(unspecified)",
      range: p.range.join(", ") || "(unspecified)",
    }));

  const keyDataProperties = structure.dataProperties
    .filter((p) => p.domain.length > 0)
    .slice(0, 40)
    .map((p) => ({
      prefixed: prefixUri(p.uri),
      label: p.label,
      domain: p.domain.join(", ") || "(unspecified)",
      range: p.range,
    }));

  const allowedNamespaces = Object.entries(discoveredNamespaces).map(
    ([prefix, uri]) => `${prefix}: (${uri})`
  );

  return {
    coreClasses,
    keyObjectProperties,
    keyDataProperties,
    allowedNamespaces,
    ontologyVersion: structure.metadata.version,
  };
};

// --- Output helpers ---

const writeJson = (filePath: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
};

const printSummary = (
  structure: OntologyStructure,
  guide: MappingGuide,
  quickRef: QuickReference,
  connectivity: Array<{ classUri: string; label: string; connectionCount: number; role: string }>,
  outputPaths: string[]
): void => {
  const line = "=".repeat(65);
  const thin = "-".repeat(65);

  console.log(`\n${line}`);
  console.log(`  Ontology Parser - Results`);
  console.log(`${line}\n`);

  console.log(`  Title:                 ${structure.metadata.title}`);
  console.log(`  Version:               ${structure.metadata.version}`);
  console.log(`  Source files:           ${structure.metadata.sourceFiles.join(", ")}`);
  console.log(`  Classes found:         ${structure.classes.length}`);
  console.log(`  Object properties:     ${structure.objectProperties.length}`);
  console.log(`  Data properties:       ${structure.dataProperties.length}`);
  console.log(`  External vocabularies: ${structure.externalVocabularies.length}`);
  console.log(`  Mapping patterns:      ${guide.commonPatterns.length}\n`);

  // Core classes
  console.log(`${thin}`);
  console.log(`  Core & Important Classes (${quickRef.coreClasses.length})`);
  console.log(`${thin}\n`);

  for (const cls of quickRef.coreClasses.slice(0, 25)) {
    const shortDef =
      cls.definition.length > 70 ? cls.definition.slice(0, 67) + "..." : cls.definition;
    console.log(`  ${cls.prefixed.padEnd(35)} ${shortDef}`);
  }
  if (quickRef.coreClasses.length > 25) {
    console.log(`  ... and ${quickRef.coreClasses.length - 25} more`);
  }

  // Class hierarchy
  console.log(`\n${thin}`);
  console.log(`  Class Hierarchy`);
  console.log(`${thin}\n`);

  for (const cls of structure.classes) {
    const prefixed = prefixUri(cls.uri);
    const supers = cls.superClasses.length > 0 ? ` -> ${cls.superClasses.join(", ")}` : " (root)";
    console.log(`  ${prefixed.padEnd(35)}${supers}`);
  }

  // Key object properties
  console.log(`\n${thin}`);
  console.log(`  Key Object Properties (${structure.objectProperties.length})`);
  console.log(`${thin}\n`);

  const propSample = structure.objectProperties
    .filter((p) => p.domain.length > 0 && p.range.length > 0)
    .slice(0, 15);
  for (const p of propSample) {
    console.log(`  ${prefixUri(p.uri).padEnd(30)} ${p.domain.join(",")} -> ${p.range.join(",")}`);
  }
  if (structure.objectProperties.length > 15) {
    console.log(`  ... and ${structure.objectProperties.length - 15} more`);
  }

  // Key data properties
  console.log(`\n${thin}`);
  console.log(`  Key Data Properties (${structure.dataProperties.length})`);
  console.log(`${thin}\n`);

  for (const p of structure.dataProperties.slice(0, 15)) {
    console.log(`  ${prefixUri(p.uri).padEnd(35)} ${p.domain.join(",")} -> ${p.range}`);
  }
  if (structure.dataProperties.length > 15) {
    console.log(`  ... and ${structure.dataProperties.length - 15} more`);
  }

  // External vocabularies
  console.log(`\n${thin}`);
  console.log(`  External Vocabularies`);
  console.log(`${thin}\n`);

  for (const vocab of structure.externalVocabularies) {
    console.log(`  ${vocab.prefix.padEnd(12)} ${vocab.namespace}`);
    if (vocab.classes.length > 0) {
      console.log(`    Classes:    ${vocab.classes.slice(0, 8).join(", ")}${vocab.classes.length > 8 ? ` ... (+${vocab.classes.length - 8} more)` : ""}`);
    }
    if (vocab.properties.length > 0) {
      const propList =
        vocab.properties.length > 6
          ? vocab.properties.slice(0, 6).join(", ") + ` ... (+${vocab.properties.length - 6} more)`
          : vocab.properties.join(", ");
      console.log(`    Properties: ${propList}`);
    }
    console.log("");
  }

  // Namespaces
  console.log(`${thin}`);
  console.log(`  Available Namespaces`);
  console.log(`${thin}\n`);

  const relevantNs = Object.entries(discoveredNamespaces)
    .filter(([prefix]) => !["rdf", "rdfs", "owl", "xsd"].includes(prefix));
  for (const [prefix, uri] of relevantNs.slice(0, 20)) {
    console.log(`  ${prefix.padEnd(14)} ${uri}`);
  }

  // Output files
  console.log(`\n${thin}`);
  console.log(`  Files Written`);
  console.log(`${thin}\n`);

  for (const p of outputPaths) {
    const size = (fs.statSync(p).size / 1024).toFixed(1);
    console.log(`  ${path.basename(p).padEnd(35)} (${size} KB)`);
  }

  console.log(`\n${line}`);
  console.log(`  Parsing complete.`);
  console.log(`${line}\n`);
};

// --- Main ---

const main = async (): Promise<void> => {
  const dataDir = process.env.DATA_DIR || "domain-data/geospatial";
  const ontologyDir = path.resolve(dataDir, "ontology");
  const outputDir = path.resolve(dataDir, "output");

  console.log(`\n  Ontology Parser`);
  console.log(`  Data directory: ${dataDir}`);
  console.log(`  Ontology directory: ${ontologyDir}`);

  // Step 1: Discover ontology files
  const ontologyFiles = discoverOntologyFiles(ontologyDir);

  // Step 2: Parse all files into quads
  console.log(`  Parsing ontology files...`);
  const allQuads: N3.Quad[] = [];
  for (const file of ontologyFiles) {
    const quads = parseOntologyFile(file);
    allQuads.push(...quads);
  }

  // Step 3: Build N3 Store from merged quads
  const store = buildStore(allQuads);
  console.log(`\n  Total triples after merge: ${allQuads.length}\n`);

  // Step 4: Extract all ontology elements
  const metadata = extractMetadata(store, ontologyFiles);
  const classes = extractClasses(store);
  const objectProperties = extractObjectProperties(store);
  const dataProperties = extractDataProperties(store);

  // Also extract rdf:Property not already classified
  const objPropUris = new Set(objectProperties.map((p) => p.uri));
  const dataPropUris = new Set(dataProperties.map((p) => p.uri));
  const { objectProps: rdfObjProps, dataProps: rdfDataProps } = extractRdfProperties(
    store,
    objPropUris,
    dataPropUris
  );

  const allObjectProperties = [...objectProperties, ...rdfObjProps];
  const allDataProperties = [...dataProperties, ...rdfDataProps];

  // External vocabularies
  const externalVocabularies = extractExternalVocabularies(
    store,
    classes,
    allObjectProperties,
    allDataProperties
  );

  // Build structure
  const structure: OntologyStructure = {
    metadata,
    classes,
    objectProperties: allObjectProperties,
    dataProperties: allDataProperties,
    externalVocabularies,
  };

  // Step 5: Analyze connectivity and patterns
  const connections = extractPropertyConnections(objectProperties, rdfObjProps);
  const connectivity = analyzeClassConnectivity(
    classes,
    allObjectProperties,
    allDataProperties,
    connections
  );

  // Step 6: Generate mapping guide
  const mappingGuide = generateMappingGuide(
    classes,
    allObjectProperties,
    allDataProperties,
    connections,
    connectivity
  );

  // Step 7: Generate quick reference
  const quickReference = generateQuickReference(structure, connectivity);

  // Step 8: Write outputs
  const structurePath = path.join(outputDir, "ontology-structure.json");
  const guidePath = path.join(outputDir, "ontology-mapping-guide.json");
  const quickRefPath = path.join(outputDir, "ontology-quick-reference.json");

  writeJson(structurePath, structure);
  writeJson(guidePath, mappingGuide);
  writeJson(quickRefPath, quickReference);

  // Step 9: Print summary
  printSummary(structure, mappingGuide, quickReference, connectivity, [
    structurePath,
    guidePath,
    quickRefPath,
  ]);
};

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
