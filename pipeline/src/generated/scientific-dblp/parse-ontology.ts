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
  frbr: "http://purl.org/vocab/frbr/core#",
  prism: "http://prismstandard.org/namespaces/basic/2.0/",
  fabio: "http://purl.org/spar/fabio/",
};

// --- Supported ontology file extensions ---

const SUPPORTED_EXTENSIONS = [".owl", ".xml", ".ttl", ".rdf", ".n3", ".jsonld"];

// Format categories
const RDFXML_EXTENSIONS = new Set([".owl", ".xml", ".rdf"]);
const N3_EXTENSIONS = new Set([".ttl", ".n3"]);

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

// --- Unified store interface wrapping either rdflib or N3.Store ---

interface UnifiedStore {
  getObjects: (subjectUri: string, predicateUri: string) => string[];
  getFirstLiteral: (subjectUri: string, predicateUri: string) => string;
  getSubjects: (predicateUri: string, objectUri: string) => string[];
  getAllQuads: () => Array<{ subject: string; predicate: string; object: string; objectType: string }>;
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

// --- Namespace extraction from file content ---

const extractNamespacesFromContent = (content: string): void => {
  let match: RegExpExecArray | null;

  // Extract xmlns:prefix="uri" declarations from RDF/XML
  const xmlnsRe = /xmlns:([a-zA-Z_][\w.-]*)="(https?:\/\/[^"]+)"/g;
  while ((match = xmlnsRe.exec(content)) !== null) {
    const prefix = match[1];
    const nsUri = match[2];
    // Validate: prefix must be a clean identifier, uri must be a proper URI
    if (nsUri && /^[a-zA-Z_][\w.-]*$/.test(prefix) && !discoveredNamespaces[prefix]) {
      discoveredNamespaces[prefix] = nsUri;
    }
  }

  // Extract PREFIX declarations from Turtle/N3/SPARQL
  const prefixRe = /PREFIX\s+([a-zA-Z_][\w.-]*)?:\s*<([^>]+)>/gi;
  while ((match = prefixRe.exec(content)) !== null) {
    const prefix = match[1] || "base";
    const nsUri = match[2];
    if (nsUri && !discoveredNamespaces[prefix]) {
      discoveredNamespaces[prefix] = nsUri;
    }
  }

  // Extract @prefix declarations (Turtle)
  const atPrefixRe = /@prefix\s+([a-zA-Z_][\w.-]*)?:\s*<([^>]+)>/gi;
  while ((match = atPrefixRe.exec(content)) !== null) {
    const prefix = match[1] || "base";
    const nsUri = match[2];
    if (nsUri && !discoveredNamespaces[prefix]) {
      discoveredNamespaces[prefix] = nsUri;
    }
  }

  // Extract vann:preferredNamespacePrefix / preferredNamespaceUri
  // For Turtle: vann:preferredNamespacePrefix "fabio"
  const vannPrefixTtl = content.match(/preferredNamespacePrefix\s+"([^"]+)"/);
  const vannNsTtl = content.match(/preferredNamespaceUri\s+"([^"]+)"/);
  if (vannPrefixTtl && vannNsTtl) {
    discoveredNamespaces[vannPrefixTtl[1]] = vannNsTtl[1];
  }
  // For RDF/XML: <vann:preferredNamespaceUri ...>http://...</vann:preferredNamespaceUri>
  const vannNsXml = content.match(/preferredNamespaceUri[^>]*>([^<]+)<\/vann:preferredNamespaceUri>/);
  const vannPrefixXml = content.match(/preferredNamespacePrefix[^>]*>([^<]+)<\/vann:preferredNamespacePrefix>/);
  if (vannPrefixXml && vannNsXml && /^https?:\/\//.test(vannNsXml[1])) {
    discoveredNamespaces[vannPrefixXml[1]] = vannNsXml[1];
  }

  // Discover namespaces from rdf:resource / rdf:about URIs that appear frequently
  const uriRe = /rdf:(?:resource|about)="(https?:\/\/[^"#\s<>]+[#/])"/g;
  const nsCounts: Record<string, number> = {};
  while ((match = uriRe.exec(content)) !== null) {
    const ns = match[1];
    // Validate: must be a proper URI (no XML fragments, no whitespace)
    if (/^https?:\/\/[^\s<>"]+[#/]$/.test(ns)) {
      nsCounts[ns] = (nsCounts[ns] || 0) + 1;
    }
  }

  // Auto-register frequently-referenced namespaces that aren't already known
  const knownUris = new Set(Object.values(discoveredNamespaces));
  for (const [nsUri, count] of Object.entries(nsCounts)) {
    if (count >= 3 && !knownUris.has(nsUri)) {
      const parts = nsUri.replace(/[#/]$/, "").split("/");
      let candidate = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!candidate || candidate.length < 2 || discoveredNamespaces[candidate]) {
        candidate = parts.slice(-2).join("_").toLowerCase().replace(/[^a-z0-9_]/g, "");
      }
      if (candidate && candidate.length >= 2 && !discoveredNamespaces[candidate]) {
        discoveredNamespaces[candidate] = nsUri;
        knownUris.add(nsUri);
      }
    }
  }

  // Sanitize: remove any namespace entries with invalid prefix keys
  for (const key of Object.keys(discoveredNamespaces)) {
    if (!/^[a-zA-Z_][\w.-]*$/.test(key)) {
      delete discoveredNamespaces[key];
    }
  }
};

// --- Entity reference expansion for RDF/XML files ---

const expandEntityReferences = (xml: string): string => {
  const entityMap: Record<string, string> = {};

  // Extract xmlns:prefix="uri" declarations
  const xmlnsRe = /xmlns:([a-zA-Z_][\w.-]*)="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = xmlnsRe.exec(xml)) !== null) {
    entityMap[match[1]] = match[2];
  }

  // Replace all &prefix; entity references with full URI
  let expanded = xml;
  for (const [prefix, uri] of Object.entries(entityMap)) {
    const entityRe = new RegExp(`&${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`, "g");
    expanded = expanded.replace(entityRe, uri);
  }

  // Also expand using well-known namespaces
  for (const [prefix, uri] of Object.entries(discoveredNamespaces)) {
    const entityRe = new RegExp(`&${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`, "g");
    expanded = expanded.replace(entityRe, uri);
  }

  return expanded;
};

