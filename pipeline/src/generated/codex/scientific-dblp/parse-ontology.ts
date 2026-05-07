import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import * as N3 from "n3";

type RdfFormat = "rdfxml" | "turtle" | "n3" | "jsonld";

type QuadView = {
  subject: string;
  predicate: string;
  object: string;
  objectType: string;
};

type RestrictionSummary = {
  onProperty: string;
  cardinality?: string;
  minCardinality?: string;
  maxCardinality?: string;
  someValuesFrom?: string[];
  allValuesFrom?: string[];
  hasValue?: string[];
};

type OntologyClass = {
  uri: string;
  label: string;
  definition: string;
  comment: string;
  superClasses: string[];
  equivalentClasses: string[];
  examples: string[];
};

type ObjectProperty = {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string[];
  superProperties: string[];
  inverseOf: string;
};

type DataProperty = {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string;
};

type ExternalVocabulary = {
  prefix: string;
  namespace: string;
  classes: string[];
  properties: string[];
};

type OntologyMetadata = {
  title: string;
  version: string;
  description: string;
  sourceFiles: string[];
  namespaces: Record<string, string>;
};

type OntologyStructure = {
  metadata: OntologyMetadata;
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
  externalVocabularies: ExternalVocabulary[];
};

type MappingPattern = {
  scenario: string;
  ontologyClass: string;
  requiredProperties: string[];
  optionalProperties: string[];
  relationships: string[];
};

type MappingGuide = {
  commonPatterns: MappingPattern[];
  allowedNamespaces: string[];
  constraints: string[];
};

type QuickReference = {
  ontology: {
    title: string;
    version: string;
    description: string;
  };
  coreClasses: Array<{
    class: string;
    label: string;
    description: string;
    connectedBy: string[];
  }>;
  keyRelationships: Array<{
    property: string;
    domain: string[];
    range: string[];
  }>;
  keyDataProperties: Array<{
    property: string;
    domain: string[];
    range: string;
  }>;
  namespaces: string[];
};

type FileDiscovery = {
  filePath: string;
  extension: string;
  format: RdfFormat;
};

type ParsedFile = FileDiscovery & {
  quadCount: number;
};

type ParsedStoreFile = ParsedFile & {
  store: UnifiedStore;
};

type UnifiedStore = {
  getObjects: (subjectUri: string, predicateUri: string) => string[];
  getFirstLiteral: (subjectUri: string, predicateUri: string) => string;
  getSubjects: (predicateUri: string, objectUri: string) => string[];
  getQuads: (subjectUri?: string, predicateUri?: string, objectUri?: string) => QuadView[];
  getAllQuads: () => QuadView[];
};

type PropertyConnection = {
  property: string;
  fromClass: string;
  toClass: string;
};

type ClassConnectivity = {
  classUri: string;
  label: string;
  connectionCount: number;
  outboundObjectProperties: string[];
  inboundObjectProperties: string[];
  dataProperties: string[];
  role: "core" | "important" | "auxiliary";
};

const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  vann: "http://purl.org/vocab/vann/",
  schemaHttp: "http://schema.org/",
  schemaHttps: "https://schema.org/",
  sh: "http://www.w3.org/ns/shacl#",
};

const SUPPORTED_EXTENSIONS = [".owl", ".xml", ".ttl", ".rdf", ".n3", ".jsonld"];

const WELL_KNOWN_NAMESPACES: Record<string, string> = {
  rdf: NS.rdf,
  rdfs: NS.rdfs,
  owl: NS.owl,
  xsd: NS.xsd,
  skos: NS.skos,
  dc: NS.dc,
  dcterms: NS.dcterms,
  vann: NS.vann,
  schema: NS.schemaHttps,
  schemaHttp: NS.schemaHttp,
  sh: NS.sh,
};

const discoveredNamespaces: Record<string, string> = { ...WELL_KNOWN_NAMESPACES };

const ontologyNamespaceCandidates = new Set<string>();

const identity = <T>(value: T): T => value;

const uniq = <T>(values: T[]): T[] => Array.from(new Set(values));

const sortStrings = (values: string[]): string[] => [...values].sort((a, b) => a.localeCompare(b));

const isNamedUri = (value: string): boolean =>
  value.startsWith("http://") || value.startsWith("https://");

const isBlankNode = (value: string): boolean => value.startsWith("_:");

const fileExists = (filePath: string): boolean => fs.existsSync(filePath);

const readUtf8 = (filePath: string): string => fs.readFileSync(filePath, "utf-8");

const basename = (filePath: string): string => path.basename(filePath);

const localNameFromUri = (uri: string): string => uri.split(/[#/]/).pop() || uri;

const namespaceFromUri = (uri: string): string => {
  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0) return uri.slice(0, hashIndex + 1);

  const slashIndex = uri.lastIndexOf("/");
  if (slashIndex >= 0) return uri.slice(0, slashIndex + 1);

  return uri;
};

const sanitizePrefix = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "").replace(/^[^a-zA-Z_]+/, "").toLowerCase();

const ensureNamespace = (prefix: string, namespaceUri: string): void => {
  if (!namespaceUri || !isNamedUri(namespaceUri)) return;

  const cleanPrefix = sanitizePrefix(prefix);
  if (!cleanPrefix) return;

  if (!discoveredNamespaces[cleanPrefix]) {
    discoveredNamespaces[cleanPrefix] = namespaceUri;
  }
};

