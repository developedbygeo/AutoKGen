import * as fs from "fs";
import * as path from "path";
import * as N3 from "n3";

const rdflib = require("rdflib");

type SupportedExtension = ".owl" | ".xml" | ".ttl" | ".rdf" | ".n3" | ".jsonld";
type DetectedFormat = "rdfxml" | "turtle" | "n3" | "jsonld";
type Term = N3.Term;
type NamedNode = N3.NamedNode;
type Quad = N3.Quad;

interface DiscoveredOntologyFile {
  absolutePath: string;
  relativePath: string;
  extension: SupportedExtension;
  detectedFormat: DetectedFormat;
}

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
  cardinalityConstraints: string[];
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

interface OntologyStructure {
  metadata: OntologyMetadata;
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
  externalVocabularies: ExternalVocabulary[];
}

interface MappingPattern {
  scenario: string;
  ontologyClass: string;
  requiredProperties: string[];
  optionalProperties: string[];
  relationships: string[];
}

interface MappingGuide {
  commonPatterns: MappingPattern[];
  allowedNamespaces: string[];
  constraints: string[];
}

interface QuickReference {
  ontology: {
    title: string;
    version: string;
    description: string;
  };
  coreClasses: Array<{
    uri: string;
    label: string;
    description: string;
    connectedPropertyCount: number;
  }>;
  propertyConnections: Array<{
    property: string;
    domain: string[];
    range: string[];
  }>;
  propertyChains: string[];
  allowedNamespaces: string[];
}

interface RestrictionDescriptor {
  targetProperty?: string;
  text: string;
  isRequired: boolean;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
const ONTOLOGY_DIR = path.resolve(DATA_DIR, "ontology");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const OUTPUT_STRUCTURE = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const OUTPUT_MAPPING_GUIDE = path.resolve(OUTPUT_DIR, "ontology-mapping-guide.json");
const OUTPUT_QUICK_REFERENCE = path.resolve(OUTPUT_DIR, "ontology-quick-reference.json");
const OUTPUT_SOURCE = path.resolve("src/generated/codex/cultural-moma/parse-ontology.ts");

const SUPPORTED_EXTENSIONS: SupportedExtension[] = [".owl", ".xml", ".ttl", ".rdf", ".n3", ".jsonld"];

const WELL_KNOWN_NAMESPACES: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  vann: "http://purl.org/vocab/vann/",
  schema: "https://schema.org/",
  schema_http: "http://schema.org/",
  foaf: "http://xmlns.com/foaf/0.1/",
};

const NS = WELL_KNOWN_NAMESPACES;

const { namedNode, literal, blankNode, defaultGraph, quad } = N3.DataFactory;

const isSupportedExtension = (value: string): value is SupportedExtension =>
  SUPPORTED_EXTENSIONS.includes(value as SupportedExtension);