// --- rdflib-based parsing for RDF/XML ---

const parseRdfXmlFile = (filePath: string): UnifiedStore => {
  const rdflib = require("rdflib");
  const store = rdflib.graph();

  const rawContent = fs.readFileSync(filePath, "utf-8");
  extractNamespacesFromContent(rawContent);
  const content = expandEntityReferences(rawContent);

  // Determine base URI from the ontology
  const baseUri = discoveredNamespaces.fabio || "http://example.org/ontology/";

  try {
    rdflib.parse(content, store, baseUri, "application/rdf+xml");
    const stmtCount = store.statements.length;
    console.log(`  Parsed ${stmtCount} triples from ${path.basename(filePath)} (rdflib/RDF-XML)`);
  } catch (err: any) {
    console.error(`  WARNING: Error parsing ${path.basename(filePath)}: ${err.message}`);
    console.error(`  Attempting partial recovery...`);
  }

  return wrapRdflibStore(store, rdflib);
};

const wrapRdflibStore = (store: any, rdflib: any): UnifiedStore => ({
  getObjects: (subjectUri: string, predicateUri: string): string[] => {
    const results = store.each(rdflib.sym(subjectUri), rdflib.sym(predicateUri), undefined);
    return results
      .map((node: any) => {
        if (node.termType === "NamedNode") return node.value;
        if (node.termType === "Literal") return node.value;
        return "";
      })
      .filter(Boolean);
  },

  getFirstLiteral: (subjectUri: string, predicateUri: string): string => {
    const results = store.each(rdflib.sym(subjectUri), rdflib.sym(predicateUri), undefined);
    const literal = results.find((n: any) => n.termType === "Literal");
    if (literal) return literal.value;
    const named = results.find((n: any) => n.termType === "NamedNode");
    return named ? named.value : "";
  },

  getSubjects: (predicateUri: string, objectUri: string): string[] => {
    const results = store.each(undefined, rdflib.sym(predicateUri), rdflib.sym(objectUri));
    return results
      .filter((n: any) => n.termType === "NamedNode")
      .map((n: any) => n.value);
  },

  getAllQuads: (): Array<{ subject: string; predicate: string; object: string; objectType: string }> => {
    return store.statements.map((st: any) => ({
      subject: st.subject.value,
      predicate: st.predicate.value,
      object: st.object.value,
      objectType: st.object.termType,
    }));
  },
});