const inferPrefixFromNamespace = (namespaceUri: string): string => {
  const known = Object.entries(discoveredNamespaces).find(([, value]) => value === namespaceUri);
  if (known) return known[0];

  const trimmed = namespaceUri.replace(/[#/]$/, "");
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  const candidate = sanitizePrefix(parts[parts.length - 1] || "ns");

  if (!candidate || discoveredNamespaces[candidate]) {
    let counter = 1;
    while (discoveredNamespaces[`ns${counter}`]) counter += 1;
    return `ns${counter}`;
  }

  return candidate;
};

const prefixUri = (uri: string): string => {
  const namespaceMatch = Object.entries(discoveredNamespaces)
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, namespaceUri]) => uri.startsWith(namespaceUri));

  if (!namespaceMatch) return uri;

  const [prefix, namespaceUri] = namespaceMatch;
  return `${prefix}:${uri.slice(namespaceUri.length)}`;
};

const collectChildFilePaths = (dirPath: string): string[] => {
  const walk = (currentDir: string): string[] => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const entryPath = path.join(currentDir, entry.name);
      return entry.isDirectory() ? walk(entryPath) : [entryPath];
    });
  };

  return walk(dirPath);
};

const sniffFormatFromContent = (content: string): RdfFormat | null => {
  const trimmed = content.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    if (trimmed.includes("\"@context\"") || trimmed.includes("\"@graph\"") || trimmed.includes("\"@id\"")) {
      return "jsonld";
    }
  }

  if (/<rdf:RDF\b|<owl:Ontology\b|<[^>]+xmlns(:\w+)?=/.test(trimmed)) {
    return "rdfxml";
  }

  if (/^@prefix\s+/mi.test(trimmed) || /^prefix\s+/mi.test(trimmed)) {
    return "turtle";
  }

  if (/@base\s+/i.test(trimmed)) {
    return "n3";
  }

  return null;
};

const detectFileFormat = (filePath: string, content: string): RdfFormat => {
  const extension = path.extname(filePath).toLowerCase();
  const fromContent = sniffFormatFromContent(content);

  if (fromContent) return fromContent;

  if (extension === ".ttl") return "turtle";
  if (extension === ".n3") return "n3";
  if (extension === ".jsonld") return "jsonld";
  return "rdfxml";
};

