import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import neo4j, { Driver, Integer, QueryResult, Session } from 'neo4j-driver';

type Primitive = string | number | boolean | null;
type Severity = 'error' | 'warning' | 'info';
type Category = 'class' | 'objectProperty' | 'dataProperty' | 'required' | 'structure';
type Risk = 'safe' | 'moderate' | 'destructive';

interface OntologyClass {
  uri: string;
  label: string;
  superClasses?: string[];
}

interface ObjectProperty {
  uri: string;
  label: string;
  domain?: string[];
  range?: string[];
}

interface DataProperty {
  uri: string;
  label: string;
  domain?: string[];
  range?: string;
}

interface ExternalVocabulary {
  prefix: string;
  namespace: string;
  classes?: string[];
  properties?: string[];
}

interface OntologyStructure {
  metadata: {
    title: string;
    version: string;
    namespaces: Record<string, string>;
    sourceFiles?: string[];
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

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface GraphRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
}

interface GraphData {
  metadata?: Record<string, unknown>;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

interface ViolationExample {
  nodeId?: string;
  labels?: string[];
  properties?: Record<string, unknown>;
  context?: string;
}

interface FixStrategy {
  strategy: string;
  cypherQuery: string;
  description: string;
  risk: Risk;
}

interface Violation {
  category: Category;
  type: string;
  property: string;
  severity: Severity;
  count: number;
  description: string;
  examples: ViolationExample[];
  fixStrategies: FixStrategy[];
}

interface GraphStatistics {
  totalNodes: number;
  totalRelationships: number;
  nodesAnalyzed: number;
  relationshipsAnalyzed: number;
}

interface ValidationReport {
  metadata: {
    validatedAt: string;
    ontologyName: string;
    ontologyVersion: string;
    graphSource: string;
  };
  overallCompliance: {
    isCompliant: boolean;
    score: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
  };
  statistics: GraphStatistics;
  violations: Violation[];
  violationSummary: {
    byCategory: Record<string, number>;
    bySeverity: { errors: number; warnings: number; info: number };
    topViolations: Array<{ type: string; count: number; severity: Severity }>;
  };
  ontologyRequirements: {
    validLabels: { met: boolean; invalid: string[] };
    validNamespaces: { met: boolean; invalid: string[] };
    validDomainRanges: { met: boolean; violations: number };
    hasRequiredProperties: { met: boolean; missing: string[] };
  };
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    action: string;
    reasoning: string;
    impact: string;
  }>;
}

interface RuntimeConfig {
  uri: string;
  user: string;
  password: string;
  database: string;
}

interface OntologyContext {
  ontology: OntologyStructure;
  mappingGuide: MappingGuide;
  graphData: GraphData;
  validLabelAliases: Map<string, Set<string>>;
  validLabelNames: Set<string>;
  objectPropertyAliases: Map<string, Set<string>>;
  dataPropertyAliases: Map<string, Set<string>>;
  allValidPropertyNames: Set<string>;
  prefixPattern: RegExp;
  namespacePrefixes: string[];
  coreClassUris: string[];
}

interface SnapshotState {
  nodeById: Map<string, GraphNode>;
  relationshipsByType: Map<string, GraphRelationship[]>;
  propertyKeys: string[];
  degreeByNodeId: Map<string, number>;
}

const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'domain-data/cultural-moma/output/codex');
const ONTOLOGY_FILE = path.resolve(DATA_DIR, 'ontology-structure.json');
const GRAPH_FILE = path.resolve(DATA_DIR, 'graph-data.json');
const MAPPING_FILE = path.resolve(DATA_DIR, 'ontology-mapping-guide.json');
const REPORT_JSON = path.resolve(DATA_DIR, 'validation-report.json');
const REPORT_TXT = path.resolve(DATA_DIR, 'validation-report.txt');
const FIXES_FILE = path.resolve(DATA_DIR, 'fixes.cypher');
const VIOLATIONS_FILE = path.resolve(DATA_DIR, 'violations-details.json');
const DEFAULT_DATABASE = 'neo4j';
const SAMPLE_LIMIT = 5;

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function ensureInputFilesExist(): void {
  for (const filePath of [ONTOLOGY_FILE, GRAPH_FILE, MAPPING_FILE]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required input file not found: ${filePath}`);
    }
  }
}

function getRequiredEnv(name: 'NEO4J_URI' | 'NEO4J_USER' | 'NEO4J_PASSWORD'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function getRuntimeConfig(): RuntimeConfig {
  return {
    uri: getRequiredEnv('NEO4J_URI'),
    user: getRequiredEnv('NEO4J_USER'),
    password: getRequiredEnv('NEO4J_PASSWORD'),
    database: process.env.NEO4J_DATABASE?.trim() || DEFAULT_DATABASE,
  };
}

function createDriver(config: RuntimeConfig): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (neo4j.isInt(value)) {
    return (value as Integer).toNumber();
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return 0;
}

function localName(value: string): string {
  const hashIndex = value.lastIndexOf('#');
  const slashIndex = value.lastIndexOf('/');
  return value.slice(Math.max(hashIndex, slashIndex) + 1);
}

function splitPrefixedName(value: string): { prefix: string; local: string } {
  const colonIndex = value.indexOf(':');
  if (colonIndex < 0) {
    return { prefix: '', local: value };
  }
  return {
    prefix: value.slice(0, colonIndex),
    local: value.slice(colonIndex + 1),
  };
}

function toPascalCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.length > 0 ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : pascal;
}

function addAlias(map: Map<string, Set<string>>, key: string, alias: string): void {
  if (!alias) {
    return;
  }
  const current = map.get(key) ?? new Set<string>();
  current.add(alias);
  map.set(key, current);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUriToCandidateStrings(uri: string, namespaces: Record<string, string>): Set<string> {
  const aliases = new Set<string>();
  const name = localName(uri);
  aliases.add(name);
  aliases.add(toPascalCase(name));
  aliases.add(toCamelCase(name));

  for (const [prefix, namespace] of Object.entries(namespaces)) {
    if (uri.startsWith(namespace)) {
      aliases.add(`${prefix}:${name}`);
      aliases.add(`${prefix}_${name}`);
      break;
    }
  }

  return aliases;
}

function sanitizeRelationshipType(rawType: string): string {
  const trimmed = rawType.trim();
  const lastSegment = trimmed.split(/[\/#]/).filter(Boolean).pop() ?? trimmed;
  const base = lastSegment
    .replace(/%[0-9A-Fa-f]{2}/g, '_')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase = base.length > 0 ? base : 'REL';
  const startsValid = /^[A-Za-z_]/.test(safeBase) ? safeBase : `REL_${safeBase}`;
  return startsValid.slice(0, 120);
}

function hashSuffix(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function buildOntologyContext(): OntologyContext {
  const ontology = readJsonFile<OntologyStructure>(ONTOLOGY_FILE);
  const mappingGuide = readJsonFile<MappingGuide>(MAPPING_FILE);
  const graphData = readJsonFile<GraphData>(GRAPH_FILE);

  const validLabelAliases = new Map<string, Set<string>>();
  const validLabelNames = new Set<string>();
  for (const cls of ontology.classes) {
    const aliases = normalizeUriToCandidateStrings(cls.uri, ontology.metadata.namespaces);
    aliases.add(cls.label);
    aliases.add(toPascalCase(cls.label));
    for (const alias of Array.from(aliases)) {
      addAlias(validLabelAliases, cls.uri, alias);
      validLabelNames.add(alias);
    }
  }

  for (const vocab of ontology.externalVocabularies ?? []) {
    for (const classRef of vocab.classes ?? []) {
      const { local, prefix } = splitPrefixedName(classRef);
      const syntheticUri = ontology.metadata.namespaces[prefix] ? `${ontology.metadata.namespaces[prefix]}${local}` : classRef;
      const aliases = normalizeUriToCandidateStrings(syntheticUri, ontology.metadata.namespaces);
      aliases.add(local);
      for (const alias of Array.from(aliases)) {
        addAlias(validLabelAliases, syntheticUri, alias);
        validLabelNames.add(alias);
      }
    }
  }

  const objectPropertyAliases = new Map<string, Set<string>>();
  const usedNeo4jTypes = new Map<string, string>();
  for (const property of ontology.objectProperties) {
    const aliases = normalizeUriToCandidateStrings(property.uri, ontology.metadata.namespaces);
    aliases.add(property.label);
    aliases.add(toCamelCase(property.label));
    aliases.add(toPascalCase(property.label));
    let neo4jType = sanitizeRelationshipType(property.uri);
    const existingOwner = usedNeo4jTypes.get(neo4jType);
    if (existingOwner && existingOwner !== property.uri) {
      neo4jType = `${neo4jType}_${hashSuffix(property.uri)}`;
    }
    usedNeo4jTypes.set(neo4jType, property.uri);
    aliases.add(neo4jType);
    for (const alias of Array.from(aliases)) {
      addAlias(objectPropertyAliases, property.uri, alias);
    }
  }

  for (const vocab of ontology.externalVocabularies ?? []) {
    for (const propertyRef of vocab.properties ?? []) {
      const { local, prefix } = splitPrefixedName(propertyRef);
      const syntheticUri = ontology.metadata.namespaces[prefix] ? `${ontology.metadata.namespaces[prefix]}${local}` : propertyRef;
      const aliases = normalizeUriToCandidateStrings(syntheticUri, ontology.metadata.namespaces);
      aliases.add(local);
      let neo4jType = sanitizeRelationshipType(syntheticUri);
      const existingOwner = usedNeo4jTypes.get(neo4jType);
      if (existingOwner && existingOwner !== syntheticUri) {
        neo4jType = `${neo4jType}_${hashSuffix(syntheticUri)}`;
      }
      usedNeo4jTypes.set(neo4jType, syntheticUri);
      aliases.add(neo4jType);
      for (const alias of Array.from(aliases)) {
        addAlias(objectPropertyAliases, syntheticUri, alias);
      }
    }
  }

  const dataPropertyAliases = new Map<string, Set<string>>();
  for (const property of ontology.dataProperties) {
    const aliases = normalizeUriToCandidateStrings(property.uri, ontology.metadata.namespaces);
    aliases.add(property.label);
    aliases.add(toCamelCase(property.label));
    aliases.add(toPascalCase(property.label));
    for (const alias of Array.from(aliases)) {
      addAlias(dataPropertyAliases, property.uri, alias);
    }
  }

  const allValidPropertyNames = new Set<string>();
  for (const aliasSet of Array.from(objectPropertyAliases.values()).concat(Array.from(dataPropertyAliases.values()))) {
    for (const alias of Array.from(aliasSet)) {
      allValidPropertyNames.add(alias);
    }
  }

  const namespacePrefixes = Object.keys(ontology.metadata.namespaces);
  const prefixPattern = new RegExp(`^(?:${namespacePrefixes.map(escapeRegExp).join('|')})(?::|_)`, 'i');

  const coreClassUris = mappingGuide.commonPatterns.length > 0
    ? mappingGuide.commonPatterns.map((pattern) => pattern.ontologyClass)
    : ontology.classes.filter((cls) => (cls.superClasses?.length ?? 0) === 0).map((cls) => cls.uri);

  return {
    ontology,
    mappingGuide,
    graphData,
    validLabelAliases,
    validLabelNames,
    objectPropertyAliases,
    dataPropertyAliases,
    allValidPropertyNames,
    prefixPattern,
    namespacePrefixes,
    coreClassUris,
  };
}

async function runQuery<T extends Record<string, unknown>>(
  session: Session,
  query: string,
  parameters: Record<string, unknown> = {}
): Promise<T[]> {
  const result: QueryResult = await session.run(query, parameters);
  return result.records.map((record) => {
    const row: Record<string, unknown> = {};
    for (const key of record.keys) {
      row[String(key)] = record.get(String(key));
    }
    return row as T;
  });
}

function resolveClassAliases(uri: string, context: OntologyContext): string[] {
  return Array.from(context.validLabelAliases.get(uri) ?? new Set<string>());
}

function resolvePropertyAliases(uri: string, aliasMap: Map<string, Set<string>>): string[] {
  return Array.from(aliasMap.get(uri) ?? new Set<string>());
}

function chooseBestAlias(aliases: string[]): string {
  const uriLike = aliases.find((alias) => alias.startsWith('http://') || alias.startsWith('https://'));
  if (uriLike) {
    return uriLike;
  }
  const human = aliases.find((alias) => alias.includes(' '));
  if (human) {
    return human;
  }
  return aliases[0] ?? '';
}

function datatypeValidator(range: string): (value: unknown) => boolean {
  const local = localName(range);
  switch (local) {
    case 'string':
    case 'Literal':
      return () => true;
    case 'boolean':
      return (value) => typeof value === 'boolean' || value === 'true' || value === 'false';
    case 'integer':
    case 'int':
    case 'long':
    case 'short':
      return (value) => Number.isInteger(typeof value === 'number' ? value : Number(value));
    case 'decimal':
    case 'float':
    case 'double':
      return (value) => !Number.isNaN(Number(value));
    case 'date':
      return (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'dateTime':
      return (value) =>
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
    case 'gYear':
      return (value) => typeof value === 'string' && /^-?\d{4}$/.test(value);
    case 'anyURI':
      return (value) => typeof value === 'string' && /^https?:\/\/|^urn:/.test(value);
    default:
      return () => true;
  }
}

function buildSnapshotState(graphData: GraphData): SnapshotState {
  const nodeById = new Map<string, GraphNode>();
  const relationshipsByType = new Map<string, GraphRelationship[]>();
  const propertyKeys = new Set<string>();
  const degreeByNodeId = new Map<string, number>();

  for (const node of graphData.nodes) {
    nodeById.set(node.id, node);
    degreeByNodeId.set(node.id, degreeByNodeId.get(node.id) ?? 0);
    for (const key of Object.keys(node.properties ?? {})) {
      propertyKeys.add(key);
    }
  }

  for (const relationship of graphData.relationships) {
    const group = relationshipsByType.get(relationship.type) ?? [];
    group.push(relationship);
    relationshipsByType.set(relationship.type, group);
    degreeByNodeId.set(relationship.from, (degreeByNodeId.get(relationship.from) ?? 0) + 1);
    degreeByNodeId.set(relationship.to, (degreeByNodeId.get(relationship.to) ?? 0) + 1);
  }

  return {
    nodeById,
    relationshipsByType,
    propertyKeys: Array.from(propertyKeys).sort((left, right) => left.localeCompare(right)),
    degreeByNodeId,
  };
}

function hasAnyLabel(labels: string[], validLabels: string[]): boolean {
  return labels.some((label) => validLabels.includes(label));
}

function pickNodeExamples(nodes: GraphNode[], limit = SAMPLE_LIMIT): ViolationExample[] {
  return nodes.slice(0, limit).map((node) => ({
    nodeId: node.id,
    labels: node.labels,
    properties: node.properties,
  }));
}

async function fetchPropertyKeys(session: Session): Promise<string[]> {
  const rows = await runQuery<{ key: string }>(
    session,
    'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey AS key ORDER BY key'
  );
  return rows.map((row) => String(row.key));
}

function fetchPropertyKeysFromSnapshot(state: SnapshotState): string[] {
  return state.propertyKeys;
}

async function validateClassLabels(
  session: Session,
  context: OntologyContext,
  violations: Violation[]
): Promise<{ invalidLabels: string[]; totalNodes: number; nodesAnalyzed: number }> {
  const rows = await runQuery<{ nodeLabels: string[]; count: Integer | number }>(
    session,
    'MATCH (n) RETURN DISTINCT labels(n) AS nodeLabels, count(*) AS count'
  );

  let totalNodes = 0;
  let nodesAnalyzed = 0;
  const invalidLabels = new Map<string, number>();

  for (const row of rows) {
    const count = asNumber(row.count);
    totalNodes += count;
    nodesAnalyzed += count;
    for (const label of row.nodeLabels ?? []) {
      if (!context.validLabelNames.has(label)) {
        invalidLabels.set(label, (invalidLabels.get(label) ?? 0) + count);
      }
    }
  }

  for (const [label, count] of Array.from(invalidLabels.entries())) {
    const sampleRows = await runQuery<{ nodeId: string; labels: string[] }>(
      session,
      `MATCH (n:${quoteIdentifier(label)}) RETURN n.id AS nodeId, labels(n) AS labels LIMIT ${SAMPLE_LIMIT}`
    );
    violations.push({
      category: 'class',
      type: 'invalid_label',
      property: label,
      severity: 'error',
      count,
      description: `Node label "${label}" is not derived from ontology-structure.json classes or referenced vocabulary classes.`,
      examples: sampleRows.map((row) => ({
        nodeId: typeof row.nodeId === 'string' ? row.nodeId : undefined,
        labels: Array.isArray(row.labels) ? row.labels : [],
      })),
      fixStrategies: [
        {
          strategy: 'add_missing_label_mapping',
          cypherQuery: `// Review invalid label "${label}" before changing data\nMATCH (n:${quoteIdentifier(label)}) RETURN n.id, labels(n), properties(n) LIMIT 25;`,
          description: 'Review whether this label should map to an ontology class alias or be removed.',
          risk: 'safe',
        },
        {
          strategy: 'remove_invalid_label',
          cypherQuery: `// Moderate risk: only if "${label}" is truly invalid\nMATCH (n:${quoteIdentifier(label)}) REMOVE n:${quoteIdentifier(label)};`,
          description: 'Remove the invalid label from nodes after confirming the correct ontology label.',
          risk: 'moderate',
        },
      ],
    });
  }

  return {
    invalidLabels: Array.from(invalidLabels.keys()),
    totalNodes,
    nodesAnalyzed,
  };
}

