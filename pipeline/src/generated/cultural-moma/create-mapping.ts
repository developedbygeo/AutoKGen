import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || 'domain-data/cultural-moma';
const OUTPUT_DIR = path.join(DATA_DIR, 'output');

// ─── Interfaces ─────────────────────────────────────────────────────────────
interface ColumnProfile {
  name: string;
  inferredType: string;
  totalValues: number;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  avgLength: number;
  minNumeric?: number;
  maxNumeric?: number;
  meanNumeric?: number;
}

interface DatasetProfile {
  dataset: string;
  totalRows: number;
  totalColumns: number;
  columns: ColumnProfile[];
  supplementaryFilesUsed: boolean;
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
}

interface DataProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string;
}

interface OntologyStructure {
  metadata: {
    title: string;
    version: string;
    description: string;
    sourceFiles: string[];
    namespaces: Record<string, string>;
  };
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
  externalVocabularies: Array<{
    prefix: string;
    namespace: string;
    classes: string[];
    properties: string[];
  }>;
}

interface MappingGuide {
  commonPatterns: Array<{
    scenario: string;
    ontologyClass: string;
    requiredProperties: string[];
    optionalProperties: string[];
    relationships: string[];
  }>;
  allowedNamespaces: string[];
  constraints: string[];
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  confidence: number;
  reasoning: string;
  identifierColumn: string;
  requiredProperties: string[];
  compliant: boolean;
}

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  propertyType: 'data' | 'annotation';
  targetEntity: string;
  datatype: string;
  confidence: number;
  reasoning: string;
  compliant: boolean;
}

interface RelationshipMapping {
  columnName: string;
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  confidence: number;
  reasoning: string;
  compliant: boolean;
}

interface UnmappedColumn {
  columnName: string;
  reason: string;
  suggestion: string;
  severity: 'warning' | 'info';
}

interface MappingStrategy {
  metadata: {
    ontologyCompliant: boolean;
    complianceScore: number;
    ontologyName: string;
    ontologyVersion: string;
    allowedNamespaces: string[];
    totalColumns: number;
    mappedColumns: number;
    unmappedColumns: number;
    warnings: string[];
  };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
  unmappedColumns: UnmappedColumn[];
  validationReport: {
    classesUsed: string[];
    propertiesUsed: string[];
    namespacesUsed: string[];
    customTermsDetected: string[];
    recommendations: string[];
  };
}

// ─── Helper Functions ───────────────────────────────────────────────────────