const extractNamespacesFromContent = (content: string): void => {
  const xmlNsRegex = /xmlns:([a-zA-Z_][\w.-]*)="([^"]+)"/g;
  const prefixRegex = /(?:@prefix|PREFIX)\s+([a-zA-Z_][\w.-]*)?:\s*<([^>]+)>/gim;

  for (const match of Array.from(content.matchAll(xmlNsRegex))) {
    ensureNamespace(match[1], match[2]);
  }

  for (const match of Array.from(content.matchAll(prefixRegex))) {
    ensureNamespace(match[1] || "base", match[2]);
  }

  const vannPrefix = content.match(/preferredNamespacePrefix[^>"]*["'>]\s*([^<"\s]+)\s*</i);
  const vannNamespace = content.match(/preferredNamespaceUri[^>"]*["'>]\s*(https?:\/\/[^<"\s]+)\s*</i);
  if (vannPrefix && vannNamespace) ensureNamespace(vannPrefix[1], vannNamespace[1]);
};

const expandEntityReferences = (xml: string): string => {
  const entityMap = Object.entries(discoveredNamespaces).reduce<Record<string, string>>(
    (acc, [prefix, namespaceUri]) => ({ ...acc, [prefix]: namespaceUri }),
    {}
  );

  for (const match of Array.from(xml.matchAll(/xmlns:([a-zA-Z_][\w.-]*)="([^"]+)"/g))) {
    entityMap[match[1]] = match[2];
  }

  return Object.entries(entityMap).reduce(
    (expandedXml, [prefix, namespaceUri]) =>
      expandedXml.replace(new RegExp(`&${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`, "g"), namespaceUri),
    xml
  );
};

const wrapN3Store = (store: N3.Store): UnifiedStore => {
  const { namedNode } = N3.DataFactory;

  const toQuadView = (quad: N3.Quad): QuadView => ({
    subject: quad.subject.value,
    predicate: quad.predicate.value,
    object: quad.object.value,
    objectType: quad.object.termType,
  });

  return {
    getObjects: (subjectUri, predicateUri) =>
      store
        .getQuads(namedNode(subjectUri), namedNode(predicateUri), null, null)
        .map((quad) => quad.object.value),
    getFirstLiteral: (subjectUri, predicateUri) => {
      const quads = store.getQuads(namedNode(subjectUri), namedNode(predicateUri), null, null);
      const literalQuad = quads.find((quad) => quad.object.termType === "Literal");
      return literalQuad?.object.value || quads[0]?.object.value || "";
    },
    getSubjects: (predicateUri, objectUri) =>
      store
        .getQuads(null, namedNode(predicateUri), namedNode(objectUri), null)
        .filter((quad) => quad.subject.termType === "NamedNode")
        .map((quad) => quad.subject.value),
    getQuads: (subjectUri, predicateUri, objectUri) =>
      store
        .getQuads(
          subjectUri ? namedNode(subjectUri) : null,
          predicateUri ? namedNode(predicateUri) : null,
          objectUri ? namedNode(objectUri) : null,
          null
        )
        .map(toQuadView),
    getAllQuads: () => store.getQuads(null, null, null, null).map(toQuadView),
  };
};

const wrapRdflibStore = (store: any, rdflib: any): UnifiedStore => ({
  getObjects: (subjectUri, predicateUri) =>
    store.each(rdflib.sym(subjectUri), rdflib.sym(predicateUri), undefined).map((term: any) => term.value),
  getFirstLiteral: (subjectUri, predicateUri) => {
    const terms = store.each(rdflib.sym(subjectUri), rdflib.sym(predicateUri), undefined);
    const literal = terms.find((term: any) => term.termType === "Literal");
    return literal?.value || terms[0]?.value || "";
  },
  getSubjects: (predicateUri, objectUri) =>
    store
      .each(undefined, rdflib.sym(predicateUri), rdflib.sym(objectUri))
      .filter((term: any) => term.termType === "NamedNode")
      .map((term: any) => term.value),
  getQuads: (subjectUri, predicateUri, objectUri) =>
    store.statements
      .filter((statement: any) => !subjectUri || statement.subject.value === subjectUri)
      .filter((statement: any) => !predicateUri || statement.predicate.value === predicateUri)
      .filter((statement: any) => !objectUri || statement.object.value === objectUri)
      .map((statement: any) => ({
        subject: statement.subject.value,
        predicate: statement.predicate.value,
        object: statement.object.value,
        objectType: statement.object.termType,
      })),
  getAllQuads: () =>
    store.statements.map((statement: any) => ({
      subject: statement.subject.value,
      predicate: statement.predicate.value,
      object: statement.object.value,
      objectType: statement.object.termType,
    })),
});

const parseRdfXml = (filePath: string, content: string): UnifiedStore => {
  const rdflib = require("rdflib");
  const store = rdflib.graph();
  const baseUri = pathToFileURL(filePath).href;

  rdflib.parse(expandEntityReferences(content), store, baseUri, "application/rdf+xml");
  return wrapRdflibStore(store, rdflib);
};

const parseWithN3 = (content: string, format: "Turtle" | "N3" | "N-Quads"): UnifiedStore => {
  const parser = new N3.Parser({ format });
  const store = new N3.Store(parser.parse(content));
  return wrapN3Store(store);
};

const parseJsonLd = async (filePath: string, content: string): Promise<UnifiedStore> => {
  const jsonld = require("jsonld");
  const document = JSON.parse(content);
  const nquads = await jsonld.toRDF(document, { format: "application/n-quads", base: pathToFileURL(filePath).href });
  return parseWithN3(nquads, "N-Quads");
};

const discoverOntologyFiles = (ontologyDir: string): FileDiscovery[] => {
  if (!fileExists(ontologyDir)) {
    console.error(`ERROR: Ontology directory not found: ${ontologyDir}`);
    process.exit(1);
  }

  const files = collectChildFilePaths(ontologyDir)
    .filter((filePath) => SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase()))
    .map((filePath) => {
      const content = readUtf8(filePath);
      const extension = path.extname(filePath).toLowerCase();
      extractNamespacesFromContent(content);
      return {
        filePath: path.resolve(filePath),
        extension,
        format: detectFileFormat(filePath, content),
      };
    });

  if (files.length === 0) {
    console.error(`ERROR: No ontology files found in ${ontologyDir}`);
    console.error(`Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} ontology file(s):`);
  files.forEach(({ filePath, extension, format }) => {
    console.log(`- ${path.relative(ontologyDir, filePath)} [extension=${extension}, format=${format}]`);
  });

  return files;
};

const parseOntologyFile = async (discovery: FileDiscovery): Promise<ParsedStoreFile> => {
  const content = readUtf8(discovery.filePath);
  const store =
    discovery.format === "rdfxml"
      ? parseRdfXml(discovery.filePath, content)
      : discovery.format === "jsonld"
        ? await parseJsonLd(discovery.filePath, content)
        : parseWithN3(content, discovery.format === "n3" ? "N3" : "Turtle");

  return {
    ...discovery,
    store,
    quadCount: store.getAllQuads().length,
  };
};

const mergeStores = (stores: UnifiedStore[]): UnifiedStore => {
  const { namedNode, blankNode, literal, quad } = N3.DataFactory;
  const mergedStore = new N3.Store();

  const toObjectTerm = (value: string, objectType: string): N3.NamedNode | N3.BlankNode | N3.Literal => {
    if (objectType === "NamedNode") return namedNode(value);
    if (objectType === "BlankNode") return blankNode(value.replace(/^_:/, ""));
    return literal(value);
  };

  const toSubjectOrPredicate = (value: string): N3.NamedNode | N3.BlankNode =>
    isBlankNode(value) ? blankNode(value.replace(/^_:/, "")) : namedNode(value);

  stores
    .flatMap((store) => store.getAllQuads())
    .forEach((entry) => {
      mergedStore.addQuad(
        quad(
          toSubjectOrPredicate(entry.subject),
          namedNode(entry.predicate),
          toObjectTerm(entry.object, entry.objectType)
        )
      );
    });

  return wrapN3Store(mergedStore);
};

const getLiteralValues = (store: UnifiedStore, subjectUri: string, predicateUris: string[]): string[] =>
  uniq(
    predicateUris.flatMap((predicateUri) =>
      store
        .getQuads(subjectUri, predicateUri)
        .filter((quad) => quad.objectType === "Literal")
        .map((quad) => quad.object.trim())
        .filter(Boolean)
    )
  );

const getNamedObjectValues = (store: UnifiedStore, subjectUri: string, predicateUris: string[]): string[] =>
  uniq(
    predicateUris.flatMap((predicateUri) =>
      store
        .getQuads(subjectUri, predicateUri)
        .filter((quad) => quad.objectType === "NamedNode")
        .map((quad) => quad.object)
        .filter(isNamedUri)
    )
  );

const getLabel = (store: UnifiedStore, uri: string): string =>
  getLiteralValues(store, uri, [
    `${NS.rdfs}label`,
    `${NS.skos}prefLabel`,
    `${NS.dc}title`,
    `${NS.dcterms}title`,
    `${NS.schemaHttps}name`,
    `${NS.schemaHttp}name`,
  ])[0] || localNameFromUri(uri);

const getDefinition = (store: UnifiedStore, uri: string): string =>
  getLiteralValues(store, uri, [
    `${NS.skos}definition`,
    `${NS.rdfs}comment`,
    `${NS.dc}description`,
    `${NS.dcterms}description`,
    `${NS.schemaHttps}description`,
    `${NS.schemaHttp}description`,
  ])[0] || "";

const getComment = (store: UnifiedStore, uri: string): string =>
  getLiteralValues(store, uri, [
    `${NS.rdfs}comment`,
    `${NS.skos}scopeNote`,
    `${NS.skos}note`,
    `${NS.dc}description`,
    `${NS.dcterms}description`,
  ]).join(" | ");

const discoverOntologyNamespaces = (store: UnifiedStore): void => {
  const ontologyUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri);

  ontologyUris.slice(0, 1).forEach((uri) => {
    ontologyNamespaceCandidates.add(namespaceFromUri(uri));
  });

  const ontologyPrefixPairs = ontologyUris.flatMap((uri) =>
    getLiteralValues(store, uri, [`${NS.vann}preferredNamespacePrefix`]).flatMap((prefixValue) =>
      getNamedObjectValues(store, uri, [`${NS.vann}preferredNamespaceUri`]).map((namespaceUri) => ({
        prefix: prefixValue,
        namespaceUri,
      }))
    )
  );

  ontologyPrefixPairs.forEach(({ prefix, namespaceUri }) => {
    ontologyNamespaceCandidates.add(namespaceUri);
    ensureNamespace(prefix, namespaceUri);
  });
};

const refreshNamespacesFromStore = (
  store: UnifiedStore,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): void => {
  const keep = new Map<string, string>(Object.entries(WELL_KNOWN_NAMESPACES));
  const structuralUris = new Set<string>([
    ...classes.map((item) => item.uri),
    ...objectProperties.map((item) => item.uri),
    ...dataProperties.map((item) => item.uri),
    ...store.getAllQuads().map((quad) => quad.predicate),
  ]);

  structuralUris.forEach((uri) => {
    if (!isNamedUri(uri)) return;
    const namespaceUri = namespaceFromUri(uri);
    const knownPrefix = Object.entries(discoveredNamespaces).find(([, value]) => value === namespaceUri)?.[0];
    keep.set(knownPrefix || inferPrefixFromNamespace(namespaceUri), namespaceUri);
  });

  Object.keys(discoveredNamespaces).forEach((key) => delete discoveredNamespaces[key]);
  Array.from(keep.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .forEach(([prefix, namespaceUri]) => {
      discoveredNamespaces[prefix] = namespaceUri;
    });
};

const extractMetadata = (store: UnifiedStore, files: ParsedStoreFile[]): OntologyMetadata => {
  const ontologyUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri);
  const metadataSources = ontologyUris.length > 0 ? ontologyUris : uniq(files.flatMap(({ store: fileStore }) =>
    fileStore.getSubjects(`${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri)
  ));

  const getFirstMetadataValue = (predicateUris: string[]): string =>
    metadataSources.flatMap((uri) => getLiteralValues(store, uri, predicateUris))[0] || "";

  const title =
    getFirstMetadataValue([
      `${NS.dc}title`,
      `${NS.dcterms}title`,
      `${NS.rdfs}label`,
      `${NS.schemaHttps}name`,
      `${NS.schemaHttp}name`,
    ]) || localNameFromUri(metadataSources[0] || "ontology");

  const version = getFirstMetadataValue([`${NS.owl}versionInfo`, `${NS.dcterms}hasVersion`]) || "unknown";

  const description = getFirstMetadataValue([
    `${NS.rdfs}comment`,
    `${NS.dc}description`,
    `${NS.dcterms}description`,
    `${NS.schemaHttps}description`,
    `${NS.schemaHttp}description`,
  ]);

  return {
    title,
    version,
    description,
    sourceFiles: files.map((file) => path.relative(process.cwd(), file.filePath)),
    namespaces: Object.fromEntries(sortStrings(Object.keys(discoveredNamespaces)).map((prefix) => [prefix, discoveredNamespaces[prefix]])),
  };
};

const extractRestrictions = (store: UnifiedStore): Record<string, RestrictionSummary[]> => {
  const restrictionSubjects = store.getSubjects(`${NS.rdf}type`, `${NS.owl}Restriction`);

  const summaries = restrictionSubjects.reduce<Record<string, RestrictionSummary[]>>((acc, restrictionUri) => {
    const targets = store.getQuads(undefined, `${NS.rdfs}subClassOf`, restrictionUri).map((quad) => quad.subject);
    const onProperty = getNamedObjectValues(store, restrictionUri, [`${NS.owl}onProperty`])[0];

    if (!onProperty || targets.length === 0) return acc;

    const summary: RestrictionSummary = {
      onProperty: prefixUri(onProperty),
      cardinality: getLiteralValues(store, restrictionUri, [`${NS.owl}cardinality`, `${NS.owl}qualifiedCardinality`])[0],
      minCardinality: getLiteralValues(store, restrictionUri, [`${NS.owl}minCardinality`, `${NS.owl}minQualifiedCardinality`])[0],
      maxCardinality: getLiteralValues(store, restrictionUri, [`${NS.owl}maxCardinality`, `${NS.owl}maxQualifiedCardinality`])[0],
      someValuesFrom: getNamedObjectValues(store, restrictionUri, [`${NS.owl}someValuesFrom`]).map(prefixUri),
      allValuesFrom: getNamedObjectValues(store, restrictionUri, [`${NS.owl}allValuesFrom`]).map(prefixUri),
      hasValue: uniq(
        store
          .getQuads(restrictionUri, `${NS.owl}hasValue`)
          .map((quad) => (quad.objectType === "NamedNode" ? prefixUri(quad.object) : quad.object))
      ),
    };

    return targets.reduce<Record<string, RestrictionSummary[]>>(
      (nextAcc, target) => ({
        ...nextAcc,
        [target]: [...(nextAcc[target] || []), summary],
      }),
      acc
    );
  }, {});

  return summaries;
};

const extractClasses = (store: UnifiedStore): OntologyClass[] => {
  const classUris = uniq([
    ...store.getSubjects(`${NS.rdf}type`, `${NS.owl}Class`),
    ...store.getSubjects(`${NS.rdf}type`, `${NS.rdfs}Class`),
  ]).filter(isNamedUri);

  return sortStrings(classUris).map((uri) => ({
    uri,
    label: getLabel(store, uri),
    definition: getDefinition(store, uri),
    comment: getComment(store, uri),
    superClasses: getNamedObjectValues(store, uri, [`${NS.rdfs}subClassOf`]).map(prefixUri),
    equivalentClasses: getNamedObjectValues(store, uri, [`${NS.owl}equivalentClass`]).map(prefixUri),
    examples: getLiteralValues(store, uri, [`${NS.skos}example`]),
  }));
};

const extractObjectProperties = (store: UnifiedStore): ObjectProperty[] => {
  const propertyUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}ObjectProperty`).filter(isNamedUri);

  return sortStrings(propertyUris).map((uri) => ({
    uri,
    label: getLabel(store, uri),
    definition: getDefinition(store, uri),
    domain: getNamedObjectValues(store, uri, [`${NS.rdfs}domain`]).map(prefixUri),
    range: getNamedObjectValues(store, uri, [`${NS.rdfs}range`]).map(prefixUri),
    superProperties: getNamedObjectValues(store, uri, [`${NS.rdfs}subPropertyOf`]).map(prefixUri),
    inverseOf: getNamedObjectValues(store, uri, [`${NS.owl}inverseOf`]).map(prefixUri)[0] || "",
  }));
};

const extractDatatypeProperties = (store: UnifiedStore): DataProperty[] => {
  const propertyUris = store.getSubjects(`${NS.rdf}type`, `${NS.owl}DatatypeProperty`).filter(isNamedUri);

  return sortStrings(propertyUris).map((uri) => ({
    uri,
    label: getLabel(store, uri),
    definition: getDefinition(store, uri),
    domain: getNamedObjectValues(store, uri, [`${NS.rdfs}domain`]).map(prefixUri),
    range: getNamedObjectValues(store, uri, [`${NS.rdfs}range`]).map(prefixUri)[0] || "xsd:string",
  }));
};

const extractRdfProperties = (
  store: UnifiedStore,
  knownObjectProperties: Set<string>,
  knownDataProperties: Set<string>
): { objectProperties: ObjectProperty[]; dataProperties: DataProperty[] } => {
  const rdfPropertyUris = store
    .getSubjects(`${NS.rdf}type`, `${NS.rdf}Property`)
    .filter(isNamedUri)
    .filter((uri) => !knownObjectProperties.has(uri) && !knownDataProperties.has(uri));

  return rdfPropertyUris.reduce<{ objectProperties: ObjectProperty[]; dataProperties: DataProperty[] }>(
    (acc, uri) => {
      const domain = getNamedObjectValues(store, uri, [`${NS.rdfs}domain`]).map(prefixUri);
      const rangeUris = getNamedObjectValues(store, uri, [`${NS.rdfs}range`]);
      const prefixedRanges = rangeUris.map(prefixUri);
      const isLiteralRange = rangeUris.some((rangeUri) => rangeUri === `${NS.rdfs}Literal` || rangeUri.startsWith(NS.xsd));

      if (isLiteralRange) {
        return {
          ...acc,
          dataProperties: [
            ...acc.dataProperties,
            {
              uri,
              label: getLabel(store, uri),
              definition: getDefinition(store, uri),
              domain,
              range: prefixedRanges[0] || "xsd:string",
            },
          ],
        };
      }

      return {
        ...acc,
        objectProperties: [
          ...acc.objectProperties,
          {
            uri,
            label: getLabel(store, uri),
            definition: getDefinition(store, uri),
            domain,
            range: prefixedRanges,
            superProperties: getNamedObjectValues(store, uri, [`${NS.rdfs}subPropertyOf`]).map(prefixUri),
            inverseOf: getNamedObjectValues(store, uri, [`${NS.owl}inverseOf`]).map(prefixUri)[0] || "",
          },
        ],
      };
    },
    { objectProperties: [], dataProperties: [] }
  );
};

const extractExternalVocabularies = (
  store: UnifiedStore,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): ExternalVocabulary[] => {
  const ontologyNamespaces = new Set(
    Array.from(ontologyNamespaceCandidates).filter(Boolean)
  );

  if (ontologyNamespaces.size === 0) {
    classes.slice(0, 20).forEach((item) => ontologyNamespaces.add(namespaceFromUri(item.uri)));
  }

  const allUris = uniq(
    store
      .getAllQuads()
      .flatMap((quad) => [quad.subject, quad.predicate, quad.object])
      .filter(isNamedUri)
  );

  const classUris = new Set(classes.map((entry) => entry.uri));
  const propertyUris = new Set([...objectProperties, ...dataProperties].map((entry) => entry.uri));
  const skippedNamespaces = new Set([NS.rdf, NS.rdfs, NS.owl, NS.xsd, NS.sh]);

  const grouped = allUris.reduce<Record<string, { classes: Set<string>; properties: Set<string> }>>(
    (acc, uri) => {
      const namespaceUri = namespaceFromUri(uri);
      if (ontologyNamespaces.has(namespaceUri) || skippedNamespaces.has(namespaceUri)) return acc;

      const next = acc[namespaceUri] || { classes: new Set<string>(), properties: new Set<string>() };
      if (classUris.has(uri)) next.classes.add(prefixUri(uri));
      if (propertyUris.has(uri)) next.properties.add(prefixUri(uri));

      return { ...acc, [namespaceUri]: next };
    },
    {}
  );

  return sortStrings(Object.keys(grouped))
    .map((namespaceUri) => ({
      prefix: inferPrefixFromNamespace(namespaceUri),
      namespace: namespaceUri,
      classes: sortStrings(Array.from(grouped[namespaceUri].classes)),
      properties: sortStrings(Array.from(grouped[namespaceUri].properties)),
    }))
    .filter((entry) => entry.classes.length > 0 || entry.properties.length > 0);
};

const extractPropertyConnections = (objectProperties: ObjectProperty[]): PropertyConnection[] =>
  objectProperties.flatMap((property) =>
    (property.domain.length > 0 ? property.domain : ["(unspecified)"]).flatMap((fromClass) =>
      (property.range.length > 0 ? property.range : ["(unspecified)"]).map((toClass) => ({
        property: prefixUri(property.uri),
        fromClass,
        toClass,
      }))
    )
  );

const analyzeClassConnectivity = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): ClassConnectivity[] => {
  const prefixedClassSet = new Set(classes.map((item) => prefixUri(item.uri)));

  const stats = classes.reduce<Record<string, ClassConnectivity>>((acc, ontologyClass) => {
    const classUri = prefixUri(ontologyClass.uri);
    return {
      ...acc,
      [classUri]: {
        classUri,
        label: ontologyClass.label,
        connectionCount: 0,
        outboundObjectProperties: [],
        inboundObjectProperties: [],
        dataProperties: [],
        role: "auxiliary",
      },
    };
  }, {});

  objectProperties.forEach((property) => {
    property.domain.forEach((domainClass) => {
      if (prefixedClassSet.has(domainClass)) {
        stats[domainClass].connectionCount += 1;
        stats[domainClass].outboundObjectProperties.push(prefixUri(property.uri));
      }
    });

    property.range.forEach((rangeClass) => {
      if (prefixedClassSet.has(rangeClass)) {
        stats[rangeClass].connectionCount += 1;
        stats[rangeClass].inboundObjectProperties.push(prefixUri(property.uri));
      }
    });
  });

  dataProperties.forEach((property) => {
    property.domain.forEach((domainClass) => {
      if (prefixedClassSet.has(domainClass)) {
        stats[domainClass].connectionCount += 1;
        stats[domainClass].dataProperties.push(prefixUri(property.uri));
      }
    });
  });

  return Object.values(stats)
    .map((entry) => {
      const hasChildren = classes.some((item) => item.superClasses.includes(entry.classUri));
      const role: ClassConnectivity["role"] =
        entry.connectionCount >= 6
          ? "core"
          : entry.connectionCount >= 3 || hasChildren
            ? "important"
            : "auxiliary";

      return {
        ...entry,
        outboundObjectProperties: sortStrings(uniq(entry.outboundObjectProperties)),
        inboundObjectProperties: sortStrings(uniq(entry.inboundObjectProperties)),
        dataProperties: sortStrings(uniq(entry.dataProperties)),
        role,
      };
    })
    .sort((left, right) => right.connectionCount - left.connectionCount || left.classUri.localeCompare(right.classUri));
};

const computePropertyChains = (connections: PropertyConnection[]): string[] => {
  const byMiddleClass = connections.reduce<Record<string, PropertyConnection[]>>((acc, connection) => ({
    ...acc,
    [connection.fromClass]: [...(acc[connection.fromClass] || []), connection],
  }), {});

  const chains = connections.flatMap((first) =>
    (byMiddleClass[first.toClass] || [])
      .filter((second) => first.toClass !== "(unspecified)" && second.toClass !== first.fromClass)
      .map((second) => `${first.fromClass} -[${first.property}]-> ${first.toClass} -[${second.property}]-> ${second.toClass}`)
  );

  return sortStrings(uniq(chains)).slice(0, 25);
};

const deriveConstraints = (
  restrictionsByClass: Record<string, RestrictionSummary[]>,
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): string[] => {
  const rangeConstraints = [
    ...objectProperties.flatMap((property) =>
      property.domain.flatMap((domainClass) =>
        property.range.map((rangeClass) => `${prefixUri(property.uri)}: ${domainClass} -> ${rangeClass}`)
      )
    ),
    ...dataProperties.flatMap((property) =>
      property.domain.map((domainClass) => `${prefixUri(property.uri)}: ${domainClass} -> ${property.range}`)
    ),
  ];

  const restrictionConstraints = Object.entries(restrictionsByClass).flatMap(([classUri, summaries]) =>
    summaries.map((summary) => {
      const parts = [
        `Class ${prefixUri(classUri)} uses restriction on ${summary.onProperty}`,
        summary.cardinality ? `cardinality=${summary.cardinality}` : "",
        summary.minCardinality ? `min=${summary.minCardinality}` : "",
        summary.maxCardinality ? `max=${summary.maxCardinality}` : "",
        summary.someValuesFrom && summary.someValuesFrom.length > 0 ? `someValuesFrom=${summary.someValuesFrom.join(", ")}` : "",
        summary.allValuesFrom && summary.allValuesFrom.length > 0 ? `allValuesFrom=${summary.allValuesFrom.join(", ")}` : "",
        summary.hasValue && summary.hasValue.length > 0 ? `hasValue=${summary.hasValue.join(", ")}` : "",
      ].filter(Boolean);

      return parts.join("; ");
    })
  );

  return sortStrings(
    uniq([
      "Use only classes and properties defined in the parsed ontology namespaces or referenced external vocabularies.",
      "Respect every rdfs:domain and rdfs:range assignment when constructing triples.",
      "Prefer the most specific class available in the subclass hierarchy for each entity.",
      "Treat owl:inverseOf links as semantically paired properties.",
      ...rangeConstraints,
      ...restrictionConstraints,
    ])
  );
};

const generateMappingGuide = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  connectivity: ClassConnectivity[],
  propertyChains: string[],
  restrictionsByClass: Record<string, RestrictionSummary[]>
): MappingGuide => {
  const patterns = connectivity
    .filter((entry) => entry.role !== "auxiliary")
    .slice(0, 20)
    .map<MappingPattern>((entry) => {
      const ontologyClass = classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri);
      const classRestrictions = restrictionsByClass[ontologyClass?.uri || ""] || [];

      const requiredProperties = sortStrings(
        uniq([
          ...classRestrictions
            .filter((restriction) => restriction.cardinality === "1" || restriction.minCardinality === "1")
            .map((restriction) => restriction.onProperty),
        ])
      );

      const optionalProperties = sortStrings(
        uniq([
          ...entry.outboundObjectProperties,
          ...entry.dataProperties,
        ].filter((property) => !requiredProperties.includes(property)))
      );

      const relationships = sortStrings(
        uniq([
          ...objectProperties
            .filter((property) => property.domain.includes(entry.classUri) || property.range.includes(entry.classUri))
            .map((property) => {
              const domain = property.domain.join(", ") || "(unspecified)";
              const range = property.range.join(", ") || "(unspecified)";
              return `${prefixUri(property.uri)}: ${domain} -> ${range}`;
            }),
          ...propertyChains.filter((chain) => chain.includes(entry.classUri)).slice(0, 5),
        ])
      );

      return {
        scenario: `${entry.label} as a ${entry.role} entity (${entry.connectionCount} ontology links)`,
        ontologyClass: entry.classUri,
        requiredProperties,
        optionalProperties,
        relationships,
      };
    });

  return {
    commonPatterns: patterns,
    allowedNamespaces: sortStrings(
      uniq(Object.values(discoveredNamespaces))
    ),
    constraints: deriveConstraints(restrictionsByClass, objectProperties, dataProperties),
  };
};

const generateQuickReference = (
  structure: OntologyStructure,
  connectivity: ClassConnectivity[]
): QuickReference => ({
  ontology: {
    title: structure.metadata.title,
    version: structure.metadata.version,
    description: structure.metadata.description,
  },
  coreClasses: connectivity
    .filter((entry) => entry.role !== "auxiliary")
    .slice(0, 15)
    .map((entry) => {
      const ontologyClass = structure.classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri);
      return {
        class: entry.classUri,
        label: entry.label,
        description: ontologyClass?.definition || ontologyClass?.comment || "",
        connectedBy: sortStrings(uniq([...entry.outboundObjectProperties, ...entry.inboundObjectProperties, ...entry.dataProperties])).slice(0, 12),
      };
    }),
  keyRelationships: structure.objectProperties
    .filter((property) => property.domain.length > 0 || property.range.length > 0)
    .slice(0, 25)
    .map((property) => ({
      property: prefixUri(property.uri),
      domain: property.domain,
      range: property.range,
    })),
  keyDataProperties: structure.dataProperties
    .filter((property) => property.domain.length > 0)
    .slice(0, 25)
    .map((property) => ({
      property: prefixUri(property.uri),
      domain: property.domain,
      range: property.range,
    })),
  namespaces: sortStrings(Object.values(discoveredNamespaces)),
});

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const printSummary = (
  structure: OntologyStructure,
  parsedFiles: ParsedFile[],
  connectivity: ClassConnectivity[]
): void => {
  console.log("");
  console.log(`Ontology: ${structure.metadata.title}`);
  console.log(`Version: ${structure.metadata.version}`);
  console.log(`Source files parsed: ${parsedFiles.map((file) => path.relative(process.cwd(), file.filePath)).join(", ")}`);
  console.log(`Classes found: ${structure.classes.length}`);
  console.log(`Object properties found: ${structure.objectProperties.length}`);
  console.log(`Data properties found: ${structure.dataProperties.length}`);
  console.log("Core classes:");
  connectivity
    .filter((entry) => entry.role !== "auxiliary")
    .slice(0, 12)
    .forEach((entry) => {
      const ontologyClass = structure.classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri);
      const description = ontologyClass?.definition || ontologyClass?.comment || "";
      console.log(`- ${entry.classUri}: ${description || entry.label}`);
    });
  console.log("Namespaces that can be used:");
  sortStrings(Object.entries(structure.metadata.namespaces).map(([prefix, namespaceUri]) => `${prefix}: ${namespaceUri}`))
    .forEach((entry) => console.log(`- ${entry}`));
};

