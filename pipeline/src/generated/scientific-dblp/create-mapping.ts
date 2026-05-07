import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || 'domain-data/scientific-dblp';
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPrefix(uri: string, namespaces: Record<string, string>): string {
  for (const [prefix, ns] of Object.entries(namespaces)) {
    if (uri.startsWith(ns)) {
      return `${prefix}:${uri.slice(ns.length)}`;
    }
  }
  return uri;
}

function buildClassIndex(ontology: OntologyStructure): Map<string, OntologyClass> {
  const index = new Map<string, OntologyClass>();
  for (const cls of ontology.classes) {
    const prefixed = getPrefix(cls.uri, ontology.metadata.namespaces);
    index.set(prefixed, cls);
    index.set(cls.uri, cls);
    if (cls.label) {
      index.set(cls.label.toLowerCase(), cls);
    }
  }
  return index;
}

function buildDataPropertyIndex(ontology: OntologyStructure): Map<string, DataProperty> {
  const index = new Map<string, DataProperty>();
  for (const prop of ontology.dataProperties) {
    const prefixed = getPrefix(prop.uri, ontology.metadata.namespaces);
    index.set(prefixed, prop);
    index.set(prop.uri, prop);
    if (prop.label) {
      index.set(prop.label.toLowerCase(), prop);
    }
  }
  return index;
}

function buildObjectPropertyIndex(ontology: OntologyStructure): Map<string, ObjectProperty> {
  const index = new Map<string, ObjectProperty>();
  for (const prop of ontology.objectProperties) {
    const prefixed = getPrefix(prop.uri, ontology.metadata.namespaces);
    index.set(prefixed, prop);
    index.set(prop.uri, prop);
    if (prop.label) {
      index.set(prop.label.toLowerCase(), prop);
    }
  }
  return index;
}

function verifyClassExists(classRef: string, classIndex: Map<string, OntologyClass>): boolean {
  return classIndex.has(classRef);
}

function verifyPropertyExists(
  propRef: string,
  dataPropertyIndex: Map<string, DataProperty>,
  objectPropertyIndex: Map<string, ObjectProperty>
): boolean {
  return dataPropertyIndex.has(propRef) || objectPropertyIndex.has(propRef);
}

// ─── DBLP Record Type → FaBiO Class Mapping ────────────────────────────────
// DBLP has 9 record_type values. Map each to the closest FaBiO class.
// All classes below are verified to exist in ontology-structure.json.

function getRecordTypeToClassMap(): Map<string, { ontologyClass: string; confidence: number; reasoning: string }> {
  const map = new Map<string, { ontologyClass: string; confidence: number; reasoning: string }>();

  map.set('article', {
    ontologyClass: 'fabio:JournalArticle',
    confidence: 0.95,
    reasoning: 'DBLP article records are journal articles — direct match to fabio:JournalArticle (subclass of fabio:Article)'
  });

  map.set('inproceedings', {
    ontologyClass: 'fabio:ConferencePaper',
    confidence: 0.95,
    reasoning: 'DBLP inproceedings are conference papers — direct match to fabio:ConferencePaper (subclass of fabio:ProceedingsPaper)'
  });

  map.set('proceedings', {
    ontologyClass: 'fabio:ConferenceProceedings',
    confidence: 0.95,
    reasoning: 'DBLP proceedings are conference proceedings volumes — direct match to fabio:ConferenceProceedings'
  });

  map.set('book', {
    ontologyClass: 'fabio:Book',
    confidence: 0.95,
    reasoning: 'DBLP book records map directly to fabio:Book'
  });

  map.set('incollection', {
    ontologyClass: 'fabio:Chapter',
    confidence: 0.85,
    reasoning: 'DBLP incollection records are parts of books (chapters, reference entries) — fabio:Chapter is the closest FaBiO class for book section contributions'
  });

  map.set('phdthesis', {
    ontologyClass: 'fabio:DoctoralThesis',
    confidence: 0.95,
    reasoning: 'DBLP phdthesis maps directly to fabio:DoctoralThesis (subclass of fabio:Thesis)'
  });

  map.set('mastersthesis', {
    ontologyClass: 'fabio:MastersThesis',
    confidence: 0.95,
    reasoning: 'DBLP mastersthesis maps directly to fabio:MastersThesis (subclass of fabio:Thesis)'
  });

  map.set('www', {
    ontologyClass: 'fabio:WebContent',
    confidence: 0.75,
    reasoning: 'DBLP www records represent web/person pages — fabio:WebContent (information primarily for web manifestation) is the closest FaBiO class'
  });

  map.set('data', {
    ontologyClass: 'fabio:DataFile',
    confidence: 0.80,
    reasoning: 'DBLP data records represent datasets/data publications — fabio:DataFile (realization of a fabio:Dataset) is the best match'
  });

  return map;
}

