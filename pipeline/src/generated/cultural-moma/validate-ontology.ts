import * as fs from 'fs';
import * as path from 'path';
import neo4j, { Driver, Session } from 'neo4j-driver';

// ─── Configuration ───────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || 'domain-data/cultural-moma';
const OUTPUT_DIR = path.resolve(DATA_DIR, 'output');

const ONTOLOGY_FILE = path.resolve(OUTPUT_DIR, 'ontology-structure.json');
const GRAPH_FILE = path.resolve(OUTPUT_DIR, 'graph-data.json');
const MAPPING_FILE = path.resolve(OUTPUT_DIR, 'ontology-mapping-guide.json');

const REPORT_JSON = path.resolve(OUTPUT_DIR, 'validation-report.json');
const REPORT_TXT = path.resolve(OUTPUT_DIR, 'validation-report.txt');
const FIXES_FILE = path.resolve(OUTPUT_DIR, 'fixes.cypher');
const VIOLATIONS_FILE = path.resolve(OUTPUT_DIR, 'violations-details.json');

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || '123123123';
const NEO4J_DATABASE = process.env.NEO4J_DATABASE || 'neo4j';

const SAMPLE_LIMIT = 5;

// ─── Types ───────────────────────────────────────────────────────────────────

interface OntologyClass {
  uri: string;
  label: string;
  definition: string;
  superClasses: string[];
  equivalentClasses: string[];
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
  externalVocabularies?: ExternalVocabulary[];
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
}

interface GraphStatistics {
  totalNodes: number;
  nodesByType: Record<string, number>;
  totalRelationships: number;
  relationshipsByType: Record<string, number>;
}