function loadJson<T>(filePath: string): T {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Required file not found: ${fullPath}`);
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as T;
}

function loadOptionalJson<T>(filePath: string): T | null {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as T;
}

function buildAllowedClasses(ontology: OntologyStructure): Map<string, OntologyClass> {
  const classMap = new Map<string, OntologyClass>();
  for (const cls of ontology.classes) {
    classMap.set(cls.uri, cls);
    // Also index by label for fuzzy matching
    classMap.set(cls.label.toLowerCase(), cls);
  }
  // Include external vocabulary classes
  for (const vocab of ontology.externalVocabularies) {
    for (const clsName of vocab.classes) {
      const uri = resolvePrefix(clsName, ontology.metadata.namespaces);
      classMap.set(uri, {
        uri,
        label: clsName.split(':')[1] || clsName,
        definition: '',
        comment: '',
        superClasses: [],
        equivalentClasses: [],
        examples: []
      });
    }
  }
  return classMap;
}

function buildAllowedObjectProperties(ontology: OntologyStructure): Map<string, ObjectProperty> {
  const propMap = new Map<string, ObjectProperty>();
  for (const prop of ontology.objectProperties) {
    propMap.set(prop.uri, prop);
    propMap.set(prop.label.toLowerCase(), prop);
  }
  return propMap;
}

function buildAllowedDataProperties(ontology: OntologyStructure): Map<string, DataProperty> {
  const propMap = new Map<string, DataProperty>();
  for (const prop of ontology.dataProperties) {
    propMap.set(prop.uri, prop);
    propMap.set(prop.label.toLowerCase(), prop);
  }
  return propMap;
}

function buildAllowedProperties(ontology: OntologyStructure): Set<string> {
  const props = new Set<string>();
  for (const prop of ontology.objectProperties) {
    props.add(prop.uri);
  }
  for (const prop of ontology.dataProperties) {
    props.add(prop.uri);
  }
  // Include external vocabulary properties
  for (const vocab of ontology.externalVocabularies) {
    for (const propName of vocab.properties) {
      props.add(resolvePrefix(propName, ontology.metadata.namespaces));
    }
  }
  return props;
}

function resolvePrefix(prefixed: string, namespaces: Record<string, string>): string {
  const colonIdx = prefixed.indexOf(':');
  if (colonIdx === -1) return prefixed;
  const prefix = prefixed.substring(0, colonIdx);
  const local = prefixed.substring(colonIdx + 1);
  if (namespaces[prefix]) {
    return namespaces[prefix] + local;
  }
  return prefixed;
}

function toPrefixed(uri: string, namespaces: Record<string, string>): string {
  for (const [prefix, ns] of Object.entries(namespaces)) {
    if (uri.startsWith(ns)) {
      return `${prefix}:${uri.substring(ns.length)}`;
    }
  }
  return uri;
}

function computeCardinality(col: ColumnProfile, totalRows: number): 'high' | 'medium' | 'low' {
  if (col.uniqueCount === -1) {
    // uniqueCount = -1 means it exceeded threshold (very high cardinality)
    return 'high';
  }
  const ratio = col.uniqueCount / Math.max(col.totalValues, 1);
  if (ratio > 0.8) return 'high';
  if (ratio > 0.1) return 'medium';
  return 'low';
}

function normalizeForMatching(s: string): string {
  return s.toLowerCase()
    .replace(/[_\-\s]+/g, '')
    .replace(/\(.*?\)/g, '')
    .trim();
}

function similarityScore(a: string, b: string): number {
  const na = normalizeForMatching(a);
  const nb = normalizeForMatching(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  // Check for partial overlap
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length >= nb.length ? na : nb;
  if (longer.includes(shorter) && shorter.length > 3) return 0.7;
  return 0;
}

// ─── Main Mapping Logic ─────────────────────────────────────────────────────

function createMapping(): void {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           STRICT ONTOLOGY MAPPING — cultural-moma              ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  // 1. Load required files
  console.log('Loading input files...');
  const profile = loadJson<DatasetProfile>(path.join(OUTPUT_DIR, 'dataset-profile.json'));
  const ontology = loadJson<OntologyStructure>(path.join(OUTPUT_DIR, 'ontology-structure.json'));
  const mappingGuide = loadJson<MappingGuide>(path.join(OUTPUT_DIR, 'ontology-mapping-guide.json'));

  // Load optional supplementary data
  const suppIndex = loadOptionalJson<any>(path.join(OUTPUT_DIR, 'supplementary-files-index.json'));
  if (suppIndex) {
    console.log('  ✓ Supplementary files index found');
  } else {
    console.log('  ○ No supplementary files index found');
  }

  console.log(`  ✓ Dataset profile: ${profile.totalColumns} columns, ${profile.totalRows} rows`);
  console.log(`  ✓ Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  ✓ Classes: ${ontology.classes.length}, Object Properties: ${ontology.objectProperties.length}, Data Properties: ${ontology.dataProperties.length}`);

  // 2. Build allowed term indexes
  const allowedClasses = buildAllowedClasses(ontology);
  const allowedObjProps = buildAllowedObjectProperties(ontology);
  const allowedDataProps = buildAllowedDataProperties(ontology);
  const allowedPropsSet = buildAllowedProperties(ontology);
  const namespaces = ontology.metadata.namespaces;
  const allowedNamespaceList = Object.entries(namespaces).map(([prefix, ns]) => `${prefix}: ${ns}`);

  // Collect all valid class URIs for verification
  const validClassURIs = new Set<string>();
  for (const cls of ontology.classes) validClassURIs.add(cls.uri);
  for (const vocab of ontology.externalVocabularies) {
    for (const cls of vocab.classes) validClassURIs.add(resolvePrefix(cls, namespaces));
  }

  // Collect all valid property URIs
  const validPropertyURIs = new Set<string>();
  for (const prop of ontology.objectProperties) validPropertyURIs.add(prop.uri);
  for (const prop of ontology.dataProperties) validPropertyURIs.add(prop.uri);
  for (const vocab of ontology.externalVocabularies) {
    for (const p of vocab.properties) validPropertyURIs.add(resolvePrefix(p, namespaces));
  }

  console.log(`\n  Valid classes: ${validClassURIs.size}`);
  console.log(`  Valid properties: ${validPropertyURIs.size}\n`);

  // ─── Entity Detection ──────────────────────────────────────────────────────
  // MoMA dataset represents artworks (cultural heritage objects) by artists.
  // EDM core pattern: ProvidedCHO -> Aggregation -> WebResource
  // Key entities: ProvidedCHO (artworks), Agent (artists), Place, TimeSpan, Concept

  const entityMappings: EntityMapping[] = [];
  const attributeMappings: AttributeMapping[] = [];
  const relationshipMappings: RelationshipMapping[] = [];
  const unmappedColumns: UnmappedColumn[] = [];
  const warnings: string[] = [];

  // Track which columns have been mapped
  const mappedColumnNames = new Set<string>();

  // ─── Define the entity mapping strategy ──────────────────────────────────
  // Entity 1: ProvidedCHO (the artwork itself)
  // The dataset is artwork-centric: each row is an artwork with ObjectID as primary key
  entityMappings.push({
    columnName: 'ObjectID',
    ontologyClass: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    confidence: 0.95,
    reasoning: 'ObjectID is the primary identifier for each artwork record. Each row represents a cultural heritage object, which maps directly to edm:ProvidedCHO — the central class in EDM for representing cultural heritage objects. High cardinality integer with unique values per row.',
    identifierColumn: 'ObjectID',
    requiredProperties: [
      'http://purl.org/dc/elements/1.1/title',
      'http://purl.org/dc/elements/1.1/creator',
      'http://purl.org/dc/elements/1.1/date',
      'http://purl.org/dc/elements/1.1/type'
    ],
    compliant: true
  });
  mappedColumnNames.add('ObjectID');

  // Entity 2: Agent (the artist/creator)
  // ConstituentID uniquely identifies artists, with Artist/DisplayName as the label
  entityMappings.push({
    columnName: 'ConstituentID',
    ontologyClass: 'http://www.europeana.eu/schemas/edm/Agent',
    confidence: 0.95,
    reasoning: 'ConstituentID identifies individual artists/creators. The edm:Agent class is defined for "people, either individually or in groups, who have the potential to perform intentional actions." Artists clearly fit this definition. Examples in the ontology include "Leonardo da Vinci" which matches the MoMA artist data pattern.',
    identifierColumn: 'ConstituentID',
    requiredProperties: [
      'http://www.europeana.eu/schemas/edm/begin',
      'http://www.europeana.eu/schemas/edm/end'
    ],
    compliant: true
  });
  mappedColumnNames.add('ConstituentID');

  // Entity 3: Place (derived from Nationality)
  entityMappings.push({
    columnName: 'Nationality_artists',
    ontologyClass: 'http://www.europeana.eu/schemas/edm/Place',
    confidence: 0.7,
    reasoning: 'Nationality_artists column contains country/region-level geographic references (e.g., "Austrian", "French", "American"). edm:Place represents "an extent in space, in particular on the surface of the earth." Nationalities serve as place-based provenance for agents. Medium confidence because nationality is adjectival, not a proper place name.',
    identifierColumn: 'Nationality_artists',
    requiredProperties: [],
    compliant: true
  });
  mappedColumnNames.add('Nationality_artists');

  // Entity 4: TimeSpan (for artwork creation dates)
  entityMappings.push({
    columnName: 'Date',
    ontologyClass: 'http://www.europeana.eu/schemas/edm/TimeSpan',
    confidence: 0.85,
    reasoning: 'The Date column contains creation dates/periods for artworks (e.g., "1896", "1976-77"). edm:TimeSpan represents "abstract temporal extents having a beginning, an end and a duration." These date values naturally map to time spans for the creation period of cultural heritage objects.',
    identifierColumn: 'Date',
    requiredProperties: [
      'http://www.europeana.eu/schemas/edm/begin',
      'http://www.europeana.eu/schemas/edm/end'
    ],
    compliant: true
  });
  mappedColumnNames.add('Date');

  // Entity 5: Concept (for Classification/Department categories)
  entityMappings.push({
    columnName: 'Classification',
    ontologyClass: 'http://www.w3.org/2004/02/skos/core#Concept',
    confidence: 0.9,
    reasoning: 'Classification column has low cardinality (37 unique values like "Architecture", "Design", "Print"). skos:Concept is part of the EDM ontology for representing controlled vocabularies and categorization. Classification types fit this as a thesaurus/taxonomy of object types.',
    identifierColumn: 'Classification',
    requiredProperties: [],
    compliant: true
  });
  mappedColumnNames.add('Classification');

  entityMappings.push({
    columnName: 'Department',
    ontologyClass: 'http://www.w3.org/2004/02/skos/core#Concept',
    confidence: 0.85,
    reasoning: 'Department column has very low cardinality (8 unique values: "Architecture & Design", "Drawings & Prints", etc.). These organizational categories map to skos:Concept as a controlled vocabulary of museum departments.',
    identifierColumn: 'Department',
    requiredProperties: [],
    compliant: true
  });
  mappedColumnNames.add('Department');

  // Entity 6: WebResource (for URL/ImageURL)
  entityMappings.push({
    columnName: 'URL',
    ontologyClass: 'http://www.europeana.eu/schemas/edm/WebResource',
    confidence: 0.9,
    reasoning: 'URL column contains web resource links to artwork pages on moma.org (e.g., "https://www.moma.org/collection/works/2"). edm:WebResource is defined as "Information Resources that have at least one Web Representation and at least a URI." Direct match.',
    identifierColumn: 'URL',
    requiredProperties: [],
    compliant: true
  });
  mappedColumnNames.add('URL');

  // ─── Relationship Mappings ─────────────────────────────────────────────────
  // ProvidedCHO -> dc:creator -> Agent (artwork created by artist)
  relationshipMappings.push({
    columnName: 'Artist',
    ontologyRelationship: 'http://purl.org/dc/elements/1.1/creator',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    confidence: 0.95,
    reasoning: 'Artist column links artworks to their creators. dc:creator is a standard Dublin Core property used within EDM for relating cultural heritage objects to their creators/agents. The ConstituentID provides the foreign key link.',
    compliant: true
  });
  mappedColumnNames.add('Artist');

  // ProvidedCHO -> edm:hasType -> skos:Concept (classification)
  relationshipMappings.push({
    columnName: 'Classification',
    ontologyRelationship: 'http://www.europeana.eu/schemas/edm/hasType',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    targetEntity: 'http://www.w3.org/2004/02/skos/core#Concept',
    confidence: 0.9,
    reasoning: 'edm:hasType relates a resource to concepts it belongs to in a type system. Classification values ("Architecture", "Design", "Print") are exactly the kind of type categorization this property was designed for. The range is edm:NonInformationResource, and skos:Concept is a subclass.',
    compliant: true
  });
  // Classification already mapped above as entity

  // ProvidedCHO -> dc:subject -> skos:Concept (department)
  relationshipMappings.push({
    columnName: 'Department',
    ontologyRelationship: 'http://purl.org/dc/elements/1.1/subject',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    targetEntity: 'http://www.w3.org/2004/02/skos/core#Concept',
    confidence: 0.75,
    reasoning: 'Department represents the organizational subject area of the artwork. dc:subject is a valid EDM property for topical classification. Department values serve as broad subject categorization within the museum structure.',
    compliant: true
  });
  // Department already mapped above as entity

  // ProvidedCHO -> edm:isShownAt -> WebResource (URL)
  relationshipMappings.push({
    columnName: 'URL',
    ontologyRelationship: 'http://www.europeana.eu/schemas/edm/isShownAt',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    targetEntity: 'http://www.europeana.eu/schemas/edm/WebResource',
    confidence: 0.9,
    reasoning: 'edm:isShownAt provides "an unambiguous URL reference to the digital object on the provider\'s web site in its full information context." The URL column points to MoMA artwork pages, matching this exactly.',
    compliant: true
  });
  // URL already mapped as entity

  // ProvidedCHO -> edm:isShownBy -> WebResource (ImageURL)
  relationshipMappings.push({
    columnName: 'ImageURL',
    ontologyRelationship: 'http://www.europeana.eu/schemas/edm/isShownBy',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    targetEntity: 'http://www.europeana.eu/schemas/edm/WebResource',
    confidence: 0.9,
    reasoning: 'edm:isShownBy provides "an unambiguous URL reference to the digital object on the provider\'s web site in the best available resolution/quality." ImageURL contains direct image links for artworks.',
    compliant: true
  });
  mappedColumnNames.add('ImageURL');

  // Agent -> edm:happenedAt via Event / edm:hasMet for nationality-place connection
  // More accurately: Agent -> dcterms:spatial -> Place  (or we model via edm:hasMet)
  // Actually the best EDM-compliant way is: we store nationality as a dc:coverage or dcterms:spatial
  // But those don't link Agent to Place directly in EDM. Let's use edm:hasMet which is the most general.
  relationshipMappings.push({
    columnName: 'Nationality_artists',
    ontologyRelationship: 'http://www.europeana.eu/schemas/edm/hasMet',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Place',
    confidence: 0.65,
    reasoning: 'edm:hasMet is the most general contextual relationship in EDM, relating a resource with objects/phenomena encountered during its existence. An agent\'s nationality implies a connection to a place. This is the broadest valid EDM relationship for this connection. Moderate confidence because nationality is not a direct "meeting" but a cultural association.',
    compliant: true
  });

  // ProvidedCHO -> dcterms:temporal -> TimeSpan
  relationshipMappings.push({
    columnName: 'Date',
    ontologyRelationship: 'http://purl.org/dc/terms/temporal',
    sourceEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    targetEntity: 'http://www.europeana.eu/schemas/edm/TimeSpan',
    confidence: 0.85,
    reasoning: 'dcterms:temporal is a valid EDM property for temporal aspects. The Date column provides creation date/period for artworks, which is a temporal characteristic of the cultural heritage object.',
    compliant: true
  });

  // ─── Attribute Mappings ────────────────────────────────────────────────────
  // Artwork (ProvidedCHO) attributes
  attributeMappings.push({
    columnName: 'Title',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/title',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.95,
    reasoning: 'dc:title is a core Dublin Core property for the name given to a resource. Title column contains artwork names which is the primary label/title for each cultural heritage object.',
    compliant: true
  });
  mappedColumnNames.add('Title');

  attributeMappings.push({
    columnName: 'Medium',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/format',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.85,
    reasoning: 'dc:format describes the file format, physical medium, or dimensions of a resource. Medium column describes the physical materials used (e.g., "Ink and cut-and-pasted painted pages on paper"), which is the physical medium/format.',
    compliant: true
  });
  mappedColumnNames.add('Medium');

  attributeMappings.push({
    columnName: 'Dimensions',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/format',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.75,
    reasoning: 'dc:format covers physical dimensions. Dimensions column contains size descriptions (e.g., "19 1/8 x 66 1/2\" (48.6 x 168.9 cm)"). While format is broad, dc:format is the standard EDM property for physical description. Lower confidence since individual measurement columns also exist.',
    compliant: true
  });
  mappedColumnNames.add('Dimensions');

  attributeMappings.push({
    columnName: 'CreditLine',
    ontologyProperty: 'http://purl.org/dc/terms/provenance',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.85,
    reasoning: 'dcterms:provenance describes the history of ownership or custody. CreditLine indicates acquisition method and donor information (e.g., "Gift of the architect"), which is provenance metadata.',
    compliant: true
  });
  mappedColumnNames.add('CreditLine');

  attributeMappings.push({
    columnName: 'AccessionNumber',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/identifier',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.9,
    reasoning: 'dc:identifier is for an unambiguous reference to the resource within a given context. AccessionNumber (e.g., "885.1996") is the museum\'s formal identifier for each artwork, distinct from the system ObjectID.',
    compliant: true
  });
  mappedColumnNames.add('AccessionNumber');

  attributeMappings.push({
    columnName: 'DateAcquired',
    ontologyProperty: 'http://purl.org/dc/terms/provenance',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:date',
    confidence: 0.75,
    reasoning: 'dcterms:provenance covers ownership history. DateAcquired records when MoMA acquired the work, which is a provenance date. An alternative would be dcterms:issued but provenance better captures acquisition timing.',
    compliant: true
  });
  mappedColumnNames.add('DateAcquired');

  attributeMappings.push({
    columnName: 'Cataloged',
    ontologyProperty: 'http://www.europeana.eu/schemas/edm/type',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.5,
    reasoning: 'Cataloged is a boolean-like field (Y/N) indicating cataloging status. edm:type is a broad data property for material type. Low confidence — this is administrative metadata with limited ontology fit.',
    compliant: true
  });
  mappedColumnNames.add('Cataloged');

  // Agent (Artist) attributes
  attributeMappings.push({
    columnName: 'DisplayName',
    ontologyProperty: 'http://www.w3.org/2004/02/skos/core#prefLabel',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.9,
    reasoning: 'skos:prefLabel is the preferred label in SKOS, widely used in EDM for naming entities. DisplayName contains the canonical display name for artists. The skos namespace is declared in the ontology.',
    compliant: true
  });
  mappedColumnNames.add('DisplayName');

  attributeMappings.push({
    columnName: 'ArtistBio_artists',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/description',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.8,
    reasoning: 'dc:description provides a textual description of a resource. ArtistBio_artists contains biographical summaries (e.g., "Austrian, 1841–1918") which serve as concise descriptions of agents.',
    compliant: true
  });
  mappedColumnNames.add('ArtistBio_artists');

  attributeMappings.push({
    columnName: 'Gender_artists',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/description',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.6,
    reasoning: 'No specific gender property exists in EDM or its declared namespaces. dc:description can hold additional descriptive attributes. Gender_artists has clean values ("male", "female", "non-binary") as descriptive metadata for agents. Lower confidence because dc:description is a catch-all.',
    compliant: true
  });
  mappedColumnNames.add('Gender_artists');

  attributeMappings.push({
    columnName: 'BeginDate_artists',
    ontologyProperty: 'http://www.europeana.eu/schemas/edm/begin',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.95,
    reasoning: 'edm:begin "denotes the start date of a period of time." BeginDate_artists contains birth years for artists (e.g., 1841, 1944). Direct match to the edm:begin data property for agents.',
    compliant: true
  });
  mappedColumnNames.add('BeginDate_artists');

  attributeMappings.push({
    columnName: 'EndDate_artists',
    ontologyProperty: 'http://www.europeana.eu/schemas/edm/end',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.95,
    reasoning: 'edm:end "denotes the end date of a period of time." EndDate_artists contains death years for artists (e.g., 1918, 1957). 0 values indicate living artists. Direct match to the edm:end data property.',
    compliant: true
  });
  mappedColumnNames.add('EndDate_artists');

  attributeMappings.push({
    columnName: 'Wiki QID',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/identifier',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.85,
    reasoning: 'dc:identifier provides unambiguous references. Wiki QID values (e.g., "Q84287") are Wikidata identifiers that uniquely reference artists in an external knowledge base.',
    compliant: true
  });
  mappedColumnNames.add('Wiki QID');

  attributeMappings.push({
    columnName: 'ULAN',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/identifier',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/Agent',
    datatype: 'xsd:string',
    confidence: 0.85,
    reasoning: 'dc:identifier for external identifiers. ULAN values (e.g., "500016971") are Getty Union List of Artist Names identifiers — an established authority file for artists.',
    compliant: true
  });
  mappedColumnNames.add('ULAN');

  // Physical dimension attributes — mapped to dc:format on ProvidedCHO
  const dimensionColumns = [
    'Height (cm)', 'Width (cm)', 'Depth (cm)', 'Length (cm)',
    'Circumference (cm)', 'Diameter (cm)', 'Weight (kg)', 'Duration (sec.)'
  ];
  for (const dimCol of dimensionColumns) {
    const col = profile.columns.find(c => c.name === dimCol);
    if (col) {
      attributeMappings.push({
        columnName: dimCol,
        ontologyProperty: 'http://purl.org/dc/elements/1.1/format',
        propertyType: 'data',
        targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
        datatype: 'xsd:float',
        confidence: 0.7,
        reasoning: `dc:format covers physical dimensions and characteristics. ${dimCol} provides specific measurement data. Multiple dimension columns map to the same property as different aspects of physical format.`,
        compliant: true
      });
      mappedColumnNames.add(dimCol);
    }
  }

  // OnView — location within museum
  attributeMappings.push({
    columnName: 'OnView',
    ontologyProperty: 'http://purl.org/dc/elements/1.1/coverage',
    propertyType: 'data',
    targetEntity: 'http://www.europeana.eu/schemas/edm/ProvidedCHO',
    datatype: 'xsd:string',
    confidence: 0.65,
    reasoning: 'dc:coverage can indicate spatial location. OnView contains gallery locations (e.g., "MoMA, Floor 4, 417") indicating where the artwork is currently displayed. An alternative is edm:currentLocation but that expects edm:Place range. dc:coverage is more flexible for string values.',
    compliant: true
  });
  mappedColumnNames.add('OnView');

  // ─── Handle unmapped/duplicate columns ─────────────────────────────────────
  // Columns that are duplicates or cannot be cleanly mapped
  const parenthesizedDuplicates: Record<string, string> = {
    'Nationality': 'Nationality_artists',
    'BeginDate': 'BeginDate_artists',
    'EndDate': 'EndDate_artists',
    'Gender': 'Gender_artists',
    'ArtistBio': 'ArtistBio_artists'
  };

  for (const [rawCol, cleanCol] of Object.entries(parenthesizedDuplicates)) {
    if (!mappedColumnNames.has(rawCol)) {
      unmappedColumns.push({
        columnName: rawCol,
        reason: `Duplicate of ${cleanCol} with parenthesized formatting. The clean version (${cleanCol}) is mapped instead.`,
        suggestion: `Use ${cleanCol} column for mapping; ${rawCol} contains the same data with parentheses.`,
        severity: 'info'
      });
      mappedColumnNames.add(rawCol);
    }
  }

  // Seat Height — completely empty
  unmappedColumns.push({
    columnName: 'Seat Height (cm)',
    reason: 'Column has 0 values (100% missing). No data to map.',
    suggestion: 'Exclude from graph generation — no usable data.',
    severity: 'info'
  });
  mappedColumnNames.add('Seat Height (cm)');

  // Now identify any remaining unmapped columns
  for (const col of profile.columns) {
    if (!mappedColumnNames.has(col.name)) {
      // This shouldn't happen if we've been thorough, but catch any stragglers
      unmappedColumns.push({
        columnName: col.name,
        reason: 'No confident mapping found to any ontology term in EDM.',
        suggestion: 'Review column manually for potential ontology extension or custom annotation.',
        severity: 'warning'
      });
    }
  }

  // ─── Validation ────────────────────────────────────────────────────────────
  console.log('\n─── Validation ─────────────────────────────────────────────────\n');

  const classesUsed = new Set<string>();
  const propertiesUsed = new Set<string>();
  const namespacesUsed = new Set<string>();
  const customTermsDetected: string[] = [];

  // Validate entity mappings
  for (const em of entityMappings) {
    classesUsed.add(em.ontologyClass);
    const ns = extractNamespace(em.ontologyClass);
    if (ns) namespacesUsed.add(ns);

    if (!validClassURIs.has(em.ontologyClass)) {
      em.compliant = false;
      customTermsDetected.push(em.ontologyClass);
      warnings.push(`Entity ${em.columnName}: class ${em.ontologyClass} not found in ontology`);
    }
    if (em.confidence < 0.6) {
      warnings.push(`Entity ${em.columnName}: low confidence (${em.confidence}) — flagged for review`);
    }
  }

  // Validate attribute mappings
  for (const am of attributeMappings) {
    propertiesUsed.add(am.ontologyProperty);
    const ns = extractNamespace(am.ontologyProperty);
    if (ns) namespacesUsed.add(ns);

    if (!validPropertyURIs.has(am.ontologyProperty)) {
      // Check if it's from a declared namespace (skos, foaf, etc.)
      const inDeclaredNs = Object.values(namespaces).some(nsUri => am.ontologyProperty.startsWith(nsUri));
      if (!inDeclaredNs) {
        am.compliant = false;
        customTermsDetected.push(am.ontologyProperty);
        warnings.push(`Attribute ${am.columnName}: property ${am.ontologyProperty} not found in ontology or declared namespaces`);
      }
    }
    if (am.confidence < 0.6) {
      warnings.push(`Attribute ${am.columnName}: low confidence (${am.confidence}) — flagged for review`);
    }
  }

  // Validate relationship mappings
  for (const rm of relationshipMappings) {
    propertiesUsed.add(rm.ontologyRelationship);
    const ns = extractNamespace(rm.ontologyRelationship);
    if (ns) namespacesUsed.add(ns);

    if (!validPropertyURIs.has(rm.ontologyRelationship)) {
      const inDeclaredNs = Object.values(namespaces).some(nsUri => rm.ontologyRelationship.startsWith(nsUri));
      if (!inDeclaredNs) {
        rm.compliant = false;
        customTermsDetected.push(rm.ontologyRelationship);
        warnings.push(`Relationship ${rm.columnName}: property ${rm.ontologyRelationship} not found in ontology or declared namespaces`);
      }
    }
    if (rm.confidence < 0.6) {
      warnings.push(`Relationship ${rm.columnName}: low confidence (${rm.confidence}) — flagged for review`);
    }
  }

  // Verify core entity is mapped
  const coreEntityMapped = entityMappings.some(
    em => em.ontologyClass === 'http://www.europeana.eu/schemas/edm/ProvidedCHO'
  );
  if (!coreEntityMapped) {
    warnings.push('CRITICAL: edm:ProvidedCHO (core cultural heritage object class) is not mapped');
  }

  // ─── Compliance Score ────────────────────────────────────────────────────
  const totalColumns = profile.totalColumns;
  const mappedCount = entityMappings.length + attributeMappings.length + relationshipMappings.length;
  // Unique mapped columns (some columns appear in both entity and relationship)
  const uniqueMappedColumns = new Set([
    ...entityMappings.map(e => e.columnName),
    ...attributeMappings.map(a => a.columnName),
    ...relationshipMappings.map(r => r.columnName)
  ]);

  const unmappedCount = unmappedColumns.filter(u => u.severity === 'warning').length;
  const infoOnlyUnmapped = unmappedColumns.filter(u => u.severity === 'info').length;

  // Score calculation:
  // Start at 100, deduct 10 per unmapped warning column, deduct 20 per custom term
  let complianceScore = 100;
  complianceScore -= unmappedCount * 10;
  complianceScore -= customTermsDetected.length * 20;
  // Small deduction for low-confidence mappings
  const lowConfCount = [
    ...entityMappings.filter(e => e.confidence < 0.6),
    ...attributeMappings.filter(a => a.confidence < 0.6),
    ...relationshipMappings.filter(r => r.confidence < 0.6)
  ].length;
  complianceScore -= lowConfCount * 5;
  complianceScore = Math.max(0, Math.min(100, complianceScore));

  const gradeLabel = complianceScore >= 95 ? 'A' :
    complianceScore >= 80 ? 'B' :
    complianceScore >= 70 ? 'C' :
    complianceScore >= 60 ? 'D' : 'F';

  const ontologyCompliant = complianceScore >= 70 && customTermsDetected.length === 0;

  // ─── Build recommendations ─────────────────────────────────────────────────
  const recommendations: string[] = [];
  if (customTermsDetected.length > 0) {
    recommendations.push(`Remove or replace ${customTermsDetected.length} custom term(s) not in the ontology`);
  }
  if (lowConfCount > 0) {
    recommendations.push(`Review ${lowConfCount} mapping(s) with confidence < 0.6`);
  }
  if (!coreEntityMapped) {
    recommendations.push('Map at least one column to edm:ProvidedCHO as the core cultural heritage object');
  }
  if (unmappedCount > 0) {
    recommendations.push(`Review ${unmappedCount} unmapped column(s) for potential ontology terms`);
  }
  recommendations.push('Consider modeling ore:Aggregation as a structural entity linking ProvidedCHO to WebResources');
  recommendations.push('Use edm:currentLocation (object property with range edm:Place) for physical gallery location if a Place entity can be created from OnView values');

  // ─── Assemble output ──────────────────────────────────────────────────────
  const mappingStrategy: MappingStrategy = {
    metadata: {
      ontologyCompliant,
      complianceScore,
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      allowedNamespaces: allowedNamespaceList,
      totalColumns,
      mappedColumns: uniqueMappedColumns.size,
      unmappedColumns: unmappedColumns.length,
      warnings
    },
    entityMappings,
    attributeMappings,
    relationshipMappings,
    unmappedColumns,
    validationReport: {
      classesUsed: Array.from(classesUsed),
      propertiesUsed: Array.from(propertiesUsed),
      namespacesUsed: Array.from(namespacesUsed),
      customTermsDetected,
      recommendations
    }
  };

  // ─── Console Output ────────────────────────────────────────────────────────
  console.log(`  Mapped: ${uniqueMappedColumns.size}/${totalColumns} columns (${((uniqueMappedColumns.size / totalColumns) * 100).toFixed(1)}% coverage)`);
  console.log(`  Ontology Compliance: ${complianceScore}/100 (Grade: ${gradeLabel})`);
  console.log(`  Unmapped columns: ${unmappedColumns.length} (${unmappedCount} warnings, ${infoOnlyUnmapped} info)`);
  console.log(`  Custom terms: ${customTermsDetected.length}`);
  console.log(`  Compliant: ${ontologyCompliant ? 'YES' : 'NO'}`);

  console.log('\n─── Entities Detected ──────────────────────────────────────────\n');
  for (const em of entityMappings) {
    const prefixed = toPrefixed(em.ontologyClass, namespaces);
    console.log(`  ${em.columnName} → ${prefixed} (confidence: ${em.confidence})`);
  }

  console.log('\n─── Relationships ──────────────────────────────────────────────\n');
  for (const rm of relationshipMappings) {
    const prefixedRel = toPrefixed(rm.ontologyRelationship, namespaces);
    const prefixedSrc = toPrefixed(rm.sourceEntity, namespaces);
    const prefixedTgt = toPrefixed(rm.targetEntity, namespaces);
    console.log(`  ${rm.columnName}: ${prefixedSrc} → ${prefixedRel} → ${prefixedTgt} (confidence: ${rm.confidence})`);
  }

  console.log('\n─── Attribute Mappings ──────────────────────────────────────────\n');
  for (const am of attributeMappings) {
    const prefixedProp = toPrefixed(am.ontologyProperty, namespaces);
    const prefixedTarget = toPrefixed(am.targetEntity, namespaces);
    console.log(`  ${am.columnName} → ${prefixedProp} on ${prefixedTarget} (confidence: ${am.confidence})`);
  }

  if (warnings.length > 0) {
    console.log('\n─── Warnings ───────────────────────────────────────────────────\n');
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  if (unmappedColumns.length > 0) {
    console.log('\n─── Unmapped Columns ───────────────────────────────────────────\n');
    for (const u of unmappedColumns) {
      const icon = u.severity === 'warning' ? '⚠' : 'ℹ';
      console.log(`  ${icon} ${u.columnName}: ${u.reason}`);
    }
  }

  // ─── Save outputs ─────────────────────────────────────────────────────────
  const strategyPath = path.join(OUTPUT_DIR, 'mapping-strategy.json');
  fs.writeFileSync(strategyPath, JSON.stringify(mappingStrategy, null, 2), 'utf-8');
  console.log(`\n✓ Mapping strategy saved to ${strategyPath}`);

  const complianceReport = {
    metadata: {
      generatedAt: new Date().toISOString(),
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      datasetFile: profile.dataset,
      totalRows: profile.totalRows,
      totalColumns: profile.totalColumns
    },
    compliance: {
      score: complianceScore,
      grade: gradeLabel,
      isCompliant: ontologyCompliant,
      passesGatekeeper: complianceScore >= 70
    },
    coverage: {
      totalColumns,
      mappedColumns: uniqueMappedColumns.size,
      unmappedColumns: unmappedColumns.length,
      coveragePercent: ((uniqueMappedColumns.size / totalColumns) * 100).toFixed(1)
    },
    entities: {
      count: entityMappings.length,
      classes: entityMappings.map(e => ({
        column: e.columnName,
        class: toPrefixed(e.ontologyClass, namespaces),
        confidence: e.confidence,
        compliant: e.compliant
      }))
    },
    attributes: {
      count: attributeMappings.length,
      properties: attributeMappings.map(a => ({
        column: a.columnName,
        property: toPrefixed(a.ontologyProperty, namespaces),
        target: toPrefixed(a.targetEntity, namespaces),
        confidence: a.confidence,
        compliant: a.compliant
      }))
    },
    relationships: {
      count: relationshipMappings.length,
      properties: relationshipMappings.map(r => ({
        column: r.columnName,
        property: toPrefixed(r.ontologyRelationship, namespaces),
        source: toPrefixed(r.sourceEntity, namespaces),
        target: toPrefixed(r.targetEntity, namespaces),
        confidence: r.confidence,
        compliant: r.compliant
      }))
    },
    validationReport: mappingStrategy.validationReport,
    warnings: mappingStrategy.metadata.warnings,
    unmappedColumns: mappingStrategy.unmappedColumns
  };

  const reportPath = path.join(OUTPUT_DIR, 'mapping-compliance-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(complianceReport, null, 2), 'utf-8');
  console.log(`✓ Compliance report saved to ${reportPath}`);

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log(`║  MAPPING COMPLETE — Score: ${complianceScore}/100 (${gradeLabel}) — ${ontologyCompliant ? 'COMPLIANT ✓' : 'NON-COMPLIANT ✗'}      ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  if (complianceScore < 70) {
    console.error('GATEKEEPER BLOCKED: Compliance score below 70. Pipeline halted.');
    process.exit(1);
  }
}

function extractNamespace(uri: string): string | null {
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx > 0) return uri.substring(0, hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  if (slashIdx > 0) return uri.substring(0, slashIdx + 1);
  return null;
}

// ─── Execute ─────────────────────────────────────────────────────────────────
createMapping();