// --- N3-based parsing for Turtle/N3 ---

const parseN3File = (filePath: string): UnifiedStore => {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf-8");
  extractNamespacesFromContent(content);

  const format = ext === ".ttl" ? "Turtle" : ext === ".n3" ? "N3" : undefined;
  const parser = new N3.Parser({ format });

  let quads: N3.Quad[] = [];
  try {
    quads = parser.parse(content);
    console.log(`  Parsed ${quads.length} triples from ${path.basename(filePath)} (N3/${format || "auto"})`);
  } catch (err: any) {
    console.error(`  WARNING: Error parsing ${path.basename(filePath)}: ${err.message}`);
  }

  const store = new N3.Store();
  store.addQuads(quads);

  return wrapN3Store(store);
};

const wrapN3Store = (store: N3.Store): UnifiedStore => {
  const { namedNode } = N3.DataFactory;

  return {
    getObjects: (subjectUri: string, predicateUri: string): string[] => {
      const quads = store.getQuads(namedNode(subjectUri), namedNode(predicateUri), null, null);
      return quads
        .map((q) => {
          if (q.object.termType === "NamedNode") return q.object.value;
          if (q.object.termType === "Literal") return q.object.value;
          return "";
        })
        .filter(Boolean);
    },

    getFirstLiteral: (subjectUri: string, predicateUri: string): string => {
      const quads = store.getQuads(namedNode(subjectUri), namedNode(predicateUri), null, null);
      const literal = quads.find((q) => q.object.termType === "Literal");
      if (literal) return literal.object.value;
      const named = quads.find((q) => q.object.termType === "NamedNode");
      return named ? named.object.value : "";
    },

    getSubjects: (predicateUri: string, objectUri: string): string[] => {
      const quads = store.getQuads(null, namedNode(predicateUri), namedNode(objectUri), null);
      return quads
        .filter((q) => q.subject.termType === "NamedNode")
        .map((q) => q.subject.value);
    },

    getAllQuads: (): Array<{ subject: string; predicate: string; object: string; objectType: string }> => {
      return store.getQuads(null, null, null, null).map((q) => ({
        subject: q.subject.value,
        predicate: q.predicate.value,
        object: q.object.value,
        objectType: q.object.termType,
      }));
    },
  };
};

// --- Parse any ontology file (dispatch by format) ---

const parseOntologyFile = (filePath: string): UnifiedStore => {
  const ext = path.extname(filePath).toLowerCase();

  if (RDFXML_EXTENSIONS.has(ext)) {
    return parseRdfXmlFile(filePath);
  } else if (N3_EXTENSIONS.has(ext)) {
    return parseN3File(filePath);
  } else {
    // Try RDF/XML first, fallback to N3
    console.log(`  Unknown format for ${path.basename(filePath)}, trying RDF/XML...`);
    try {
      return parseRdfXmlFile(filePath);
    } catch {
      console.log(`  RDF/XML failed, trying N3...`);
      return parseN3File(filePath);
    }
  }
};

