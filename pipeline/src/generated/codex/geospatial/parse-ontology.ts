import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import * as N3 from "n3";

type RdfFormat = "rdfxml" | "turtle" | "n3" | "jsonld";

type QuadView = {
  subject: string;
  predicate: string;
  object: string;
  objectType: "NamedNode" | "BlankNode" | "Literal";
};

type UnifiedStore = {
  quads: QuadView[];
};

type FileDiscovery = {
  filePath: string;
  extension: string;
  format: RdfFormat;
};

type ParsedFile = FileDiscovery & {
  quadCount: number;
};

type RestrictionSummary = {
  classUri: string;
  onProperty: string;
  cardinality?: string;
  minCardinality?: string;
  maxCardinality?: string;
  someValuesFrom: string[];
  allValuesFrom: string[];
  hasValue: string[];
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
  cardinalityConstraints?: string[];
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
  counts: {
    classes: number;
    objectProperties: number;
    dataProperties: number;
    externalVocabularies: number;
  };
  coreClasses: Array<{
    class: string;
    label: string;
    role: "core" | "auxiliary" | "metadata";
    description: string;
  }>;
  propertyConnections: Array<{
    property: string;
    domain: string[];
    range: string[];
  }>;
  propertyChains: string[];
  allowedNamespaces: string[];
  constraints: string[];
};

type PropertyConnection = {
  property: string;
  fromClass: string;
  toClass: string;
};

type ClassPatternStats = {
  classUri: string;
  label: string;
  connectionCount: number;
  outboundObjectProperties: string[];
  inboundObjectProperties: string[];
  dataProperties: string[];
  role: "core" | "auxiliary" | "metadata";
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
  schemahttp: NS.schemaHttp,
};

const discoveredNamespaces: Record<string, string> = { ...WELL_KNOWN_NAMESPACES };

const uniq = <T>(values: T[]): T[] => Array.from(new Set(values));

