import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';

// ─── Configuration ───────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || 'domain-data/scientific-dblp';
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
const TEMP_RELS = path.resolve(DATA_DIR, 'output', '.temp-relationships.ndjson');
const TEMP_NODES = path.resolve(DATA_DIR, 'output', '.temp-nodes.ndjson');

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

function localName(prefixed: string): string {
  const idx = prefixed.indexOf(':');
  return idx >= 0 ? prefixed.substring(idx + 1) : prefixed;
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
  classByPrefixed: Map<string, OntologyClass>;
  objPropByPrefixed: Map<string, OntologyObjectProperty>;
  dataPropByPrefixed: Map<string, OntologyDataProperty>;
  namespaces: Map<string, string>;
  superClassMap: Map<string, Set<string>>;
}

function buildOntologyIndex(ontology: OntologyStructure): OntologyIndex {
  const classByPrefixed = new Map<string, OntologyClass>();
  const objPropByPrefixed = new Map<string, OntologyObjectProperty>();
  const dataPropByPrefixed = new Map<string, OntologyDataProperty>();
  const namespaces = new Map<string, string>();

  for (const [pfx, uri] of Object.entries(ontology.metadata.namespaces)) {
    namespaces.set(pfx, uri);
  }

  for (const cls of ontology.classes) {
    const prefixed = uriToPrefixed(cls.uri, namespaces);
    if (prefixed) classByPrefixed.set(prefixed, cls);
  }

  for (const prop of ontology.objectProperties) {
    const prefixed = uriToPrefixed(prop.uri, namespaces);
    if (prefixed) objPropByPrefixed.set(prefixed, prop);
  }

  for (const prop of ontology.dataProperties) {
    const prefixed = uriToPrefixed(prop.uri, namespaces);
    if (prefixed) dataPropByPrefixed.set(prefixed, prop);
  }

  // Build super class hierarchy (BFS from each class up to all ancestors)
  const superClassMap = new Map<string, Set<string>>();
  for (const cls of ontology.classes) {
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
      const parentCls = classByPrefixed.get(parent);
      if (parentCls) {
        for (const gp of parentCls.superClasses) queue.push(gp);
      }
    }
    superClassMap.set(prefixed, ancestors);
  }

  return { classByPrefixed, objPropByPrefixed, dataPropByPrefixed, namespaces, superClassMap };
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
    const constraintPrefixed = uriToPrefixed(constraintUri, index.namespaces);
    if (!constraintPrefixed) continue;
    if (classPrefixed === constraintPrefixed) return true;
    const ancestors = index.superClassMap.get(classPrefixed);
    if (ancestors && ancestors.has(constraintPrefixed)) return true;
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

function buildRecordTypeMap(entityMappings: EntityMapping[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const em of entityMappings) {
    if (!em.compliant) continue;
    if (em.columnName.startsWith('record_type=')) {
      map.set(em.columnName.substring('record_type='.length), em.ontologyClass);
    }
  }
  return map;
}

function buildAttributeIndex(attrs: AttributeMapping[]): Map<string, AttrMapEntry> {
  const map = new Map<string, AttrMapEntry>();
  for (const a of attrs) {
    if (!a.compliant) continue;
    map.set(a.columnName, {
      columnName: a.columnName,
      ontologyProperty: a.ontologyProperty,
      datatype: a.datatype,
      targetEntity: a.targetEntity,
      confidence: a.confidence,
    });
  }
  return map;
}

function buildRelationshipIndex(rels: RelationshipMapping[]): Map<string, RelMapEntry[]> {
  const map = new Map<string, RelMapEntry[]>();
  for (const r of rels) {
    if (!r.compliant) continue;
    const entry: RelMapEntry = {
      columnName: r.columnName,
      ontologyRelationship: r.ontologyRelationship,
      sourceEntity: r.sourceEntity,
      targetEntity: r.targetEntity,
      confidence: r.confidence,
    };
    const existing = map.get(r.columnName) || [];
    existing.push(entry);
    map.set(r.columnName, existing);
  }
  return map;
}