// --- Merge multiple stores into one ---

const mergeStores = (stores: UnifiedStore[]): UnifiedStore => {
  if (stores.length === 1) return stores[0];

  // Collect all quads from all stores into a single N3.Store
  const mergedStore = new N3.Store();
  const { namedNode, literal, quad } = N3.DataFactory;

  for (const store of stores) {
    for (const q of store.getAllQuads()) {
      const subject = namedNode(q.subject);
      const predicate = namedNode(q.predicate);
      const object = q.objectType === "Literal" ? literal(q.object) : namedNode(q.object);
      mergedStore.addQuad(quad(subject, predicate, object));
    }
  }

  return wrapN3Store(mergedStore);
};

// --- Utility helpers ---

const isNamedUri = (value: string): boolean =>
  value.startsWith("http://") || value.startsWith("https://");

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

// --- Label/description helpers ---

const getLabel = (store: UnifiedStore, uri: string): string => {
  const NS = discoveredNamespaces;
  return (
    store.getFirstLiteral(uri, `${NS.rdfs}label`) ||
    store.getFirstLiteral(uri, `${NS.schema}name`) ||
    store.getFirstLiteral(uri, `${NS.schema_http}name`) ||
    store.getFirstLiteral(uri, `${NS.skos}prefLabel`) ||
    store.getFirstLiteral(uri, `${NS.dc}title`) ||
    store.getFirstLiteral(uri, `${NS.dcterms}title`) ||
    uri.split(/[#/]/).pop() ||
    uri
  );
};

const getDescription = (store: UnifiedStore, uri: string): string => {
  const NS = discoveredNamespaces;
  return (
    store.getFirstLiteral(uri, `${NS.skos}definition`) ||
    store.getFirstLiteral(uri, `${NS.rdfs}comment`) ||
    store.getFirstLiteral(uri, `${NS.dc}description`) ||
    store.getFirstLiteral(uri, `${NS.dcterms}description`) ||
    store.getFirstLiteral(uri, `${NS.schema}description`) ||
    store.getFirstLiteral(uri, `${NS.schema_http}description`) ||
    ""
  );
};

const getComment = (store: UnifiedStore, uri: string): string => {
  const NS = discoveredNamespaces;
  const parts = [
    ...store.getObjects(uri, `${NS.rdfs}comment`),
    ...store.getObjects(uri, `${NS.skos}scopeNote`),
    ...store.getObjects(uri, `${NS.skos}note`),
    ...store.getObjects(uri, `${NS.dc}description`),
  ].filter(Boolean);

  return [...new Set(parts)].join(" | ");
};

// --- Extraction functions ---

const extractMetadata = (store: UnifiedStore, sourceFiles: string[]): OntologyMetadata => {
  const NS = discoveredNamespaces;

  // Find owl:Ontology nodes
  const ontologyNodes = store.getSubjects(`${NS.rdf}type`, `${NS.owl}Ontology`)
    .filter(isNamedUri);

  let title = "";
  let version = "";
  let description = "";

  for (const uri of ontologyNodes) {
    if (!title) title = store.getFirstLiteral(uri, `${NS.dc}title`);
    if (!title) title = store.getFirstLiteral(uri, `${NS.dcterms}title`);
    if (!title) title = store.getFirstLiteral(uri, `${NS.rdfs}label`);
    if (!title) title = store.getFirstLiteral(uri, `${NS.schema}name`);
    if (!title) title = store.getFirstLiteral(uri, `${NS.schema_http}name`);
    if (!version) version = store.getFirstLiteral(uri, `${NS.owl}versionInfo`);
    if (!description) description = store.getFirstLiteral(uri, `${NS.dc}description`);
    if (!description) description = store.getFirstLiteral(uri, `${NS.dcterms}description`);
    if (!description) description = store.getFirstLiteral(uri, `${NS.rdfs}comment`);
    if (!description) description = store.getFirstLiteral(uri, `${NS.schema}description`);
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

const extractClasses = (store: UnifiedStore): OntologyClass[] => {
  const NS = discoveredNamespaces;

  const owlClassUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}Class`).filter(isNamedUri);
  const rdfsClassUris = store.getSubjects(`${NS.rdf}type`, `${NS.rdfs}Class`).filter(isNamedUri);
  const allClassUris = [...new Set([...owlClassUris, ...rdfsClassUris])];

  return allClassUris.map((uri: string) => {
    const superClasses = store.getObjects(uri, `${NS.rdfs}subClassOf`).filter(isNamedUri);
    const equivalentClasses = store.getObjects(uri, `${NS.owl}equivalentClass`).filter(isNamedUri);
    const examples = store.getObjects(uri, `${NS.skos}example`);

    return {
      uri,
      label: getLabel(store, uri),
      definition: getDescription(store, uri),
      comment: getComment(store, uri),
      superClasses: superClasses.map(prefixUri),
      equivalentClasses: equivalentClasses.map(prefixUri),
      examples,
    };
  });
};

const extractObjectProperties = (store: UnifiedStore): ObjectProperty[] => {
  const NS = discoveredNamespaces;

  const propUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}ObjectProperty`).filter(isNamedUri);

  return propUris.map((uri: string) => {
    const domains = store.getObjects(uri, `${NS.rdfs}domain`).filter(isNamedUri);
    const ranges = store.getObjects(uri, `${NS.rdfs}range`).filter(isNamedUri);
    const superProps = store.getObjects(uri, `${NS.rdfs}subPropertyOf`).filter(isNamedUri);
    const inverseOf = store.getObjects(uri, `${NS.owl}inverseOf`).filter(isNamedUri);
    const equivalentProps = store.getObjects(uri, `${NS.owl}equivalentProperty`).filter(isNamedUri);

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

const extractDataProperties = (store: UnifiedStore): DataProperty[] => {
  const NS = discoveredNamespaces;

  const propUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}DatatypeProperty`).filter(isNamedUri);

  return propUris.map((uri: string) => {
    const domains = store.getObjects(uri, `${NS.rdfs}domain`).filter(isNamedUri);
    const ranges = store.getObjects(uri, `${NS.rdfs}range`).filter(isNamedUri);

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
  store: UnifiedStore,
  objectPropUris: Set<string>,
  dataPropUris: Set<string>
): { objectProps: ObjectProperty[]; dataProps: DataProperty[] } => {
  const NS = discoveredNamespaces;

  const rdfPropUris = store.getSubjects(`${NS.rdf}type`, `${NS.rdf}Property`)
    .filter(isNamedUri)
    .filter((uri) => !objectPropUris.has(uri) && !dataPropUris.has(uri));

  const additionalObjProps: ObjectProperty[] = [];
  const additionalDataProps: DataProperty[] = [];

  for (const uri of rdfPropUris) {
    const domains = store.getObjects(uri, `${NS.rdfs}domain`).filter(isNamedUri);
    const ranges = store.getObjects(uri, `${NS.rdfs}range`).filter(isNamedUri);
    const superProps = store.getObjects(uri, `${NS.rdfs}subPropertyOf`).filter(isNamedUri);
    const inverseOf = store.getObjects(uri, `${NS.owl}inverseOf`).filter(isNamedUri);
    const hasLiteralRange = ranges.some((r: string) =>
      r.startsWith(NS.xsd) || r === `${NS.rdfs}Literal`
    );

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
  store: UnifiedStore,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): ExternalVocabulary[] => {
  const NS = discoveredNamespaces;

  // Determine primary namespaces (the ontology's own)
  const primaryNamespaces = new Set<string>();
  const ontologyNodes = store.getSubjects(`${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri);

  for (const uri of ontologyNodes) {
    primaryNamespaces.add(uri);
    primaryNamespaces.add(uri + "/");
    primaryNamespaces.add(uri + "#");
  }

  // Also treat vann:preferredNamespaceUri as primary
  for (const uri of ontologyNodes) {
    const vannNs = store.getObjects(uri, `${NS.vann}preferredNamespaceUri`);
    for (const v of vannNs) {
      if (v) primaryNamespaces.add(v);
    }
  }

  const externalNs: Record<
    string,
    { prefix: string; namespace: string; classes: Set<string>; properties: Set<string> }
  > = {};

  // Meta-ontology namespaces to exclude
  const metaNs = new Set([NS.rdf, NS.rdfs, NS.owl, NS.xsd]);

  for (const [prefix, nsUri] of Object.entries(discoveredNamespaces)) {
    if (metaNs.has(nsUri)) continue;
    if (primaryNamespaces.has(nsUri)) continue;
    externalNs[prefix] = { prefix, namespace: nsUri, classes: new Set(), properties: new Set() };
  }

  // Scan all quads for external namespace references
  const seenUris = new Set<string>();
  for (const q of store.getAllQuads()) {
    for (const uri of [q.subject, q.predicate, q.object]) {
      if (!isNamedUri(uri)) continue;
      if (seenUris.has(uri)) continue;
      seenUris.add(uri);

      for (const [prefix, data] of Object.entries(externalNs)) {
        if (uri.startsWith(data.namespace) && uri !== data.namespace) {
          const localName = uri.slice(data.namespace.length);
          if (!localName) continue;

          const isClass =
            store.getSubjects(`${NS.rdf}type`, uri).length > 0 ||
            store.getSubjects(`${NS.rdfs}subClassOf`, uri).length > 0 ||
            store.getSubjects(`${NS.owl}equivalentClass`, uri).length > 0;

          const isProperty =
            store.getSubjects(`${NS.rdfs}subPropertyOf`, uri).length > 0 ||
            store.getObjects(uri, `${NS.rdfs}subPropertyOf`).length > 0 ||
            store.getObjects(uri, `${NS.rdfs}domain`).length > 0;

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
      const hasSubClasses = classes.some((c) => c.superClasses.includes(prefixed));

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
    "owl:disjointWith constraints must not be violated",
    "owl:Restriction constraints (allValuesFrom, someValuesFrom) must be respected",
    "FaBiO classes follow FRBR: Work -> Expression -> Manifestation -> Item hierarchy",
    "Properties from external vocabularies (FRBR, DC Terms, PRISM, SKOS) are valid for use",
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
    .slice(0, 50)
    .map((p) => ({
      prefixed: prefixUri(p.uri),
      label: p.label,
      domain: p.domain.join(", ") || "(unspecified)",
      range: p.range.join(", ") || "(unspecified)",
    }));

  const keyDataProperties = structure.dataProperties
    .filter((p) => p.domain.length > 0)
    .slice(0, 50)
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
  const line = "=".repeat(70);
  const thin = "-".repeat(70);

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

  for (const cls of quickRef.coreClasses.slice(0, 30)) {
    const shortDef =
      cls.definition.length > 65 ? cls.definition.slice(0, 62) + "..." : cls.definition;
    console.log(`  ${cls.prefixed.padEnd(40)} ${shortDef}`);
  }
  if (quickRef.coreClasses.length > 30) {
    console.log(`  ... and ${quickRef.coreClasses.length - 30} more`);
  }

  // Class hierarchy (top-level roots)
  console.log(`\n${thin}`);
  console.log(`  Class Hierarchy (top-level roots)`);
  console.log(`${thin}\n`);

  const rootClasses = structure.classes.filter(
    (c) => c.superClasses.length === 0 || c.superClasses.every((s) => s.startsWith("owl:") || s.startsWith("rdfs:"))
  );
  for (const cls of rootClasses.slice(0, 20)) {
    const prefixed = prefixUri(cls.uri);
    const children = structure.classes.filter((c) => c.superClasses.includes(prefixed));
    const childStr = children.length > 0 ? ` (${children.length} subclasses)` : "";
    console.log(`  ${prefixed.padEnd(40)}${childStr}`);
  }
  if (rootClasses.length > 20) {
    console.log(`  ... and ${rootClasses.length - 20} more root classes`);
  }

  // Key object properties
  console.log(`\n${thin}`);
  console.log(`  Key Object Properties (${structure.objectProperties.length})`);
  console.log(`${thin}\n`);

  const propSample = structure.objectProperties
    .filter((p) => p.domain.length > 0 && p.range.length > 0)
    .slice(0, 20);
  for (const p of propSample) {
    console.log(`  ${prefixUri(p.uri).padEnd(35)} ${p.domain.join(",")} -> ${p.range.join(",")}`);
  }
  if (structure.objectProperties.length > 20) {
    console.log(`  ... and ${structure.objectProperties.length - 20} more`);
  }

  // Key data properties
  console.log(`\n${thin}`);
  console.log(`  Key Data Properties (${structure.dataProperties.length})`);
  console.log(`${thin}\n`);

  for (const p of structure.dataProperties.slice(0, 20)) {
    console.log(`  ${prefixUri(p.uri).padEnd(40)} ${p.domain.join(",")} -> ${p.range}`);
  }
  if (structure.dataProperties.length > 20) {
    console.log(`  ... and ${structure.dataProperties.length - 20} more`);
  }

  // External vocabularies
  console.log(`\n${thin}`);
  console.log(`  External Vocabularies`);
  console.log(`${thin}\n`);

  for (const vocab of structure.externalVocabularies) {
    console.log(`  ${vocab.prefix.padEnd(14)} ${vocab.namespace}`);
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
  for (const [prefix, uri] of relevantNs.slice(0, 25)) {
    console.log(`  ${prefix.padEnd(16)} ${uri}`);
  }
  if (relevantNs.length > 25) {
    console.log(`  ... and ${relevantNs.length - 25} more`);
  }

  // Typical property chains
  console.log(`\n${thin}`);
  console.log(`  Typical Property Chains`);
  console.log(`${thin}\n`);

  const chains = structure.objectProperties
    .filter((p) => p.domain.length > 0 && p.range.length > 0)
    .slice(0, 10)
    .map((p) => `  ${p.domain[0]} -[${prefixUri(p.uri)}]-> ${p.range[0]}`);
  for (const c of chains) {
    console.log(c);
  }

  // Output files
  console.log(`\n${thin}`);
  console.log(`  Files Written`);
  console.log(`${thin}\n`);

  for (const p of outputPaths) {
    const size = (fs.statSync(p).size / 1024).toFixed(1);
    console.log(`  ${path.basename(p).padEnd(40)} (${size} KB)`);
  }

  console.log(`\n${line}`);
  console.log(`  Parsing complete.`);
  console.log(`${line}\n`);
};

// --- Main ---

const main = async (): Promise<void> => {
  const dataDir = process.env.DATA_DIR || "domain-data/scientific-dblp";
  const ontologyDir = path.resolve(dataDir, "ontology");
  const outputDir = path.resolve(dataDir, "output");

  console.log(`\n  Ontology Parser`);
  console.log(`  Data directory: ${dataDir}`);
  console.log(`  Ontology directory: ${ontologyDir}`);

  // Step 1: Discover ontology files
  const ontologyFiles = discoverOntologyFiles(ontologyDir);

  // Step 2: Parse all files into unified stores
  console.log(`  Parsing ontology files...`);
  const stores: UnifiedStore[] = [];
  for (const file of ontologyFiles) {
    const store = parseOntologyFile(file);
    stores.push(store);
  }

  // Step 3: Merge all stores
  const store = mergeStores(stores);
  const totalTriples = store.getAllQuads().length;
  console.log(`\n  Total triples after merge: ${totalTriples}\n`);

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