const sortStrings = (values: string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const isNamedUri = (value: string): boolean => value.startsWith("http://") || value.startsWith("https://");

const isBlankNode = (value: string): boolean => value.startsWith("_:");

const localNameFromUri = (uri: string): string => uri.split(/[#/]/).filter(Boolean).pop() || uri;

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
  const cleanedPrefix = sanitizePrefix(prefix || "base");
  if (!cleanedPrefix) return;
  if (!discoveredNamespaces[cleanedPrefix]) discoveredNamespaces[cleanedPrefix] = namespaceUri;
};

const inferPrefixFromNamespace = (namespaceUri: string): string => {
  const known = Object.entries(discoveredNamespaces).find(([, value]) => value === namespaceUri);
  if (known) return known[0];

  const trimmed = namespaceUri.replace(/[#/]$/, "");
  const candidate = sanitizePrefix(trimmed.split(/[/:]/).filter(Boolean).pop() || "ns");
  if (!candidate || discoveredNamespaces[candidate]) {
    let index = 1;
    while (discoveredNamespaces[`ns${index}`]) index += 1;
    return `ns${index}`;
  }

  return candidate;
};

const canonicalizeNamespaces = (): void => {
  const entries = Object.entries(discoveredNamespaces);
  const preferredByNamespace = entries.reduce<Record<string, string>>((acc, [prefix, namespaceUri]) => {
    const current = acc[namespaceUri];
    if (!current) {
      acc[namespaceUri] = prefix;
      return acc;
    }

    const currentScore =
      (current === "base" ? 0 : 2) +
      (WELL_KNOWN_NAMESPACES[current] ? 3 : 0) +
      (current.startsWith("ns") ? -1 : 0);
    const nextScore =
      (prefix === "base" ? 0 : 2) +
      (WELL_KNOWN_NAMESPACES[prefix] ? 3 : 0) +
      (prefix.startsWith("ns") ? -1 : 0);

    if (nextScore > currentScore || (nextScore === currentScore && prefix.localeCompare(current) < 0)) {
      acc[namespaceUri] = prefix;
    }

    return acc;
  }, {});

  Object.keys(discoveredNamespaces).forEach((key) => delete discoveredNamespaces[key]);
  Object.entries(preferredByNamespace)
    .sort((left, right) => left[1].localeCompare(right[1]))
    .forEach(([namespaceUri, prefix]) => {
      discoveredNamespaces[prefix] = namespaceUri;
    });
};

const prefixUri = (uri: string): string => {
  const match = Object.entries(discoveredNamespaces)
    .sort((left, right) => right[1].length - left[1].length)
    .find(([, namespaceUri]) => uri.startsWith(namespaceUri));

  if (!match) return uri;

  const [prefix, namespaceUri] = match;
  return `${prefix}:${uri.slice(namespaceUri.length)}`;
};

const fileExists = (filePath: string): boolean => fs.existsSync(filePath);

const readUtf8 = (filePath: string): string => fs.readFileSync(filePath, "utf-8");

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const walkFiles = (dirPath: string): string[] =>
  fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });

const sniffFormatFromContent = (content: string): RdfFormat | null => {
  const trimmed = content.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    if (trimmed.includes("\"@context\"") || trimmed.includes("\"@graph\"") || trimmed.includes("\"@id\"")) {
      return "jsonld";
    }
  }

  if (/<rdf:RDF\b|<owl:Ontology\b|<[^>]+xmlns(?::\w+)?=/.test(trimmed)) {
    return "rdfxml";
  }

  if (/^@prefix\s+/im.test(trimmed) || /^prefix\s+/im.test(trimmed) || /^base\s+</im.test(trimmed)) {
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
  const turtlePrefixRegex = /(?:@prefix|PREFIX)\s+([a-zA-Z_][\w.-]*)?:\s*<([^>]+)>/gim;
  const xmlNamespaceRegex = /xmlns:([a-zA-Z_][\w.-]*)="([^"]+)"/g;
  const defaultXmlNamespaceRegex = /xmlns="([^"]+)"/g;
  const baseRegex = /(?:^|\s)(?:BASE|@base)\s*<([^>]+)>/gim;

  for (const match of Array.from(content.matchAll(turtlePrefixRegex))) {
    ensureNamespace(match[1] || "base", match[2]);
  }

  for (const match of Array.from(content.matchAll(xmlNamespaceRegex))) {
    ensureNamespace(match[1], match[2]);
  }

  for (const match of Array.from(content.matchAll(defaultXmlNamespaceRegex))) {
    ensureNamespace("base", match[1]);
  }

  for (const match of Array.from(content.matchAll(baseRegex))) {
    ensureNamespace("base", match[1]);
  }

  const prefixMatches = Array.from(content.matchAll(/preferredNamespacePrefix\s+"([^"]+)"/gim));
  const namespaceMatches = Array.from(content.matchAll(/preferredNamespaceUri\s+"([^"]+)"/gim));
  prefixMatches.forEach((match, index) => ensureNamespace(match[1], namespaceMatches[index]?.[1] || ""));
};