// ─── Column → Data Property Mapping ─────────────────────────────────────────
// Each column mapped to a verified ontology data property with domain frbr:Endeavour or broader.

function getColumnPropertyMap(): Map<string, { ontologyProperty: string; propertyType: 'data' | 'annotation'; datatype: string; confidence: number; reasoning: string }> {
  const map = new Map<string, { ontologyProperty: string; propertyType: 'data' | 'annotation'; datatype: string; confidence: number; reasoning: string }>();

  map.set('title', {
    ontologyProperty: 'dcterms:title',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.98,
    reasoning: 'Title column maps directly to dcterms:title — standard Dublin Core title property'
  });

  map.set('year', {
    ontologyProperty: 'fabio:hasPublicationYear',
    propertyType: 'data',
    datatype: 'xsd:gYear',
    confidence: 0.95,
    reasoning: 'Year of publication maps to fabio:hasPublicationYear with gYear datatype'
  });

  map.set('mdate', {
    ontologyProperty: 'dcterms:modified',
    propertyType: 'data',
    datatype: 'xsd:dateTime',
    confidence: 0.90,
    reasoning: 'DBLP mdate is the metadata modification date — maps to dcterms:modified'
  });

  map.set('key', {
    ontologyProperty: 'dcterms:identifier',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.95,
    reasoning: 'DBLP key is a unique identifier for each record — maps to dcterms:identifier'
  });

  map.set('ee', {
    ontologyProperty: 'fabio:hasURL',
    propertyType: 'data',
    datatype: 'xsd:anyURI',
    confidence: 0.90,
    reasoning: 'DBLP ee field contains electronic edition URLs (usually DOIs) — maps to fabio:hasURL'
  });

  map.set('url', {
    ontologyProperty: 'fabio:hasURL',
    propertyType: 'data',
    datatype: 'xsd:anyURI',
    confidence: 0.85,
    reasoning: 'DBLP url field contains DBLP page URLs — maps to fabio:hasURL (second URL property for DBLP-internal link)'
  });

  map.set('pages', {
    ontologyProperty: 'prism:pageRange',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.95,
    reasoning: 'Pages field (e.g., "815-819") maps directly to prism:pageRange'
  });

  map.set('volume', {
    ontologyProperty: 'prism:volume',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.95,
    reasoning: 'Volume identifier maps directly to prism:volume'
  });

  map.set('number', {
    ontologyProperty: 'prism:issueIdentifier',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.90,
    reasoning: 'DBLP number field typically represents journal issue number — maps to prism:issueIdentifier'
  });

  map.set('isbn', {
    ontologyProperty: 'prism:isbn',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.98,
    reasoning: 'ISBN field maps directly to prism:isbn'
  });

  map.set('month', {
    ontologyProperty: 'prism:publicationDate',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.70,
    reasoning: 'Month of publication contributes to prism:publicationDate — partial date information'
  });

  map.set('note', {
    ontologyProperty: 'dcterms:abstract',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.60,
    reasoning: 'DBLP note field contains supplementary textual information — dcterms:abstract is the closest standard property for descriptive text, though notes are not always abstracts'
  });

  map.set('publnr', {
    ontologyProperty: 'fabio:hasSequenceIdentifier',
    propertyType: 'data',
    datatype: 'xsd:string',
    confidence: 0.75,
    reasoning: 'Publication number is a sequence/identifier within a context — maps to fabio:hasSequenceIdentifier'
  });

  map.set('cdrom', {
    ontologyProperty: 'fabio:hasURL',
    propertyType: 'data',
    datatype: 'xsd:anyURI',
    confidence: 0.65,
    reasoning: 'CD-ROM path is a resource locator — fabio:hasURL is the closest property for resource location references'
  });

  return map;
}