function validateClassLabelsFromSnapshot(
  context: OntologyContext,
  state: SnapshotState,
  violations: Violation[]
): { invalidLabels: string[]; totalNodes: number; nodesAnalyzed: number } {
  const invalidLabels = new Map<string, GraphNode[]>();

  for (const node of context.graphData.nodes) {
    for (const label of node.labels ?? []) {
      if (!context.validLabelNames.has(label)) {
        const existing = invalidLabels.get(label) ?? [];
        existing.push(node);
        invalidLabels.set(label, existing);
      }
    }
  }

  for (const [label, nodes] of Array.from(invalidLabels.entries())) {
    violations.push({
      category: 'class',
      type: 'invalid_label',
      property: label,
      severity: 'error',
      count: nodes.length,
      description: `Node label "${label}" is not derived from ontology-structure.json classes or referenced vocabulary classes.`,
      examples: pickNodeExamples(nodes),
      fixStrategies: [
        {
          strategy: 'add_missing_label_mapping',
          cypherQuery: `// Review invalid label "${label}" before changing data\nMATCH (n:${quoteIdentifier(label)}) RETURN n.id, labels(n), properties(n) LIMIT 25;`,
          description: 'Review whether this label should map to an ontology class alias or be removed.',
          risk: 'safe',
        },
        {
          strategy: 'remove_invalid_label',
          cypherQuery: `// Moderate risk: only if "${label}" is truly invalid\nMATCH (n:${quoteIdentifier(label)}) REMOVE n:${quoteIdentifier(label)};`,
          description: 'Remove the invalid label from nodes after confirming the correct ontology label.',
          risk: 'moderate',
        },
      ],
    });
  }

  return {
    invalidLabels: Array.from(invalidLabels.keys()),
    totalNodes: context.graphData.nodes.length,
    nodesAnalyzed: context.graphData.nodes.length,
  };
}

