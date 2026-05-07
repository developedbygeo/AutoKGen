import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';

// ─── Configuration ───────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || 'domain-data/cultural-moma';
const INPUT_CSV = path.resolve(DATA_DIR, 'output', 'dataset-cleaned.csv');
const MAPPING_FILE = path.resolve(DATA_DIR, 'output', 'mapping-strategy.json');
const ONTOLOGY_FILE = path.resolve(DATA_DIR, 'output', 'ontology-structure.json');
const MAPPING_GUIDE_FILE = path.resolve(DATA_DIR, 'output', 'ontology-mapping-guide.json');
const SUPPLEMENTARY_INDEX = path.resolve(DATA_DIR, 'output', 'supplementary-files-index.json');
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, 'supplementary-files');

const OUTPUT_JSON = path.resolve(DATA_DIR, 'output', 'graph-data.json');
const OUTPUT_CYPHER = path.resolve(DATA_DIR, 'output', 'graph-import.cypher');
const OUTPUT_TTL = path.resolve(DATA_DIR, 'output', 'graph-data.ttl');
const OUTPUT_STATS = path.resolve(DATA_DIR, 'output', 'graph-stats.json');
const OUTPUT_ERRORS = path.resolve(DATA_DIR, 'output', 'graph-validation-errors.json');
const TEMP_NODES = path.resolve(DATA_DIR, 'output', '.temp-nodes.ndjson');
const TEMP_RELS = path.resolve(DATA_DIR, 'output', '.temp-relationships.ndjson');

const CHUNK_SIZE = 50_000;
const BASE_URI = 'http://data.example.org/';

// ─── Types ───────────────────────────────────────────────────────────────────

type Row = Record<string, string>;

interface OntologyClass {
  uri: string;
  label: string;
  definition: string;
  superClasses: string[];
  equivalentClasses: string[];
}

interface OntologyObjectProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string[];
  superProperties: string[];
  inverseOf: string;
}