// ─── Relationship Mappings ──────────────────────────────────────────────────
// Columns that represent relationships between entities.

interface RelationshipDef {
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  confidence: number;
  reasoning: string;
}

function getRelationshipColumns(): Map<string, RelationshipDef> {
  const map = new Map<string, RelationshipDef>();

  map.set('crossref', {
    ontologyRelationship: 'frbr:partOf',
    sourceEntity: 'fabio:Expression',
    targetEntity: 'fabio:Expression',
    confidence: 0.90,
    reasoning: 'DBLP crossref links a paper to its parent proceedings/journal volume — frbr:partOf expresses part-whole containment between FRBR endeavours'
  });

  map.set('authors', {
    ontologyRelationship: 'dcterms:creator',
    sourceEntity: 'fabio:Expression',
    targetEntity: 'foaf:Person',
    confidence: 0.95,
    reasoning: 'Authors are the primary creators of works — dcterms:creator is the standard property (declared as objectProperty in ontology with open domain/range)'
  });

  map.set('editors', {
    ontologyRelationship: 'dcterms:creator',
    sourceEntity: 'fabio:Expression',
    targetEntity: 'foaf:Person',
    confidence: 0.80,
    reasoning: 'Editors are contributors/creators of proceedings and books — dcterms:creator covers this role. Note: foaf:Person is from a declared namespace but not an ontology class; relationship target will use string literals if Person class unavailable'
  });

  map.set('publisher', {
    ontologyRelationship: 'dcterms:publisher',
    sourceEntity: 'fabio:Expression',
    targetEntity: 'foaf:Organization',
    confidence: 0.90,
    reasoning: 'Publisher column maps directly to dcterms:publisher object property declared in the ontology'
  });

  map.set('cite', {
    ontologyRelationship: 'frbr:relatedEndeavour',
    sourceEntity: 'fabio:Expression',
    targetEntity: 'fabio:Expression',
    confidence: 0.75,
    reasoning: 'DBLP cite field lists referenced works — frbr:relatedEndeavour captures the generic relationship between bibliographic entities'
  });

  return map;
}

// ─── Entity Detection from Columns ──────────────────────────────────────────

function detectEntities(
  profile: DatasetProfile,
  classIndex: Map<string, OntologyClass>,
  namespaces: Record<string, string>
): EntityMapping[] {
  const entities: EntityMapping[] = [];
  const recordTypeMap = getRecordTypeToClassMap();

  // Primary entity: record_type discriminator column
  // Each DBLP record is a bibliographic entity typed by record_type
  entities.push({
    columnName: 'record_type',
    ontologyClass: 'fabio:Expression',
    confidence: 0.95,
    reasoning: 'record_type column discriminates DBLP bibliographic entity types. Each value maps to a specific FaBiO class (article→JournalArticle, inproceedings→ConferencePaper, etc.). The parent class fabio:Expression covers all.',
    identifierColumn: 'key',
    requiredProperties: ['dcterms:title', 'dcterms:identifier'],
    compliant: verifyClassExists('fabio:Expression', classIndex)
  });

  // Entity subtype mappings for each record_type value
  for (const [recordType, mapping] of recordTypeMap) {
    const classExists = verifyClassExists(mapping.ontologyClass, classIndex);
    entities.push({
      columnName: `record_type=${recordType}`,
      ontologyClass: mapping.ontologyClass,
      confidence: mapping.confidence,
      reasoning: mapping.reasoning,
      identifierColumn: 'key',
      requiredProperties: ['dcterms:title', 'dcterms:identifier'],
      compliant: classExists
    });
  }

  // Journal as a venue entity
  const journalCol = profile.columns.find(c => c.name === 'journal');
  if (journalCol) {
    entities.push({
      columnName: 'journal',
      ontologyClass: 'fabio:Journal',
      confidence: 0.90,
      reasoning: 'journal column contains journal names (2,061 unique values) — each represents a fabio:Journal venue entity',
      identifierColumn: 'journal',
      requiredProperties: ['dcterms:title'],
      compliant: verifyClassExists('fabio:Journal', classIndex)
    });
  }

  // Booktitle as a proceedings/collection entity
  const booktitleCol = profile.columns.find(c => c.name === 'booktitle');
  if (booktitleCol) {
    entities.push({
      columnName: 'booktitle',
      ontologyClass: 'fabio:AcademicProceedings',
      confidence: 0.80,
      reasoning: 'booktitle column identifies proceedings/collection venues — maps to fabio:AcademicProceedings (parent of ConferenceProceedings and WorkshopProceedings)',
      identifierColumn: 'booktitle',
      requiredProperties: ['dcterms:title'],
      compliant: verifyClassExists('fabio:AcademicProceedings', classIndex)
    });
  }

  // Series entity
  const seriesCol = profile.columns.find(c => c.name === 'series');
  if (seriesCol) {
    entities.push({
      columnName: 'series',
      ontologyClass: 'fabio:Series',
      confidence: 0.85,
      reasoning: 'series column contains publication series names (1,814 unique) — maps to fabio:Series (sequence of expressions identified as a group)',
      identifierColumn: 'series',
      requiredProperties: ['dcterms:title'],
      compliant: verifyClassExists('fabio:Series', classIndex)
    });
  }

  return entities;
}