async function validateObjectPropertyDomainRange(
  session: Session,
  context: OntologyContext,
  violations: Violation[]
): Promise<{ relationshipsAnalyzed: number; domainRangeViolations: number }> {
  let relationshipsAnalyzed = 0;
  let domainRangeViolations = 0;

  for (const property of context.ontology.objectProperties) {
    const domains = property.domain ?? [];
    const ranges = property.range ?? [];
    if (domains.length === 0 && ranges.length === 0) {
      continue;
    }

    const aliases = resolvePropertyAliases(property.uri, context.objectPropertyAliases);
    if (aliases.length === 0) {
      continue;
    }

    const typeRows = await runQuery<{ relationshipType: string; count: Integer | number }>(
      session,
      'MATCH ()-[r]->() WHERE type(r) IN $types RETURN type(r) AS relationshipType, count(r) AS count',
      { types: aliases }
    );

    if (typeRows.length === 0) {
      continue;
    }

    const relationshipCount = typeRows.reduce((sum, row) => sum + asNumber(row.count), 0);
    relationshipsAnalyzed += relationshipCount;

    const domainAliases = domains.flatMap((domainUri) => resolveClassAliases(domainUri, context));
    const rangeAliases = ranges.flatMap((rangeUri) => resolveClassAliases(rangeUri, context));

    if (domainAliases.length > 0) {
      const invalidSources = await runQuery<{
        nodeId: string;
        labels: string[];
        relationshipType: string;
        count: Integer | number;
      }>(
        session,
        `MATCH (s)-[r]->()
         WHERE type(r) IN $types
         AND NONE(label IN labels(s) WHERE label IN $validLabels)
         RETURN s.id AS nodeId, labels(s) AS labels, type(r) AS relationshipType, count(r) AS count
         ORDER BY count DESC
         LIMIT ${SAMPLE_LIMIT}`,
        { types: aliases, validLabels: domainAliases }
      );

      if (invalidSources.length > 0) {
        const count = invalidSources.reduce((sum, row) => sum + asNumber(row.count), 0);
        domainRangeViolations += count;
        violations.push({
          category: 'objectProperty',
          type: 'domain_violation',
          property: property.uri,
          severity: 'error',
          count,
          description: `Relationship "${property.uri}" is attached to source nodes outside its ontology domain.`,
          examples: invalidSources.map((row) => ({
            nodeId: row.nodeId,
            labels: row.labels,
            context: `Observed relationship type ${row.relationshipType}; expected one of [${domainAliases.join(', ')}]`,
          })),
          fixStrategies: [
            {
              strategy: 'add_inferred_domain_label',
              cypherQuery: `MATCH (s)-[r]->() WHERE type(r) IN ${JSON.stringify(aliases)} AND NONE(label IN labels(s) WHERE label IN ${JSON.stringify(domainAliases)}) SET s:${quoteIdentifier(chooseBestAlias(domainAliases))};`,
              description: 'Add an inferred ontology label to source nodes when the relationship semantics are trusted.',
              risk: 'moderate',
            },
            {
              strategy: 'delete_invalid_relationships',
              cypherQuery: `// Destructive: uncomment only after review\n// MATCH (s)-[r]->() WHERE type(r) IN ${JSON.stringify(aliases)} AND NONE(label IN labels(s) WHERE label IN ${JSON.stringify(domainAliases)}) DELETE r;`,
              description: 'Delete relationships whose source nodes cannot be reconciled to the ontology domain.',
              risk: 'destructive',
            },
          ],
        });
      }
    }

    if (rangeAliases.length > 0) {
      const invalidTargets = await runQuery<{
        nodeId: string;
        labels: string[];
        relationshipType: string;
        count: Integer | number;
      }>(
        session,
        `MATCH ()-[r]->(t)
         WHERE type(r) IN $types
         AND NONE(label IN labels(t) WHERE label IN $validLabels)
         RETURN t.id AS nodeId, labels(t) AS labels, type(r) AS relationshipType, count(r) AS count
         ORDER BY count DESC
         LIMIT ${SAMPLE_LIMIT}`,
        { types: aliases, validLabels: rangeAliases }
      );

      if (invalidTargets.length > 0) {
        const count = invalidTargets.reduce((sum, row) => sum + asNumber(row.count), 0);
        domainRangeViolations += count;
        violations.push({
          category: 'objectProperty',
          type: 'range_violation',
          property: property.uri,
          severity: 'error',
          count,
          description: `Relationship "${property.uri}" points to target nodes outside its ontology range.`,
          examples: invalidTargets.map((row) => ({
            nodeId: row.nodeId,
            labels: row.labels,
            context: `Observed relationship type ${row.relationshipType}; expected one of [${rangeAliases.join(', ')}]`,
          })),
          fixStrategies: [
            {
              strategy: 'add_inferred_range_label',
              cypherQuery: `MATCH ()-[r]->(t) WHERE type(r) IN ${JSON.stringify(aliases)} AND NONE(label IN labels(t) WHERE label IN ${JSON.stringify(rangeAliases)}) SET t:${quoteIdentifier(chooseBestAlias(rangeAliases))};`,
              description: 'Add an inferred ontology label to target nodes when the relationship semantics are trusted.',
              risk: 'moderate',
            },
            {
              strategy: 'delete_invalid_relationships',
              cypherQuery: `// Destructive: uncomment only after review\n// MATCH ()-[r]->(t) WHERE type(r) IN ${JSON.stringify(aliases)} AND NONE(label IN labels(t) WHERE label IN ${JSON.stringify(rangeAliases)}) DELETE r;`,
              description: 'Delete relationships whose targets cannot be reconciled to the ontology range.',
              risk: 'destructive',
            },
          ],
        });
      }
    }
  }

  return { relationshipsAnalyzed, domainRangeViolations };
}