interface OntologyDataProperty {
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
  objectProperties: OntologyObjectProperty[];
  dataProperties: OntologyDataProperty[];
  externalVocabularies?: Array<{
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
  propertyType: string;
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
  severity: string;
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

interface ValidationIssue {
  type: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  entity?: string;
  property?: string;
  rowIndex?: number;
}

interface GraphStats {
  totalNodes: number;
  nodesByType: Record<string, number>;
  totalRelationships: number;
  relationshipsByType: Record<string, number>;
  validNodes: number;
  invalidNodes: number;
  validRelationships: number;
  invalidRelationships: number;
  violationsByType: Record<string, number>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 200);
}

function generateNodeId(classSlug: string, identifier: string): string {
  return `${BASE_URI}${slugify(classSlug)}/${slugify(identifier)}`;
}

function generateRelId(relType: string, fromId: string, toId: string): string {
  const fromSlug = slugify(fromId.split('/').pop() || fromId);
  const toSlug = slugify(toId.split('/').pop() || toId);
  return `${BASE_URI}rel/${slugify(relType)}/${fromSlug}--${toSlug}`;
}

function localName(uri: string): string {
  // Handle full URIs — take fragment after last # or /
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx >= 0) return uri.substring(hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  if (slashIdx >= 0) return uri.substring(slashIdx + 1);
  // Handle prefixed form
  const colonIdx = uri.indexOf(':');
  return colonIdx >= 0 ? uri.substring(colonIdx + 1) : uri;
}

function escapeCypher(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

function escapeTurtle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function elapsed(startMs: number): string {
  const sec = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${sec}s`;
}

// ─── Ontology Index ──────────────────────────────────────────────────────────

interface OntologyIndex {
  classByUri: Map<string, OntologyClass>;
  classByPrefixed: Map<string, OntologyClass>;
  objPropByUri: Map<string, OntologyObjectProperty>;
  objPropByPrefixed: Map<string, OntologyObjectProperty>;
  dataPropByUri: Map<string, OntologyDataProperty>;
  dataPropByPrefixed: Map<string, OntologyDataProperty>;
  namespaces: Map<string, string>;
  superClassMap: Map<string, Set<string>>;
  // External vocabulary properties (dc:title, dcterms:provenance, etc.)
  externalProperties: Set<string>;
}

function buildOntologyIndex(ontology: OntologyStructure): OntologyIndex {
  const classByUri = new Map<string, OntologyClass>();
  const classByPrefixed = new Map<string, OntologyClass>();
  const objPropByUri = new Map<string, OntologyObjectProperty>();
  const objPropByPrefixed = new Map<string, OntologyObjectProperty>();
  const dataPropByUri = new Map<string, OntologyDataProperty>();
  const dataPropByPrefixed = new Map<string, OntologyDataProperty>();
  const namespaces = new Map<string, string>();
  const externalProperties = new Set<string>();

  for (const [pfx, uri] of Object.entries(ontology.metadata.namespaces)) {
    namespaces.set(pfx, uri);
  }

  for (const cls of ontology.classes) {
    classByUri.set(cls.uri, cls);
    const prefixed = uriToPrefixed(cls.uri, namespaces);
    if (prefixed) classByPrefixed.set(prefixed, cls);
  }

  for (const prop of ontology.objectProperties) {
    objPropByUri.set(prop.uri, prop);
    const prefixed = uriToPrefixed(prop.uri, namespaces);
    if (prefixed) objPropByPrefixed.set(prefixed, prop);
  }

  for (const prop of ontology.dataProperties) {
    dataPropByUri.set(prop.uri, prop);
    const prefixed = uriToPrefixed(prop.uri, namespaces);
    if (prefixed) dataPropByPrefixed.set(prefixed, prop);
  }

  // Index external vocabulary properties (dc:title, dcterms:provenance, etc.)
  if (ontology.externalVocabularies) {
    for (const vocab of ontology.externalVocabularies) {
      for (const prop of vocab.properties) {
        externalProperties.add(prop);
        // Also resolve the full URI
        const fullUri = vocab.namespace + localName(prop);
        externalProperties.add(fullUri);
      }
      for (const cls of vocab.classes) {
        const fullUri = vocab.namespace + localName(cls);
        if (!classByUri.has(fullUri)) {
          const syntheticCls: OntologyClass = {
            uri: fullUri,
            label: localName(cls),
            definition: '',
            superClasses: [],
            equivalentClasses: [],
          };
          classByUri.set(fullUri, syntheticCls);
          classByPrefixed.set(cls, syntheticCls);
        }
      }
    }
  }

  // Build super class hierarchy
  const superClassMap = new Map<string, Set<string>>();
  for (const cls of classByUri.values()) {
    const prefixed = uriToPrefixed(cls.uri, namespaces);
    if (!prefixed) continue;
    const ancestors = new Set<string>();
    const queue = [...cls.superClasses];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      ancestors.add(parent);
      // Resolve parent to prefixed if it's a URI
      const parentPrefixed = parent.includes('://') ? uriToPrefixed(parent, namespaces) : parent;
      if (parentPrefixed) {
        const parentCls = classByPrefixed.get(parentPrefixed);
        if (parentCls) {
          for (const gp of parentCls.superClasses) queue.push(gp);
        }
      }
    }
    superClassMap.set(prefixed, ancestors);
  }

  return { classByUri, classByPrefixed, objPropByUri, objPropByPrefixed, dataPropByUri, dataPropByPrefixed, namespaces, superClassMap, externalProperties };
}

function uriToPrefixed(uri: string, namespaces: Map<string, string>): string | null {
  for (const [pfx, nsUri] of namespaces) {
    if (uri.startsWith(nsUri)) {
      return `${pfx}:${uri.substring(nsUri.length)}`;
    }
  }
  return null;
}

function classMatchesDomainRange(classPrefixed: string, constraintUris: string[], index: OntologyIndex): boolean {
  if (constraintUris.length === 0) return true;
  for (const constraintUri of constraintUris) {
    // Try as prefixed directly
    if (classPrefixed === constraintUri) return true;
    // Convert URI to prefixed
    const constraintPrefixed = constraintUri.includes('://') ? uriToPrefixed(constraintUri, index.namespaces) : constraintUri;
    if (!constraintPrefixed) continue;
    if (classPrefixed === constraintPrefixed) return true;
    const ancestors = index.superClassMap.get(classPrefixed);
    if (ancestors && ancestors.has(constraintPrefixed)) return true;
    // Also check using raw constraint string against ancestors
    if (ancestors && ancestors.has(constraintUri)) return true;
  }
  return false;
}

// ─── Mapping Indices ─────────────────────────────────────────────────────────

interface AttrMapEntry {
  columnName: string;
  ontologyProperty: string;
  datatype: string;
  targetEntity: string;
  confidence: number;
}

interface RelMapEntry {
  columnName: string;
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  confidence: number;
}

function buildAttributeIndex(attrs: AttributeMapping[]): Map<string, AttrMapEntry[]> {
  const map = new Map<string, AttrMapEntry[]>();
  for (const a of attrs) {
    if (!a.compliant) continue;
    const entry: AttrMapEntry = {
      columnName: a.columnName,
      ontologyProperty: a.ontologyProperty,
      datatype: a.datatype,
      targetEntity: a.targetEntity,
      confidence: a.confidence,
    };
    const existing = map.get(a.targetEntity) || [];
    existing.push(entry);
    map.set(a.targetEntity, existing);
  }
  return map;
}

function buildRelationshipIndex(rels: RelationshipMapping[]): RelMapEntry[] {
  return rels
    .filter(r => r.compliant)
    .map(r => ({
      columnName: r.columnName,
      ontologyRelationship: r.ontologyRelationship,
      sourceEntity: r.sourceEntity,
      targetEntity: r.targetEntity,
      confidence: r.confidence,
    }));
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateNodeClass(classUri: string, index: OntologyIndex): boolean {
  if (index.classByUri.has(classUri)) return true;
  const prefixed = uriToPrefixed(classUri, index.namespaces);
  if (prefixed && index.classByPrefixed.has(prefixed)) return true;
  return false;
}

function validateProperty(
  propUri: string,
  nodeClassUri: string,
  index: OntologyIndex
): { valid: boolean; reason?: string } {
  const prefixed = uriToPrefixed(propUri, index.namespaces);
  const nodeClassPrefixed = uriToPrefixed(nodeClassUri, index.namespaces);

  // Check data properties
  const dp = index.dataPropByUri.get(propUri) || (prefixed ? index.dataPropByPrefixed.get(prefixed) : undefined);
  if (dp) {
    if (dp.domain.length > 0 && nodeClassPrefixed && !classMatchesDomainRange(nodeClassPrefixed, dp.domain, index)) {
      return { valid: false, reason: `Domain mismatch: ${propUri} domain does not include ${nodeClassUri}` };
    }
    return { valid: true };
  }

  // Check object properties (some like dc:creator can be used as both)
  const op = index.objPropByUri.get(propUri) || (prefixed ? index.objPropByPrefixed.get(prefixed) : undefined);
  if (op) {
    if (op.domain.length > 0 && nodeClassPrefixed && !classMatchesDomainRange(nodeClassPrefixed, op.domain, index)) {
      return { valid: false, reason: `Domain mismatch: ${propUri} domain does not include ${nodeClassUri}` };
    }
    return { valid: true };
  }

  // Check external vocabulary properties
  if (prefixed && index.externalProperties.has(prefixed)) return { valid: true };
  if (index.externalProperties.has(propUri)) return { valid: true };

  return { valid: false, reason: `Property ${propUri} not found in ontology` };
}

function validateRelationship(
  relUri: string,
  sourceClassUri: string,
  targetClassUri: string,
  index: OntologyIndex
): { valid: boolean; reason?: string } {
  const relPrefixed = uriToPrefixed(relUri, index.namespaces);
  const sourceClassPrefixed = uriToPrefixed(sourceClassUri, index.namespaces);
  const targetClassPrefixed = uriToPrefixed(targetClassUri, index.namespaces);

  const op = index.objPropByUri.get(relUri) || (relPrefixed ? index.objPropByPrefixed.get(relPrefixed) : undefined);
  if (!op) {
    // Check external vocabulary properties
    if (relPrefixed && index.externalProperties.has(relPrefixed)) return { valid: true };
    if (index.externalProperties.has(relUri)) return { valid: true };
    return { valid: false, reason: `Relationship ${relUri} not found in ontology` };
  }

  if (op.domain.length > 0 && sourceClassPrefixed && !classMatchesDomainRange(sourceClassPrefixed, op.domain, index)) {
    return { valid: false, reason: `Domain mismatch: ${relUri} domain does not include ${sourceClassUri}` };
  }
  if (op.range.length > 0 && targetClassPrefixed && !classMatchesDomainRange(targetClassPrefixed, op.range, index)) {
    return { valid: false, reason: `Range mismatch: ${relUri} range does not include ${targetClassUri}` };
  }
  return { valid: true };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          KNOWLEDGE GRAPH GENERATION                        ║');
  console.log('║          Cultural Heritage — MoMA Collection               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  // ── 1. Load required files ──────────────────────────────────────────────

  console.log('[1/6] Loading input files...');

  for (const f of [INPUT_CSV, MAPPING_FILE, ONTOLOGY_FILE, MAPPING_GUIDE_FILE]) {
    if (!fs.existsSync(f)) {
      console.error(`  ERROR: Required file not found: ${f}`);
      process.exit(1);
    }
  }

  const mapping: MappingStrategy = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
  const ontology: OntologyStructure = JSON.parse(fs.readFileSync(ONTOLOGY_FILE, 'utf-8'));
  // Mapping guide loaded for reference — constraints enforced via ontology-structure.json
  JSON.parse(fs.readFileSync(MAPPING_GUIDE_FILE, 'utf-8'));

  // Check supplementary files (optional)
  if (fs.existsSync(SUPPLEMENTARY_INDEX)) {
    const supplementaryIndex = JSON.parse(fs.readFileSync(SUPPLEMENTARY_INDEX, 'utf-8'));
    console.log(`  Supplementary index found with ${Object.keys(supplementaryIndex).length} entries`);
    if (fs.existsSync(SUPPLEMENTARY_DIR)) {
      const suppFiles = fs.readdirSync(SUPPLEMENTARY_DIR);
      console.log(`  Supplementary files: ${suppFiles.join(', ')}`);
    }
  } else {
    console.log('  No supplementary files index found — skipping enrichment');
  }

  console.log(`  Mapping: ${path.basename(MAPPING_FILE)}`);
  console.log(`  Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  Classes: ${ontology.classes.length}, Object Props: ${ontology.objectProperties.length}, Data Props: ${ontology.dataProperties.length}`);
  console.log();

  // ── 2. Compliance validation ────────────────────────────────────────────

  console.log('[2/6] Validating mapping compliance...');

  const complianceScore = mapping.metadata.complianceScore;
  const grade =
    complianceScore >= 95 ? 'A' :
    complianceScore >= 80 ? 'B' :
    complianceScore >= 70 ? 'C' :
    complianceScore >= 60 ? 'D' : 'F';

  console.log(`  Compliance score: ${complianceScore}/100 (Grade ${grade})`);

  if (complianceScore < 60) {
    console.error('  FATAL: Compliance score below 60. Cannot generate graph.');
    console.error('  Fix mapping issues and re-run the mapping step.');
    for (const w of mapping.metadata.warnings || []) console.error(`    - ${w}`);
    process.exit(1);
  }

  if (complianceScore < 80) {
    console.log('  WARNING: Compliance score below 80. Graph will be marked as non-compliant.');
    for (const w of mapping.metadata.warnings || []) console.log(`    - ${w}`);
  } else {
    console.log('  Compliance OK — proceeding with graph generation');
  }

  const isCompliant = complianceScore >= 80;
  console.log();

  // ── 3. Build indices ────────────────────────────────────────────────────

  console.log('[3/6] Building ontology and mapping indices...');

  const index = buildOntologyIndex(ontology);

  // Build entity mapping index by class URI for quick lookup
  const entityByClass = new Map<string, EntityMapping>();
  for (const em of mapping.entityMappings) {
    if (!em.compliant) continue;
    entityByClass.set(em.ontologyClass, em);
  }

  // Group attribute mappings by target entity class
  const attrByEntity = buildAttributeIndex(mapping.attributeMappings);
  const relMappings = buildRelationshipIndex(mapping.relationshipMappings);
  const unmappedCols = new Set(mapping.unmappedColumns.map(u => u.columnName));

  // Build property URI → prefixed name map for TTL output
  const propPrefixedMap = new Map<string, string>();
  for (const attrs of attrByEntity.values()) {
    for (const attr of attrs) {
      const prefixed = uriToPrefixed(attr.ontologyProperty, index.namespaces);
      if (prefixed) propPrefixedMap.set(attr.ontologyProperty, prefixed);
    }
  }
  for (const rel of relMappings) {
    const prefixed = uriToPrefixed(rel.ontologyRelationship, index.namespaces);
    if (prefixed) propPrefixedMap.set(rel.ontologyRelationship, prefixed);
  }

  console.log(`  Entity classes: ${entityByClass.size}`);
  console.log(`  Attribute mappings: ${[...attrByEntity.values()].reduce((sum, arr) => sum + arr.length, 0)}`);
  console.log(`  Relationship mappings: ${relMappings.length}`);
  console.log(`  Unmapped columns: ${unmappedCols.size} (${[...unmappedCols].join(', ')})`);
  console.log();

  // ── 4. Streaming graph generation (two-pass) ───────────────────────────

  console.log('[4/6] Generating graph (streaming two-pass architecture)...');
  console.log('  Pass 1: Streaming CSV → nodes + temp relationships...');

  const stats: GraphStats = {
    totalNodes: 0,
    nodesByType: {},
    totalRelationships: 0,
    relationshipsByType: {},
    validNodes: 0,
    invalidNodes: 0,
    validRelationships: 0,
    invalidRelationships: 0,
    violationsByType: {},
  };

  const issues: ValidationIssue[] = [];
  const MAX_ISSUES = 10_000;

  function addIssue(issue: ValidationIssue): void {
    if (issues.length < MAX_ISSUES) issues.push(issue);
    stats.violationsByType[issue.type] = (stats.violationsByType[issue.type] || 0) + 1;
  }

  // Node dedup — stores only string IDs
  const nodeIdSet = new Set<string>();
  // Secondary entity dedup: "Classification:Architecture" → nodeId
  const secondaryNodeIds = new Map<string, string>();

  // Output streams for pass 1
  const nodeTempStream = fs.createWriteStream(TEMP_NODES, { encoding: 'utf-8' });
  const relTempStream = fs.createWriteStream(TEMP_RELS, { encoding: 'utf-8' });

  // Collect unique labels for Cypher constraints
  const uniqueLabels = new Set<string>();

  const pass1Start = Date.now();
  let rowCount = 0;
  let unmappedDataCount = 0;

  // ── Entity mapping shortcuts for MoMA data ─────────────────────────────

  // Primary entity: ProvidedCHO (each row = one artwork, identified by ObjectID)
  const choMapping = entityByClass.get('http://www.europeana.eu/schemas/edm/ProvidedCHO');
  const choClassUri = choMapping?.ontologyClass || 'http://www.europeana.eu/schemas/edm/ProvidedCHO';
  const choClassLabel = 'ProvidedCHO';

  // Secondary entities: Agent, Place, TimeSpan, Concept, WebResource
  const agentMapping = entityByClass.get('http://www.europeana.eu/schemas/edm/Agent');
  const placeMapping = entityByClass.get('http://www.europeana.eu/schemas/edm/Place');
  const timeSpanMapping = entityByClass.get('http://www.europeana.eu/schemas/edm/TimeSpan');
  const classificationMapping = mapping.entityMappings.find(
    em => em.compliant && em.columnName === 'Classification'
  );
  const departmentMapping = mapping.entityMappings.find(
    em => em.compliant && em.columnName === 'Department'
  );
  const webResourceMapping = entityByClass.get('http://www.europeana.eu/schemas/edm/WebResource');

  // Attribute mappings per entity
  const choAttrs = attrByEntity.get('http://www.europeana.eu/schemas/edm/ProvidedCHO') || [];
  const agentAttrs = attrByEntity.get('http://www.europeana.eu/schemas/edm/Agent') || [];

  // ── Pass 1: Stream CSV → temp NDJSON files for nodes and relationships ──

  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(INPUT_CSV, {
      encoding: 'utf-8',
      highWaterMark: 64 * 1024,
    });

    const csvParser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
    });

    csvParser.on('readable', () => {
      let record: Row;
      while ((record = csvParser.read()) !== null) {
        rowCount++;
        processRow(record, rowCount);

        if (rowCount % CHUNK_SIZE === 0) {
          process.stdout.write(`\r  Pass 1: ${formatNumber(rowCount)} rows processed...`);
        }
      }
    });

    csvParser.on('error', (err: Error) => {
      console.error('\n  CSV parse error:', err.message);
      reject(err);
    });

    csvParser.on('end', () => {
      process.stdout.write(`\r  Pass 1: ${formatNumber(rowCount)} rows processed — done.     \n`);
      relTempStream.end(() => {
        nodeTempStream.end(() => resolve());
      });
    });

    readStream.pipe(csvParser);
  });

  stats.totalRelationships = stats.validRelationships + stats.invalidRelationships;

  console.log(`  Pass 1 completed in ${elapsed(pass1Start)}`);
  console.log(`  Nodes: ${formatNumber(stats.totalNodes)} | Relationships: ${formatNumber(stats.totalRelationships)}`);

  // Free dedup structures
  nodeIdSet.clear();
  secondaryNodeIds.clear();

  // ── Pass 2: Stream temp files → write Cypher, TTL, JSON outputs ─────────

  console.log('  Pass 2: Writing output files from temp data...');
  const pass2Start = Date.now();

  const cypherStream = fs.createWriteStream(OUTPUT_CYPHER, { encoding: 'utf-8' });
  const ttlStream = fs.createWriteStream(OUTPUT_TTL, { encoding: 'utf-8' });
  const jsonStream = fs.createWriteStream(OUTPUT_JSON, { encoding: 'utf-8' });

  // Cypher preamble + constraints
  cypherStream.write('// ══════════════════════════════════════════════════════════════\n');
  cypherStream.write(`// Neo4j Import Script — ${ontology.metadata.title} v${ontology.metadata.version}\n`);
  cypherStream.write(`// Generated: ${new Date().toISOString()}\n`);
  cypherStream.write('// ══════════════════════════════════════════════════════════════\n\n');
  cypherStream.write('// ── Uniqueness Constraints ──────────────────────────────────\n');
  for (const label of uniqueLabels) {
    cypherStream.write(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.uri IS UNIQUE;\n`);
  }
  cypherStream.write('\n// ── Nodes ──────────────────────────────────────────────────\n');

  // TTL preamble
  for (const [pfx, uri] of index.namespaces) {
    ttlStream.write(`@prefix ${pfx}: <${uri}> .\n`);
  }
  ttlStream.write(`@prefix data: <${BASE_URI}> .\n\n`);

  // JSON preamble
  jsonStream.write('{\n');
  jsonStream.write(`  "metadata": {\n`);
  jsonStream.write(`    "generatedAt": "${new Date().toISOString()}",\n`);
  jsonStream.write(`    "ontologyName": ${JSON.stringify(ontology.metadata.title)},\n`);
  jsonStream.write(`    "ontologyVersion": ${JSON.stringify(ontology.metadata.version)},\n`);
  jsonStream.write(`    "complianceScore": ${complianceScore},\n`);
  jsonStream.write(`    "validation": {\n`);
  jsonStream.write(`      "compliant": ${isCompliant},\n`);
  jsonStream.write(`      "errors": ${stats.invalidNodes + stats.invalidRelationships},\n`);
  jsonStream.write(`      "warnings": ${issues.filter(i => i.severity === 'warning').length}\n`);
  jsonStream.write(`    }\n`);
  jsonStream.write(`  },\n`);
  jsonStream.write(`  "nodes": [\n`);

  // Stream nodes from temp file
  let nodeCount = 0;
  await streamNdjsonFile(TEMP_NODES, (obj: any) => {
    if (nodeCount > 0) jsonStream.write(',\n');
    jsonStream.write('    ' + JSON.stringify(obj));

    // Cypher MERGE for node
    const propsEntries = Object.entries(obj.properties as Record<string, any>)
      .filter(([, v]) => v !== '' && v !== null && v !== undefined);
    const propsStr = propsEntries
      .map(([k, v]) => `${sanitizeCypherKey(k)}: '${escapeCypher(String(v))}'`)
      .join(', ');
    const label = obj.labels[0];
    cypherStream.write(`MERGE (n:\`${label}\` {uri: '${escapeCypher(obj.id)}'}) SET n += {${propsStr}};\n`);

    // TTL for node
    const rdfType = obj._meta?.rdfType || `edm:${label}`;
    ttlStream.write(`<${obj.id}> a ${rdfType}`);
    for (const [k, v] of propsEntries) {
      if (k === 'uri') continue;
      const propUri = obj._meta?.propertyUriMap?.[k];
      const propPrefixed = propUri ? (propPrefixedMap.get(propUri) || `data:${k}`) : `data:${k}`;
      ttlStream.write(` ;\n  ${propPrefixed} "${escapeTurtle(String(v))}"`);
    }
    ttlStream.write(' .\n\n');

    nodeCount++;
  });

  jsonStream.write('\n  ],\n');
  jsonStream.write(`  "relationships": [\n`);

  cypherStream.write('\n// ── Relationships ──────────────────────────────────────────\n');

  // Stream relationships from temp file
  let relCount = 0;
  await streamNdjsonFile(TEMP_RELS, (obj: any) => {
    if (relCount > 0) jsonStream.write(',\n');
    jsonStream.write('    ' + JSON.stringify(obj));

    // Cypher MATCH/MERGE for relationship
    const fromLabel = obj._meta?.fromLabel || 'Resource';
    const toLabel = obj._meta?.toLabel || 'Resource';
    cypherStream.write(`MATCH (a:\`${fromLabel}\` {uri: '${escapeCypher(obj.from)}'}), (b:\`${toLabel}\` {uri: '${escapeCypher(obj.to)}'}) MERGE (a)-[:\`${obj.type}\`]->(b);\n`);

    // TTL triple
    const relPrefixed = propPrefixedMap.get(obj._meta?.relUri || '') || `data:${obj.type}`;
    ttlStream.write(`<${obj.from}> ${relPrefixed} <${obj.to}> .\n`);

    relCount++;
    if (relCount % CHUNK_SIZE === 0) {
      process.stdout.write(`\r  Pass 2: ${formatNumber(nodeCount)} nodes, ${formatNumber(relCount)} relationships written...`);
    }
  });

  process.stdout.write(`\r  Pass 2: ${formatNumber(nodeCount)} nodes, ${formatNumber(relCount)} relationships written — done.     \n`);

  // Close JSON
  jsonStream.write('\n  ],\n');
  jsonStream.write(`  "statistics": {\n`);
  jsonStream.write(`    "totalNodes": ${stats.totalNodes},\n`);
  jsonStream.write(`    "nodesByType": ${JSON.stringify(stats.nodesByType)},\n`);
  jsonStream.write(`    "totalRelationships": ${stats.totalRelationships},\n`);
  jsonStream.write(`    "relationshipsByType": ${JSON.stringify(stats.relationshipsByType)}\n`);
  jsonStream.write(`  }\n`);
  jsonStream.write('}\n');

  // End all streams and wait
  await Promise.all([
    new Promise<void>(r => cypherStream.end(() => r())),
    new Promise<void>(r => ttlStream.end(() => r())),
    new Promise<void>(r => jsonStream.end(() => r())),
  ]);

  console.log(`  Pass 2 completed in ${elapsed(pass2Start)}`);

  // Clean up temp files
  try { fs.unlinkSync(TEMP_NODES); } catch {}
  try { fs.unlinkSync(TEMP_RELS); } catch {}

  console.log();

  // ── 5. Write stats and errors ─────────────────────────────────────────

  console.log('[5/6] Writing statistics and validation report...');

  const totalNodes = stats.totalNodes;
  const totalRels = stats.totalRelationships;
  const avgDegree = totalNodes > 0 ? (2 * stats.validRelationships) / totalNodes : 0;
  const maxPossibleEdges = totalNodes > 1 ? totalNodes * (totalNodes - 1) : 1;
  const density = stats.validRelationships / maxPossibleEdges;

  const statsReport = {
    summary: {
      totalNodes,
      totalRelationships: totalRels,
      avgDegree: parseFloat(avgDegree.toFixed(4)),
      density: parseFloat(density.toExponential(4)),
    },
    nodeStatistics: {
      byType: stats.nodesByType,
      withIssues: stats.invalidNodes,
      compliant: stats.validNodes,
    },
    relationshipStatistics: {
      byType: stats.relationshipsByType,
      withIssues: stats.invalidRelationships,
      compliant: stats.validRelationships,
    },
    complianceMetrics: {
      overallScore: complianceScore,
      validNodesPercent: totalNodes > 0 ? parseFloat(((stats.validNodes / totalNodes) * 100).toFixed(2)) : 0,
      validRelationshipsPercent: totalRels > 0 ? parseFloat(((stats.validRelationships / totalRels) * 100).toFixed(2)) : 0,
      unmappedDataPercent: rowCount > 0 ? parseFloat(((unmappedDataCount / (rowCount * Math.max(unmappedCols.size, 1))) * 100).toFixed(2)) : 0,
    },
    issues: summarizeIssues(),
  };

  fs.writeFileSync(OUTPUT_STATS, JSON.stringify(statsReport, null, 2), 'utf-8');
  console.log(`  Stats: ${OUTPUT_STATS}`);

  if (issues.length > 0) {
    fs.writeFileSync(OUTPUT_ERRORS, JSON.stringify({
      totalIssues: Object.values(stats.violationsByType).reduce((a, b) => a + b, 0),
      issuesCaptured: issues.length,
      maxIssuesCaptured: MAX_ISSUES,
      violationsByType: stats.violationsByType,
      issues: issues.slice(0, 1000),
    }, null, 2), 'utf-8');
    console.log(`  Errors: ${OUTPUT_ERRORS}`);
  }

  // ── 6. Summary ────────────────────────────────────────────────────────

  console.log();
  console.log('[6/6] Generation complete.');
  console.log();
  const totalTime = elapsed(startTime);
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              GRAPH GENERATION SUMMARY                      ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Ontology:         ${(ontology.metadata.title + ' v' + ontology.metadata.version).padEnd(39)}║`);
  console.log(`║  Compliance:       ${String(complianceScore + '/100 (Grade ' + grade + ')').padEnd(39)}║`);
  console.log(`║  Rows processed:   ${formatNumber(rowCount).padEnd(39)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  NODES                                                     ║');
  console.log(`║    Total:          ${formatNumber(totalNodes).padEnd(39)}║`);
  console.log(`║    Valid:          ${formatNumber(stats.validNodes).padEnd(39)}║`);
  console.log(`║    Invalid:        ${formatNumber(stats.invalidNodes).padEnd(39)}║`);

  const sortedNodeTypes = Object.entries(stats.nodesByType).sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sortedNodeTypes.slice(0, 10)) {
    const shortLabel = localName(label);
    console.log(`║    ${shortLabel.padEnd(17)}${formatNumber(count).padEnd(39)}║`);
  }
  if (sortedNodeTypes.length > 10) {
    console.log(`║    ... and ${sortedNodeTypes.length - 10} more types`.padEnd(61) + '║');
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  RELATIONSHIPS                                             ║');
  console.log(`║    Total:          ${formatNumber(totalRels).padEnd(39)}║`);
  console.log(`║    Valid:          ${formatNumber(stats.validRelationships).padEnd(39)}║`);
  console.log(`║    Invalid:        ${formatNumber(stats.invalidRelationships).padEnd(39)}║`);

  const sortedRelTypes = Object.entries(stats.relationshipsByType).sort((a, b) => b[1] - a[1]);
  for (const [relType, count] of sortedRelTypes) {
    const shortRel = localName(relType);
    console.log(`║    ${shortRel.padEnd(17)}${formatNumber(count).padEnd(39)}║`);
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  VALIDATION                                                ║');
  console.log(`║    Node compliance:  ${statsReport.complianceMetrics.validNodesPercent}%`.padEnd(61) + '║');
  console.log(`║    Rel compliance:   ${statsReport.complianceMetrics.validRelationshipsPercent}%`.padEnd(61) + '║');
  console.log(`║    Unmapped columns: ${unmappedCols.size}`.padEnd(61) + '║');

  if (Object.keys(stats.violationsByType).length > 0) {
    console.log('║  Violations:                                               ║');
    for (const [vType, count] of Object.entries(stats.violationsByType).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`║    ${vType.padEnd(17)}${formatNumber(count).padEnd(39)}║`);
    }
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  OUTPUT FILES                                              ║');
  for (const f of [OUTPUT_JSON, OUTPUT_CYPHER, OUTPUT_TTL, OUTPUT_STATS]) {
    if (fs.existsSync(f)) {
      const size = formatBytes(fs.statSync(f).size);
      console.log(`║    ${path.basename(f).padEnd(28)}${size.padEnd(28)}║`);
    }
  }
  if (issues.length > 0 && fs.existsSync(OUTPUT_ERRORS)) {
    const size = formatBytes(fs.statSync(OUTPUT_ERRORS).size);
    console.log(`║    ${path.basename(OUTPUT_ERRORS).padEnd(28)}${size.padEnd(28)}║`);
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Time: ${totalTime.padEnd(51)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ═══════════════════════════════════════════════════════════════════════
  // Inner functions
  // ═══════════════════════════════════════════════════════════════════════

  function processRow(row: Row, rowIdx: number): void {
    const objectId = (row['ObjectID'] || '').trim();

    if (!objectId) {
      addIssue({ type: 'missing-identifier', severity: 'warning', message: `Row ${rowIdx}: missing ObjectID`, rowIndex: rowIdx });
      return;
    }

    // ── Create ProvidedCHO node (artwork) ────────────────────────────

    const choNodeId = generateNodeId(choClassLabel, objectId);

    if (!nodeIdSet.has(choNodeId)) {
      nodeIdSet.add(choNodeId);

      const classValid = validateNodeClass(choClassUri, index);
      if (!classValid) {
        addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${choClassUri} not in ontology`, entity: choNodeId, rowIndex: rowIdx });
        stats.invalidNodes++;
      } else {
        stats.validNodes++;
      }

      stats.totalNodes++;
      stats.nodesByType[choClassUri] = (stats.nodesByType[choClassUri] || 0) + 1;
      uniqueLabels.add(choClassLabel);

      // Build properties from attribute mappings targeting ProvidedCHO
      const props: Record<string, any> = {};
      const propertyUriMap: Record<string, string> = {};
      props['uri'] = choNodeId;
      props['objectId'] = objectId;

      for (const attr of choAttrs) {
        const val = (row[attr.columnName] || '').trim();
        if (!val) continue;

        const propCheck = validateProperty(attr.ontologyProperty, choClassUri, index);
        if (!propCheck.valid) {
          addIssue({
            type: 'invalid-property',
            severity: 'warning',
            message: propCheck.reason || `Property ${attr.ontologyProperty} invalid for ${choClassUri}`,
            entity: choNodeId,
            property: attr.ontologyProperty,
            rowIndex: rowIdx,
          });
        }

        // Use a descriptive key combining property local name and column for disambiguation
        const propKey = makePropKey(attr.ontologyProperty, attr.columnName);
        if (attr.datatype === 'xsd:float') {
          const num = parseFloat(val);
          if (!isNaN(num)) {
            props[propKey] = num;
          }
        } else if (attr.datatype === 'xsd:date') {
          props[propKey] = val;
        } else {
          props[propKey] = val;
        }
        propertyUriMap[propKey] = attr.ontologyProperty;
      }

      const rdfType = uriToPrefixed(choClassUri, index.namespaces) || `edm:${choClassLabel}`;
      nodeTempStream.write(JSON.stringify({
        id: choNodeId,
        labels: [choClassLabel],
        properties: props,
        _meta: { sourceRow: rowIdx, confidence: choMapping?.confidence || 0.95, compliant: classValid, rdfType, propertyUriMap },
      }) + '\n');
    }

    // ── Create Agent node (artist) ───────────────────────────────────

    const constituentId = (row['ConstituentID'] || '').trim();
    if (constituentId && agentMapping) {
      const agentClassUri = agentMapping.ontologyClass;
      const agentLabel = 'Agent';
      const agentKey = `Agent:${constituentId}`;

      if (!secondaryNodeIds.has(agentKey)) {
        const agentNodeId = generateNodeId(agentLabel, constituentId);
        secondaryNodeIds.set(agentKey, agentNodeId);

        if (!nodeIdSet.has(agentNodeId)) {
          nodeIdSet.add(agentNodeId);

          const classValid = validateNodeClass(agentClassUri, index);
          if (!classValid) {
            addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${agentClassUri} not in ontology`, entity: agentNodeId, rowIndex: rowIdx });
            stats.invalidNodes++;
          } else {
            stats.validNodes++;
          }

          stats.totalNodes++;
          stats.nodesByType[agentClassUri] = (stats.nodesByType[agentClassUri] || 0) + 1;
          uniqueLabels.add(agentLabel);

          const agentProps: Record<string, any> = {};
          const agentPropUriMap: Record<string, string> = {};
          agentProps['uri'] = agentNodeId;
          agentProps['constituentId'] = constituentId;

          for (const attr of agentAttrs) {
            const val = (row[attr.columnName] || '').trim();
            if (!val || val === '0') continue;

            const propCheck = validateProperty(attr.ontologyProperty, agentClassUri, index);
            if (!propCheck.valid) {
              addIssue({
                type: 'invalid-property',
                severity: 'warning',
                message: propCheck.reason || `Property ${attr.ontologyProperty} invalid for ${agentClassUri}`,
                entity: agentNodeId,
                property: attr.ontologyProperty,
                rowIndex: rowIdx,
              });
            }

            const propKey = makePropKey(attr.ontologyProperty, attr.columnName);
            agentProps[propKey] = val;
            agentPropUriMap[propKey] = attr.ontologyProperty;
          }

          const rdfType = uriToPrefixed(agentClassUri, index.namespaces) || `edm:${agentLabel}`;
          nodeTempStream.write(JSON.stringify({
            id: agentNodeId,
            labels: [agentLabel],
            properties: agentProps,
            _meta: { sourceRow: rowIdx, confidence: agentMapping.confidence, compliant: classValid, rdfType, propertyUriMap: agentPropUriMap },
          }) + '\n');
        }
      }
    }

    // ── Create Place node (nationality) ──────────────────────────────

    const nationality = (row['Nationality_artists'] || '').trim();
    if (nationality && placeMapping) {
      const placeClassUri = placeMapping.ontologyClass;
      const placeLabel = 'Place';
      const placeKey = `Place:${nationality}`;

      if (!secondaryNodeIds.has(placeKey)) {
        const placeNodeId = generateNodeId(placeLabel, nationality);
        secondaryNodeIds.set(placeKey, placeNodeId);

        if (!nodeIdSet.has(placeNodeId)) {
          nodeIdSet.add(placeNodeId);

          const classValid = validateNodeClass(placeClassUri, index);
          if (!classValid) {
            addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${placeClassUri} not in ontology`, entity: placeNodeId, rowIndex: rowIdx });
            stats.invalidNodes++;
          } else {
            stats.validNodes++;
          }

          stats.totalNodes++;
          stats.nodesByType[placeClassUri] = (stats.nodesByType[placeClassUri] || 0) + 1;
          uniqueLabels.add(placeLabel);

          const rdfType = uriToPrefixed(placeClassUri, index.namespaces) || `edm:${placeLabel}`;
          nodeTempStream.write(JSON.stringify({
            id: placeNodeId,
            labels: [placeLabel],
            properties: { uri: placeNodeId, name: nationality },
            _meta: { sourceRow: rowIdx, confidence: placeMapping.confidence, compliant: classValid, rdfType, propertyUriMap: {} },
          }) + '\n');
        }
      }
    }

    // ── Create TimeSpan node (date) ──────────────────────────────────

    const dateVal = (row['Date'] || '').trim();
    if (dateVal && timeSpanMapping) {
      const tsClassUri = timeSpanMapping.ontologyClass;
      const tsLabel = 'TimeSpan';
      const tsKey = `TimeSpan:${dateVal}`;

      if (!secondaryNodeIds.has(tsKey)) {
        const tsNodeId = generateNodeId('time-span', dateVal);
        secondaryNodeIds.set(tsKey, tsNodeId);

        if (!nodeIdSet.has(tsNodeId)) {
          nodeIdSet.add(tsNodeId);

          const classValid = validateNodeClass(tsClassUri, index);
          if (!classValid) {
            addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${tsClassUri} not in ontology`, entity: tsNodeId, rowIndex: rowIdx });
            stats.invalidNodes++;
          } else {
            stats.validNodes++;
          }

          stats.totalNodes++;
          stats.nodesByType[tsClassUri] = (stats.nodesByType[tsClassUri] || 0) + 1;
          uniqueLabels.add(tsLabel);

          // Parse date into begin/end
          const { begin, end } = parseDateRange(dateVal);

          const rdfType = uriToPrefixed(tsClassUri, index.namespaces) || `edm:${tsLabel}`;
          nodeTempStream.write(JSON.stringify({
            id: tsNodeId,
            labels: [tsLabel],
            properties: { uri: tsNodeId, label: dateVal, begin, end },
            _meta: {
              sourceRow: rowIdx,
              confidence: timeSpanMapping.confidence,
              compliant: classValid,
              rdfType,
              propertyUriMap: {
                label: 'http://www.w3.org/2004/02/skos/core#prefLabel',
                begin: 'http://www.europeana.eu/schemas/edm/begin',
                end: 'http://www.europeana.eu/schemas/edm/end',
              },
            },
          }) + '\n');
        }
      }
    }

    // ── Create Concept nodes (Classification, Department) ────────────

    const classification = (row['Classification'] || '').trim();
    if (classification && classificationMapping) {
      createConceptNode(classification, 'Classification', classificationMapping.ontologyClass, classificationMapping.confidence, rowIdx);
    }

    const department = (row['Department'] || '').trim();
    if (department && departmentMapping) {
      createConceptNode(department, 'Department', departmentMapping.ontologyClass, departmentMapping.confidence, rowIdx);
    }

    // ── Create WebResource nodes (URL, ImageURL) ─────────────────────

    const url = (row['URL'] || '').trim();
    if (url && webResourceMapping) {
      createWebResourceNode(url, webResourceMapping.ontologyClass, webResourceMapping.confidence, rowIdx);
    }

    const imageUrl = (row['ImageURL'] || '').trim();
    if (imageUrl && webResourceMapping) {
      createWebResourceNode(imageUrl, webResourceMapping.ontologyClass, webResourceMapping.confidence, rowIdx);
    }

    // ── Create Relationships ─────────────────────────────────────────

    for (const relMap of relMappings) {
      const val = (row[relMap.columnName] || '').trim();
      if (!val) continue;

      let sourceNodeId: string;
      let targetNodeId: string;
      let sourceLabel: string;
      let targetLabel: string;

      // Determine source and target based on mapping
      if (relMap.sourceEntity === 'http://www.europeana.eu/schemas/edm/ProvidedCHO') {
        sourceNodeId = choNodeId;
        sourceLabel = choClassLabel;
      } else if (relMap.sourceEntity === 'http://www.europeana.eu/schemas/edm/Agent') {
        const agentKey = `Agent:${constituentId}`;
        sourceNodeId = secondaryNodeIds.get(agentKey) || generateNodeId('Agent', constituentId);
        sourceLabel = 'Agent';
      } else {
        sourceNodeId = choNodeId;
        sourceLabel = choClassLabel;
      }

      // Determine target
      if (relMap.targetEntity === 'http://www.europeana.eu/schemas/edm/Agent') {
        const agentKey = `Agent:${constituentId}`;
        targetNodeId = secondaryNodeIds.get(agentKey) || generateNodeId('Agent', constituentId);
        targetLabel = 'Agent';
      } else if (relMap.targetEntity === 'http://www.europeana.eu/schemas/edm/Place') {
        const placeKey = `Place:${val}`;
        targetNodeId = secondaryNodeIds.get(placeKey) || generateNodeId('Place', val);
        targetLabel = 'Place';
      } else if (relMap.targetEntity === 'http://www.europeana.eu/schemas/edm/TimeSpan') {
        const tsKey = `TimeSpan:${val}`;
        targetNodeId = secondaryNodeIds.get(tsKey) || generateNodeId('time-span', val);
        targetLabel = 'TimeSpan';
      } else if (relMap.targetEntity === 'http://www.w3.org/2004/02/skos/core#Concept') {
        // For Classification and Department — use the column-specific key
        const conceptKey = `Concept:${relMap.columnName}:${val}`;
        targetNodeId = secondaryNodeIds.get(conceptKey) || generateNodeId('concept', `${relMap.columnName}-${val}`);
        targetLabel = 'Concept';
      } else if (relMap.targetEntity === 'http://www.europeana.eu/schemas/edm/WebResource') {
        const wrKey = `WebResource:${val}`;
        targetNodeId = secondaryNodeIds.get(wrKey) || generateNodeId('web-resource', val);
        targetLabel = 'WebResource';
      } else {
        targetNodeId = generateNodeId(localName(relMap.targetEntity), val);
        targetLabel = localName(relMap.targetEntity);
      }

      // Skip if source or target is missing
      if (!sourceNodeId || !targetNodeId) continue;

      // Validate relationship
      const relCheck = validateRelationship(relMap.ontologyRelationship, relMap.sourceEntity, relMap.targetEntity, index);
      if (!relCheck.valid) {
        addIssue({
          type: 'invalid-relationship',
          severity: 'warning',
          message: relCheck.reason || `Relationship ${relMap.ontologyRelationship} invalid`,
          entity: sourceNodeId,
          property: relMap.ontologyRelationship,
          rowIndex: rowIdx,
        });
        stats.invalidRelationships++;
      } else {
        stats.validRelationships++;
      }

      stats.relationshipsByType[relMap.ontologyRelationship] = (stats.relationshipsByType[relMap.ontologyRelationship] || 0) + 1;

      relTempStream.write(JSON.stringify({
        id: generateRelId(localName(relMap.ontologyRelationship), sourceNodeId, targetNodeId),
        type: localName(relMap.ontologyRelationship),
        from: sourceNodeId,
        to: targetNodeId,
        properties: {},
        _meta: {
          confidence: relMap.confidence,
          compliant: relCheck.valid,
          sourceRow: rowIdx,
          relUri: relMap.ontologyRelationship,
          fromLabel: sourceLabel,
          toLabel: targetLabel,
        },
      }) + '\n');
    }

    // Track unmapped data
    for (const col of unmappedCols) {
      if ((row[col] || '').trim()) unmappedDataCount++;
    }
  }

  function createConceptNode(value: string, category: string, classUri: string, confidence: number, rowIdx: number): void {
    const conceptLabel = 'Concept';
    const conceptKey = `Concept:${category}:${value}`;

    if (!secondaryNodeIds.has(conceptKey)) {
      const conceptNodeId = generateNodeId('concept', `${category}-${value}`);
      secondaryNodeIds.set(conceptKey, conceptNodeId);

      if (!nodeIdSet.has(conceptNodeId)) {
        nodeIdSet.add(conceptNodeId);

        const classValid = validateNodeClass(classUri, index);
        if (!classValid) {
          addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${classUri} not in ontology`, entity: conceptNodeId, rowIndex: rowIdx });
          stats.invalidNodes++;
        } else {
          stats.validNodes++;
        }

        stats.totalNodes++;
        stats.nodesByType[classUri] = (stats.nodesByType[classUri] || 0) + 1;
        uniqueLabels.add(conceptLabel);

        const rdfType = uriToPrefixed(classUri, index.namespaces) || `skos:${conceptLabel}`;
        nodeTempStream.write(JSON.stringify({
          id: conceptNodeId,
          labels: [conceptLabel],
          properties: { uri: conceptNodeId, prefLabel: value, category },
          _meta: {
            sourceRow: rowIdx,
            confidence,
            compliant: classValid,
            rdfType,
            propertyUriMap: {
              prefLabel: 'http://www.w3.org/2004/02/skos/core#prefLabel',
            },
          },
        }) + '\n');
      }
    }
  }

  function createWebResourceNode(url: string, classUri: string, confidence: number, rowIdx: number): void {
    const wrLabel = 'WebResource';
    const wrKey = `WebResource:${url}`;

    if (!secondaryNodeIds.has(wrKey)) {
      const wrNodeId = generateNodeId('web-resource', url);
      secondaryNodeIds.set(wrKey, wrNodeId);

      if (!nodeIdSet.has(wrNodeId)) {
        nodeIdSet.add(wrNodeId);

        const classValid = validateNodeClass(classUri, index);
        if (!classValid) {
          addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${classUri} not in ontology`, entity: wrNodeId, rowIndex: rowIdx });
          stats.invalidNodes++;
        } else {
          stats.validNodes++;
        }

        stats.totalNodes++;
        stats.nodesByType[classUri] = (stats.nodesByType[classUri] || 0) + 1;
        uniqueLabels.add(wrLabel);

        const rdfType = uriToPrefixed(classUri, index.namespaces) || `edm:${wrLabel}`;
        nodeTempStream.write(JSON.stringify({
          id: wrNodeId,
          labels: [wrLabel],
          properties: { uri: wrNodeId, resourceUrl: url },
          _meta: { sourceRow: rowIdx, confidence, compliant: classValid, rdfType, propertyUriMap: {} },
        }) + '\n');
      }
    }
  }

  function summarizeIssues(): Array<{ type: string; severity: string; count: number; examples: string[] }> {
    const grouped = new Map<string, { severity: string; examples: string[] }>();

    for (const issue of issues) {
      const key = `${issue.type}:${issue.severity}`;
      const entry = grouped.get(key) || { severity: issue.severity, examples: [] };
      if (entry.examples.length < 3) entry.examples.push(issue.message);
      grouped.set(key, entry);
    }

    const result: Array<{ type: string; severity: string; count: number; examples: string[] }> = [];
    for (const [key, entry] of grouped) {
      const type = key.split(':')[0];
      const fullCount = stats.violationsByType[type] || 0;
      result.push({ type, severity: entry.severity, count: fullCount, examples: entry.examples });
    }

    return result.sort((a, b) => b.count - a.count);
  }
}