interface Violation {
  category: 'class' | 'objectProperty' | 'dataProperty' | 'required' | 'structure';
  type: string;
  property: string;
  severity: 'error' | 'warning' | 'info';
  count: number;
  description: string;
  examples: Array<{ nodeId?: string; labels?: string[]; properties?: Record<string, unknown>; context?: string }>;
  fixStrategies: Array<{ strategy: string; cypherQuery: string; description: string; risk: 'safe' | 'moderate' | 'destructive' }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function toPascalCase(label: string): string {
  return label.replace(/(?:^|\s)\w/g, (m) => m.trim().toUpperCase()).replace(/\s+/g, '');
}

function extractLocalName(uri: string): string {
  const hashIdx = uri.lastIndexOf('#');
  const slashIdx = uri.lastIndexOf('/');
  return uri.substring(Math.max(hashIdx, slashIdx) + 1);
}

function extractPrefix(prefixed: string): { prefix: string; local: string } {
  const colonIdx = prefixed.indexOf(':');
  if (colonIdx === -1) return { prefix: '', local: prefixed };
  return { prefix: prefixed.substring(0, colonIdx), local: prefixed.substring(colonIdx + 1) };
}

function toCamelCase(s: string): string {
  const words = s.split(/\s+/);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
}

function resolveClassLabel(classRef: string, ontology: OntologyStructure): string {
  const { prefix, local } = extractPrefix(classRef);
  const ns = ontology.metadata.namespaces[prefix];
  if (ns) {
    const fullUri = ns + local;
    // Check core classes first
    const cls = ontology.classes.find((c) => c.uri === fullUri);
    if (cls) return toPascalCase(cls.label);
    // Check external vocabulary classes
    if (ontology.externalVocabularies) {
      for (const ext of ontology.externalVocabularies) {
        if (ext.classes.includes(classRef)) {
          // Use the local name as-is (e.g., PeriodOfTime, Organization, Person)
          return local;
        }
      }
    }
  }
  return local;
}

function buildValidLabelsSet(ontology: OntologyStructure): Set<string> {
  const labels = new Set<string>();

  // Add core ontology classes
  for (const cls of ontology.classes) {
    labels.add(toPascalCase(cls.label));
    labels.add(extractLocalName(cls.uri));
  }

  // Add external vocabulary classes (from externalVocabularies section)
  if (ontology.externalVocabularies) {
    for (const ext of ontology.externalVocabularies) {
      for (const classRef of ext.classes) {
        const { local } = extractPrefix(classRef);
        labels.add(local);
        // Also add PascalCase version of multi-word names
        const pascal = toPascalCase(local.replace(/([A-Z])/g, ' $1').trim());
        labels.add(pascal);
      }
    }
  }

  // Add classes referenced in domain/range of properties
  const externalClassRefs = new Set<string>();
  for (const op of ontology.objectProperties) {
    for (const d of op.domain) externalClassRefs.add(d);
    for (const r of op.range) externalClassRefs.add(r);
  }
  for (const dp of ontology.dataProperties) {
    for (const d of dp.domain) externalClassRefs.add(d);
  }
  for (const ref of externalClassRefs) {
    const resolved = resolveClassLabel(ref, ontology);
    labels.add(resolved);
  }

  // Add "Resource" (common import label used for indexing)
  labels.add('Resource');

  return labels;
}

function buildRelTypeMap(ontology: OntologyStructure): Map<string, ObjectProperty> {
  const map = new Map<string, ObjectProperty>();

  // Map from object properties
  for (const op of ontology.objectProperties) {
    const local = extractLocalName(op.uri);
    map.set(local, op);
    map.set(toCamelCase(op.label), op);
    // Also map the label in various forms
    const labelNormalized = op.label.replace(/\s+/g, '');
    map.set(labelNormalized, op);
  }

  // Map external vocabulary properties as lightweight ObjectProperty-like entries
  if (ontology.externalVocabularies) {
    for (const ext of ontology.externalVocabularies) {
      for (const propRef of ext.properties) {
        const { local } = extractPrefix(propRef);
        if (!map.has(local)) {
          map.set(local, {
            uri: ext.namespace + local,
            label: local,
            definition: '',
            domain: [],
            range: [],
            superProperties: [],
            inverseOf: '',
          });
        }
      }
    }
  }

  return map;
}

function buildAllValidPropertyNames(ontology: OntologyStructure): Set<string> {
  const names = new Set<string>();

  for (const dp of ontology.dataProperties) {
    names.add(extractLocalName(dp.uri));
  }
  for (const op of ontology.objectProperties) {
    names.add(extractLocalName(op.uri));
  }

  // Add external vocabulary property names
  if (ontology.externalVocabularies) {
    for (const ext of ontology.externalVocabularies) {
      for (const propRef of ext.properties) {
        const { local } = extractPrefix(propRef);
        names.add(local);
      }
    }
  }

  return names;
}

function buildNamespacePrefixes(ontology: OntologyStructure): string[] {
  return Object.keys(ontology.metadata.namespaces);
}

function xsdToValidator(xsdType: string): (value: unknown) => boolean {
  const type = xsdType.replace(/^xsd:/, '');
  switch (type) {
    case 'string': return () => true;
    case 'integer': case 'int': case 'long': case 'short':
      return (v) => typeof v === 'number' ? Number.isInteger(v) : /^-?\d+$/.test(String(v));
    case 'positiveInteger':
      return (v) => { const n = Number(v); return Number.isInteger(n) && n > 0; };
    case 'nonNegativeInteger':
      return (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0; };
    case 'decimal': case 'float': case 'double':
      return (v) => !isNaN(Number(v));
    case 'boolean':
      return (v) => typeof v === 'boolean' || v === 'true' || v === 'false';
    case 'date':
      return (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
    case 'dateTime':
      return (v) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(String(v));
    case 'gYear':
      return (v) => /^-?\d{4}$/.test(String(v));
    case 'anyURI':
      return (v) => typeof v === 'string' && v.length > 0;
    default:
      return () => true;
  }
}

function gradeScore(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 95) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// ─── Neo4j Connection ────────────────────────────────────────────────────────

function createDriver(): Driver {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function runCypher<T = Record<string, unknown>>(session: Session, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await session.run(query, params);
  return result.records.map((r) => {
    const obj: Record<string, unknown> = {};
    for (const key of r.keys) {
      const val = r.get(key);
      obj[key as string] = neo4j.isInt(val) ? val.toNumber() : val;
    }
    return obj as T;
  });
}

// ─── Validation Checks ──────────────────────────────────────────────────────

async function validateClassLabels(
  session: Session,
  validLabels: Set<string>,
  violations: Violation[]
): Promise<{ totalNodes: number; labelCounts: Record<string, number> }> {
  console.log('  Checking node labels against ontology classes...');

  const rows = await runCypher<{ nodeLabels: string[]; count: number }>(
    session,
    'MATCH (n) RETURN DISTINCT labels(n) AS nodeLabels, count(*) AS count'
  );

  const labelCounts: Record<string, number> = {};
  let totalNodes = 0;
  const invalidLabels: Array<{ label: string; count: number; coLabels: string[] }> = [];

  for (const row of rows) {
    const count = typeof row.count === 'object' && row.count !== null && 'toNumber' in (row.count as any)
      ? (row.count as any).toNumber() : Number(row.count);
    totalNodes += count;

    for (const label of row.nodeLabels) {
      labelCounts[label] = (labelCounts[label] || 0) + count;
      if (!validLabels.has(label)) {
        invalidLabels.push({ label, count, coLabels: row.nodeLabels.filter((l) => l !== label) });
      }
    }
  }

  // Group invalid labels
  const invalidByLabel = new Map<string, { count: number; coLabels: string[][] }>();
  for (const inv of invalidLabels) {
    const existing = invalidByLabel.get(inv.label);
    if (existing) {
      existing.count += inv.count;
      existing.coLabels.push(inv.coLabels);
    } else {
      invalidByLabel.set(inv.label, { count: inv.count, coLabels: [inv.coLabels] });
    }
  }

  for (const [label, info] of invalidByLabel) {
    const samples = await runCypher<{ id: string; labels: string[] }>(
      session,
      `MATCH (n:\`${label}\`) RETURN n.id AS id, labels(n) AS labels LIMIT ${SAMPLE_LIMIT}`
    );

    violations.push({
      category: 'class',
      type: 'invalid_label',
      property: label,
      severity: 'error',
      count: info.count,
      description: `Label "${label}" is not defined in the ontology. Found ${formatNumber(info.count)} nodes with this label.`,
      examples: samples.map((s) => ({
        nodeId: String(s.id),
        labels: s.labels,
        context: `Co-labels: ${info.coLabels[0]?.join(', ') || 'none'}`,
      })),
      fixStrategies: [
        {
          strategy: 'remove_label',
          cypherQuery: `MATCH (n:\`${label}\`) REMOVE n:\`${label}\``,
          description: `Remove invalid label "${label}" from all nodes`,
          risk: 'moderate',
        },
      ],
    });
  }

  console.log(`    Found ${invalidByLabel.size} invalid label(s) across ${formatNumber(totalNodes)} nodes`);
  return { totalNodes, labelCounts };
}

async function validateObjectPropertyDomainRange(
  session: Session,
  ontology: OntologyStructure,
  violations: Violation[]
): Promise<number> {
  console.log('  Checking object property domain/range constraints...');

  let totalRels = 0;
  const relTypeRows = await runCypher<{ type: string; count: number }>(
    session,
    'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count'
  );

  const relTypeCounts = new Map<string, number>();
  for (const row of relTypeRows) {
    const count = typeof row.count === 'object' && row.count !== null && 'toNumber' in (row.count as any)
      ? (row.count as any).toNumber() : Number(row.count);
    relTypeCounts.set(row.type, count);
    totalRels += count;
  }

  const relTypeMap = buildRelTypeMap(ontology);
  let violationCount = 0;

  for (const [relType, count] of relTypeCounts) {
    const opDef = relTypeMap.get(relType);
    if (!opDef || (opDef.domain.length === 0 && opDef.range.length === 0)) continue;

    // Resolve domain/range to Neo4j labels
    const validDomainLabels = new Set(opDef.domain.map((d) => resolveClassLabel(d, ontology)));
    const validRangeLabels = new Set(opDef.range.map((r) => resolveClassLabel(r, ontology)));

    // Check domain violations (source node labels)
    if (opDef.domain.length > 0) {
      const domainCheck = await runCypher<{ sourceLabels: string[]; sampleId: string; count: number }>(
        session,
        `MATCH (s)-[r:\`${relType}\`]->(t)
         WITH labels(s) AS sourceLabels, s.id AS sampleId, count(*) AS count
         RETURN sourceLabels, sampleId, count LIMIT 100`
      );

      for (const row of domainCheck) {
        const nodeLabels = row.sourceLabels.filter((l: string) => l !== 'Resource');
        const matchesDomain = nodeLabels.some((l: string) => validDomainLabels.has(l));
        if (!matchesDomain && nodeLabels.length > 0) {
          const rowCount = typeof row.count === 'object' && row.count !== null && 'toNumber' in (row.count as any)
            ? (row.count as any).toNumber() : Number(row.count);
          violationCount += rowCount;
          violations.push({
            category: 'objectProperty',
            type: 'domain_violation',
            property: relType,
            severity: 'warning',
            count: rowCount,
            description: `Relationship "${relType}" has source nodes with labels [${nodeLabels.join(', ')}] but ontology domain requires [${[...validDomainLabels].join(', ')}].`,
            examples: [{ nodeId: String(row.sampleId), labels: nodeLabels, context: `Expected domain: ${opDef.domain.join(', ')}` }],
            fixStrategies: [{
              strategy: 'add_domain_label',
              cypherQuery: `MATCH (s)-[r:\`${relType}\`]->(t) WHERE NOT any(l IN labels(s) WHERE l IN [${[...validDomainLabels].map((l) => `'${l}'`).join(',')}]) SET s:\`${[...validDomainLabels][0]}\``,
              description: `Add missing domain label to source nodes of "${relType}"`,
              risk: 'moderate',
            }],
          });
        }
      }
    }

    // Check range violations (target node labels)
    if (opDef.range.length > 0) {
      const rangeCheck = await runCypher<{ targetLabels: string[]; sampleId: string; count: number }>(
        session,
        `MATCH (s)-[r:\`${relType}\`]->(t)
         WITH labels(t) AS targetLabels, t.id AS sampleId, count(*) AS count
         RETURN targetLabels, sampleId, count LIMIT 100`
      );

      for (const row of rangeCheck) {
        const nodeLabels = row.targetLabels.filter((l: string) => l !== 'Resource');
        const matchesRange = nodeLabels.some((l: string) => validRangeLabels.has(l));
        if (!matchesRange && nodeLabels.length > 0) {
          const rowCount = typeof row.count === 'object' && row.count !== null && 'toNumber' in (row.count as any)
            ? (row.count as any).toNumber() : Number(row.count);
          violationCount += rowCount;
          violations.push({
            category: 'objectProperty',
            type: 'range_violation',
            property: relType,
            severity: 'warning',
            count: rowCount,
            description: `Relationship "${relType}" has target nodes with labels [${nodeLabels.join(', ')}] but ontology range requires [${[...validRangeLabels].join(', ')}].`,
            examples: [{ nodeId: String(row.sampleId), labels: nodeLabels, context: `Expected range: ${opDef.range.join(', ')}` }],
            fixStrategies: [{
              strategy: 'add_range_label',
              cypherQuery: `MATCH (s)-[r:\`${relType}\`]->(t) WHERE NOT any(l IN labels(t) WHERE l IN [${[...validRangeLabels].map((l) => `'${l}'`).join(',')}]) SET t:\`${[...validRangeLabels][0]}\``,
              description: `Add missing range label to target nodes of "${relType}"`,
              risk: 'moderate',
            }],
          });
        }
      }
    }
  }

  console.log(`    Analyzed ${relTypeCounts.size} relationship type(s), found ${violationCount} domain/range issue(s)`);
  return totalRels;
}

async function fetchExistingPropertyKeys(session: Session): Promise<Set<string>> {
  const existingKeys = await runCypher<{ key: string }>(
    session,
    `CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey AS key`
  );
  return new Set(existingKeys.map((r) => r.key));
}

async function validateDataPropertyDomains(
  session: Session,
  ontology: OntologyStructure,
  existingKeySet: Set<string>,
  violations: Violation[]
): Promise<void> {
  console.log('  Checking data property domain constraints...');

  let checkedCount = 0;
  for (const dp of ontology.dataProperties) {
    if (dp.domain.length === 0) continue;

    const propName = extractLocalName(dp.uri);
    if (!existingKeySet.has(propName)) continue;

    const validDomainLabels = new Set(dp.domain.map((d) => resolveClassLabel(d, ontology)));
    const domainLabelsArray = [...validDomainLabels].map((l) => `'${l}'`).join(',');

    const mismatchSamples = await runCypher<{ id: string; labels: string[] }>(
      session,
      `MATCH (n) WHERE n.\`${propName}\` IS NOT NULL
       AND NOT any(l IN labels(n) WHERE l IN [${domainLabelsArray}])
       RETURN n.id AS id, labels(n) AS labels LIMIT ${SAMPLE_LIMIT}`
    );

    if (mismatchSamples.length === 0) {
      checkedCount++;
      continue;
    }

    checkedCount++;

    const mismatchLabels = new Set<string>();
    for (const s of mismatchSamples) {
      for (const l of s.labels) {
        if (l !== 'Resource' && !validDomainLabels.has(l)) mismatchLabels.add(l);
      }
    }

    let estimatedMismatch = 0;
    for (const label of mismatchLabels) {
      const labelCount = await runCypher<{ count: number }>(
        session,
        `MATCH (n:\`${label}\`) WHERE n.\`${propName}\` IS NOT NULL RETURN count(n) AS count`
      );
      if (labelCount[0]) {
        const c = typeof labelCount[0].count === 'object' ? (labelCount[0].count as any).toNumber() : Number(labelCount[0].count);
        estimatedMismatch += c;
      }
    }

    violations.push({
      category: 'dataProperty',
      type: 'domain_violation',
      property: propName,
      severity: 'warning',
      count: estimatedMismatch || mismatchSamples.length,
      description: `Data property "${propName}" found on nodes outside its domain. Expected domain: [${[...validDomainLabels].join(', ')}].`,
      examples: mismatchSamples.map((r) => ({
        nodeId: String(r.id),
        labels: r.labels,
        context: `Property "${propName}" should only be on [${[...validDomainLabels].join(', ')}] nodes`,
      })),
      fixStrategies: [{
        strategy: 'review_property_placement',
        cypherQuery: `MATCH (n) WHERE n.\`${propName}\` IS NOT NULL AND NOT any(l IN labels(n) WHERE l IN [${domainLabelsArray}]) RETURN n.id, labels(n), n.\`${propName}\` LIMIT 20`,
        description: `Review nodes with "${propName}" outside domain`,
        risk: 'safe',
      }],
    });
  }

  console.log(`    Checked ${checkedCount} data propert(ies) with domain constraints`);
}

async function validateDataPropertyDatatypes(
  session: Session,
  ontology: OntologyStructure,
  existingKeySet: Set<string>,
  violations: Violation[]
): Promise<void> {
  console.log('  Checking data property datatype constraints...');

  let checkedCount = 0;
  for (const dp of ontology.dataProperties) {
    if (!dp.range || dp.range === 'xsd:string') continue;

    const propName = extractLocalName(dp.uri);
    if (!existingKeySet.has(propName)) continue;

    const validator = xsdToValidator(dp.range);

    const sampleRows = await runCypher<{ value: unknown; id: string }>(
      session,
      `MATCH (n) WHERE n.\`${propName}\` IS NOT NULL RETURN n.\`${propName}\` AS value, n.id AS id LIMIT 50`
    );
    if (sampleRows.length === 0) continue;

    checkedCount++;

    const invalidSamples = sampleRows.filter((r) => !validator(r.value));
    if (invalidSamples.length > 0) {
      const violationRate = invalidSamples.length / sampleRows.length;
      let estimatedTotal = sampleRows.length;
      if (dp.domain.length > 0) {
        const domainLabel = resolveClassLabel(dp.domain[0], ontology);
        const labelCountResult = await runCypher<{ count: number }>(
          session,
          `MATCH (n:\`${domainLabel}\`) WHERE n.\`${propName}\` IS NOT NULL RETURN count(n) AS count`
        );
        if (labelCountResult[0]) {
          estimatedTotal = typeof labelCountResult[0].count === 'object' ? (labelCountResult[0].count as any).toNumber() : Number(labelCountResult[0].count);
        }
      }
      const estimatedViolations = Math.round(estimatedTotal * violationRate);

      violations.push({
        category: 'dataProperty',
        type: 'datatype_violation',
        property: propName,
        severity: estimatedViolations > 1000 ? 'error' : 'warning',
        count: estimatedViolations,
        description: `Property "${propName}" expected type ${dp.range} but ${invalidSamples.length}/${sampleRows.length} samples failed validation. Estimated ~${formatNumber(estimatedViolations)} violations.`,
        examples: invalidSamples.slice(0, SAMPLE_LIMIT).map((s) => ({
          nodeId: String(s.id),
          context: `Value: "${s.value}" (expected ${dp.range})`,
        })),
        fixStrategies: [{
          strategy: 'coerce_datatype',
          cypherQuery: `// Review values for "${propName}" that don't match ${dp.range}\nMATCH (n) WHERE n.\`${propName}\` IS NOT NULL RETURN n.\`${propName}\` AS value, count(*) AS count ORDER BY count DESC LIMIT 20`,
          description: `Review and correct datatype for "${propName}"`,
          risk: 'safe',
        }],
      });
    }
  }

  console.log(`    Checked ${checkedCount} data propert(ies) with datatype constraints`);
}

async function validateRequiredProperties(
  session: Session,
  mappingGuide: MappingGuide,
  ontology: OntologyStructure,
  violations: Violation[]
): Promise<void> {
  console.log('  Checking required properties from mapping guide...');

  let checkedCount = 0;
  for (const pattern of mappingGuide.commonPatterns) {
    if (pattern.requiredProperties.length === 0) continue;

    const neoLabel = resolveClassLabel(pattern.ontologyClass, ontology);

    const labelExists = await runCypher<{ count: number }>(
      session,
      `MATCH (n:\`${neoLabel}\`) RETURN count(n) AS count LIMIT 1`
    );
    const count = labelExists[0] ? (typeof labelExists[0].count === 'object' ? (labelExists[0].count as any).toNumber() : Number(labelExists[0].count)) : 0;
    if (count === 0) continue;

    checkedCount++;

    for (const reqProp of pattern.requiredProperties) {
      const propName = extractLocalName(reqProp.includes(':') ? reqProp.split(':').slice(1).join(':') : reqProp);

      const missingRows = await runCypher<{ id: string; missing: number }>(
        session,
        `MATCH (n:\`${neoLabel}\`) WHERE n.\`${propName}\` IS NULL
         RETURN n.id AS id, count(*) AS missing LIMIT ${SAMPLE_LIMIT}`
      );

      if (missingRows.length > 0) {
        const totalMissing = await runCypher<{ count: number }>(
          session,
          `MATCH (n:\`${neoLabel}\`) WHERE n.\`${propName}\` IS NULL RETURN count(n) AS count`
        );
        const missingCount = totalMissing[0] ? (typeof totalMissing[0].count === 'object' ? (totalMissing[0].count as any).toNumber() : Number(totalMissing[0].count)) : 0;

        violations.push({
          category: 'required',
          type: 'missing_required_property',
          property: `${neoLabel}.${propName}`,
          severity: 'error',
          count: missingCount,
          description: `Required property "${propName}" is missing from ${formatNumber(missingCount)} "${neoLabel}" node(s).`,
          examples: missingRows.map((r) => ({
            nodeId: String(r.id),
            labels: [neoLabel],
            context: `Missing required property: ${propName}`,
          })),
          fixStrategies: [{
            strategy: 'add_default_value',
            cypherQuery: `MATCH (n:\`${neoLabel}\`) WHERE n.\`${propName}\` IS NULL SET n.\`${propName}\` = 'UNKNOWN'`,
            description: `Set default value for missing "${propName}" on "${neoLabel}" nodes`,
            risk: 'moderate',
          }],
        });
      }
    }
  }

  console.log(`    Checked ${checkedCount} class(es) for required properties`);
}

async function validateStructure(
  session: Session,
  graphStats: GraphStatistics,
  ontology: OntologyStructure,
  violations: Violation[]
): Promise<void> {
  console.log('  Running structural validation...');

  // Check orphaned nodes per label
  const labelNames = await runCypher<{ label: string }>(
    session,
    `CALL db.labels() YIELD label RETURN label`
  );

  let totalOrphaned = 0;
  const orphanedByLabel: Array<{ labels: string[]; count: number; sampleId: string }> = [];

  for (const row of labelNames) {
    const label = row.label;
    try {
      const countResult = await runCypher<{ count: number }>(
        session,
        `MATCH (n:\`${label}\`) WHERE NOT (n)--() RETURN count(n) AS count`
      );
      const count = countResult[0] ? (typeof countResult[0].count === 'object' ? (countResult[0].count as any).toNumber() : Number(countResult[0].count)) : 0;
      if (count > 0) {
        totalOrphaned += count;
        const sample = await runCypher<{ id: string }>(
          session,
          `MATCH (n:\`${label}\`) WHERE NOT (n)--() RETURN n.id AS id LIMIT 1`
        );
        orphanedByLabel.push({
          labels: [label],
          count,
          sampleId: sample[0] ? String(sample[0].id) : 'unknown',
        });
      }
    } catch {
      console.log(`    Warning: Skipping orphan check for label "${label}" (query too expensive)`);
    }
  }
  orphanedByLabel.sort((a, b) => b.count - a.count);

  if (totalOrphaned > 0) {
    const orphanedPct = ((totalOrphaned / graphStats.totalNodes) * 100).toFixed(2);
    violations.push({
      category: 'structure',
      type: 'orphaned_nodes',
      property: 'graph_connectivity',
      severity: totalOrphaned > graphStats.totalNodes * 0.05 ? 'warning' : 'info',
      count: totalOrphaned,
      description: `${formatNumber(totalOrphaned)} orphaned node(s) (${orphanedPct}% of graph) have no relationships.`,
      examples: orphanedByLabel.slice(0, SAMPLE_LIMIT).map((o) => ({
        nodeId: o.sampleId,
        labels: o.labels,
        context: `${formatNumber(o.count)} orphaned nodes with labels [${o.labels.join(', ')}]`,
      })),
      fixStrategies: [
        {
          strategy: 'review_orphans',
          cypherQuery: `MATCH (n) WHERE NOT (n)--() RETURN labels(n) AS labels, count(*) AS count ORDER BY count DESC`,
          description: 'Review orphaned nodes by label',
          risk: 'safe',
        },
        {
          strategy: 'delete_orphans',
          cypherQuery: `// DESTRUCTIVE: Uncomment to delete orphaned nodes\n// MATCH (n) WHERE NOT (n)--() DELETE n`,
          description: 'Delete all orphaned nodes (DESTRUCTIVE)',
          risk: 'destructive',
        },
      ],
    });
  }

  // Verify core entity classes have at least one instance
  const coreClassLabels = ontology.classes.map((c) => toPascalCase(c.label));
  const emptyClasses: string[] = [];

  for (const classLabel of coreClassLabels) {
    const checkResult = await runCypher<{ count: number }>(
      session,
      `MATCH (n:\`${classLabel}\`) RETURN count(n) AS count LIMIT 1`
    );
    const cnt = checkResult[0] ? (typeof checkResult[0].count === 'object' ? (checkResult[0].count as any).toNumber() : Number(checkResult[0].count)) : 0;
    if (cnt === 0) {
      emptyClasses.push(classLabel);
    }
  }

  // Only flag as info if many core classes are empty — not all need instances
  if (emptyClasses.length > 0 && emptyClasses.length < coreClassLabels.length) {
    violations.push({
      category: 'structure',
      type: 'empty_core_classes',
      property: 'class_instantiation',
      severity: 'info',
      count: emptyClasses.length,
      description: `${emptyClasses.length} ontology class(es) have no instances in the graph: ${emptyClasses.slice(0, 10).join(', ')}${emptyClasses.length > 10 ? '...' : ''}`,
      examples: emptyClasses.slice(0, SAMPLE_LIMIT).map((c) => ({
        context: `Class "${c}" has 0 instances`,
      })),
      fixStrategies: [{
        strategy: 'review_empty_classes',
        cypherQuery: `CALL db.labels() YIELD label MATCH (n) WHERE label IN labels(n) RETURN label, count(n) AS count ORDER BY count DESC`,
        description: 'Review instance counts per class label',
        risk: 'safe',
      }],
    });
  }

  // Verify graph has relationships
  if (graphStats.totalRelationships === 0) {
    violations.push({
      category: 'structure',
      type: 'no_relationships',
      property: 'graph_connectivity',
      severity: 'error',
      count: 1,
      description: 'Graph has no relationships — it is completely disconnected.',
      examples: [],
      fixStrategies: [],
    });
  }

  console.log(`    Found ${formatNumber(totalOrphaned)} orphaned node(s), ${emptyClasses.length} empty core class(es)`);
}

async function validatePropertyNamespaces(
  session: Session,
  ontology: OntologyStructure,
  existingKeySet: Set<string>,
  violations: Violation[]
): Promise<void> {
  console.log('  Checking property namespace validity...');

  const validPropertyNames = buildAllValidPropertyNames(ontology);
  const nsPrefixes = buildNamespacePrefixes(ontology);

  // Common standard properties always valid (graph infrastructure)
  const standardProps = new Set([
    'id', 'uri', 'name', 'title', 'label', 'description', 'type', 'rdfType',
    'identifier', 'modified', 'created', 'source', 'subject', 'creator',
    'publisher', 'date', 'format', 'language', 'relation', 'coverage', 'rights',
    'prefLabel', 'altLabel', 'notation', 'category', 'resourceUrl', 'constituentId',
    'objectId',
  ]);

  const invalidProps: Array<{ key: string }> = [];
  for (const key of existingKeySet) {
    if (validPropertyNames.has(key) || standardProps.has(key)) continue;

    // Check if it matches a known namespace prefix pattern (e.g. dc_title, dcterms_spatial)
    const isFromKnownNs = nsPrefixes.some((prefix) => {
      return key.startsWith(prefix + '_') || key.startsWith(prefix + ':');
    });
    if (isFromKnownNs) continue;

    // Also check if the key contains a known property name as a suffix (e.g. format_Medium maps to dc:format)
    const isCompoundProperty = nsPrefixes.some((prefix) => key.toLowerCase().startsWith(prefix.toLowerCase()));
    if (isCompoundProperty) continue;

    invalidProps.push({ key });
  }

  if (invalidProps.length > 0) {
    violations.push({
      category: 'dataProperty',
      type: 'unknown_property',
      property: 'property_namespace',
      severity: 'info',
      count: invalidProps.length,
      description: `${invalidProps.length} property key(s) not explicitly defined in the ontology.`,
      examples: invalidProps.slice(0, SAMPLE_LIMIT).map((p) => ({
        context: `Property "${p.key}" not found in ontology namespaces`,
      })),
      fixStrategies: [{
        strategy: 'review_properties',
        cypherQuery: `CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey`,
        description: 'List all property keys for manual review',
        risk: 'safe',
      }],
    });
  }

  console.log(`    Found ${invalidProps.length} unrecognized property key(s)`);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function calculateComplianceScore(violations: Violation[], totalNodes: number, totalRels: number): number {
  if (totalNodes === 0) return 0;

  let deductions = 0;
  const totalElements = totalNodes + totalRels;

  for (const v of violations) {
    const impactRatio = v.count / totalElements;

    switch (v.severity) {
      case 'error':
        deductions += Math.min(10, impactRatio * 100 * 2);
        break;
      case 'warning':
        deductions += Math.min(5, impactRatio * 100);
        break;
      case 'info':
        deductions += Math.min(2, impactRatio * 50);
        break;
    }
  }

  return Math.max(0, Math.min(100, Math.round(100 - deductions)));
}

// ─── Report Generation ──────────────────────────────────────────────────────

function generateReport(
  ontology: OntologyStructure,
  violations: Violation[],
  totalNodes: number,
  totalRels: number,
  nodesAnalyzed: number,
  relsAnalyzed: number
): Record<string, unknown> {
  const score = calculateComplianceScore(violations, totalNodes, totalRels);
  const grade = gradeScore(score);

  const byCategory: Record<string, number> = {};
  let errors = 0, warnings = 0, info = 0;

  for (const v of violations) {
    byCategory[v.category] = (byCategory[v.category] || 0) + 1;
    if (v.severity === 'error') errors++;
    else if (v.severity === 'warning') warnings++;
    else info++;
  }

  const topViolations = [...violations]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((v) => ({ type: v.type, count: v.count, severity: v.severity }));

  const invalidLabels = violations.filter((v) => v.type === 'invalid_label').map((v) => v.property);
  const invalidNamespaces = violations.filter((v) => v.type === 'unknown_property').flatMap((v) =>
    v.examples.map((e) => e.context || '').filter(Boolean)
  );
  const domainRangeViolations = violations.filter((v) => v.type === 'domain_violation' || v.type === 'range_violation').length;
  const missingRequired = violations.filter((v) => v.type === 'missing_required_property').map((v) => v.property);

  const recommendations: Array<{ priority: string; action: string; reasoning: string; impact: string }> = [];

  if (invalidLabels.length > 0) {
    recommendations.push({
      priority: 'high',
      action: `Review and fix ${invalidLabels.length} invalid label(s): ${invalidLabels.join(', ')}`,
      reasoning: 'Non-ontology labels indicate mapping errors or data outside the domain model.',
      impact: 'Improves class-level compliance and query reliability.',
    });
  }

  if (domainRangeViolations > 0) {
    recommendations.push({
      priority: 'medium',
      action: `Fix ${domainRangeViolations} domain/range constraint violation(s).`,
      reasoning: 'Relationships connecting wrong node types violate the ontology schema.',
      impact: 'Ensures semantic correctness of relationships.',
    });
  }

  if (missingRequired.length > 0) {
    recommendations.push({
      priority: 'high',
      action: `Populate missing required properties: ${missingRequired.join(', ')}`,
      reasoning: 'Required properties ensure minimum data quality.',
      impact: 'Data completeness and downstream query reliability.',
    });
  }

  const orphanedViolation = violations.find((v) => v.type === 'orphaned_nodes');
  if (orphanedViolation && orphanedViolation.count > totalNodes * 0.01) {
    recommendations.push({
      priority: 'low',
      action: `Review ${formatNumber(orphanedViolation.count)} orphaned nodes.`,
      reasoning: 'Orphaned nodes may indicate broken relationships or data quality issues.',
      impact: 'Graph connectivity and completeness.',
    });
  }

  return {
    metadata: {
      validatedAt: new Date().toISOString(),
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      graphSource: GRAPH_FILE,
    },
    overallCompliance: {
      isCompliant: score >= 70,
      score,
      grade,
    },
    statistics: {
      totalNodes,
      totalRelationships: totalRels,
      nodesAnalyzed,
      relationshipsAnalyzed: relsAnalyzed,
    },
    violations: violations.map((v) => ({
      ...v,
      examples: v.examples.slice(0, SAMPLE_LIMIT),
    })),
    violationSummary: {
      byCategory,
      bySeverity: { errors, warnings, info },
      topViolations,
    },
    ontologyRequirements: {
      validLabels: { met: invalidLabels.length === 0, invalid: invalidLabels },
      validNamespaces: { met: invalidNamespaces.length === 0, invalid: invalidNamespaces },
      validDomainRanges: { met: domainRangeViolations === 0, violations: domainRangeViolations },
      hasRequiredProperties: { met: missingRequired.length === 0, missing: missingRequired },
    },
    recommendations,
  };
}

function generateTextReport(report: Record<string, unknown>): string {
  const meta = report.metadata as Record<string, string>;
  const compliance = report.overallCompliance as { score: number; grade: string; isCompliant: boolean };
  const stats = report.statistics as { totalNodes: number; totalRelationships: number; nodesAnalyzed: number; relationshipsAnalyzed: number };
  const summary = report.violationSummary as { bySeverity: { errors: number; warnings: number; info: number }; byCategory: Record<string, number>; topViolations: Array<{ type: string; count: number; severity: string }> };
  const violations = report.violations as Violation[];
  const reqs = report.ontologyRequirements as Record<string, { met: boolean; invalid?: string[]; missing?: string[]; violations?: number }>;
  const recommendations = report.recommendations as Array<{ priority: string; action: string; reasoning: string; impact: string }>;

  const lines: string[] = [];

  lines.push('='.repeat(80));
  lines.push('  ONTOLOGY VALIDATION REPORT');
  lines.push('='.repeat(80));
  lines.push('');
  lines.push(`  Ontology:    ${meta.ontologyName} v${meta.ontologyVersion}`);
  lines.push(`  Validated:   ${meta.validatedAt}`);
  lines.push(`  Graph:       ${meta.graphSource}`);
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push(`  COMPLIANCE SCORE: ${compliance.score}/100 (Grade ${compliance.grade})`);
  lines.push(`  STATUS: ${compliance.isCompliant ? 'COMPLIANT' : 'NON-COMPLIANT'}`);
  lines.push('-'.repeat(80));
  lines.push('');
  lines.push('  GRAPH STATISTICS');
  lines.push(`    Total Nodes:            ${formatNumber(stats.totalNodes)}`);
  lines.push(`    Total Relationships:    ${formatNumber(stats.totalRelationships)}`);
  lines.push(`    Nodes Analyzed:         ${formatNumber(stats.nodesAnalyzed)}`);
  lines.push(`    Relationships Analyzed: ${formatNumber(stats.relationshipsAnalyzed)}`);
  lines.push('');
  lines.push('  ISSUE SUMMARY');
  lines.push(`    Errors:   ${summary.bySeverity.errors}`);
  lines.push(`    Warnings: ${summary.bySeverity.warnings}`);
  lines.push(`    Info:     ${summary.bySeverity.info}`);
  lines.push('');

  if (Object.keys(summary.byCategory).length > 0) {
    lines.push('  VIOLATIONS BY CATEGORY');
    for (const [cat, count] of Object.entries(summary.byCategory)) {
      lines.push(`    ${cat}: ${count}`);
    }
    lines.push('');
  }

  lines.push('  ONTOLOGY REQUIREMENTS');
  lines.push(`    Valid Labels:          ${reqs.validLabels.met ? 'PASS' : `FAIL (${(reqs.validLabels.invalid || []).length} invalid)`}`);
  lines.push(`    Valid Namespaces:      ${reqs.validNamespaces.met ? 'PASS' : `FAIL (${(reqs.validNamespaces.invalid || []).length} invalid)`}`);
  lines.push(`    Domain/Range:          ${reqs.validDomainRanges.met ? 'PASS' : `FAIL (${reqs.validDomainRanges.violations} violations)`}`);
  lines.push(`    Required Properties:   ${reqs.hasRequiredProperties.met ? 'PASS' : `FAIL (${(reqs.hasRequiredProperties.missing || []).length} missing)`}`);
  lines.push('');

  if (violations.length > 0) {
    lines.push('-'.repeat(80));
    lines.push('  DETAILED VIOLATIONS');
    lines.push('-'.repeat(80));
    for (const v of violations) {
      lines.push('');
      lines.push(`  [${v.severity.toUpperCase()}] ${v.type} (${v.category})`);
      lines.push(`    Property: ${v.property}`);
      lines.push(`    Count:    ${formatNumber(v.count)}`);
      lines.push(`    ${v.description}`);
      if (v.examples.length > 0) {
        lines.push(`    Examples:`);
        for (const ex of v.examples.slice(0, 3)) {
          const parts: string[] = [];
          if (ex.nodeId) parts.push(`ID: ${ex.nodeId}`);
          if (ex.labels) parts.push(`Labels: [${ex.labels.join(', ')}]`);
          if (ex.context) parts.push(ex.context);
          lines.push(`      - ${parts.join(' | ')}`);
        }
      }
    }
    lines.push('');
  }

  if (recommendations.length > 0) {
    lines.push('-'.repeat(80));
    lines.push('  RECOMMENDATIONS');
    lines.push('-'.repeat(80));
    for (const rec of recommendations) {
      lines.push('');
      lines.push(`  [${rec.priority.toUpperCase()}] ${rec.action}`);
      lines.push(`    Reasoning: ${rec.reasoning}`);
      lines.push(`    Impact:    ${rec.impact}`);
    }
    lines.push('');
  }

  lines.push('='.repeat(80));
  lines.push(`  Report generated at ${meta.validatedAt}`);
  lines.push('='.repeat(80));

  return lines.join('\n');
}

function generateFixesCypher(violations: Violation[]): string {
  const lines: string[] = [];

  lines.push('// ═══════════════════════════════════════════════════════════════════════════');
  lines.push('// Automated Fix Queries — Generated by Ontology Validator');
  lines.push(`// Generated: ${new Date().toISOString()}`);
  lines.push('// ═══════════════════════════════════════════════════════════════════════════');
  lines.push('');

  const safe: Array<{ violation: Violation; fix: Violation['fixStrategies'][0] }> = [];
  const moderate: Array<{ violation: Violation; fix: Violation['fixStrategies'][0] }> = [];
  const destructive: Array<{ violation: Violation; fix: Violation['fixStrategies'][0] }> = [];

  for (const v of violations) {
    for (const fix of v.fixStrategies) {
      if (fix.risk === 'safe') safe.push({ violation: v, fix });
      else if (fix.risk === 'moderate') moderate.push({ violation: v, fix });
      else destructive.push({ violation: v, fix });
    }
  }

  if (safe.length > 0) {
    lines.push('// ─── SAFE FIXES (review queries, no data modification) ──────────────────');
    lines.push('');
    for (const { violation, fix } of safe) {
      lines.push(`// ${fix.description}`);
      lines.push(`// Violation: ${violation.description}`);
      lines.push(fix.cypherQuery);
      lines.push('');
    }
  }

  if (moderate.length > 0) {
    lines.push('// ─── MODERATE FIXES (data modification, reversible) ──────────────────────');
    lines.push('');
    for (const { violation, fix } of moderate) {
      lines.push(`// ${fix.description}`);
      lines.push(`// Violation: ${violation.description}`);
      lines.push(`// Risk: MODERATE — Review before executing`);
      lines.push(fix.cypherQuery);
      lines.push('');
    }
  }

  if (destructive.length > 0) {
    lines.push('// ─── DESTRUCTIVE FIXES (data deletion, NOT reversible) ───────────────────');
    lines.push('// WARNING: These queries DELETE data. Review carefully before uncommenting.');
    lines.push('');
    for (const { violation, fix } of destructive) {
      lines.push(`// ${fix.description}`);
      lines.push(`// Violation: ${violation.description}`);
      lines.push(`// Risk: DESTRUCTIVE — Data will be permanently deleted`);
      lines.push(fix.cypherQuery);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          ONTOLOGY VALIDATION — Final Gatekeeper             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. Load required files
  console.log('[1/7] Loading input files...');

  if (!fs.existsSync(ONTOLOGY_FILE)) {
    console.error(`ERROR: Ontology file not found: ${ONTOLOGY_FILE}`);
    process.exit(2);
  }
  if (!fs.existsSync(MAPPING_FILE)) {
    console.error(`ERROR: Mapping guide not found: ${MAPPING_FILE}`);
    process.exit(2);
  }

  const ontology: OntologyStructure = JSON.parse(fs.readFileSync(ONTOLOGY_FILE, 'utf-8'));
  const mappingGuide: MappingGuide = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));

  // Load graph statistics from graph-data.json tail (avoid loading full file)
  let graphStats: GraphStatistics = { totalNodes: 0, nodesByType: {}, totalRelationships: 0, relationshipsByType: {} };
  if (fs.existsSync(GRAPH_FILE)) {
    const fd = fs.openSync(GRAPH_FILE, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const readSize = Math.min(8192, fileSize);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, fileSize - readSize);
    fs.closeSync(fd);
    const tail = buffer.toString('utf-8');
    const statsMatch = tail.match(/"statistics"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (statsMatch) {
      try {
        graphStats = JSON.parse(statsMatch[1]);
      } catch {
        console.log('  Warning: Could not parse graph statistics from tail, will use Neo4j counts.');
      }
    }
  }

  console.log(`  Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  Classes: ${ontology.classes.length}, Object Properties: ${ontology.objectProperties.length}, Data Properties: ${ontology.dataProperties.length}`);
  if (ontology.externalVocabularies) {
    const extClassCount = ontology.externalVocabularies.reduce((sum, ext) => sum + ext.classes.length, 0);
    const extPropCount = ontology.externalVocabularies.reduce((sum, ext) => sum + ext.properties.length, 0);
    console.log(`  External Vocabularies: ${ontology.externalVocabularies.length} (${extClassCount} classes, ${extPropCount} properties)`);
  }
  console.log(`  Mapping patterns: ${mappingGuide.commonPatterns.length}`);
  console.log('');

  // 2. Build validation rules from ontology
  console.log('[2/7] Building validation rules from ontology...');
  const validLabels = buildValidLabelsSet(ontology);
  console.log(`  Valid labels: ${validLabels.size}`);
  const allValidProps = buildAllValidPropertyNames(ontology);
  console.log(`  Valid property names: ${allValidProps.size}`);
  console.log('');

  // 3. Connect to Neo4j
  console.log('[3/7] Connecting to Neo4j...');
  const driver = createDriver();
  let session: Session;
  try {
    session = driver.session({ database: NEO4J_DATABASE });
    await runCypher(session, 'RETURN 1 AS ping');
    console.log(`  Connected to ${NEO4J_URI} (database: ${NEO4J_DATABASE})`);
  } catch (err) {
    console.error(`ERROR: Cannot connect to Neo4j at ${NEO4J_URI}: ${(err as Error).message}`);
    await driver.close();
    process.exit(2);
  }
  console.log('');

  // 4. Run validation checks
  console.log('[4/7] Running validation checks...');
  const violations: Violation[] = [];
  let totalNodes = 0;
  let totalRels = 0;

  try {
    const existingKeySet = await fetchExistingPropertyKeys(session);

    // (a) Class label validation
    const labelResult = await validateClassLabels(session, validLabels, violations);
    totalNodes = labelResult.totalNodes;

    // (b) Object property domain/range validation
    totalRels = await validateObjectPropertyDomainRange(session, ontology, violations);

    // (c) Data property domain validation
    await validateDataPropertyDomains(session, ontology, existingKeySet, violations);

    // (d) Data property datatype validation
    await validateDataPropertyDatatypes(session, ontology, existingKeySet, violations);

    // (e) Required properties check
    await validateRequiredProperties(session, mappingGuide, ontology, violations);

    // (f) Structural validation
    if (graphStats.totalNodes === 0) {
      graphStats.totalNodes = totalNodes;
      graphStats.totalRelationships = totalRels;
    }
    await validateStructure(session, graphStats, ontology, violations);

    // (g) Property namespace validation
    await validatePropertyNamespaces(session, ontology, existingKeySet, violations);
  } finally {
    await session.close();
    await driver.close();
  }
  console.log('');

  // 5. Generate report
  console.log('[5/7] Generating validation report...');
  const report = generateReport(ontology, violations, totalNodes, totalRels, totalNodes, totalRels);
  const compliance = report.overallCompliance as { score: number; grade: string; isCompliant: boolean };
  console.log('');

  // 6. Write output files
  console.log('[6/7] Writing output files...');

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`  ${REPORT_JSON}`);

  const textReport = generateTextReport(report);
  fs.writeFileSync(REPORT_TXT, textReport);
  console.log(`  ${REPORT_TXT}`);

  const fixesCypher = generateFixesCypher(violations);
  fs.writeFileSync(FIXES_FILE, fixesCypher);
  console.log(`  ${FIXES_FILE}`);

  const violationDetails = {
    generatedAt: new Date().toISOString(),
    totalViolations: violations.length,
    violations: violations.map((v) => ({ ...v })),
  };
  fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(violationDetails, null, 2));
  console.log(`  ${VIOLATIONS_FILE}`);
  console.log('');

  // 7. Console summary
  console.log('[7/7] Validation Summary');
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Compliance Score: ${String(compliance.score).padStart(3)}/100  Grade: ${compliance.grade}                        ║`);
  console.log(`║  Status: ${(compliance.isCompliant ? 'COMPLIANT' : 'NON-COMPLIANT').padEnd(49)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Nodes:         ${formatNumber(totalNodes).padStart(15)}                          ║`);
  console.log(`║  Relationships: ${formatNumber(totalRels).padStart(15)}                          ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  const summary = report.violationSummary as { bySeverity: { errors: number; warnings: number; info: number } };
  console.log(`║  Errors:   ${String(summary.bySeverity.errors).padStart(5)}                                        ║`);
  console.log(`║  Warnings: ${String(summary.bySeverity.warnings).padStart(5)}                                        ║`);
  console.log(`║  Info:     ${String(summary.bySeverity.info).padStart(5)}                                        ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Output Files:                                              ║');
  console.log(`║    ${path.basename(REPORT_JSON).padEnd(56)}║`);
  console.log(`║    ${path.basename(REPORT_TXT).padEnd(56)}║`);
  console.log(`║    ${path.basename(FIXES_FILE).padEnd(56)}║`);
  console.log(`║    ${path.basename(VIOLATIONS_FILE).padEnd(56)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Exit code
  if (compliance.score >= 95) {
    console.log('Result: FULLY COMPLIANT — Graph passes all ontology checks.');
    process.exit(0);
  } else if (compliance.score >= 70) {
    console.log(`Result: PARTIALLY COMPLIANT — Score ${compliance.score}/100. Review recommendations.`);
    process.exit(1);
  } else {
    console.log(`Result: NON-COMPLIANT — Score ${compliance.score}/100. Graph blocked from production use.`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Fatal validation error:', err);
  process.exit(2);
});