function validateObjectPropertyDomainRangeFromSnapshot(
  context: OntologyContext,
  state: SnapshotState,
  violations: Violation[]
): { relationshipsAnalyzed: number; domainRangeViolations: number } {
  let relationshipsAnalyzed = 0;
  let domainRangeViolations = 0;

  for (const property of context.ontology.objectProperties) {
    const domains = property.domain ?? [];
    const ranges = property.range ?? [];
    if (domains.length === 0 && ranges.length === 0) {
      continue;
    }

    const aliases = new Set(resolvePropertyAliases(property.uri, context.objectPropertyAliases));
    const matchingRelationships = context.graphData.relationships.filter((relationship) => aliases.has(relationship.type));
    if (matchingRelationships.length === 0) {
      continue;
    }

    relationshipsAnalyzed += matchingRelationships.length;
    const domainAliases = domains.flatMap((domainUri) => resolveClassAliases(domainUri, context));
    const rangeAliases = ranges.flatMap((rangeUri) => resolveClassAliases(rangeUri, context));

    if (domainAliases.length > 0) {
      const invalidSources = matchingRelationships.filter((relationship) => {
        const sourceNode = state.nodeById.get(relationship.from);
        return !sourceNode || !hasAnyLabel(sourceNode.labels ?? [], domainAliases);
      });

      if (invalidSources.length > 0) {
        domainRangeViolations += invalidSources.length;
        violations.push({
          category: 'objectProperty',
          type: 'domain_violation',
          property: property.uri,
          severity: 'error',
          count: invalidSources.length,
          description: `Relationship "${property.uri}" is attached to source nodes outside its ontology domain.`,
          examples: invalidSources.slice(0, SAMPLE_LIMIT).map((relationship) => {
            const sourceNode = state.nodeById.get(relationship.from);
            return {
              nodeId: relationship.from,
              labels: sourceNode?.labels ?? [],
              properties: sourceNode?.properties,
              context: `Expected one of [${domainAliases.join(', ')}] for relationship ${relationship.type}`,
            };
          }),
          fixStrategies: [
            {
              strategy: 'add_inferred_domain_label',
              cypherQuery: `MATCH (s)-[r]->() WHERE type(r) IN ${JSON.stringify(Array.from(aliases))} AND NONE(label IN labels(s) WHERE label IN ${JSON.stringify(domainAliases)}) SET s:${quoteIdentifier(chooseBestAlias(domainAliases))};`,
              description: 'Add an inferred ontology label to source nodes when the relationship semantics are trusted.',
              risk: 'moderate',
            },
            {
              strategy: 'delete_invalid_relationships',
              cypherQuery: `// Destructive: uncomment only after review\n// MATCH (s)-[r]->() WHERE type(r) IN ${JSON.stringify(Array.from(aliases))} AND NONE(label IN labels(s) WHERE label IN ${JSON.stringify(domainAliases)}) DELETE r;`,
              description: 'Delete relationships whose source nodes cannot be reconciled to the ontology domain.',
              risk: 'destructive',
            },
          ],
        });
      }
    }

    if (rangeAliases.length > 0) {
      const invalidTargets = matchingRelationships.filter((relationship) => {
        const targetNode = state.nodeById.get(relationship.to);
        return !targetNode || !hasAnyLabel(targetNode.labels ?? [], rangeAliases);
      });

      if (invalidTargets.length > 0) {
        domainRangeViolations += invalidTargets.length;
        violations.push({
          category: 'objectProperty',
          type: 'range_violation',
          property: property.uri,
          severity: 'error',
          count: invalidTargets.length,
          description: `Relationship "${property.uri}" points to target nodes outside its ontology range.`,
          examples: invalidTargets.slice(0, SAMPLE_LIMIT).map((relationship) => {
            const targetNode = state.nodeById.get(relationship.to);
            return {
              nodeId: relationship.to,
              labels: targetNode?.labels ?? [],
              properties: targetNode?.properties,
              context: `Expected one of [${rangeAliases.join(', ')}] for relationship ${relationship.type}`,
            };
          }),
          fixStrategies: [
            {
              strategy: 'add_inferred_range_label',
              cypherQuery: `MATCH ()-[r]->(t) WHERE type(r) IN ${JSON.stringify(Array.from(aliases))} AND NONE(label IN labels(t) WHERE label IN ${JSON.stringify(rangeAliases)}) SET t:${quoteIdentifier(chooseBestAlias(rangeAliases))};`,
              description: 'Add an inferred ontology label to target nodes when the relationship semantics are trusted.',
              risk: 'moderate',
            },
            {
              strategy: 'delete_invalid_relationships',
              cypherQuery: `// Destructive: uncomment only after review\n// MATCH ()-[r]->(t) WHERE type(r) IN ${JSON.stringify(Array.from(aliases))} AND NONE(label IN labels(t) WHERE label IN ${JSON.stringify(rangeAliases)}) DELETE r;`,
              description: 'Delete relationships whose targets cannot be reconciled to the ontology range.',
              risk: 'destructive',
            },
          ],
        });
      }
    }
  }

  return { relationshipsAnalyzed, domainRangeViolations };
}

async function validateDataPropertyDomains(
  session: Session,
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): Promise<void> {
  const propertyKeySet = new Set(propertyKeys);

  for (const property of context.ontology.dataProperties) {
    const domains = property.domain ?? [];
    if (domains.length === 0) {
      continue;
    }

    const aliases = resolvePropertyAliases(property.uri, context.dataPropertyAliases).filter((alias) => propertyKeySet.has(alias));
    if (aliases.length === 0) {
      continue;
    }

    const domainAliases = domains.flatMap((domainUri) => resolveClassAliases(domainUri, context));
    if (domainAliases.length === 0) {
      continue;
    }

    for (const alias of aliases) {
      const invalidRows = await runQuery<{ nodeId: string; labels: string[]; value: unknown }>(
        session,
        `MATCH (n)
         WHERE n.${quoteIdentifier(alias)} IS NOT NULL
         AND NONE(label IN labels(n) WHERE label IN $validLabels)
         RETURN n.id AS nodeId, labels(n) AS labels, n.${quoteIdentifier(alias)} AS value
         LIMIT ${SAMPLE_LIMIT}`,
        { validLabels: domainAliases }
      );

      if (invalidRows.length === 0) {
        continue;
      }

      const countRows = await runQuery<{ count: Integer | number }>(
        session,
        `MATCH (n)
         WHERE n.${quoteIdentifier(alias)} IS NOT NULL
         AND NONE(label IN labels(n) WHERE label IN $validLabels)
         RETURN count(n) AS count`,
        { validLabels: domainAliases }
      );

      violations.push({
        category: 'dataProperty',
        type: 'domain_violation',
        property: property.uri,
        severity: 'warning',
        count: asNumber(countRows[0]?.count),
        description: `Property "${property.uri}" appears on nodes outside its ontology domain.`,
        examples: invalidRows.map((row) => ({
          nodeId: row.nodeId,
          labels: row.labels,
          properties: { [alias]: row.value as Primitive },
          context: `Expected one of [${domainAliases.join(', ')}]`,
        })),
        fixStrategies: [
          {
            strategy: 'review_property_placement',
            cypherQuery: `MATCH (n) WHERE n.${quoteIdentifier(alias)} IS NOT NULL AND NONE(label IN labels(n) WHERE label IN ${JSON.stringify(domainAliases)}) RETURN n.id, labels(n), n.${quoteIdentifier(alias)} LIMIT 25;`,
            description: 'Review nodes carrying the property outside its ontology domain.',
            risk: 'safe',
          },
        ],
      });
    }
  }
}

function validateDataPropertyDomainsFromSnapshot(
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): void {
  const propertyKeySet = new Set(propertyKeys);

  for (const property of context.ontology.dataProperties) {
    const domains = property.domain ?? [];
    if (domains.length === 0) {
      continue;
    }

    const aliases = resolvePropertyAliases(property.uri, context.dataPropertyAliases).filter((alias) => propertyKeySet.has(alias));
    const domainAliases = domains.flatMap((domainUri) => resolveClassAliases(domainUri, context));
    if (aliases.length === 0 || domainAliases.length === 0) {
      continue;
    }

    for (const alias of aliases) {
      const invalidNodes = context.graphData.nodes.filter((node) => {
        return node.properties?.[alias] !== undefined && !hasAnyLabel(node.labels ?? [], domainAliases);
      });

      if (invalidNodes.length === 0) {
        continue;
      }

      violations.push({
        category: 'dataProperty',
        type: 'domain_violation',
        property: property.uri,
        severity: 'warning',
        count: invalidNodes.length,
        description: `Property "${property.uri}" appears on nodes outside its ontology domain.`,
        examples: invalidNodes.slice(0, SAMPLE_LIMIT).map((node) => ({
          nodeId: node.id,
          labels: node.labels,
          properties: { [alias]: node.properties[alias] as Primitive },
          context: `Expected one of [${domainAliases.join(', ')}]`,
        })),
        fixStrategies: [
          {
            strategy: 'review_property_placement',
            cypherQuery: `MATCH (n) WHERE n.${quoteIdentifier(alias)} IS NOT NULL AND NONE(label IN labels(n) WHERE label IN ${JSON.stringify(domainAliases)}) RETURN n.id, labels(n), n.${quoteIdentifier(alias)} LIMIT 25;`,
            description: 'Review nodes carrying the property outside its ontology domain.',
            risk: 'safe',
          },
        ],
      });
    }
  }
}