// ─── Utility: Parse date range ("1976-77" → {begin: "1976", end: "1977"}) ───

function parseDateRange(dateStr: string): { begin: string; end: string } {
  // Handle "c. 1900", "c.1900"
  const cleaned = dateStr.replace(/^c\.?\s*/i, '').trim();

  // "1976-77" → begin=1976, end=1977
  const dashMatch = cleaned.match(/^(\d{4})-(\d{2,4})$/);
  if (dashMatch) {
    const begin = dashMatch[1];
    let end = dashMatch[2];
    if (end.length === 2) {
      end = begin.substring(0, 2) + end;
    }
    return { begin, end };
  }

  // "1980-81" already handled above
  // Single year "1896"
  const singleYear = cleaned.match(/^(\d{4})$/);
  if (singleYear) {
    return { begin: singleYear[1], end: singleYear[1] };
  }

  // Full date "1996-04-09"
  const fullDate = cleaned.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (fullDate) {
    return { begin: fullDate[1], end: fullDate[1] };
  }

  // Fallback
  return { begin: cleaned, end: cleaned };
}

// ─── Utility: Create unique property key from ontology property + column ──────

function makePropKey(ontologyProperty: string, columnName: string): string {
  const propLocal = localName(ontologyProperty);
  // Multiple columns can map to the same ontology property (e.g., dc:format for Height, Width, etc.)
  // Use column name as suffix to disambiguate
  const colSlug = columnName
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+$/, '');

  // If the column name is a natural match for the property, just use the property local name
  const colLower = columnName.toLowerCase();
  const propLower = propLocal.toLowerCase();
  if (colLower === propLower || colLower.includes(propLower) || propLower.includes(colLower)) {
    return colSlug;
  }

  return `${propLocal}_${colSlug}`;
}

// ─── Utility: Sanitize Cypher property key ────────────────────────────────────

function sanitizeCypherKey(key: string): string {
  // Cypher property names with special chars need backticks
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return key;
  return '`' + key.replace(/`/g, '``') + '`';
}

// ─── NDJSON Stream Helper ────────────────────────────────────────────────────

async function streamNdjsonFile(filePath: string, onObject: (obj: any) => void): Promise<void> {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return;

  return new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
    let buffer = '';

    rs.on('data', (chunk: string | Buffer) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onObject(JSON.parse(line));
        } catch {
          // Skip malformed
        }
      }
    });

    rs.on('end', () => {
      if (buffer.trim()) {
        try {
          onObject(JSON.parse(buffer));
        } catch {}
      }
      resolve();
    });

    rs.on('error', reject);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