const main = async (): Promise<void> => {
  const dataDir = path.resolve(process.env.DATA_DIR || "domain-data/scientific-dblp");
  const ontologyDir = path.join(dataDir, "ontology");
  const outputDir = path.join(dataDir, "output", "codex");

  console.log(`Ontology directory: ${ontologyDir}`);
  console.log(`Output directory: ${outputDir}`);

  const discoveredFiles = discoverOntologyFiles(ontologyDir);
  const parsedFiles = await Promise.all(discoveredFiles.map(parseOntologyFile));

  parsedFiles.forEach((file) => {
    console.log(`Parsed ${file.quadCount} triples from ${path.relative(ontologyDir, file.filePath)} (${file.format})`);
  });

  const mergedStore = mergeStores(parsedFiles.map((file) => file.store));
  discoverOntologyNamespaces(mergedStore);

  const initialClasses = extractClasses(mergedStore);

  const initialObjectProperties = extractObjectProperties(mergedStore);
  const initialDatatypeProperties = extractDatatypeProperties(mergedStore);
  refreshNamespacesFromStore(mergedStore, initialClasses, initialObjectProperties, initialDatatypeProperties);

  const metadata = extractMetadata(mergedStore, parsedFiles);
  const classes = extractClasses(mergedStore);

  const objectProperties = extractObjectProperties(mergedStore);
  const datatypeProperties = extractDatatypeProperties(mergedStore);
  const extraProperties = extractRdfProperties(
    mergedStore,
    new Set(objectProperties.map((item) => item.uri)),
    new Set(datatypeProperties.map((item) => item.uri))
  );

  const allObjectProperties = sortStrings(
    uniq([...objectProperties, ...extraProperties.objectProperties].map((item) => item.uri))
  ).map((uri) => [...objectProperties, ...extraProperties.objectProperties].find((item) => item.uri === uri)).filter(identity) as ObjectProperty[];

  const allDataProperties = sortStrings(
    uniq([...datatypeProperties, ...extraProperties.dataProperties].map((item) => item.uri))
  ).map((uri) => [...datatypeProperties, ...extraProperties.dataProperties].find((item) => item.uri === uri)).filter(identity) as DataProperty[];

  const externalVocabularies = extractExternalVocabularies(
    mergedStore,
    classes,
    allObjectProperties,
    allDataProperties
  );

  const structure: OntologyStructure = {
    metadata,
    classes,
    objectProperties: allObjectProperties,
    dataProperties: allDataProperties,
    externalVocabularies,
  };

  const restrictionsByClass = extractRestrictions(mergedStore);
  const propertyConnections = extractPropertyConnections(allObjectProperties);
  const connectivity = analyzeClassConnectivity(classes, allObjectProperties, allDataProperties);
  const propertyChains = computePropertyChains(propertyConnections);
  const mappingGuide = generateMappingGuide(
    classes,
    allObjectProperties,
    allDataProperties,
    connectivity,
    propertyChains,
    restrictionsByClass
  );
  const quickReference = generateQuickReference(structure, connectivity);

  writeJson(path.join(outputDir, "ontology-structure.json"), structure);
  writeJson(path.join(outputDir, "ontology-mapping-guide.json"), mappingGuide);
  writeJson(path.join(outputDir, "ontology-quick-reference.json"), quickReference);

  printSummary(structure, parsedFiles, connectivity);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