async function validateDataPropertyDatatypes(
  session: Session,
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): Promise<void> {
  const propertyKeySet = new Set(propertyKeys);

  for (const property of context.ontology.dataProperties) {
    if (!property.range) {
      continue;
    }

    const validator = datatypeValidator(property.range);
    const aliases = resolvePropertyAliases(property.uri, context.dataPropertyAliases).filter((alias) => propertyKeySet.has(alias));

    for (const alias of aliases) {
      const rows = await runQuery<{ nodeId: string; value: unknown; labels: string[] }>(
        session,
        `MATCH (n)
         WHERE n.${quoteIdentifier(alias)} IS NOT NULL
         RETURN n.id AS nodeId, n.${quoteIdentifier(alias)} AS value, labels(n) AS labels
         LIMIT 200`
      );

      const invalid = rows.filter((row) => !validator(row.value));
      if (invalid.length === 0) {
        continue;
      }

      const totalRows = await runQuery<{ count: Integer | number }>(
        session,
        `MATCH (n) WHERE n.${quoteIdentifier(alias)} IS NOT NULL RETURN count(n) AS count`
      );
      const estimatedCount = Math.round((invalid.length / rows.length) * Math.max(asNumber(totalRows[0]?.count), rows.length));

      violations.push({
        category: 'dataProperty',
        type: 'datatype_violation',
        property: property.uri,
        severity: estimatedCount > 1000 ? 'error' : 'warning',
        count: estimatedCount,
        description: `Property "${property.uri}" does not consistently match datatype "${property.range}".`,
        examples: invalid.slice(0, SAMPLE_LIMIT).map((row) => ({
          nodeId: row.nodeId,
          labels: row.labels,
          properties: { [alias]: row.value as Primitive },
          context: `Expected datatype ${property.range}`,
        })),
        fixStrategies: [
          {
            strategy: 'review_invalid_datatypes',
            cypherQuery: `MATCH (n) WHERE n.${quoteIdentifier(alias)} IS NOT NULL RETURN n.id, labels(n), n.${quoteIdentifier(alias)} AS value LIMIT 50;`,
            description: 'Review property values that should be coerced or reformatted.',
            risk: 'safe',
          },
        ],
      });
    }
  }
}

function validateDataPropertyDatatypesFromSnapshot(
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): void {
  const propertyKeySet = new Set(propertyKeys);

  for (const property of context.ontology.dataProperties) {
    if (!property.range) {
      continue;
    }

    const validator = datatypeValidator(property.range);
    const aliases = resolvePropertyAliases(property.uri, context.dataPropertyAliases).filter((alias) => propertyKeySet.has(alias));
    for (const alias of aliases) {
      const nodesWithProperty = context.graphData.nodes.filter((node) => node.properties?.[alias] !== undefined);
      const invalidNodes = nodesWithProperty.filter((node) => !validator(node.properties?.[alias]));
      if (invalidNodes.length === 0) {
        continue;
      }

      violations.push({
        category: 'dataProperty',
        type: 'datatype_violation',
        property: property.uri,
        severity: invalidNodes.length > 1000 ? 'error' : 'warning',
        count: invalidNodes.length,
        description: `Property "${property.uri}" does not consistently match datatype "${property.range}".`,
        examples: invalidNodes.slice(0, SAMPLE_LIMIT).map((node) => ({
          nodeId: node.id,
          labels: node.labels,
          properties: { [alias]: node.properties[alias] as Primitive },
          context: `Expected datatype ${property.range}`,
        })),
        fixStrategies: [
          {
            strategy: 'review_invalid_datatypes',
            cypherQuery: `MATCH (n) WHERE n.${quoteIdentifier(alias)} IS NOT NULL RETURN n.id, labels(n), n.${quoteIdentifier(alias)} AS value LIMIT 50;`,
            description: 'Review property values that should be coerced or reformatted.',
            risk: 'safe',
          },
        ],
      });
    }
  }
}

async function validateRequiredProperties(
  session: Session,
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): Promise<string[]> {
  const missingRequirements: string[] = [];
  const propertyKeySet = new Set(propertyKeys);

  for (const pattern of context.mappingGuide.commonPatterns) {
    if ((pattern.requiredProperties ?? []).length === 0) {
      continue;
    }

    const classAliases = resolveClassAliases(pattern.ontologyClass, context);
    if (classAliases.length === 0) {
      continue;
    }

    const label = chooseBestAlias(classAliases);
    const classCountRows = await runQuery<{ count: Integer | number }>(
      session,
      `MATCH (n) WHERE ANY(label IN labels(n) WHERE label IN $classAliases) RETURN count(n) AS count`,
      { classAliases }
    );
    const classCount = asNumber(classCountRows[0]?.count);
    if (classCount === 0) {
      continue;
    }

    for (const requirement of pattern.requiredProperties) {
      const requirementUris = requirement.includes('http://') || requirement.includes('https://')
        ? [requirement]
        : (() => {
            const split = splitPrefixedName(requirement);
            const namespace = context.ontology.metadata.namespaces[split.prefix];
            return namespace ? [`${namespace}${split.local}`] : [requirement];
          })();

      const objectAliases = requirementUris.flatMap((uri) => resolvePropertyAliases(uri, context.objectPropertyAliases));
      const dataAliases = requirementUris.flatMap((uri) => resolvePropertyAliases(uri, context.dataPropertyAliases))
        .filter((alias) => propertyKeySet.has(alias));
      const relTypes = Array.from(new Set(objectAliases));
      const propKeys = Array.from(new Set(dataAliases));

      const rows = await runQuery<{
        nodeId: string;
        labels: string[];
        count: Integer | number;
      }>(
        session,
        `MATCH (n)
         WHERE ANY(label IN labels(n) WHERE label IN $classAliases)
         AND NOT (
           (${relTypes.length > 0 ? 'EXISTS { MATCH (n)-[r]->() WHERE type(r) IN $relTypes }' : 'false'})
           OR
           (${propKeys.length > 0 ? 'ANY(propKey IN $propKeys WHERE n[propKey] IS NOT NULL)' : 'false'})
         )
         RETURN n.id AS nodeId, labels(n) AS labels, count(n) AS count
         LIMIT ${SAMPLE_LIMIT}`,
        { classAliases, relTypes, propKeys }
      );

      if (rows.length === 0) {
        continue;
      }

      const countRows = await runQuery<{ count: Integer | number }>(
        session,
        `MATCH (n)
         WHERE ANY(label IN labels(n) WHERE label IN $classAliases)
         AND NOT (
           (${relTypes.length > 0 ? 'EXISTS { MATCH (n)-[r]->() WHERE type(r) IN $relTypes }' : 'false'})
           OR
           (${propKeys.length > 0 ? 'ANY(propKey IN $propKeys WHERE n[propKey] IS NOT NULL)' : 'false'})
         )
         RETURN count(n) AS count`,
        { classAliases, relTypes, propKeys }
      );

      const requirementName = requirementUris[0];
      missingRequirements.push(`${label}:${requirementName}`);
      violations.push({
        category: 'required',
        type: 'missing_required_property',
        property: requirementName,
        severity: 'error',
        count: asNumber(countRows[0]?.count),
        description: `Nodes matching ontology class "${pattern.ontologyClass}" are missing required property or relationship "${requirementName}".`,
        examples: rows.map((row) => ({
          nodeId: row.nodeId,
          labels: row.labels,
          context: `Required by mapping pattern: ${pattern.scenario}`,
        })),
        fixStrategies: [
          {
            strategy: 'inspect_missing_requirement',
            cypherQuery: `MATCH (n) WHERE ANY(label IN labels(n) WHERE label IN ${JSON.stringify(classAliases)}) RETURN n.id, labels(n), properties(n) LIMIT 25;`,
            description: 'Inspect nodes missing a mapping-guide requirement before inferring data.',
            risk: 'safe',
          },
          {
            strategy: 'add_inferred_requirement',
            cypherQuery: `// Moderate risk: infer the required property/relationship only if you can derive it from source data.`,
            description: 'Backfill required fields from the source system or graph derivation logic.',
            risk: 'moderate',
          },
        ],
      });
    }
  }

  return missingRequirements;
}