const ensureDirectory = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const readUtf8 = (filePath: string): string => fs.readFileSync(filePath, "utf8");

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const sortStrings = (values: string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const firstNonEmpty = (values: Array<string | undefined>): string => values.find((value) => Boolean(value && value.trim()))?.trim() || "";

const namedNodeValue = (term: Term | null | undefined): string | undefined =>
  term && term.termType === "NamedNode" ? term.value : undefined;

const literalValue = (term: Term | null | undefined): string | undefined =>
  term && term.termType === "Literal" ? normalizeWhitespace(term.value) : undefined;

const isNamedNodeTerm = (term: Term | null | undefined): term is NamedNode =>
  Boolean(term && term.termType === "NamedNode");

const isBlankNodeTerm = (term: Term | null | undefined): term is N3.BlankNode =>
  Boolean(term && term.termType === "BlankNode");

const isLiteralTerm = (term: Term | null | undefined): term is N3.Literal =>
  Boolean(term && term.termType === "Literal");

const getNamespaceFromUri = (uri: string): string | undefined => {
  if (!/^https?:\/\//.test(uri)) return undefined;
  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0) return uri.slice(0, hashIndex + 1);

  const slashIndex = uri.lastIndexOf("/");
  if (slashIndex > uri.indexOf("//") + 1) return uri.slice(0, slashIndex + 1);

  return undefined;
};

const getLocalName = (uri: string): string => {
  const namespace = getNamespaceFromUri(uri);
  return namespace ? uri.slice(namespace.length) : uri;
};

const discoverOntologyFiles = (ontologyDir: string): DiscoveredOntologyFile[] => {
  if (!fs.existsSync(ontologyDir)) {
    throw new Error(`Ontology directory not found: ${ontologyDir}`);
  }

  const discovered = fs
    .readdirSync(ontologyDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const extension = path.extname(entry.name).toLowerCase();
      if (!isSupportedExtension(extension)) return undefined;
      const absolutePath = path.resolve(ontologyDir, entry.name);
      const content = readUtf8(absolutePath);
      return {
        absolutePath,
        relativePath: path.relative(process.cwd(), absolutePath),
        extension,
        detectedFormat: detectFormat(absolutePath, content),
      } satisfies DiscoveredOntologyFile;
    })
    .filter((value): value is DiscoveredOntologyFile => Boolean(value))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (discovered.length === 0) {
    throw new Error(
      `No ontology files found in ${ontologyDir}. Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }

  console.log(`Found ${discovered.length} ontology file(s):`);
  discovered.forEach((file) => {
    console.log(`- ${file.relativePath} [extension=${file.extension}, format=${file.detectedFormat}]`);
  });

  return discovered;
};

const detectFormat = (filePath: string, content: string): DetectedFormat => {
  const extension = path.extname(filePath).toLowerCase() as SupportedExtension;
  const trimmed = content.trimStart();

  if (extension === ".ttl") return "turtle";
  if (extension === ".n3") return "n3";
  if (extension === ".jsonld") return "jsonld";

  if (/^<\?xml/i.test(trimmed) || /^<!DOCTYPE/i.test(trimmed) || /^<rdf:RDF/i.test(trimmed)) {
    return "rdfxml";
  }

  if (/^[@]prefix/i.test(trimmed) || /^prefix\s+/i.test(trimmed)) return "turtle";

  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && /"@context"/.test(trimmed)) {
    return "jsonld";
  }

  if (extension === ".owl" || extension === ".xml" || extension === ".rdf") {
    return "rdfxml";
  }

  return "turtle";
};

const collectDeclaredNamespaces = (content: string): Record<string, string> => {
  const collected: Record<string, string> = {};
  const add = (prefix: string, namespace: string): void => {
    if (!prefix || !namespace || collected[prefix]) return;
    collected[prefix] = namespace;
  };

  Array.from(content.matchAll(/xmlns:([A-Za-z_][\w.-]*)="([^"]+)"/g)).forEach((match) => add(match[1], match[2]));
  Array.from(content.matchAll(/@prefix\s+([A-Za-z_][\w.-]*)?:\s*<([^>]+)>/gi)).forEach((match) =>
    add(match[1] || "base", match[2]),
  );
  Array.from(content.matchAll(/PREFIX\s+([A-Za-z_][\w.-]*)?:\s*<([^>]+)>/gi)).forEach((match) =>
    add(match[1] || "base", match[2]),
  );

  const preferredPrefix = content.match(/preferredNamespacePrefix[^>]*>([^<]+)</i)?.[1]?.trim();
  const preferredNamespace = content.match(/preferredNamespaceUri[^>]*>([^<]+)</i)?.[1]?.trim();
  if (preferredPrefix && preferredNamespace) add(preferredPrefix, preferredNamespace);

  return collected;
};

const expandXmlEntities = (xml: string, namespaces: Record<string, string>): string => {
  const entityMap: Record<string, string> = {};

  Array.from(xml.matchAll(/<!ENTITY\s+([^\s]+)\s+"([^"]+)"\s*>/g)).forEach((match) => {
    entityMap[match[1]] = match[2];
  });

  Object.entries(namespaces).forEach(([prefix, namespace]) => {
    if (!entityMap[prefix]) entityMap[prefix] = namespace;
  });

  let expanded = xml;
  Object.entries(entityMap).forEach(([prefix, namespace]) => {
    const pattern = new RegExp(`&${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`, "g");
    expanded = expanded.replace(pattern, namespace);
  });

  return expanded.replace(/<!DOCTYPE[^>]*\[[\s\S]*?\]>/g, "");
};

const rdflibTermToN3Term = (term: any): Term => {
  if (term.termType === "NamedNode") return namedNode(term.value);
  if (term.termType === "BlankNode") return blankNode(term.value.replace(/^_:/, ""));
  if (term.termType === "Literal") {
    if (term.language) return literal(term.value, term.language);
    if (term.datatype?.value) return literal(term.value, namedNode(term.datatype.value));
    return literal(term.value);
  }
  return namedNode(term.value);
};

const collectionToRdfListQuads = (collection: any): { head: N3.BlankNode; quads: Quad[] } => {
  const head = blankNode(`collection_${collection.value}`);
  const elements = Array.isArray(collection.elements) ? collection.elements : [];
  const quads: Quad[] = [];

  if (elements.length === 0) {
    quads.push(quad(head, namedNode(`${NS.rdf}rest`), namedNode(`${NS.rdf}nil`), defaultGraph()));
    return { head, quads };
  }

  elements.forEach((element: any, index: number) => {
    const current = index === 0 ? head : blankNode(`collection_${collection.value}_${index}`);
    const next =
      index === elements.length - 1
        ? namedNode(`${NS.rdf}nil`)
        : blankNode(`collection_${collection.value}_${index + 1}`);

    quads.push(quad(current, namedNode(`${NS.rdf}first`), asQuadObject(rdflibTermToN3Term(element)), defaultGraph()));
    quads.push(quad(current, namedNode(`${NS.rdf}rest`), next, defaultGraph()));
  });

  return { head, quads };
};

const asQuadSubject = (term: Term): N3.Quad_Subject => {
  if (term.termType === "NamedNode" || term.termType === "BlankNode" || term.termType === "Variable") return term;
  throw new Error(`Invalid RDF subject term: ${term.termType}`);
};

const asQuadPredicate = (term: Term): N3.Quad_Predicate => {
  if (term.termType === "NamedNode" || term.termType === "Variable") return term;
  throw new Error(`Invalid RDF predicate term: ${term.termType}`);
};

const asQuadObject = (term: Term): N3.Quad_Object => {
  if (term.termType === "NamedNode" || term.termType === "BlankNode" || term.termType === "Literal" || term.termType === "Variable") {
    return term;
  }
  throw new Error(`Invalid RDF object term: ${term.termType}`);
};

const parseWithRdflib = (content: string, baseUri: string, mediaType: string): Quad[] => {
  const store = rdflib.graph();
  rdflib.parse(content, store, baseUri, mediaType);

  return store.statements.flatMap((statement: any) => {
    if (statement.object?.termType === "Collection") {
      const list = collectionToRdfListQuads(statement.object);
      return [
        quad(
          asQuadSubject(rdflibTermToN3Term(statement.subject)),
          asQuadPredicate(rdflibTermToN3Term(statement.predicate)),
          list.head,
          defaultGraph(),
        ),
        ...list.quads,
      ];
    }

    return [
      quad(
        asQuadSubject(rdflibTermToN3Term(statement.subject)),
        asQuadPredicate(rdflibTermToN3Term(statement.predicate)),
        asQuadObject(rdflibTermToN3Term(statement.object)),
        defaultGraph(),
      ),
    ];
  });
};

const parseWithN3 = (content: string, format: "Turtle" | "N3"): Quad[] => {
  const parser = new N3.Parser({ format });
  return parser.parse(content);
};

const parseOntologyFile = (
  file: DiscoveredOntologyFile,
): { quads: Quad[]; namespaces: Record<string, string> } => {
  const rawContent = readUtf8(file.absolutePath);
  const declaredNamespaces = collectDeclaredNamespaces(rawContent);
  const baseUri = Object.values(declaredNamespaces)[0] || "http://example.org/ontology/";

  if (file.detectedFormat === "rdfxml") {
    const expanded = expandXmlEntities(rawContent, { ...WELL_KNOWN_NAMESPACES, ...declaredNamespaces });
    const quads = parseWithRdflib(expanded, baseUri, "application/rdf+xml");
    return { quads, namespaces: declaredNamespaces };
  }

  if (file.detectedFormat === "jsonld") {
    const quads = parseWithRdflib(rawContent, baseUri, "application/ld+json");
    if (quads.length === 0 && rawContent.trim().length > 0) {
      throw new Error(`JSON-LD parsing yielded zero triples for ${file.relativePath}`);
    }
    return { quads, namespaces: declaredNamespaces };
  }

  const quads = parseWithN3(rawContent, file.detectedFormat === "n3" ? "N3" : "Turtle");
  return { quads, namespaces: declaredNamespaces };
};

const buildStore = (files: DiscoveredOntologyFile[]): { store: N3.Store; namespaces: Record<string, string> } => {
  const store = new N3.Store();
  const namespaceRegistry: Record<string, string> = { ...WELL_KNOWN_NAMESPACES };

  files.forEach((file) => {
    const parsed = parseOntologyFile(file);
    store.addQuads(parsed.quads);
    Object.entries(parsed.namespaces).forEach(([prefix, namespace]) => {
      if (!namespaceRegistry[prefix]) namespaceRegistry[prefix] = namespace;
    });
    console.log(`Parsed ${parsed.quads.length} triples from ${file.relativePath}`);
  });

  const observedNamespaces = unique(
    store
      .getQuads(null, null, null, null)
      .flatMap((item) => [item.subject, item.predicate, item.object])
      .filter(isNamedNodeTerm)
      .map((term) => getNamespaceFromUri(term.value))
      .filter((value): value is string => Boolean(value)),
  );

  const registeredUris = new Set(Object.values(namespaceRegistry));
  observedNamespaces.forEach((namespace, index) => {
    if (registeredUris.has(namespace)) return;
    if (!/^https?:\/\/.+/.test(namespace) || namespace === "http://" || namespace === "https://") return;
    const candidate = normalizePrefix(getLocalName(namespace.replace(/[#/]$/, ""))) || `ns${index + 1}`;
    const prefix = namespaceRegistry[candidate] ? `ns${Object.keys(namespaceRegistry).length + index + 1}` : candidate;
    namespaceRegistry[prefix] = namespace;
    registeredUris.add(namespace);
  });

  return { store, namespaces: namespaceRegistry };
};

const normalizePrefix = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

const prefixed = (uri: string, namespaces: Record<string, string>): string => {
  const match = Object.entries(namespaces)
    .sort((left, right) => right[1].length - left[1].length)
    .find(([, namespace]) => uri.startsWith(namespace));

  if (!match) return uri;
  return `${match[0]}:${uri.slice(match[1].length)}`;
};

const toSubjectTerm = (subject: string | N3.Quad_Subject): N3.Quad_Subject =>
  typeof subject === "string" ? namedNode(subject) : subject;

const getObjects = (store: N3.Store, subject: string | N3.Quad_Subject, predicate: string): Term[] =>
  store.getQuads(toSubjectTerm(subject), namedNode(predicate), null, null).map((item) => item.object);

const getSubjects = (store: N3.Store, predicate: string, object: string): Term[] =>
  store.getQuads(null, namedNode(predicate), namedNode(object), null).map((item) => item.subject);

const getLiteralObjects = (store: N3.Store, subject: string | N3.Quad_Subject, predicate: string): string[] =>
  getObjects(store, subject, predicate).map(literalValue).filter((value): value is string => Boolean(value));

const getNamedObjects = (store: N3.Store, subject: string | N3.Quad_Subject, predicate: string): string[] =>
  getObjects(store, subject, predicate).map(namedNodeValue).filter((value): value is string => Boolean(value));

const getFirstLiteral = (store: N3.Store, subject: string | N3.Quad_Subject, predicates: string[]): string =>
  firstNonEmpty(predicates.flatMap((predicate) => getLiteralObjects(store, subject, predicate)));

const getRdfListValues = (store: N3.Store, head: Term): Term[] => {
  if (!head || head.equals(namedNode(`${NS.rdf}nil`))) return [];
  if (!isBlankNodeTerm(head)) return [head];

  const first = store.getQuads(head, namedNode(`${NS.rdf}first`), null, null)[0]?.object;
  const rest = store.getQuads(head, namedNode(`${NS.rdf}rest`), null, null)[0]?.object;

  if (!first) return [];
  return [first, ...(rest ? getRdfListValues(store, rest) : [])];
};

const describeClassExpression = (store: N3.Store, term: Term, namespaces: Record<string, string>): string[] => {
  if (isNamedNodeTerm(term)) return [term.value];
  if (!isBlankNodeTerm(term)) return [];

  const unionHead = store.getQuads(term, namedNode(`${NS.owl}unionOf`), null, null)[0]?.object;
  if (unionHead) {
    return getRdfListValues(store, unionHead).flatMap((item) => describeClassExpression(store, item, namespaces));
  }

  const intersectionHead = store.getQuads(term, namedNode(`${NS.owl}intersectionOf`), null, null)[0]?.object;
  if (intersectionHead) {
    const members = getRdfListValues(store, intersectionHead).flatMap((item) => describeClassExpression(store, item, namespaces));
    return members.length > 0 ? [`intersection(${members.map((value) => prefixed(value, namespaces)).join(", ")})`] : [];
  }

  const restriction = describeRestriction(store, term, namespaces);
  return restriction ? [restriction.text] : [];
};

const describeRestriction = (
  store: N3.Store,
  blank: N3.BlankNode,
  namespaces: Record<string, string>,
): RestrictionDescriptor | undefined => {
  const restrictionType = store.getQuads(blank, namedNode(`${NS.rdf}type`), namedNode(`${NS.owl}Restriction`), null)[0];
  if (!restrictionType) return undefined;

  const property = store.getQuads(blank, namedNode(`${NS.owl}onProperty`), null, null)[0]?.object;
  const propertyUri = namedNodeValue(property);
  const propertyText = propertyUri ? prefixed(propertyUri, namespaces) : "unknownProperty";

  const cardinalityValue = getLiteralObjects(store, blank, `${NS.owl}cardinality`)[0];
  const minCardinalityValue = getLiteralObjects(store, blank, `${NS.owl}minCardinality`)[0];
  const maxCardinalityValue = getLiteralObjects(store, blank, `${NS.owl}maxCardinality`)[0];
  const qualifiedMin = getLiteralObjects(store, blank, `${NS.owl}minQualifiedCardinality`)[0];
  const qualifiedMax = getLiteralObjects(store, blank, `${NS.owl}maxQualifiedCardinality`)[0];
  const qualifiedExactly = getLiteralObjects(store, blank, `${NS.owl}qualifiedCardinality`)[0];

  const someValuesFrom = store.getQuads(blank, namedNode(`${NS.owl}someValuesFrom`), null, null)[0]?.object;
  const allValuesFrom = store.getQuads(blank, namedNode(`${NS.owl}allValuesFrom`), null, null)[0]?.object;
  const hasValue = store.getQuads(blank, namedNode(`${NS.owl}hasValue`), null, null)[0]?.object;

  const targetExpression = someValuesFrom || allValuesFrom || hasValue;
  const renderedTarget = targetExpression
    ? describeClassExpression(store, targetExpression, namespaces)
        .map((item) => prefixed(item, namespaces))
        .join(" | ")
    : "";

  if (cardinalityValue) {
    return { targetProperty: propertyUri, text: `${propertyText} exactly ${cardinalityValue}`, isRequired: true };
  }

  if (qualifiedExactly) {
    return {
      targetProperty: propertyUri,
      text: `${propertyText} exactly ${qualifiedExactly}${renderedTarget ? ` ${renderedTarget}` : ""}`,
      isRequired: true,
    };
  }

  if (minCardinalityValue || qualifiedMin) {
    const value = minCardinalityValue || qualifiedMin;
    return {
      targetProperty: propertyUri,
      text: `${propertyText} min ${value}${renderedTarget ? ` ${renderedTarget}` : ""}`,
      isRequired: Number(value) > 0,
    };
  }

  if (maxCardinalityValue || qualifiedMax) {
    const value = maxCardinalityValue || qualifiedMax;
    return {
      targetProperty: propertyUri,
      text: `${propertyText} max ${value}${renderedTarget ? ` ${renderedTarget}` : ""}`,
      isRequired: false,
    };
  }

  if (someValuesFrom && renderedTarget) {
    return {
      targetProperty: propertyUri,
      text: `${propertyText} some ${renderedTarget}`,
      isRequired: true,
    };
  }

  if (allValuesFrom && renderedTarget) {
    return {
      targetProperty: propertyUri,
      text: `${propertyText} only ${renderedTarget}`,
      isRequired: false,
    };
  }

  if (hasValue) {
    return {
      targetProperty: propertyUri,
      text: `${propertyText} value ${renderTerm(hasValue, namespaces)}`,
      isRequired: true,
    };
  }

  return propertyUri ? { targetProperty: propertyUri, text: `${propertyText} restricted`, isRequired: false } : undefined;
};

const renderTerm = (term: Term, namespaces: Record<string, string>): string => {
  if (isNamedNodeTerm(term)) return prefixed(term.value, namespaces);
  if (isLiteralTerm(term)) return term.value;
  return term.value;
};

const collectLabels = (store: N3.Store, subject: string): string =>
  firstNonEmpty([
    getFirstLiteral(store, subject, [`${NS.rdfs}label`, `${NS.skos}prefLabel`, `${NS.dc}title`, `${NS.dcterms}title`]),
    getLocalName(subject),
  ]);

const collectDefinition = (store: N3.Store, subject: string): string =>
  getFirstLiteral(store, subject, [
    `${NS.skos}definition`,
    `${NS.rdfs}comment`,
    `${NS.dc}description`,
    `${NS.dcterms}description`,
    `${NS.schema}description`,
    `${NS.schema_http}description`,
  ]);

const collectComment = (store: N3.Store, subject: string): string =>
  unique(
    [
      ...getLiteralObjects(store, subject, `${NS.rdfs}comment`),
      ...getLiteralObjects(store, subject, `${NS.skos}scopeNote`),
      ...getLiteralObjects(store, subject, `${NS.skos}note`),
    ].map(normalizeWhitespace),
  ).join(" | ");

const getClassUris = (store: N3.Store): string[] =>
  sortStrings(
    unique([
      ...getSubjects(store, `${NS.rdf}type`, `${NS.owl}Class`),
      ...getSubjects(store, `${NS.rdf}type`, `${NS.rdfs}Class`),
    ])
      .map(namedNodeValue)
      .filter((value): value is string => Boolean(value)),
  );

const getPropertyUris = (store: N3.Store, classUri: string): string[] =>
  sortStrings(
    unique(
      getSubjects(store, `${NS.rdf}type`, classUri)
        .map(namedNodeValue)
        .filter((value): value is string => Boolean(value)),
    ),
  );

const inferDataPropertyUris = (store: N3.Store): string[] => {
  const explicitDataProperties = getPropertyUris(store, `${NS.owl}DatatypeProperty`);
  const rdfProperties = getPropertyUris(store, `${NS.rdf}Property`);

  const inferred = rdfProperties.filter((propertyUri) => {
    const ranges = getNamedObjects(store, propertyUri, `${NS.rdfs}range`);
    return ranges.some((rangeUri) => rangeUri.startsWith(NS.xsd) || rangeUri === `${NS.rdfs}Literal`);
  });

  return sortStrings(unique([...explicitDataProperties, ...inferred]));
};

const inferObjectPropertyUris = (store: N3.Store, dataPropertyUris: string[]): string[] => {
  const explicitObjectProperties = getPropertyUris(store, `${NS.owl}ObjectProperty`);
  const rdfProperties = getPropertyUris(store, `${NS.rdf}Property`);
  const dataPropertySet = new Set(dataPropertyUris);

  const inferred = rdfProperties.filter((propertyUri) => {
    if (dataPropertySet.has(propertyUri)) return false;
    const ranges = getNamedObjects(store, propertyUri, `${NS.rdfs}range`);
    return ranges.some((rangeUri) => !rangeUri.startsWith(NS.xsd) && rangeUri !== `${NS.rdfs}Literal`);
  });

  return sortStrings(unique([...explicitObjectProperties, ...inferred]));
};

const extractMetadata = (
  store: N3.Store,
  sourceFiles: string[],
  namespaces: Record<string, string>,
  localNamespaces: string[],
): OntologyMetadata => {
  const ontologySubjects = sortStrings(
    unique([
      ...getSubjects(store, `${NS.rdf}type`, `${NS.owl}Ontology`),
      ...getSubjects(store, `${NS.rdf}type`, "http://purl.org/vocommons/voaf#Vocabulary"),
    ])
      .map(namedNodeValue)
      .filter((value): value is string => value !== undefined),
  );

  const ontologySubject =
    ontologySubjects[0] ||
    getClassUris(store).find((classUri) => localNamespaces.includes(getNamespaceFromUri(classUri) || "")) ||
    "";

  const title = ontologySubject
    ? firstNonEmpty([
        getFirstLiteral(store, ontologySubject, [`${NS.dc}title`, `${NS.dcterms}title`, `${NS.rdfs}label`]),
        collectLabels(store, ontologySubject),
      ])
    : "Unnamed ontology";

  const version = ontologySubject
    ? getFirstLiteral(store, ontologySubject, [`${NS.owl}versionInfo`, `${NS.dcterms}hasVersion`])
    : "";

  const description = ontologySubject
    ? getFirstLiteral(store, ontologySubject, [
        `${NS.rdfs}comment`,
        `${NS.dc}description`,
        `${NS.dcterms}description`,
        `${NS.skos}definition`,
      ])
    : "";

  return {
    title,
    version,
    description,
    sourceFiles,
    namespaces: Object.fromEntries(
      Object.entries(namespaces).sort((left, right) => left[0].localeCompare(right[0])),
    ),
  };
};

const extractClasses = (store: N3.Store, namespaces: Record<string, string>): OntologyClass[] =>
  getClassUris(store).map((classUri) => {
    const equivalentTerms = getObjects(store, classUri, `${NS.owl}equivalentClass`);
    return {
      uri: classUri,
      label: collectLabels(store, classUri),
      definition: collectDefinition(store, classUri),
      comment: collectComment(store, classUri),
      superClasses: sortStrings(unique(getNamedObjects(store, classUri, `${NS.rdfs}subClassOf`))),
      equivalentClasses: sortStrings(unique(equivalentTerms.flatMap((term) => describeClassExpression(store, term, namespaces)))),
      examples: sortStrings(unique(getLiteralObjects(store, classUri, `${NS.skos}example`))),
    };
  });

const collectRestrictionsForResource = (
  store: N3.Store,
  subject: string,
  namespaces: Record<string, string>,
): RestrictionDescriptor[] =>
  unique(
    [
      ...getObjects(store, subject, `${NS.rdfs}subClassOf`),
      ...getObjects(store, subject, `${NS.owl}equivalentClass`),
    ]
      .filter(isBlankNodeTerm)
      .map((term) => describeRestriction(store, term, namespaces))
      .filter((value): value is RestrictionDescriptor => Boolean(value))
      .map((restriction) => JSON.stringify(restriction)),
  ).map((entry) => JSON.parse(entry) as RestrictionDescriptor);

const extractObjectProperties = (store: N3.Store, namespaces: Record<string, string>): ObjectProperty[] => {
  const dataPropertyUris = inferDataPropertyUris(store);
  return inferObjectPropertyUris(store, dataPropertyUris).map((propertyUri) => ({
    uri: propertyUri,
    label: collectLabels(store, propertyUri),
    definition: collectDefinition(store, propertyUri),
    domain: sortStrings(unique(getNamedObjects(store, propertyUri, `${NS.rdfs}domain`))),
    range: sortStrings(unique(getNamedObjects(store, propertyUri, `${NS.rdfs}range`))),
    superProperties: sortStrings(unique(getNamedObjects(store, propertyUri, `${NS.rdfs}subPropertyOf`))),
    inverseOf: getNamedObjects(store, propertyUri, `${NS.owl}inverseOf`)[0] || "",
    cardinalityConstraints: sortStrings(
      unique(
        store
          .getQuads(null, namedNode(`${NS.owl}onProperty`), namedNode(propertyUri), null)
          .map((item) => item.subject)
          .filter(isBlankNodeTerm)
          .map((blank) => describeRestriction(store, blank, namespaces)?.text)
          .filter((value): value is string => Boolean(value)),
      ),
    ),
  }));
};

const extractDataProperties = (store: N3.Store): DataProperty[] =>
  inferDataPropertyUris(store).map((propertyUri) => {
    const ranges = sortStrings(unique(getNamedObjects(store, propertyUri, `${NS.rdfs}range`)));
    return {
      uri: propertyUri,
      label: collectLabels(store, propertyUri),
      definition: collectDefinition(store, propertyUri),
      domain: sortStrings(unique(getNamedObjects(store, propertyUri, `${NS.rdfs}domain`))),
      range: ranges.find((range) => range.startsWith(NS.xsd)) || ranges[0] || `${NS.rdfs}Literal`,
    };
  });

const determineLocalNamespaces = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  store: N3.Store,
): string[] => {
  const preferredNamespace = getSubjects(store, `${NS.rdf}type`, `${NS.owl}Ontology`)
    .map(namedNodeValue)
    .filter((value): value is string => Boolean(value))
    .flatMap((ontologyUri) => getLiteralObjects(store, ontologyUri, `${NS.vann}preferredNamespaceUri`));

  const definedEntityNamespaces = [
    ...classes.map((item) => getNamespaceFromUri(item.uri)),
    ...objectProperties.map((item) => getNamespaceFromUri(item.uri)),
    ...dataProperties.map((item) => getNamespaceFromUri(item.uri)),
  ].filter((value): value is string => Boolean(value));

  const namespaceCounts = definedEntityNamespaces.reduce<Record<string, number>>((accumulator, namespace) => {
    accumulator[namespace] = (accumulator[namespace] || 0) + 1;
    return accumulator;
  }, {});

  const dominantNamespaces = Object.entries(namespaceCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([namespace]) => namespace);

  if (preferredNamespace.length > 0) {
    return sortStrings(unique(preferredNamespace));
  }

  return sortStrings(unique(dominantNamespaces.slice(0, 1)));
};

const extractExternalVocabularies = (
  store: N3.Store,
  namespaces: Record<string, string>,
  localNamespaces: string[],
): ExternalVocabulary[] => {
  const localNamespaceSet = new Set(localNamespaces);
  const classUris = new Set(getClassUris(store));
  const objectPropertyUris = new Set(inferObjectPropertyUris(store, inferDataPropertyUris(store)));
  const dataPropertyUris = new Set(inferDataPropertyUris(store));
  const propertyUris = new Set([...objectPropertyUris, ...dataPropertyUris]);

  const namespaceUsage = store
    .getQuads(null, null, null, null)
    .flatMap((item) => [item.subject, item.predicate, item.object])
    .filter(isNamedNodeTerm)
    .reduce<Record<string, { classes: Set<string>; properties: Set<string> }>>((accumulator, term) => {
      const namespace = getNamespaceFromUri(term.value);
      if (!namespace || localNamespaceSet.has(namespace)) return accumulator;
      if (!accumulator[namespace]) {
        accumulator[namespace] = { classes: new Set<string>(), properties: new Set<string>() };
      }
      if (classUris.has(term.value)) accumulator[namespace].classes.add(term.value);
      if (propertyUris.has(term.value)) accumulator[namespace].properties.add(term.value);
      return accumulator;
    }, {});

  const importedNamespaces = unique(
    getSubjects(store, `${NS.rdf}type`, `${NS.owl}Ontology`)
      .map(namedNodeValue)
      .filter((value): value is string => Boolean(value))
      .flatMap((ontologyUri) =>
        getNamedObjects(store, ontologyUri, `${NS.owl}imports`).map((uri) => getNamespaceFromUri(uri) || uri),
      ),
  );

  importedNamespaces.forEach((namespace) => {
    if (!namespaceUsage[namespace]) {
      namespaceUsage[namespace] = { classes: new Set<string>(), properties: new Set<string>() };
    }
  });

  return sortStrings(Object.keys(namespaceUsage)).map((namespace) => {
    const prefix =
      Object.entries(namespaces).find(([, namespaceUri]) => namespaceUri === namespace)?.[0] ||
      normalizePrefix(getLocalName(namespace.replace(/[#/]$/, ""))) ||
      "ns";

    return {
      prefix,
      namespace,
      classes: sortStrings([...namespaceUsage[namespace].classes].map((uri) => prefixed(uri, namespaces))),
      properties: sortStrings([...namespaceUsage[namespace].properties].map((uri) => prefixed(uri, namespaces))),
    };
  });
};

const buildPropertyConnections = (
  objectProperties: ObjectProperty[],
): Array<{ property: string; domain: string[]; range: string[] }> =>
  objectProperties
    .filter((property) => property.domain.length > 0 || property.range.length > 0)
    .map((property) => ({
      property: property.uri,
      domain: property.domain,
      range: property.range,
    }));

const buildConnectivityScores = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
): Record<string, number> => {
  const scores: Record<string, number> = Object.fromEntries(classes.map((item) => [item.uri, 0]));

  [...objectProperties, ...dataProperties].forEach((property) => {
    property.domain.forEach((domainUri) => {
      scores[domainUri] = (scores[domainUri] || 0) + 1;
    });
  });

  objectProperties.forEach((property) => {
    property.range.forEach((rangeUri) => {
      scores[rangeUri] = (scores[rangeUri] || 0) + 1;
    });
  });

  classes.forEach((item) => {
    item.superClasses.forEach((superClassUri) => {
      scores[item.uri] = (scores[item.uri] || 0) + 1;
      scores[superClassUri] = (scores[superClassUri] || 0) + 1;
    });
  });

  return scores;
};

const determineCoreClasses = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  localNamespaces: string[],
): OntologyClass[] => {
  const connectivityScores = buildConnectivityScores(classes, objectProperties, dataProperties);
  const localNamespaceSet = new Set(localNamespaces);
  const sorted = [...classes].sort((left, right) => {
    const leftLocal = localNamespaceSet.has(getNamespaceFromUri(left.uri) || "");
    const rightLocal = localNamespaceSet.has(getNamespaceFromUri(right.uri) || "");
    if (leftLocal !== rightLocal) return rightLocal ? 1 : -1;
    const scoreDiff = (connectivityScores[right.uri] || 0) - (connectivityScores[left.uri] || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return left.label.localeCompare(right.label);
  });

  const threshold = Math.max(1, Math.ceil((objectProperties.length + dataProperties.length) / Math.max(classes.length, 1)));
  return sorted.filter((item, index) => (connectivityScores[item.uri] || 0) >= threshold || index < Math.min(8, sorted.length));
};

const buildPropertyChains = (objectProperties: ObjectProperty[]): string[] => {
  const chains = objectProperties.flatMap((left) =>
    objectProperties.flatMap((right) => {
      const overlap = left.range.filter((rangeUri) => right.domain.includes(rangeUri));
      if (overlap.length === 0 || left.uri === right.uri) return [];
      return overlap.map(
        (classUri) => `${left.domain[0] || "*"} --${left.uri}--> ${classUri} --${right.uri}--> ${right.range[0] || "*"}`,
      );
    }),
  );

  return sortStrings(unique(chains)).slice(0, 20);
};

const buildConstraints = (
  store: N3.Store,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  namespaces: Record<string, string>,
): string[] => {
  const classConstraints = classes.flatMap((item) =>
    collectRestrictionsForResource(store, item.uri, namespaces)
      .filter((restriction) => Boolean(restriction.targetProperty))
      .map((restriction) => `${prefixed(item.uri, namespaces)}: ${restriction.text}`),
  );

  const propertyConstraints = objectProperties.flatMap((property) =>
    property.cardinalityConstraints.map((constraint) => `${prefixed(property.uri, namespaces)}: ${constraint}`),
  );

  return sortStrings(unique([...classConstraints, ...propertyConstraints]));
};

const buildMappingPatterns = (
  store: N3.Store,
  coreClasses: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  namespaces: Record<string, string>,
): MappingPattern[] =>
  coreClasses.map((ontologyClass) => {
    const relevantObjectProperties = objectProperties.filter((property) => property.domain.includes(ontologyClass.uri));
    const relevantDataProperties = dataProperties.filter((property) => property.domain.includes(ontologyClass.uri));
    const restrictions = collectRestrictionsForResource(store, ontologyClass.uri, namespaces);
    const requiredFromRestrictions = restrictions
      .filter((restriction) => restriction.isRequired && restriction.targetProperty)
      .map((restriction) => restriction.targetProperty as string);

    const allRelevantProperties = [...relevantObjectProperties, ...relevantDataProperties].map((property) => property.uri);

    const requiredProperties = sortStrings(unique(requiredFromRestrictions));
    const optionalProperties = sortStrings(unique(allRelevantProperties.filter((uri) => !requiredProperties.includes(uri))));
    const relationships = sortStrings(
      unique(
        relevantObjectProperties.map(
          (property) =>
            `${prefixed(property.uri, namespaces)} -> ${property.range.map((uri) => prefixed(uri, namespaces)).join(", ") || "unspecified"}`,
        ),
      ),
    );

    return {
      scenario: `Map records that represent ${ontologyClass.label}. Use the class when the record's identity and relationships align with this concept.`,
      ontologyClass: ontologyClass.uri,
      requiredProperties,
      optionalProperties,
      relationships,
    };
  });

const buildQuickReference = (
  metadata: OntologyMetadata,
  coreClasses: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
): QuickReference => {
  const connectivityScores = buildConnectivityScores(coreClasses, objectProperties, dataProperties);

  return {
    ontology: {
      title: metadata.title,
      version: metadata.version,
      description: metadata.description,
    },
    coreClasses: coreClasses.slice(0, 10).map((item) => ({
      uri: item.uri,
      label: item.label,
      description: item.definition || item.comment,
      connectedPropertyCount: connectivityScores[item.uri] || 0,
    })),
    propertyConnections: buildPropertyConnections(objectProperties)
      .slice(0, 20)
      .map((item) => ({ property: item.property, domain: item.domain, range: item.range })),
    propertyChains: buildPropertyChains(objectProperties),
    allowedNamespaces: Object.values(metadata.namespaces),
  };
};

const writeJson = (outputPath: string, value: unknown): void => {
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const printSummary = (
  metadata: OntologyMetadata,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  coreClasses: OntologyClass[],
  namespaces: Record<string, string>,
): void => {
  console.log("");
  console.log(`Ontology: ${metadata.title || "Unnamed ontology"}${metadata.version ? ` (version ${metadata.version})` : ""}`);
  console.log(`Source files: ${metadata.sourceFiles.join(", ")}`);
  console.log(`Classes: ${classes.length}`);
  console.log(`Object properties: ${objectProperties.length}`);
  console.log(`Data properties: ${dataProperties.length}`);
  console.log("Core classes:");
  coreClasses.slice(0, 10).forEach((item) => {
    console.log(`- ${prefixed(item.uri, namespaces)}: ${item.definition || item.comment || item.label}`);
  });
  console.log("Usable namespaces:");
  Object.entries(namespaces)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .forEach(([prefix, namespace]) => {
      console.log(`- ${prefix}: ${namespace}`);
    });
};

const main = (): void => {
  ensureDirectory(OUTPUT_DIR);

  const discoveredFiles = discoverOntologyFiles(ONTOLOGY_DIR);
  const { store, namespaces } = buildStore(discoveredFiles);

  const classes = extractClasses(store, namespaces);
  const dataProperties = extractDataProperties(store);
  const objectProperties = extractObjectProperties(store, namespaces);
  const localNamespaces = determineLocalNamespaces(classes, objectProperties, dataProperties, store);
  const metadata = extractMetadata(
    store,
    discoveredFiles.map((file) => path.basename(file.absolutePath)),
    namespaces,
    localNamespaces,
  );
  const externalVocabularies = extractExternalVocabularies(store, namespaces, localNamespaces);
  const ontologyStructure: OntologyStructure = {
    metadata,
    classes,
    objectProperties,
    dataProperties,
    externalVocabularies,
  };

  const coreClasses = determineCoreClasses(classes, objectProperties, dataProperties, localNamespaces);
  const mappingGuide: MappingGuide = {
    commonPatterns: buildMappingPatterns(store, coreClasses, objectProperties, dataProperties, namespaces),
    allowedNamespaces: sortStrings(
      unique(
        Object.values(namespaces).filter(
          (namespace) => /^https?:\/\/.+/.test(namespace) && namespace !== "http://" && namespace !== "https://",
        ),
      ),
    ),
    constraints: buildConstraints(store, classes, objectProperties, namespaces),
  };

  const quickReference = buildQuickReference(metadata, coreClasses, objectProperties, dataProperties);

  writeJson(OUTPUT_STRUCTURE, ontologyStructure);
  writeJson(OUTPUT_MAPPING_GUIDE, mappingGuide);
  writeJson(OUTPUT_QUICK_REFERENCE, quickReference);

  printSummary(metadata, classes, objectProperties, dataProperties, coreClasses, namespaces);
  console.log("");
  console.log(`Saved parser source to ${OUTPUT_SOURCE}`);
  console.log(`Wrote ${OUTPUT_STRUCTURE}`);
  console.log(`Wrote ${OUTPUT_MAPPING_GUIDE}`);
  console.log(`Wrote ${OUTPUT_QUICK_REFERENCE}`);
};

main();