// ─── Attribute Mapping ──────────────────────────────────────────────────────

function mapAttributes(
  profile: DatasetProfile,
  dataPropertyIndex: Map<string, DataProperty>,
  objectPropertyIndex: Map<string, ObjectProperty>,
  mappedEntityColumns: Set<string>,
  mappedRelationshipColumns: Set<string>
): { attributes: AttributeMapping[]; unmapped: UnmappedColumn[] } {
  const columnPropertyMap = getColumnPropertyMap();
  const attributes: AttributeMapping[] = [];
  const unmapped: UnmappedColumn[] = [];

  for (const col of profile.columns) {
    // Skip columns already mapped as entities or relationships
    if (mappedEntityColumns.has(col.name) || mappedRelationshipColumns.has(col.name)) continue;

    const propertyDef = columnPropertyMap.get(col.name);
    if (propertyDef) {
      const propExists = verifyPropertyExists(propertyDef.ontologyProperty, dataPropertyIndex, objectPropertyIndex);
      attributes.push({
        columnName: col.name,
        ontologyProperty: propertyDef.ontologyProperty,
        propertyType: propertyDef.propertyType,
        targetEntity: 'fabio:Expression',
        datatype: propertyDef.datatype,
        confidence: propertyDef.confidence,
        reasoning: propertyDef.reasoning,
        compliant: propExists
      });
    } else {
      // Column has no mapping — flag it
      const suggestion = suggestForUnmapped(col);
      unmapped.push({
        columnName: col.name,
        reason: suggestion.reason,
        suggestion: suggestion.suggestion,
        severity: suggestion.severity
      });
    }
  }

  return { attributes, unmapped };
}

function suggestForUnmapped(col: ColumnProfile): { reason: string; suggestion: string; severity: 'warning' | 'info' } {
  switch (col.name) {
    case 'publtype':
      return {
        reason: 'publtype is a DBLP-specific publication subtype qualifier (e.g., encyclopedia, informal, withdrawn) with no direct FaBiO data property match',
        suggestion: 'Could be used as a secondary classifier to refine entity type selection during graph generation. Consider mapping to a SKOS concept if needed.',
        severity: 'info'
      };
    case 'school':
      return {
        reason: 'school represents the academic institution for theses — no direct FaBiO property for institutional affiliation',
        suggestion: 'Use as a literal attribute on Thesis entities. In the graph generation step, this could be stored via a custom annotation or linked to a foaf:Organization if the ontology is extended.',
        severity: 'warning'
      };
    case 'address':
      return {
        reason: 'address column has only 3 values (all "New York") with 100% missing rate — negligible data coverage',
        suggestion: 'Can be safely ignored due to near-zero coverage. If needed, fabio:hasPlaceOfPublication (object property to frbr:Place) could model this, but frbr:Place is not a declared class.',
        severity: 'info'
      };
    case 'stream':
      return {
        reason: 'stream is a DBLP-internal repository/source stream identifier with no ontology equivalent',
        suggestion: 'DBLP-specific metadata. Could be stored as dcterms:identifier with a qualifier, but this would overload the property. Recommend flagging for review.',
        severity: 'info'
      };
    case 'rel':
      return {
        reason: 'rel contains DBLP-internal related record keys (99.95% missing) — sparse cross-reference with no specific FaBiO property',
        suggestion: 'Could potentially be modeled via frbr:relatedEndeavour during graph generation if values are resolved to known keys.',
        severity: 'info'
      };
    case 'chapter':
      return {
        reason: 'chapter column has only 2 values in 12.3M rows (effectively empty) — negligible data',
        suggestion: 'Can be safely ignored. If populated, could map to fabio:hasSequenceIdentifier.',
        severity: 'info'
      };
    default:
      return {
        reason: `No matching ontology property found for column "${col.name}"`,
        suggestion: 'Review column semantics against the ontology. Do not invent custom properties.',
        severity: 'warning'
      };
  }
}