const discoverOntologyFiles = (ontologyDir: string): FileDiscovery[] => {
  if (!fileExists(ontologyDir)) {
    console.error(`ERROR: Ontology directory not found: ${ontologyDir}`);
    process.exit(1);
  }

  const files = walkFiles(ontologyDir)
    .filter((filePath) => SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase()))
    .map((filePath) => {
      const content = readUtf8(filePath);
      extractNamespacesFromContent(content);
      return {
        filePath: path.resolve(filePath),
        extension: path.extname(filePath).toLowerCase(),
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

const normalizeTerm = (term: { value: string; termType: string }): QuadView["object"] =>
  term.termType === "BlankNode" ? `_:${term.value}` : term.value;

const parseWithN3 = (content: string, format: "Turtle" | "N3"): UnifiedStore => {
  const parser = new N3.Parser({ format });
  const quads = parser.parse(content).map<QuadView>((quad) => ({
    subject: normalizeTerm(quad.subject),
    predicate: quad.predicate.value,
    object: normalizeTerm(quad.object),
    objectType: quad.object.termType as QuadView["objectType"],
  }));

  return { quads };
};

const parseWithRdflib = (filePath: string, content: string, contentType: string): UnifiedStore => {
  const rdflib = require("rdflib");
  const store = rdflib.graph();
  rdflib.parse(content, store, pathToFileURL(filePath).href, contentType);

  const quads = store.statements.map((statement: any) => ({
    subject: normalizeTerm(statement.subject),
    predicate: statement.predicate.value,
    object: normalizeTerm(statement.object),
    objectType: statement.object.termType as QuadView["objectType"],
  }));

  return { quads };
};

const parseOntologyFile = async (file: FileDiscovery): Promise<ParsedFile & { store: UnifiedStore }> => {
  const content = readUtf8(file.filePath);
  const store =
    file.format === "rdfxml"
      ? parseWithRdflib(file.filePath, content, "application/rdf+xml")
      : file.format === "jsonld"
        ? parseWithRdflib(file.filePath, content, "application/ld+json")
        : parseWithN3(content, file.format === "n3" ? "N3" : "Turtle");

  return {
    ...file,
    quadCount: store.quads.length,
    store,
  };
};

const mergeStores = (stores: UnifiedStore[]): UnifiedStore => ({
  quads: stores.flatMap((store) => store.quads),
});

const getQuads = (
  store: UnifiedStore,
  subject?: string,
  predicate?: string,
  object?: string
): QuadView[] =>
  store.quads
    .filter((quad) => (subject ? quad.subject === subject : true))
    .filter((quad) => (predicate ? quad.predicate === predicate : true))
    .filter((quad) => (object ? quad.object === object : true));

const getSubjects = (store: UnifiedStore, predicate: string, object: string): string[] =>
  uniq(getQuads(store, undefined, predicate, object).map((quad) => quad.subject));

const getObjectQuads = (store: UnifiedStore, subject: string, predicate: string): QuadView[] =>
  getQuads(store, subject, predicate);

const getLiteralValues = (store: UnifiedStore, subject: string, predicates: string[]): string[] =>
  uniq(
    predicates.flatMap((predicate) =>
      getObjectQuads(store, subject, predicate)
        .filter((quad) => quad.objectType === "Literal")
        .map((quad) => normalizeWhitespace(quad.object))
        .filter(Boolean)
    )
  );

const getNamedObjectValues = (store: UnifiedStore, subject: string, predicates: string[]): string[] =>
  uniq(
    predicates.flatMap((predicate) =>
      getObjectQuads(store, subject, predicate)
        .filter((quad) => quad.objectType === "NamedNode")
        .map((quad) => quad.object)
        .filter(isNamedUri)
    )
  );

const getAllNamedUris = (store: UnifiedStore): string[] =>
  uniq(
    store.quads
      .flatMap((quad) => [quad.subject, quad.predicate, quad.object])
      .filter(isNamedUri)
  );

const registerNamespacesFromUris = (uris: string[]): void => {
  uris.forEach((uri) => {
    const namespaceUri = namespaceFromUri(uri);
    const prefix = inferPrefixFromNamespace(namespaceUri);
    ensureNamespace(prefix, namespaceUri);
  });
};

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

const getExamples = (store: UnifiedStore, uri: string): string[] =>
  uniq(
    getObjectQuads(store, uri, `${NS.skos}example`)
      .map((quad) => (quad.objectType === "NamedNode" ? quad.object : normalizeWhitespace(quad.object)))
      .filter(Boolean)
  );

const isDatatypeRange = (uri: string): boolean =>
  uri === `${NS.rdfs}Literal` ||
  uri.startsWith(NS.xsd) ||
  getSubjects.length > 0;

const extractMetadata = (store: UnifiedStore, files: ParsedFile[]): OntologyMetadata => {
  const ontologyUris = getSubjects(store, `${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri);
  const metadataTargets = ontologyUris.length > 0 ? ontologyUris : files.map((file) => pathToFileURL(file.filePath).href);

  const takeFirst = (predicates: string[]): string =>
    metadataTargets.flatMap((uri) => getLiteralValues(store, uri, predicates))[0] || "";

  const title =
    takeFirst([
      `${NS.dc}title`,
      `${NS.dcterms}title`,
      `${NS.rdfs}label`,
      `${NS.schemaHttps}name`,
      `${NS.schemaHttp}name`,
    ]) || localNameFromUri(ontologyUris[0] || "ontology");

  const version = takeFirst([`${NS.owl}versionInfo`, `${NS.dcterms}hasVersion`]) || "unknown";

  const description = takeFirst([
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
    namespaces: Object.fromEntries(
      sortStrings(Object.keys(discoveredNamespaces)).map((prefix) => [prefix, discoveredNamespaces[prefix]])
    ),
  };
};

const registerOntologyPreferredNamespace = (store: UnifiedStore): void => {
  const ontologyUris = getSubjects(store, `${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri);
  ontologyUris.forEach((uri) => {
    const preferredPrefix = getLiteralValues(store, uri, [`${NS.vann}preferredNamespacePrefix`])[0];
    const preferredNamespaceUri = getLiteralValues(store, uri, [`${NS.vann}preferredNamespaceUri`])[0];
    if (preferredPrefix && preferredNamespaceUri) {
      ensureNamespace(preferredPrefix, preferredNamespaceUri);
    }
  });

  canonicalizeNamespaces();
};

const extractRestrictions = (store: UnifiedStore): Record<string, RestrictionSummary[]> => {
  const restrictionNodes = getSubjects(store, `${NS.rdf}type`, `${NS.owl}Restriction`);
  const summaries = restrictionNodes.reduce<Record<string, RestrictionSummary[]>>((acc, restrictionNode) => {
    const parentClasses = getQuads(store, undefined, `${NS.rdfs}subClassOf`, restrictionNode)
      .map((quad) => quad.subject)
      .filter(isNamedUri);
    const onProperty = getNamedObjectValues(store, restrictionNode, [`${NS.owl}onProperty`])[0];

    if (!onProperty || parentClasses.length === 0) return acc;

    const summaryBase = {
      onProperty: prefixUri(onProperty),
      cardinality: getLiteralValues(store, restrictionNode, [`${NS.owl}cardinality`, `${NS.owl}qualifiedCardinality`])[0],
      minCardinality: getLiteralValues(store, restrictionNode, [`${NS.owl}minCardinality`, `${NS.owl}minQualifiedCardinality`])[0],
      maxCardinality: getLiteralValues(store, restrictionNode, [`${NS.owl}maxCardinality`, `${NS.owl}maxQualifiedCardinality`])[0],
      someValuesFrom: getNamedObjectValues(store, restrictionNode, [`${NS.owl}someValuesFrom`]).map(prefixUri),
      allValuesFrom: getNamedObjectValues(store, restrictionNode, [`${NS.owl}allValuesFrom`]).map(prefixUri),
      hasValue: uniq(
        getObjectQuads(store, restrictionNode, `${NS.owl}hasValue`).map((quad) =>
          quad.objectType === "NamedNode" ? prefixUri(quad.object) : normalizeWhitespace(quad.object)
        )
      ),
    };

    parentClasses.forEach((classUri) => {
      const nextSummary: RestrictionSummary = { classUri, ...summaryBase };
      acc[classUri] = [...(acc[classUri] || []), nextSummary];
    });

    return acc;
  }, {});

  return summaries;
};

const extractClasses = (store: UnifiedStore): OntologyClass[] =>
  sortStrings(
    uniq([
      ...getSubjects(store, `${NS.rdf}type`, `${NS.owl}Class`),
      ...getSubjects(store, `${NS.rdf}type`, `${NS.rdfs}Class`),
    ]).filter(isNamedUri)
  ).map((uri) => ({
    uri,
    label: getLabel(store, uri),
    definition: getDefinition(store, uri),
    comment: getComment(store, uri),
    superClasses: getNamedObjectValues(store, uri, [`${NS.rdfs}subClassOf`]).map(prefixUri),
    equivalentClasses: getNamedObjectValues(store, uri, [`${NS.owl}equivalentClass`]).map(prefixUri),
    examples: getExamples(store, uri),
  }));

const propertyRangeUris = (store: UnifiedStore, propertyUri: string): string[] =>
  getNamedObjectValues(store, propertyUri, [`${NS.rdfs}range`]);

const propertyDomainUris = (store: UnifiedStore, propertyUri: string): string[] =>
  getNamedObjectValues(store, propertyUri, [`${NS.rdfs}domain`]);

const extractPropertyUris = (store: UnifiedStore): {
  explicitObjectProperties: string[];
  explicitDataProperties: string[];
  rdfProperties: string[];
} => ({
  explicitObjectProperties: sortStrings(getSubjects(store, `${NS.rdf}type`, `${NS.owl}ObjectProperty`).filter(isNamedUri)),
  explicitDataProperties: sortStrings(getSubjects(store, `${NS.rdf}type`, `${NS.owl}DatatypeProperty`).filter(isNamedUri)),
  rdfProperties: sortStrings(getSubjects(store, `${NS.rdf}type`, `${NS.rdf}Property`).filter(isNamedUri)),
});

const classifyRdfProperties = (
  store: UnifiedStore,
  explicitObjectProperties: string[],
  explicitDataProperties: string[]
): { objectProperties: string[]; dataProperties: string[] } => {
  const objectSet = new Set(explicitObjectProperties);
  const dataSet = new Set(explicitDataProperties);

  extractPropertyUris(store).rdfProperties.forEach((propertyUri) => {
    if (objectSet.has(propertyUri) || dataSet.has(propertyUri)) return;

    const ranges = propertyRangeUris(store, propertyUri);
    if (ranges.length === 0) return;

    if (ranges.every((rangeUri) => rangeUri === `${NS.rdfs}Literal` || rangeUri.startsWith(NS.xsd))) {
      dataSet.add(propertyUri);
      return;
    }

    if (ranges.some((rangeUri) => isNamedUri(rangeUri) && !rangeUri.startsWith(NS.xsd) && rangeUri !== `${NS.rdfs}Literal`)) {
      objectSet.add(propertyUri);
    }
  });

  return {
    objectProperties: sortStrings(Array.from(objectSet)),
    dataProperties: sortStrings(Array.from(dataSet)),
  };
};

const extractObjectProperties = (
  store: UnifiedStore,
  propertyUris: string[],
  restrictionsByClass: Record<string, RestrictionSummary[]>
): ObjectProperty[] =>
  propertyUris.map((uri) => {
    const cardinalityConstraints = sortStrings(
      Object.values(restrictionsByClass)
        .flatMap((items) => items)
        .filter((item) => prefixUri(uri) === item.onProperty)
        .map((item) => {
          const parts = [
            `${prefixUri(item.classUri)}`,
            item.cardinality ? `cardinality=${item.cardinality}` : "",
            item.minCardinality ? `min=${item.minCardinality}` : "",
            item.maxCardinality ? `max=${item.maxCardinality}` : "",
            item.someValuesFrom.length > 0 ? `someValuesFrom=${item.someValuesFrom.join(", ")}` : "",
            item.allValuesFrom.length > 0 ? `allValuesFrom=${item.allValuesFrom.join(", ")}` : "",
            item.hasValue.length > 0 ? `hasValue=${item.hasValue.join(", ")}` : "",
          ].filter(Boolean);

          return parts.join("; ");
        })
    );

    return {
      uri,
      label: getLabel(store, uri),
      definition: getDefinition(store, uri),
      domain: propertyDomainUris(store, uri).map(prefixUri),
      range: propertyRangeUris(store, uri).map(prefixUri),
      superProperties: getNamedObjectValues(store, uri, [`${NS.rdfs}subPropertyOf`]).map(prefixUri),
      inverseOf: getNamedObjectValues(store, uri, [`${NS.owl}inverseOf`]).map(prefixUri)[0] || "",
      cardinalityConstraints,
    };
  });

const datatypeLabel = (uri: string): string => prefixUri(uri);

const extractDataProperties = (store: UnifiedStore, propertyUris: string[]): DataProperty[] =>
  propertyUris.map((uri) => {
    const ranges = propertyRangeUris(store, uri);
    const dataRange =
      ranges.find((rangeUri) => rangeUri.startsWith(NS.xsd)) ||
      ranges.find((rangeUri) => rangeUri === `${NS.rdfs}Literal`) ||
      ranges[0] ||
      `${NS.xsd}string`;

    return {
      uri,
      label: getLabel(store, uri),
      definition: getDefinition(store, uri),
      domain: propertyDomainUris(store, uri).map(prefixUri),
      range: datatypeLabel(dataRange),
    };
  });

const extractExternalVocabularies = (
  store: UnifiedStore,
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): ExternalVocabulary[] => {
  const ontologyNamespaces = new Set(
    uniq([
      ...getSubjects(store, `${NS.rdf}type`, `${NS.owl}Ontology`).filter(isNamedUri).map(namespaceFromUri),
      ...classes.map((item) => namespaceFromUri(item.uri)),
    ])
  );

  const classUriSet = new Set(classes.map((item) => item.uri));
  const propertyUriSet = new Set([...objectProperties, ...dataProperties].map((item) => item.uri));
  const referencedUris = getAllNamedUris(store);

  const groups = referencedUris.reduce<Record<string, { classes: Set<string>; properties: Set<string> }>>((acc, uri) => {
    const namespaceUri = namespaceFromUri(uri);
    if (ontologyNamespaces.has(namespaceUri)) return acc;

    const bucket = acc[namespaceUri] || { classes: new Set<string>(), properties: new Set<string>() };

    if (classUriSet.has(uri) || getSubjects(store, `${NS.rdf}type`, `${NS.owl}Class`).includes(uri) || getSubjects(store, `${NS.rdf}type`, `${NS.rdfs}Class`).includes(uri)) {
      bucket.classes.add(prefixUri(uri));
    }

    if (
      propertyUriSet.has(uri) ||
      getSubjects(store, `${NS.rdf}type`, `${NS.owl}ObjectProperty`).includes(uri) ||
      getSubjects(store, `${NS.rdf}type`, `${NS.owl}DatatypeProperty`).includes(uri) ||
      getSubjects(store, `${NS.rdf}type`, `${NS.rdf}Property`).includes(uri)
    ) {
      bucket.properties.add(prefixUri(uri));
    }

    acc[namespaceUri] = bucket;
    return acc;
  }, {});

  return sortStrings(Object.keys(groups)).map((namespaceUri) => ({
    prefix: inferPrefixFromNamespace(namespaceUri),
    namespace: namespaceUri,
    classes: sortStrings(Array.from(groups[namespaceUri].classes)),
    properties: sortStrings(Array.from(groups[namespaceUri].properties)),
  }));
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

const classifyClassRole = (
  label: string,
  definition: string,
  comment: string,
  connectionCount: number,
  hasChildren: boolean
): ClassPatternStats["role"] => {
  const text = `${label} ${definition} ${comment}`.toLowerCase();
  if (/metadata|annotation|literal|datatype|code list|codeset|provenance/.test(text)) {
    return "metadata";
  }

  if (connectionCount >= 4 || hasChildren) {
    return "core";
  }

  return "auxiliary";
};

const analyzeClassPatterns = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): ClassPatternStats[] => {
  const stats = classes.reduce<Record<string, ClassPatternStats>>((acc, ontologyClass) => {
    const prefixed = prefixUri(ontologyClass.uri);
    acc[prefixed] = {
      classUri: prefixed,
      label: ontologyClass.label,
      connectionCount: 0,
      outboundObjectProperties: [],
      inboundObjectProperties: [],
      dataProperties: [],
      role: "auxiliary",
    };
    return acc;
  }, {});

  objectProperties.forEach((property) => {
    property.domain.forEach((domainClass) => {
      if (stats[domainClass]) {
        stats[domainClass].connectionCount += 1;
        stats[domainClass].outboundObjectProperties.push(prefixUri(property.uri));
      }
    });

    property.range.forEach((rangeClass) => {
      if (stats[rangeClass]) {
        stats[rangeClass].connectionCount += 1;
        stats[rangeClass].inboundObjectProperties.push(prefixUri(property.uri));
      }
    });
  });

  dataProperties.forEach((property) => {
    property.domain.forEach((domainClass) => {
      if (stats[domainClass]) {
        stats[domainClass].connectionCount += 1;
        stats[domainClass].dataProperties.push(prefixUri(property.uri));
      }
    });
  });

  return Object.values(stats)
    .map((entry) => {
      const ontologyClass = classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri);
      const hasChildren = classes.some((candidate) => candidate.superClasses.includes(entry.classUri));
      return {
        ...entry,
        outboundObjectProperties: sortStrings(uniq(entry.outboundObjectProperties)),
        inboundObjectProperties: sortStrings(uniq(entry.inboundObjectProperties)),
        dataProperties: sortStrings(uniq(entry.dataProperties)),
        role: classifyClassRole(
          ontologyClass?.label || entry.label,
          ontologyClass?.definition || "",
          ontologyClass?.comment || "",
          entry.connectionCount,
          hasChildren
        ),
      };
    })
    .sort((left, right) => right.connectionCount - left.connectionCount || left.classUri.localeCompare(right.classUri));
};

const computePropertyChains = (connections: PropertyConnection[]): string[] => {
  const byFromClass = connections.reduce<Record<string, PropertyConnection[]>>((acc, connection) => {
    acc[connection.fromClass] = [...(acc[connection.fromClass] || []), connection];
    return acc;
  }, {});

  const chains = connections.flatMap((first) =>
    (byFromClass[first.toClass] || [])
      .filter((second) => first.toClass !== "(unspecified)" && second.toClass !== first.fromClass)
      .map((second) => `${first.fromClass} -[${first.property}]-> ${first.toClass} -[${second.property}]-> ${second.toClass}`)
  );

  return sortStrings(uniq(chains)).slice(0, 30);
};

const deriveConstraints = (
  restrictionsByClass: Record<string, RestrictionSummary[]>,
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[]
): string[] => {
  const propertyConstraints = [
    ...objectProperties.flatMap((property) =>
      property.domain.flatMap((domainClass) =>
        property.range.map((rangeClass) => `${prefixUri(property.uri)}: ${domainClass} -> ${rangeClass}`)
      )
    ),
    ...dataProperties.flatMap((property) =>
      property.domain.map((domainClass) => `${prefixUri(property.uri)}: ${domainClass} -> ${property.range}`)
    ),
  ];

  const restrictionConstraints = Object.values(restrictionsByClass)
    .flatMap((items) => items)
    .map((item) => {
      const parts = [
        `Class ${prefixUri(item.classUri)} restricted by ${item.onProperty}`,
        item.cardinality ? `cardinality=${item.cardinality}` : "",
        item.minCardinality ? `min=${item.minCardinality}` : "",
        item.maxCardinality ? `max=${item.maxCardinality}` : "",
        item.someValuesFrom.length > 0 ? `someValuesFrom=${item.someValuesFrom.join(", ")}` : "",
        item.allValuesFrom.length > 0 ? `allValuesFrom=${item.allValuesFrom.join(", ")}` : "",
        item.hasValue.length > 0 ? `hasValue=${item.hasValue.join(", ")}` : "",
      ].filter(Boolean);

      return parts.join("; ");
    });

  return sortStrings(
    uniq([
      "Use only classes and properties from the discovered ontology namespaces and referenced external vocabularies.",
      "Respect all rdfs:domain and rdfs:range declarations when building triples.",
      "Use the most specific subclass that correctly describes an entity.",
      "Treat owl:inverseOf relations as paired directions of the same semantic link.",
      ...propertyConstraints,
      ...restrictionConstraints,
    ])
  );
};

const generateMappingGuide = (
  classes: OntologyClass[],
  objectProperties: ObjectProperty[],
  dataProperties: DataProperty[],
  classPatterns: ClassPatternStats[],
  propertyChains: string[],
  restrictionsByClass: Record<string, RestrictionSummary[]>
): MappingGuide => ({
  commonPatterns: classPatterns
    .filter((entry) => entry.role !== "metadata")
    .slice(0, 20)
    .map((entry) => {
      const classUri = classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri)?.uri || "";
      const classRestrictions = restrictionsByClass[classUri] || [];
      const requiredProperties = sortStrings(
        uniq(
          classRestrictions
            .filter((item) => item.cardinality === "1" || item.minCardinality === "1")
            .map((item) => item.onProperty)
        )
      );

      const optionalProperties = sortStrings(
        uniq([...entry.outboundObjectProperties, ...entry.dataProperties].filter((item) => !requiredProperties.includes(item)))
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
        scenario: `${entry.label} mapping pattern (${entry.role}, ${entry.connectionCount} ontology links)`,
        ontologyClass: entry.classUri,
        requiredProperties,
        optionalProperties,
        relationships,
      };
    }),
  allowedNamespaces: sortStrings(uniq(Object.values(discoveredNamespaces))),
  constraints: deriveConstraints(restrictionsByClass, objectProperties, dataProperties),
});

const generateQuickReference = (
  structure: OntologyStructure,
  classPatterns: ClassPatternStats[],
  propertyChains: string[],
  mappingGuide: MappingGuide
): QuickReference => ({
  ontology: {
    title: structure.metadata.title,
    version: structure.metadata.version,
    description: structure.metadata.description,
  },
  counts: {
    classes: structure.classes.length,
    objectProperties: structure.objectProperties.length,
    dataProperties: structure.dataProperties.length,
    externalVocabularies: structure.externalVocabularies.length,
  },
  coreClasses: classPatterns.slice(0, 15).map((entry) => {
    const ontologyClass = structure.classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri);
    return {
      class: entry.classUri,
      label: entry.label,
      role: entry.role,
      description: ontologyClass?.definition || ontologyClass?.comment || "",
    };
  }),
  propertyConnections: structure.objectProperties.slice(0, 30).map((property) => ({
    property: prefixUri(property.uri),
    domain: property.domain,
    range: property.range,
  })),
  propertyChains,
  allowedNamespaces: mappingGuide.allowedNamespaces,
  constraints: mappingGuide.constraints.slice(0, 40),
});

const printSummary = (
  structure: OntologyStructure,
  parsedFiles: ParsedFile[],
  classPatterns: ClassPatternStats[]
): void => {
  console.log("");
  console.log(`Ontology: ${structure.metadata.title}`);
  console.log(`Version: ${structure.metadata.version}`);
  console.log(`Source files parsed: ${parsedFiles.map((file) => path.relative(process.cwd(), file.filePath)).join(", ")}`);
  console.log(`Classes found: ${structure.classes.length}`);
  console.log(`Object properties found: ${structure.objectProperties.length}`);
  console.log(`Data properties found: ${structure.dataProperties.length}`);
  console.log("Core classes:");
  classPatterns
    .filter((entry) => entry.role === "core")
    .slice(0, 12)
    .forEach((entry) => {
      const ontologyClass = structure.classes.find((candidate) => prefixUri(candidate.uri) === entry.classUri);
      console.log(`- ${entry.classUri}: ${ontologyClass?.definition || ontologyClass?.comment || entry.label}`);
    });
  console.log("Namespaces that can be used:");
  sortStrings(Object.entries(structure.metadata.namespaces).map(([prefix, namespace]) => `${prefix}: ${namespace}`)).forEach((entry) =>
    console.log(`- ${entry}`)
  );
};

const main = async (): Promise<void> => {
  const dataDir = path.resolve(process.env.DATA_DIR || "domain-data/geospatial");
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
  registerNamespacesFromUris(getAllNamedUris(mergedStore));
  registerOntologyPreferredNamespace(mergedStore);

  const restrictionsByClass = extractRestrictions(mergedStore);
  const classes = extractClasses(mergedStore);
  const propertyUris = extractPropertyUris(mergedStore);
  const classifiedProperties = classifyRdfProperties(
    mergedStore,
    propertyUris.explicitObjectProperties,
    propertyUris.explicitDataProperties
  );
  const objectProperties = extractObjectProperties(mergedStore, classifiedProperties.objectProperties, restrictionsByClass);
  const dataProperties = extractDataProperties(mergedStore, classifiedProperties.dataProperties);
  registerNamespacesFromUris([
    ...classes.map((item) => item.uri),
    ...objectProperties.map((item) => item.uri),
    ...dataProperties.map((item) => item.uri),
  ]);

  const metadata = extractMetadata(mergedStore, parsedFiles);
  const externalVocabularies = extractExternalVocabularies(mergedStore, classes, objectProperties, dataProperties);
  const structure: OntologyStructure = {
    metadata,
    classes,
    objectProperties,
    dataProperties,
    externalVocabularies,
  };

  const propertyConnections = extractPropertyConnections(objectProperties);
  const classPatterns = analyzeClassPatterns(classes, objectProperties, dataProperties);
  const propertyChains = computePropertyChains(propertyConnections);
  const mappingGuide = generateMappingGuide(
    classes,
    objectProperties,
    dataProperties,
    classPatterns,
    propertyChains,
    restrictionsByClass
  );
  const quickReference = generateQuickReference(structure, classPatterns, propertyChains, mappingGuide);

  writeJson(path.join(outputDir, "ontology-structure.json"), structure);
  writeJson(path.join(outputDir, "ontology-mapping-guide.json"), mappingGuide);
  writeJson(path.join(outputDir, "ontology-quick-reference.json"), quickReference);

  printSummary(structure, parsedFiles, classPatterns);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