function validateRequiredPropertiesFromSnapshot(
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): string[] {
  const missingRequirements: string[] = [];
  const propertyKeySet = new Set(propertyKeys);

  for (const pattern of context.mappingGuide.commonPatterns) {
    if ((pattern.requiredProperties ?? []).length === 0) {
      continue;
    }

    const classAliases = resolveClassAliases(pattern.ontologyClass, context);
    const candidateNodes = context.graphData.nodes.filter((node) => hasAnyLabel(node.labels ?? [], classAliases));
    if (candidateNodes.length === 0) {
      continue;
    }

    for (const requirement of pattern.requiredProperties) {
      const requirementUris = requirement.includes('http://') || requirement.includes('https://')
        ? [requirement]
        : (() => {
            const split = splitPrefixedName(requirement);
            const namespace = context.ontology.metadata.namespaces[split.prefix];
            return namespace ? [`${namespace}${split.local}`] : [requirement];
          })();

      const objectAliases = new Set(requirementUris.flatMap((uri) => resolvePropertyAliases(uri, context.objectPropertyAliases)));
      const dataAliases = requirementUris.flatMap((uri) => resolvePropertyAliases(uri, context.dataPropertyAliases))
        .filter((alias) => propertyKeySet.has(alias));

      const invalidNodes = candidateNodes.filter((node) => {
        const hasRequiredRelationship = context.graphData.relationships.some((relationship) => relationship.from === node.id && objectAliases.has(relationship.type));
        const hasRequiredProperty = dataAliases.some((alias) => node.properties?.[alias] !== undefined);
        return !hasRequiredRelationship && !hasRequiredProperty;
      });

      if (invalidNodes.length === 0) {
        continue;
      }

      const label = chooseBestAlias(classAliases);
      const requirementName = requirementUris[0];
      missingRequirements.push(`${label}:${requirementName}`);
      violations.push({
        category: 'required',
        type: 'missing_required_property',
        property: requirementName,
        severity: 'error',
        count: invalidNodes.length,
        description: `Nodes matching ontology class "${pattern.ontologyClass}" are missing required property or relationship "${requirementName}".`,
        examples: invalidNodes.slice(0, SAMPLE_LIMIT).map((node) => ({
          nodeId: node.id,
          labels: node.labels,
          properties: node.properties,
          context: `Required by mapping pattern: ${pattern.scenario}`,
        })),
        fixStrategies: [
          {
            strategy: 'inspect_missing_requirement',
            cypherQuery: `MATCH (n) WHERE ANY(label IN labels(n) WHERE label IN ${JSON.stringify(classAliases)}) RETURN n.id, labels(n), properties(n) LIMIT 25;`,
            description: 'Inspect nodes missing a mapping-guide requirement before inferring data.',
            risk: 'safe',
          },
          {
            strategy: 'add_inferred_requirement',
            cypherQuery: `// Moderate risk: infer the required property/relationship only if you can derive it from source data.`,
            description: 'Backfill required fields from the source system or graph derivation logic.',
            risk: 'moderate',
          },
        ],
      });
    }
  }

  return missingRequirements;
}

async function validateStructuralRules(
  session: Session,
  context: OntologyContext,
  statistics: GraphStatistics,
  violations: Violation[]
): Promise<void> {
  const orphanRows = await runQuery<{ count: Integer | number }>(
    session,
    'MATCH (n) WHERE NOT (n)--() RETURN count(n) AS count'
  );
  const orphanCount = asNumber(orphanRows[0]?.count);
  if (orphanCount > 0) {
    const orphanExamples = await runQuery<{ nodeId: string; labels: string[] }>(
      session,
      `MATCH (n) WHERE NOT (n)--() RETURN n.id AS nodeId, labels(n) AS labels LIMIT ${SAMPLE_LIMIT}`
    );
    violations.push({
      category: 'structure',
      type: 'orphaned_nodes',
      property: 'graph_connectivity',
      severity: orphanCount > Math.max(10, statistics.totalNodes * 0.01) ? 'warning' : 'info',
      count: orphanCount,
      description: 'Nodes with no incoming or outgoing relationships were found.',
      examples: orphanExamples.map((row) => ({ nodeId: row.nodeId, labels: row.labels })),
      fixStrategies: [
        {
          strategy: 'review_orphaned_nodes',
          cypherQuery: 'MATCH (n) WHERE NOT (n)--() RETURN n.id, labels(n), properties(n) LIMIT 50;',
          description: 'Review orphaned nodes before reconnecting or deleting them.',
          risk: 'safe',
        },
        {
          strategy: 'delete_orphaned_nodes',
          cypherQuery: '// Destructive: uncomment only after review\n// MATCH (n) WHERE NOT (n)--() DELETE n;',
          description: 'Delete disconnected nodes that have no valid place in the graph.',
          risk: 'destructive',
        },
      ],
    });
  }

  const missingCoreClasses: string[] = [];
  for (const classUri of context.coreClassUris) {
    const aliases = resolveClassAliases(classUri, context);
    if (aliases.length === 0) {
      continue;
    }
    const rows = await runQuery<{ count: Integer | number }>(
      session,
      'MATCH (n) WHERE ANY(label IN labels(n) WHERE label IN $aliases) RETURN count(n) AS count',
      { aliases }
    );
    if (asNumber(rows[0]?.count) === 0) {
      missingCoreClasses.push(classUri);
    }
  }

  if (missingCoreClasses.length > 0) {
    violations.push({
      category: 'structure',
      type: 'missing_core_class_instances',
      property: 'core_entity_classes',
      severity: 'warning',
      count: missingCoreClasses.length,
      description: 'At least one ontology-derived core entity class has no instances in Neo4j.',
      examples: missingCoreClasses.slice(0, SAMPLE_LIMIT).map((uri) => ({
        context: uri,
      })),
      fixStrategies: [
        {
          strategy: 'review_missing_core_classes',
          cypherQuery: 'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC;',
          description: 'Compare populated labels with core classes derived from the ontology mapping guide.',
          risk: 'safe',
        },
      ],
    });
  }
}

function validateStructuralRulesFromSnapshot(
  context: OntologyContext,
  state: SnapshotState,
  statistics: GraphStatistics,
  violations: Violation[]
): void {
  const orphanNodes = context.graphData.nodes.filter((node) => (state.degreeByNodeId.get(node.id) ?? 0) === 0);
  if (orphanNodes.length > 0) {
    violations.push({
      category: 'structure',
      type: 'orphaned_nodes',
      property: 'graph_connectivity',
      severity: orphanNodes.length > Math.max(10, statistics.totalNodes * 0.01) ? 'warning' : 'info',
      count: orphanNodes.length,
      description: 'Nodes with no incoming or outgoing relationships were found.',
      examples: pickNodeExamples(orphanNodes),
      fixStrategies: [
        {
          strategy: 'review_orphaned_nodes',
          cypherQuery: 'MATCH (n) WHERE NOT (n)--() RETURN n.id, labels(n), properties(n) LIMIT 50;',
          description: 'Review orphaned nodes before reconnecting or deleting them.',
          risk: 'safe',
        },
        {
          strategy: 'delete_orphaned_nodes',
          cypherQuery: '// Destructive: uncomment only after review\n// MATCH (n) WHERE NOT (n)--() DELETE n;',
          description: 'Delete disconnected nodes that have no valid place in the graph.',
          risk: 'destructive',
        },
      ],
    });
  }

  const missingCoreClasses = context.coreClassUris.filter((classUri) => {
    const aliases = resolveClassAliases(classUri, context);
    return !context.graphData.nodes.some((node) => hasAnyLabel(node.labels ?? [], aliases));
  });

  if (missingCoreClasses.length > 0) {
    violations.push({
      category: 'structure',
      type: 'missing_core_class_instances',
      property: 'core_entity_classes',
      severity: 'warning',
      count: missingCoreClasses.length,
      description: 'At least one ontology-derived core entity class has no instances in Neo4j.',
      examples: missingCoreClasses.slice(0, SAMPLE_LIMIT).map((uri) => ({ context: uri })),
      fixStrategies: [
        {
          strategy: 'review_missing_core_classes',
          cypherQuery: 'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC;',
          description: 'Compare populated labels with core classes derived from the ontology mapping guide.',
          risk: 'safe',
        },
      ],
    });
  }
}