// Build reverse lookup: localName → prefixed ontology property (for TTL output)
function buildPropertyLocalNameMap(attrIndex: Map<string, AttrMapEntry>): Map<string, string> {
  const map = new Map<string, string>();
  for (const attr of attrIndex.values()) {
    map.set(localName(attr.ontologyProperty), attr.ontologyProperty);
  }
  return map;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateNodeLabel(label: string, index: OntologyIndex): boolean {
  return index.classByPrefixed.has(label);
}

function validateDataProperty(
  propPrefixed: string,
  nodeClass: string,
  index: OntologyIndex
): { valid: boolean; reason?: string } {
  const dp = index.dataPropByPrefixed.get(propPrefixed);
  if (dp) {
    if (dp.domain.length > 0 && !classMatchesDomainRange(nodeClass, dp.domain, index)) {
      return { valid: false, reason: `Domain mismatch: ${propPrefixed} domain does not include ${nodeClass}` };
    }
    return { valid: true };
  }
  // Also check object properties — dcterms:identifier, dcterms:creator etc. may be there
  const op = index.objPropByPrefixed.get(propPrefixed);
  if (op) {
    if (op.domain.length > 0 && !classMatchesDomainRange(nodeClass, op.domain, index)) {
      return { valid: false, reason: `Domain mismatch: ${propPrefixed} domain does not include ${nodeClass}` };
    }
    return { valid: true };
  }
  return { valid: false, reason: `Property ${propPrefixed} not found in ontology` };
}

function validateRelationship(
  relPrefixed: string,
  sourceClass: string,
  targetClass: string,
  index: OntologyIndex
): { valid: boolean; reason?: string } {
  const op = index.objPropByPrefixed.get(relPrefixed);
  if (!op) {
    if (index.dataPropByPrefixed.has(relPrefixed)) {
      return { valid: false, reason: `${relPrefixed} is a data property, not an object property` };
    }
    return { valid: false, reason: `Relationship ${relPrefixed} not found in ontology` };
  }
  if (op.domain.length > 0 && !classMatchesDomainRange(sourceClass, op.domain, index)) {
    return { valid: false, reason: `Domain mismatch: ${relPrefixed} domain does not include ${sourceClass}` };
  }
  if (op.range.length > 0 && !classMatchesDomainRange(targetClass, op.range, index)) {
    return { valid: false, reason: `Range mismatch: ${relPrefixed} range does not include ${targetClass}` };
  }
  return { valid: true };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          KNOWLEDGE GRAPH GENERATION                        ║');
  console.log('║          Ontology-Compliant Graph Builder                  ║');
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
  const recordTypeMap = buildRecordTypeMap(mapping.entityMappings);
  const attrIndex = buildAttributeIndex(mapping.attributeMappings);
  const relIndex = buildRelationshipIndex(mapping.relationshipMappings);
  const propLocalNameMap = buildPropertyLocalNameMap(attrIndex);

  const defaultEntityMapping = mapping.entityMappings.find(
    em => em.compliant && em.columnName === 'record_type'
  );
  const defaultClass = defaultEntityMapping?.ontologyClass || 'fabio:Expression';
  const identifierColumn = defaultEntityMapping?.identifierColumn || 'key';

  const secondaryEntityMappings = mapping.entityMappings.filter(
    em => em.compliant && !em.columnName.startsWith('record_type') && em.columnName !== 'record_type'
  );

  const unmappedCols = new Set(mapping.unmappedColumns.map(u => u.columnName));

  // Columns that serve as relationship targets — skip these from node attribute properties
  const relColumns = new Set(relIndex.keys());

  console.log(`  Record type classes: ${recordTypeMap.size}`);
  console.log(`  Attribute mappings: ${attrIndex.size}`);
  console.log(`  Relationship columns: ${relIndex.size}`);
  console.log(`  Secondary entities: ${secondaryEntityMappings.length} (${secondaryEntityMappings.map(e => e.columnName).join(', ')})`);
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
  // Secondary entity dedup: "journal:Nature" → nodeId
  const secondaryNodeIds = new Map<string, string>();

  // Output streams for pass 1
  const nodeTempStream = fs.createWriteStream(TEMP_NODES, { encoding: 'utf-8' });
  const relTempStream = fs.createWriteStream(TEMP_RELS, { encoding: 'utf-8' });

  // Collect unique labels for Cypher constraints
  const uniqueLabels = new Set<string>();

  const pass1Start = Date.now();
  let rowCount = 0;
  let unmappedDataCount = 0;

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

  // Free dedup structures — no longer needed
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
    const propsStr = Object.entries(obj.properties as Record<string, string>)
      .map(([k, v]) => `${k}: '${escapeCypher(String(v))}'`)
      .join(', ');
    const label = obj.labels[0];
    cypherStream.write(`MERGE (n:\`${label}\` {uri: '${escapeCypher(obj.id)}'}) SET n += {${propsStr}};\n`);

    // TTL for node
    const rdfType = obj._meta?.rdfType || `data:${label}`;
    ttlStream.write(`<${obj.id}> a ${rdfType}`);
    for (const [k, v] of Object.entries(obj.properties as Record<string, string>)) {
      if (k === 'uri') continue;
      const propPrefixed = propLocalNameMap.get(k) || `data:${k}`;
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
    cypherStream.write(`MATCH (a {uri: '${escapeCypher(obj.from)}'}), (b {uri: '${escapeCypher(obj.to)}'}) MERGE (a)-[:\`${obj.type}\`]->(b);\n`);

    // TTL triple
    ttlStream.write(`<${obj.from}> ${obj.typePrefixed} <${obj.to}> .\n`);

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
    console.log(`║    ${label.padEnd(17)}${formatNumber(count).padEnd(39)}║`);
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
    console.log(`║    ${relType.padEnd(17)}${formatNumber(count).padEnd(39)}║`);
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
  // Inner functions (hoisted by JS)
  // ═══════════════════════════════════════════════════════════════════════

  function processRow(row: Row, rowIdx: number): void {
    const recordType = (row['record_type'] || '').trim().toLowerCase();
    const key = (row[identifierColumn] || '').trim();

    if (!key) {
      addIssue({ type: 'missing-identifier', severity: 'warning', message: `Row ${rowIdx}: missing identifier column '${identifierColumn}'`, rowIndex: rowIdx });
      return;
    }

    // Determine ontology class for this record
    const ontologyClass = recordTypeMap.get(recordType) || defaultClass;
    const classLabel = localName(ontologyClass);

    // Create primary node
    const nodeId = generateNodeId(classLabel, key);

    if (!nodeIdSet.has(nodeId)) {
      nodeIdSet.add(nodeId);

      const classValid = validateNodeLabel(ontologyClass, index);
      if (!classValid) {
        addIssue({ type: 'invalid-class', severity: 'error', message: `Class ${ontologyClass} not in ontology`, entity: nodeId, rowIndex: rowIdx });
        stats.invalidNodes++;
      } else {
        stats.validNodes++;
      }

      stats.totalNodes++;
      stats.nodesByType[ontologyClass] = (stats.nodesByType[ontologyClass] || 0) + 1;
      uniqueLabels.add(classLabel);

      // Build properties from attribute mappings
      const props: Record<string, string> = {};
      props['uri'] = nodeId;
      props['identifier'] = key;

      for (const [colName, attr] of attrIndex) {
        const val = (row[colName] || '').trim();
        if (!val) continue;
        if (relColumns.has(colName)) continue;

        const propCheck = validateDataProperty(attr.ontologyProperty, ontologyClass, index);
        if (!propCheck.valid) {
          addIssue({
            type: 'invalid-property',
            severity: 'warning',
            message: propCheck.reason || `Property ${attr.ontologyProperty} invalid for ${ontologyClass}`,
            entity: nodeId,
            property: attr.ontologyProperty,
            rowIndex: rowIdx,
          });
        }

        props[localName(attr.ontologyProperty)] = val;
      }

      // Write node to temp NDJSON
      const rdfType = ontologyClass.includes(':') ? ontologyClass : `fabio:${ontologyClass}`;
      nodeTempStream.write(JSON.stringify({
        id: nodeId,
        labels: [classLabel],
        properties: props,
        _meta: { sourceRow: rowIdx, confidence: recordTypeMap.has(recordType) ? 0.95 : 0.8, compliant: classValid, rdfType },
      }) + '\n');
    }

    // ── Secondary entities (journals, proceedings, series) ──────────

    for (const secMapping of secondaryEntityMappings) {
      const colName = secMapping.columnName;
      const val = (row[colName] || '').trim();
      if (!val) continue;

      const secClass = secMapping.ontologyClass;
      const secLabel = localName(secClass);
      const secKey = `${colName}:${val}`;

      if (!secondaryNodeIds.has(secKey)) {
        const secNodeId = generateNodeId(secLabel, val);
        secondaryNodeIds.set(secKey, secNodeId);

        if (!nodeIdSet.has(secNodeId)) {
          nodeIdSet.add(secNodeId);

          const secClassValid = validateNodeLabel(secClass, index);
          if (!secClassValid) {
            addIssue({ type: 'invalid-class', severity: 'error', message: `Secondary class ${secClass} not in ontology`, entity: secNodeId, rowIndex: rowIdx });
            stats.invalidNodes++;
          } else {
            stats.validNodes++;
          }

          stats.totalNodes++;
          stats.nodesByType[secClass] = (stats.nodesByType[secClass] || 0) + 1;
          uniqueLabels.add(secLabel);

          const rdfType = secClass.includes(':') ? secClass : `fabio:${secClass}`;
          nodeTempStream.write(JSON.stringify({
            id: secNodeId,
            labels: [secLabel],
            properties: { uri: secNodeId, title: val },
            _meta: { sourceRow: rowIdx, confidence: secMapping.confidence, compliant: secClassValid, rdfType },
          }) + '\n');
        }
      }
    }

    // ── Relationships ───────────────────────────────────────────────

    for (const [colName, relMappings] of relIndex) {
      const val = (row[colName] || '').trim();
      if (!val) continue;

      for (const relMap of relMappings) {
        // Multi-valued: authors/editors separated by |
        const values = (colName === 'authors' || colName === 'editors')
          ? val.split('|').map(v => v.trim()).filter(Boolean)
          : [val];

        const sourceNodeId = generateNodeId(classLabel, key);

        for (const singleVal of values) {
          let targetNodeId: string;

          if (colName === 'crossref' || colName === 'cite') {
            // Cross-references point to records whose type is unknown — use Expression as general class
            targetNodeId = generateNodeId('Expression', singleVal);
          } else if (colName === 'authors' || colName === 'editors') {
            targetNodeId = createAgentNode('Person', 'foaf:Person', singleVal, relMap.confidence, rowIdx);
          } else if (colName === 'publisher') {
            targetNodeId = createAgentNode('Organization', 'foaf:Organization', singleVal, relMap.confidence, rowIdx);
          } else {
            // Secondary entity lookup (journal, booktitle, series)
            const secKey = `${colName}:${singleVal}`;
            targetNodeId = secondaryNodeIds.get(secKey) || generateNodeId(localName(relMap.targetEntity), singleVal);
          }

          // Validate relationship
          const relCheck = validateRelationship(relMap.ontologyRelationship, ontologyClass, relMap.targetEntity, index);
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

          // Write relationship to temp NDJSON
          relTempStream.write(JSON.stringify({
            id: generateRelId(localName(relMap.ontologyRelationship), sourceNodeId, targetNodeId),
            type: localName(relMap.ontologyRelationship),
            typePrefixed: relMap.ontologyRelationship,
            from: sourceNodeId,
            to: targetNodeId,
            properties: {},
            _meta: { confidence: relMap.confidence, compliant: relCheck.valid, sourceRow: rowIdx },
          }) + '\n');
        }
      }
    }

    // Track unmapped data
    for (const col of unmappedCols) {
      if ((row[col] || '').trim()) unmappedDataCount++;
    }
  }

  /** Create a Person or Organization node, deduped by name */
  function createAgentNode(label: string, prefixedClass: string, name: string, confidence: number, rowIdx: number): string {
    const nodeId = generateNodeId(label, name);

    if (!nodeIdSet.has(nodeId)) {
      nodeIdSet.add(nodeId);

      const classValid = validateNodeLabel(prefixedClass, index);
      if (!classValid) {
        addIssue({ type: 'external-class', severity: 'info', message: `External class ${prefixedClass} used for ${name}`, entity: nodeId, rowIndex: rowIdx });
        stats.invalidNodes++;
      } else {
        stats.validNodes++;
      }

      stats.totalNodes++;
      stats.nodesByType[prefixedClass] = (stats.nodesByType[prefixedClass] || 0) + 1;
      uniqueLabels.add(label);

      nodeTempStream.write(JSON.stringify({
        id: nodeId,
        labels: [label],
        properties: { uri: nodeId, name },
        _meta: { sourceRow: rowIdx, confidence, compliant: classValid, rdfType: prefixedClass },
      }) + '\n');
    }

    return nodeId;
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