// ─── Map Relationships ──────────────────────────────────────────────────────

function mapRelationships(
  profile: DatasetProfile,
  objectPropertyIndex: Map<string, ObjectProperty>,
  classIndex: Map<string, OntologyClass>
): RelationshipMapping[] {
  const relationshipColumns = getRelationshipColumns();
  const relationships: RelationshipMapping[] = [];

  for (const col of profile.columns) {
    const relDef = relationshipColumns.get(col.name);
    if (relDef) {
      const relExists = objectPropertyIndex.has(relDef.ontologyRelationship);
      relationships.push({
        columnName: col.name,
        ontologyRelationship: relDef.ontologyRelationship,
        sourceEntity: relDef.sourceEntity,
        targetEntity: relDef.targetEntity,
        confidence: relDef.confidence,
        reasoning: relDef.reasoning,
        compliant: relExists
      });
    }
  }

  // Implicit relationship: journal column → partOf Journal
  const journalCol = profile.columns.find(c => c.name === 'journal');
  if (journalCol) {
    relationships.push({
      columnName: 'journal',
      ontologyRelationship: 'frbr:partOf',
      sourceEntity: 'fabio:JournalArticle',
      targetEntity: 'fabio:Journal',
      confidence: 0.90,
      reasoning: 'Journal articles are part of journals — frbr:partOf models the containment relationship',
      compliant: objectPropertyIndex.has('frbr:partOf')
    });
  }

  // Implicit relationship: booktitle → partOf AcademicProceedings
  const booktitleCol = profile.columns.find(c => c.name === 'booktitle');
  if (booktitleCol) {
    relationships.push({
      columnName: 'booktitle',
      ontologyRelationship: 'frbr:partOf',
      sourceEntity: 'fabio:ConferencePaper',
      targetEntity: 'fabio:AcademicProceedings',
      confidence: 0.85,
      reasoning: 'Conference papers are part of proceedings — frbr:partOf models the containment relationship',
      compliant: objectPropertyIndex.has('frbr:partOf')
    });
  }

  // Implicit relationship: series → partOf Series
  const seriesCol = profile.columns.find(c => c.name === 'series');
  if (seriesCol) {
    relationships.push({
      columnName: 'series',
      ontologyRelationship: 'frbr:partOf',
      sourceEntity: 'fabio:Expression',
      targetEntity: 'fabio:Series',
      confidence: 0.80,
      reasoning: 'Publications belong to series — frbr:partOf models the membership relationship',
      compliant: objectPropertyIndex.has('frbr:partOf')
    });
  }

  return relationships;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateMapping(
  strategy: MappingStrategy,
  classIndex: Map<string, OntologyClass>,
  dataPropertyIndex: Map<string, DataProperty>,
  objectPropertyIndex: Map<string, ObjectProperty>,
  namespaces: Record<string, string>
): void {
  const warnings: string[] = [];
  const classesUsed = new Set<string>();
  const propertiesUsed = new Set<string>();
  const namespacesUsed = new Set<string>();
  const customTerms: string[] = [];

  // Validate entity mappings
  for (const entity of strategy.entityMappings) {
    classesUsed.add(entity.ontologyClass);
    if (!entity.compliant) {
      customTerms.push(entity.ontologyClass);
      warnings.push(`Entity class ${entity.ontologyClass} not found in ontology-structure.json`);
    }
    if (entity.confidence < 0.6) {
      warnings.push(`Low confidence (${entity.confidence}) for entity mapping: ${entity.columnName} → ${entity.ontologyClass}`);
    }
    extractNamespace(entity.ontologyClass, namespaces, namespacesUsed);
  }

  // Validate attribute mappings
  for (const attr of strategy.attributeMappings) {
    propertiesUsed.add(attr.ontologyProperty);
    if (!attr.compliant) {
      customTerms.push(attr.ontologyProperty);
      warnings.push(`Property ${attr.ontologyProperty} not found in ontology-structure.json`);
    }
    if (attr.confidence < 0.6) {
      warnings.push(`Low confidence (${attr.confidence}) for attribute mapping: ${attr.columnName} → ${attr.ontologyProperty}`);
    }
    extractNamespace(attr.ontologyProperty, namespaces, namespacesUsed);
  }

  // Validate relationship mappings
  for (const rel of strategy.relationshipMappings) {
    propertiesUsed.add(rel.ontologyRelationship);
    classesUsed.add(rel.sourceEntity);
    classesUsed.add(rel.targetEntity);
    if (!rel.compliant) {
      customTerms.push(rel.ontologyRelationship);
      warnings.push(`Relationship ${rel.ontologyRelationship} not found in ontology-structure.json`);
    }
    if (rel.confidence < 0.6) {
      warnings.push(`Low confidence (${rel.confidence}) for relationship mapping: ${rel.columnName} → ${rel.ontologyRelationship}`);
    }
    extractNamespace(rel.ontologyRelationship, namespaces, namespacesUsed);
    extractNamespace(rel.sourceEntity, namespaces, namespacesUsed);
    extractNamespace(rel.targetEntity, namespaces, namespacesUsed);
  }

  // Calculate compliance score
  const totalMapped = strategy.entityMappings.length + strategy.attributeMappings.length + strategy.relationshipMappings.length;
  const unmappedPenalty = strategy.unmappedColumns.length * 3; // 3 points per unmapped column (gentler for sparse DBLP columns)
  const customTermPenalty = customTerms.length * 20;
  const rawScore = Math.max(0, 100 - unmappedPenalty - customTermPenalty);
  const complianceScore = Math.min(100, rawScore);

  // Count mapped data columns (not entity sub-type entries like record_type=article)
  const dataColumnsMapped = new Set<string>();
  for (const e of strategy.entityMappings) {
    if (!e.columnName.includes('=')) dataColumnsMapped.add(e.columnName);
  }
  for (const a of strategy.attributeMappings) dataColumnsMapped.add(a.columnName);
  for (const r of strategy.relationshipMappings) dataColumnsMapped.add(r.columnName);

  const mappedColumnCount = dataColumnsMapped.size;
  const unmappedColumnCount = strategy.unmappedColumns.length;

  // Recommendations
  const recommendations: string[] = [];
  if (!classesUsed.has('fabio:JournalArticle')) {
    recommendations.push('Consider mapping to fabio:JournalArticle — the most common DBLP record type');
  }
  if (customTerms.length > 0) {
    recommendations.push(`Remove or replace ${customTerms.length} custom term(s) not in the ontology`);
  }
  if (unmappedColumnCount > 5) {
    recommendations.push(`${unmappedColumnCount} columns unmapped — review if any contain critical domain data`);
  }
  recommendations.push('During graph generation, use record_type values to instantiate specific FaBiO subclasses');
  recommendations.push('Authors/editors should be split on "|" delimiter to create individual Person entities');
  recommendations.push('The ee column often contains DOI URLs — extract DOI identifiers using prism:doi during graph generation');

  // Update strategy
  strategy.metadata.complianceScore = complianceScore;
  strategy.metadata.ontologyCompliant = complianceScore >= 70 && customTerms.length === 0;
  strategy.metadata.mappedColumns = mappedColumnCount;
  strategy.metadata.unmappedColumns = unmappedColumnCount;
  strategy.metadata.warnings = warnings;

  strategy.validationReport = {
    classesUsed: Array.from(classesUsed).sort(),
    propertiesUsed: Array.from(propertiesUsed).sort(),
    namespacesUsed: Array.from(namespacesUsed).sort(),
    customTermsDetected: customTerms,
    recommendations
  };
}

function extractNamespace(prefixedUri: string, namespaces: Record<string, string>, namespacesUsed: Set<string>): void {
  const colonIdx = prefixedUri.indexOf(':');
  if (colonIdx > 0) {
    const prefix = prefixedUri.slice(0, colonIdx);
    if (namespaces[prefix]) {
      namespacesUsed.add(prefix);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ONTOLOGY MAPPING — STRICT COMPLIANCE MODE');
  console.log('  Domain: scientific-dblp | Ontology: FaBiO v2.2');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 1. Load required files
  console.log('[1/8] Loading input files...');

  const profilePath = path.join(OUTPUT_DIR, 'dataset-profile.json');
  const ontologyPath = path.join(OUTPUT_DIR, 'ontology-structure.json');
  const guidePath = path.join(OUTPUT_DIR, 'ontology-mapping-guide.json');

  if (!fs.existsSync(profilePath)) throw new Error(`Missing: ${profilePath}`);
  if (!fs.existsSync(ontologyPath)) throw new Error(`Missing: ${ontologyPath}`);
  if (!fs.existsSync(guidePath)) throw new Error(`Missing: ${guidePath}`);

  const profile: DatasetProfile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  const ontology: OntologyStructure = JSON.parse(fs.readFileSync(ontologyPath, 'utf-8'));
  const _guide = JSON.parse(fs.readFileSync(guidePath, 'utf-8'));

  // Check for supplementary files
  const suppIndexPath = path.join(OUTPUT_DIR, 'supplementary-files-index.json');
  const hasSupplementary = fs.existsSync(suppIndexPath);
  if (hasSupplementary) {
    console.log('  → Supplementary files index found');
  } else {
    console.log('  → No supplementary files index found');
  }

  console.log(`  → Dataset: ${profile.totalRows.toLocaleString()} rows, ${profile.totalColumns} columns`);
  console.log(`  → Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  → Classes: ${ontology.classes.length} | Object Props: ${ontology.objectProperties.length} | Data Props: ${ontology.dataProperties.length}\n`);

  // 2. Build indexes
  console.log('[2/8] Building ontology indexes...');
  const classIndex = buildClassIndex(ontology);
  const dataPropertyIndex = buildDataPropertyIndex(ontology);
  const objectPropertyIndex = buildObjectPropertyIndex(ontology);
  console.log(`  → Indexed ${classIndex.size} class entries, ${dataPropertyIndex.size} data property entries, ${objectPropertyIndex.size} object property entries\n`);

  // 3. Detect entities
  console.log('[3/8] Detecting entities from dataset columns...');
  const entityMappings = detectEntities(profile, classIndex, ontology.metadata.namespaces);
  const entityColumnNames = new Set<string>();
  for (const e of entityMappings) {
    if (!e.columnName.includes('=')) entityColumnNames.add(e.columnName);
  }
  console.log(`  → Detected ${entityMappings.length} entity mappings (${entityColumnNames.size} columns)\n`);

  // 4. Map relationships
  console.log('[4/8] Mapping relationship columns...');
  const relationshipMappings = mapRelationships(profile, objectPropertyIndex, classIndex);
  const relationshipColumnNames = new Set(relationshipMappings.map(r => r.columnName));
  console.log(`  → Mapped ${relationshipMappings.length} relationships (${relationshipColumnNames.size} columns)\n`);

  // 5. Map attributes
  console.log('[5/8] Mapping attribute columns to data properties...');
  const { attributes, unmapped } = mapAttributes(profile, dataPropertyIndex, objectPropertyIndex, entityColumnNames, relationshipColumnNames);
  console.log(`  → Mapped ${attributes.length} attributes, ${unmapped.length} unmapped\n`);

  // 6. Assemble strategy
  console.log('[6/8] Assembling mapping strategy...');
  const strategy: MappingStrategy = {
    metadata: {
      ontologyCompliant: false,
      complianceScore: 0,
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      allowedNamespaces: Object.values(ontology.metadata.namespaces),
      totalColumns: profile.totalColumns,
      mappedColumns: 0,
      unmappedColumns: 0,
      warnings: []
    },
    entityMappings,
    attributeMappings: attributes,
    relationshipMappings,
    unmappedColumns: unmapped,
    validationReport: {
      classesUsed: [],
      propertiesUsed: [],
      namespacesUsed: [],
      customTermsDetected: [],
      recommendations: []
    }
  };

  // 7. Validate
  console.log('[7/8] Running compliance validation...');
  validateMapping(strategy, classIndex, dataPropertyIndex, objectPropertyIndex, ontology.metadata.namespaces);

  // 8. Save outputs
  console.log('[8/8] Saving outputs...\n');

  const strategyPath = path.join(OUTPUT_DIR, 'mapping-strategy.json');
  const reportPath = path.join(OUTPUT_DIR, 'mapping-compliance-report.json');

  fs.writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));
  fs.writeFileSync(reportPath, JSON.stringify(strategy.validationReport, null, 2));

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MAPPING RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mapped:              ${strategy.metadata.mappedColumns}/${strategy.metadata.totalColumns} columns (${Math.round(strategy.metadata.mappedColumns / strategy.metadata.totalColumns * 100)}% coverage)`);
  console.log(`  Ontology Compliance: ${strategy.metadata.complianceScore}/100 ${getGrade(strategy.metadata.complianceScore)}`);
  console.log(`  Unmapped columns:    ${strategy.metadata.unmappedColumns} (flagged for review)`);
  console.log(`  Custom terms:        ${strategy.validationReport.customTermsDetected.length}`);
  console.log(`  Warnings:            ${strategy.metadata.warnings.length}`);
  console.log('');

  // Entity detail
  console.log('  ── Entity Mappings ──');
  for (const e of entityMappings) {
    if (e.columnName.includes('=')) continue; // skip subtypes in summary
    const check = e.compliant ? '✓' : '✗';
    console.log(`    ${check} ${e.columnName} → ${e.ontologyClass} (confidence: ${e.confidence})`);
  }
  console.log('');

  // Subtype detail
  console.log('  ── Record Type Subtypes ──');
  for (const e of entityMappings) {
    if (!e.columnName.includes('=')) continue;
    const check = e.compliant ? '✓' : '✗';
    const typeName = e.columnName.split('=')[1];
    console.log(`    ${check} ${typeName} → ${e.ontologyClass} (confidence: ${e.confidence})`);
  }
  console.log('');

  // Attribute detail
  console.log('  ── Attribute Mappings ──');
  for (const a of attributes) {
    const check = a.compliant ? '✓' : '✗';
    console.log(`    ${check} ${a.columnName} → ${a.ontologyProperty} [${a.datatype}] (confidence: ${a.confidence})`);
  }
  console.log('');

  // Relationship detail
  console.log('  ── Relationship Mappings ──');
  for (const r of relationshipMappings) {
    const check = r.compliant ? '✓' : '✗';
    console.log(`    ${check} ${r.columnName} → ${r.ontologyRelationship} (${r.sourceEntity} → ${r.targetEntity}) (confidence: ${r.confidence})`);
  }
  console.log('');

  // Unmapped
  if (unmapped.length > 0) {
    console.log('  ── Unmapped Columns (Flagged for Review) ──');
    for (const u of unmapped) {
      const icon = u.severity === 'warning' ? '⚠' : 'ℹ';
      console.log(`    ${icon} ${u.columnName}: ${u.reason}`);
    }
    console.log('');
  }

  // Recommendations
  if (strategy.validationReport.recommendations.length > 0) {
    console.log('  ── Recommendations ──');
    for (const rec of strategy.validationReport.recommendations) {
      console.log(`    → ${rec}`);
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Saved: ${strategyPath}`);
  console.log(`  Saved: ${reportPath}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Fail if compliance is below threshold
  if (strategy.metadata.complianceScore < 70) {
    console.error(`\n  GATEKEEPER BLOCKED: Compliance score ${strategy.metadata.complianceScore}/100 is below threshold (70).`);
    process.exit(1);
  }

  if (strategy.validationReport.customTermsDetected.length > 0) {
    console.warn(`\n  WARNING: ${strategy.validationReport.customTermsDetected.length} custom term(s) detected — ontology compliance is not strict.`);
  }
}

function getGrade(score: number): string {
  if (score >= 95) return '(A)';
  if (score >= 80) return '(B)';
  if (score >= 70) return '(C)';
  if (score >= 60) return '(D)';
  return '(F — BLOCKED)';
}

main();