async function validatePropertyNamespaces(
  session: Session,
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): Promise<string[]> {
  const invalidKeys = propertyKeys.filter((key) => {
    if (key === 'id') {
      return false;
    }
    if (context.allValidPropertyNames.has(key)) {
      return false;
    }
    if (!key.includes(':') && !key.includes('_')) {
      return true;
    }
    return !context.prefixPattern.test(key);
  });

  if (invalidKeys.length > 0) {
    const sampleKey = invalidKeys[0];
    const sampleRows = await runQuery<{ nodeId: string; labels: string[]; value: unknown }>(
      session,
      `MATCH (n)
       WHERE n.${quoteIdentifier(sampleKey)} IS NOT NULL
       RETURN n.id AS nodeId, labels(n) AS labels, n.${quoteIdentifier(sampleKey)} AS value
       LIMIT ${SAMPLE_LIMIT}`
    );

    violations.push({
      category: 'dataProperty',
      type: 'invalid_namespace_property',
      property: 'property_namespace',
      severity: 'warning',
      count: invalidKeys.length,
      description: `Property keys were found that are neither ontology-derived names nor prefixed with ontology metadata namespaces (${context.namespacePrefixes.join(', ')}).`,
      examples: sampleRows.map((row) => ({
        nodeId: row.nodeId,
        labels: row.labels,
        properties: { [sampleKey]: row.value as Primitive },
        context: `Invalid key example: ${sampleKey}`,
      })),
      fixStrategies: [
        {
          strategy: 'review_invalid_property_names',
          cypherQuery: 'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey;',
          description: 'Review database property keys against ontology-derived aliases and namespace prefixes.',
          risk: 'safe',
        },
      ],
    });
  }

  return invalidKeys;
}

function validatePropertyNamespacesFromSnapshot(
  context: OntologyContext,
  propertyKeys: string[],
  violations: Violation[]
): string[] {
  const invalidKeys = propertyKeys.filter((key) => {
    if (key === 'id') {
      return false;
    }
    if (context.allValidPropertyNames.has(key)) {
      return false;
    }
    if (!key.includes(':') && !key.includes('_')) {
      return true;
    }
    return !context.prefixPattern.test(key);
  });

  if (invalidKeys.length > 0) {
    const sampleKey = invalidKeys[0];
    const sampleNodes = context.graphData.nodes.filter((node) => node.properties?.[sampleKey] !== undefined);
    violations.push({
      category: 'dataProperty',
      type: 'invalid_namespace_property',
      property: 'property_namespace',
      severity: 'warning',
      count: invalidKeys.length,
      description: `Property keys were found that are neither ontology-derived names nor prefixed with ontology metadata namespaces (${context.namespacePrefixes.join(', ')}).`,
      examples: sampleNodes.slice(0, SAMPLE_LIMIT).map((node) => ({
        nodeId: node.id,
        labels: node.labels,
        properties: { [sampleKey]: node.properties[sampleKey] as Primitive },
        context: `Invalid key example: ${sampleKey}`,
      })),
      fixStrategies: [
        {
          strategy: 'review_invalid_property_names',
          cypherQuery: 'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey;',
          description: 'Review database property keys against ontology-derived aliases and namespace prefixes.',
          risk: 'safe',
        },
      ],
    });
  }

  return invalidKeys;
}

function scoreViolations(violations: Violation[], statistics: GraphStatistics): number {
  const totalElements = Math.max(statistics.totalNodes + statistics.totalRelationships, 1);
  let deductions = 0;

  for (const violation of violations) {
    const impact = Math.min(violation.count / totalElements, 1);
    if (violation.severity === 'error') {
      deductions += Math.min(35, Math.ceil(impact * 120));
    } else if (violation.severity === 'warning') {
      deductions += Math.min(20, Math.ceil(impact * 70));
    } else {
      deductions += Math.min(10, Math.ceil(impact * 30));
    }
  }

  return Math.max(0, Math.min(100, 100 - deductions));
}

function grade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 95) {
    return 'A';
  }
  if (score >= 85) {
    return 'B';
  }
  if (score >= 70) {
    return 'C';
  }
  if (score >= 60) {
    return 'D';
  }
  return 'F';
}

function buildRecommendations(violations: Violation[]): ValidationReport['recommendations'] {
  const recommendations: ValidationReport['recommendations'] = [];

  const invalidLabels = violations.filter((violation) => violation.type === 'invalid_label');
  if (invalidLabels.length > 0) {
    recommendations.push({
      priority: 'high',
      action: 'Reconcile invalid Neo4j labels with ontology-derived class aliases.',
      reasoning: 'Class labels are the primary gatekeeper for every downstream domain/range and required-property check.',
      impact: 'Reduces class-level errors and improves semantic consistency.',
    });
  }

  const objectViolations = violations.filter(
    (violation) => violation.type === 'domain_violation' || violation.type === 'range_violation'
  );
  if (objectViolations.length > 0) {
    recommendations.push({
      priority: 'high',
      action: 'Repair relationship domain/range mismatches before adding or deleting data.',
      reasoning: 'Invalid edges corrupt graph semantics and can make inferred fixes dangerous.',
      impact: 'Improves ontology compliance and trust in graph traversals.',
    });
  }

  const requiredViolations = violations.filter((violation) => violation.type === 'missing_required_property');
  if (requiredViolations.length > 0) {
    recommendations.push({
      priority: 'medium',
      action: 'Backfill mapping-guide required properties or relationships from source data.',
      reasoning: 'Missing required fields indicate incomplete mapping execution rather than isolated bad records.',
      impact: 'Raises data completeness and unblocks stricter downstream validation.',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'low',
      action: 'Keep the validator in CI as a release gate.',
      reasoning: 'The graph is currently compliant enough that regression prevention matters more than manual remediation.',
      impact: 'Preserves graph quality over future generation cycles.',
    });
  }

  return recommendations;
}

function buildReport(
  context: OntologyContext,
  statistics: GraphStatistics,
  violations: Violation[],
  invalidLabels: string[],
  invalidNamespaces: string[],
  domainRangeViolations: number,
  missingRequirements: string[],
  graphSource: string
): ValidationReport {
  const score = scoreViolations(violations, statistics);
  const finalGrade = grade(score);
  const byCategory: Record<string, number> = {};
  const bySeverity = { errors: 0, warnings: 0, info: 0 };

  for (const violation of violations) {
    byCategory[violation.category] = (byCategory[violation.category] ?? 0) + violation.count;
    if (violation.severity === 'error') {
      bySeverity.errors += violation.count;
    } else if (violation.severity === 'warning') {
      bySeverity.warnings += violation.count;
    } else {
      bySeverity.info += violation.count;
    }
  }

  return {
    metadata: {
      validatedAt: new Date().toISOString(),
      ontologyName: context.ontology.metadata.title,
      ontologyVersion: context.ontology.metadata.version,
      graphSource,
    },
    overallCompliance: {
      isCompliant: score >= 95,
      score,
      grade: finalGrade,
    },
    statistics,
    violations,
    violationSummary: {
      byCategory,
      bySeverity,
      topViolations: [...violations]
        .sort((left, right) => right.count - left.count)
        .slice(0, 10)
        .map((violation) => ({
          type: violation.type,
          count: violation.count,
          severity: violation.severity,
        })),
    },
    ontologyRequirements: {
      validLabels: {
        met: invalidLabels.length === 0,
        invalid: invalidLabels,
      },
      validNamespaces: {
        met: invalidNamespaces.length === 0,
        invalid: invalidNamespaces,
      },
      validDomainRanges: {
        met: domainRangeViolations === 0,
        violations: domainRangeViolations,
      },
      hasRequiredProperties: {
        met: missingRequirements.length === 0,
        missing: missingRequirements,
      },
    },
    recommendations: buildRecommendations(violations),
  };
}

function buildFixesCypher(report: ValidationReport): string {
  const safe: string[] = [];
  const moderate: string[] = [];
  const destructive: string[] = [];

  for (const violation of report.violations) {
    for (const strategy of violation.fixStrategies) {
      const lines = [
        `// ${violation.category} | ${violation.type} | ${strategy.risk}`,
        `// ${strategy.description}`,
        strategy.cypherQuery,
        '',
      ];
      const chunk = lines.join('\n');
      if (strategy.risk === 'safe') {
        safe.push(chunk);
      } else if (strategy.risk === 'moderate') {
        moderate.push(chunk);
      } else {
        destructive.push(chunk);
      }
    }
  }

  return [
    `// Ontology validation fixes generated at ${report.metadata.validatedAt}`,
    `// Ontology: ${report.metadata.ontologyName} v${report.metadata.ontologyVersion}`,
    '',
    '// SAFE FIXES',
    ...safe,
    '// MODERATE FIXES',
    ...moderate,
    '// DESTRUCTIVE FIXES',
    ...destructive,
  ].join('\n');
}

function buildTextReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`Ontology Validation Report`);
  lines.push(`Validated At: ${report.metadata.validatedAt}`);
  lines.push(`Ontology: ${report.metadata.ontologyName} v${report.metadata.ontologyVersion}`);
  lines.push(`Graph Source: ${report.metadata.graphSource}`);
  lines.push('');
  lines.push(`Overall Compliance: ${report.overallCompliance.score}/100 (${report.overallCompliance.grade})`);
  lines.push(`Compliant Gate: ${report.overallCompliance.isCompliant ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`Statistics`);
  lines.push(`- Total Nodes: ${formatNumber(report.statistics.totalNodes)}`);
  lines.push(`- Total Relationships: ${formatNumber(report.statistics.totalRelationships)}`);
  lines.push(`- Nodes Analyzed: ${formatNumber(report.statistics.nodesAnalyzed)}`);
  lines.push(`- Relationships Analyzed: ${formatNumber(report.statistics.relationshipsAnalyzed)}`);
  lines.push('');
  lines.push(`Issue Breakdown`);
  lines.push(`- Errors: ${formatNumber(report.violationSummary.bySeverity.errors)}`);
  lines.push(`- Warnings: ${formatNumber(report.violationSummary.bySeverity.warnings)}`);
  lines.push(`- Info: ${formatNumber(report.violationSummary.bySeverity.info)}`);
  lines.push('');
  lines.push(`Ontology Requirements`);
  lines.push(`- Valid Labels: ${report.ontologyRequirements.validLabels.met ? 'met' : 'not met'}`);
  lines.push(`- Valid Namespaces: ${report.ontologyRequirements.validNamespaces.met ? 'met' : 'not met'}`);
  lines.push(`- Valid Domain/Range Rules: ${report.ontologyRequirements.validDomainRanges.met ? 'met' : 'not met'}`);
  lines.push(`- Required Properties: ${report.ontologyRequirements.hasRequiredProperties.met ? 'met' : 'not met'}`);
  lines.push('');
  lines.push(`Violations`);

  if (report.violations.length === 0) {
    lines.push(`- No violations found.`);
  } else {
    for (const violation of report.violations) {
      lines.push(`- [${violation.severity.toUpperCase()}] ${violation.type} (${formatNumber(violation.count)})`);
      lines.push(`  Property: ${violation.property}`);
      lines.push(`  Description: ${violation.description}`);
      if (violation.examples.length > 0) {
        const example = violation.examples[0];
        lines.push(`  Example: ${example.nodeId ?? 'n/a'} ${example.context ?? ''}`.trimEnd());
      }
    }
  }

  lines.push('');
  lines.push(`Next Steps`);
  for (const recommendation of report.recommendations) {
    lines.push(`- [${recommendation.priority.toUpperCase()}] ${recommendation.action}`);
    lines.push(`  Reasoning: ${recommendation.reasoning}`);
    lines.push(`  Impact: ${recommendation.impact}`);
  }

  return lines.join('\n');
}

function writeOutputs(report: ValidationReport): void {
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(report.violations, null, 2));
  fs.writeFileSync(FIXES_FILE, buildFixesCypher(report));
  fs.writeFileSync(REPORT_TXT, buildTextReport(report));
}

function printSummary(report: ValidationReport): void {
  console.log(`Compliance Score: ${report.overallCompliance.score}/100`);
  console.log(`Grade: ${report.overallCompliance.grade}`);
  console.log(`Total Nodes: ${formatNumber(report.statistics.totalNodes)}`);
  console.log(`Total Relationships: ${formatNumber(report.statistics.totalRelationships)}`);
  console.log(
    `Issues: ${formatNumber(report.violationSummary.bySeverity.errors)} errors, ` +
      `${formatNumber(report.violationSummary.bySeverity.warnings)} warnings, ` +
      `${formatNumber(report.violationSummary.bySeverity.info)} info`
  );
  console.log(`Outputs:`);
  console.log(`- ${REPORT_JSON}`);
  console.log(`- ${REPORT_TXT}`);
  console.log(`- ${FIXES_FILE}`);
  console.log(`- ${VIOLATIONS_FILE}`);
}

function exitCodeForScore(score: number): number {
  if (score >= 95) {
    return 0;
  }
  if (score >= 70) {
    return 1;
  }
  return 2;
}

async function gatherStatistics(session: Session): Promise<GraphStatistics> {
  const countRows = await runQuery<{ totalNodes: Integer | number; totalRelationships: Integer | number }>(
    session,
    'MATCH (n) WITH count(n) AS totalNodes MATCH ()-[r]->() RETURN totalNodes, count(r) AS totalRelationships'
  );

  return {
    totalNodes: asNumber(countRows[0]?.totalNodes),
    totalRelationships: asNumber(countRows[0]?.totalRelationships),
    nodesAnalyzed: 0,
    relationshipsAnalyzed: 0,
  };
}

function gatherSnapshotStatistics(graphData: GraphData): GraphStatistics {
  return {
    totalNodes: graphData.nodes.length,
    totalRelationships: graphData.relationships.length,
    nodesAnalyzed: 0,
    relationshipsAnalyzed: 0,
  };
}

function isConnectivityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to connect to server|ECONNREFUSED|EPERM|ENOTFOUND|EHOSTUNREACH/i.test(message);
}

async function main(): Promise<void> {
  ensureInputFilesExist();
  const context = buildOntologyContext();
  const runtime = getRuntimeConfig();
  const violations: Violation[] = [];
  let statistics: GraphStatistics;
  let propertyKeys: string[];
  let classResult: { invalidLabels: string[]; totalNodes: number; nodesAnalyzed: number };
  let objectResult: { relationshipsAnalyzed: number; domainRangeViolations: number };
  let missingRequirements: string[];
  let invalidNamespaces: string[];
  let graphSource = `${GRAPH_FILE} (validated against Neo4j database ${runtime.database})`;

  try {
    const driver = createDriver(runtime);
    try {
      const session = driver.session({ database: runtime.database });
      try {
        statistics = await gatherStatistics(session);
        propertyKeys = await fetchPropertyKeys(session);
        classResult = await validateClassLabels(session, context, violations);
        statistics.nodesAnalyzed = classResult.nodesAnalyzed;
        objectResult = await validateObjectPropertyDomainRange(session, context, violations);
        statistics.relationshipsAnalyzed = objectResult.relationshipsAnalyzed || statistics.totalRelationships;
        await validateDataPropertyDomains(session, context, propertyKeys, violations);
        await validateDataPropertyDatatypes(session, context, propertyKeys, violations);
        missingRequirements = await validateRequiredProperties(session, context, propertyKeys, violations);
        await validateStructuralRules(session, context, statistics, violations);
        invalidNamespaces = await validatePropertyNamespaces(session, context, propertyKeys, violations);
      } finally {
        await session.close();
      }
    } finally {
      await driver.close();
    }
  } catch (error: unknown) {
    if (!isConnectivityError(error)) {
      throw error;
    }

    console.warn(`Neo4j connectivity unavailable; falling back to exported graph snapshot validation. ${error instanceof Error ? error.message : String(error)}`);
    const snapshotState = buildSnapshotState(context.graphData);
    statistics = gatherSnapshotStatistics(context.graphData);
    propertyKeys = fetchPropertyKeysFromSnapshot(snapshotState);
    classResult = validateClassLabelsFromSnapshot(context, snapshotState, violations);
    statistics.nodesAnalyzed = classResult.nodesAnalyzed;
    objectResult = validateObjectPropertyDomainRangeFromSnapshot(context, snapshotState, violations);
    statistics.relationshipsAnalyzed = objectResult.relationshipsAnalyzed || statistics.totalRelationships;
    validateDataPropertyDomainsFromSnapshot(context, propertyKeys, violations);
    validateDataPropertyDatatypesFromSnapshot(context, propertyKeys, violations);
    missingRequirements = validateRequiredPropertiesFromSnapshot(context, propertyKeys, violations);
    validateStructuralRulesFromSnapshot(context, snapshotState, statistics, violations);
    invalidNamespaces = validatePropertyNamespacesFromSnapshot(context, propertyKeys, violations);
    graphSource = `${GRAPH_FILE} (snapshot fallback; Neo4j connectivity unavailable for database ${runtime.database})`;
  }

  if (statistics.relationshipsAnalyzed === 0) {
    statistics.relationshipsAnalyzed = statistics.totalRelationships;
  }

  const report = buildReport(
    context,
    statistics,
    violations,
    classResult.invalidLabels,
    invalidNamespaces,
    objectResult.domainRangeViolations,
    missingRequirements,
    graphSource
  );

  writeOutputs(report);
  printSummary(report);
  process.exitCode = exitCodeForScore(report.overallCompliance.score);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Validation failed: ${message}`);
  process.exitCode = 2;
});
