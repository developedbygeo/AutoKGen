import { promises as fs } from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import neo4j, { Driver, Integer, Session } from 'neo4j-driver';

type Primitive = string | number | boolean | null;
type PropertyValue = Primitive | Primitive[];

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface GraphRelationship {
  id?: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface GraphStatistics {
  totalNodes?: number;
  nodesByType?: Record<string, number>;
  totalRelationships?: number;
  relationshipsByType?: Record<string, number>;
}

interface GraphData {
  metadata?: Record<string, unknown>;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  statistics?: GraphStatistics;
}

interface RuntimeConfig {
  uri: string;
  user: string;
  password: string;
  database: string;
}

interface ExistingState {
  nodeCount: number;
  relationshipCount: number;
  labels: string[];
  relationshipTypes: string[];
  constraintCount: number;
  indexCount: number;
}

interface ImportReport {
  status: 'success' | 'partial' | 'failed';
  duration: number;
  throughput: {
    nodesPerSecond: number;
    relationshipsPerSecond: number;
  };
  imported: {
    nodes: number;
    relationships: number;
    nodesByLabel: Record<string, number>;
    relationshipsByType: Record<string, number>;
  };
  optimization: {
    constraintsCreated: number;
    indexesCreated: number;
    batchSize: {
      nodes: number;
      relationships: number;
    };
  };
  validation: {
    expectedNodes: number;
    actualNodes: number;
    expectedRelationships: number;
    actualRelationships: number;
    orphanedNodes: number;
  };
  errors: string[];
}

interface ProgressTracker {
  label: string;
  startedAt: number;
  totalRecords: number;
  totalBatches: number;
  processedRecords: number;
  completedBatches: number;
}

interface ConstraintPlan {
  label: string;
  query: string;
}

interface IndexPlan {
  label: string;
  property: string;
  query: string;
}

interface ValidationSummary {
  actualNodes: number;
  actualRelationships: number;
  orphanedNodes: number;
  missingIdNodes: number;
  nodeCountsRaw: Array<{ labels: string[]; count: number }>;
  relationshipCounts: Array<{ type: string; count: number }>;
}

interface SourceCounts {
  nodesByLabel: Record<string, number>;
  relationshipsByType: Record<string, number>;
}

interface NodeGroup {
  labels: string[];
  nodes: GraphNode[];
}

interface RelationshipGroup {
  rawType: string;
  neo4jType: string;
  relationships: GraphRelationship[];
}

interface SourceAnalysis {
  nodeGroups: NodeGroup[];
  relationshipGroups: RelationshipGroup[];
  sourceCounts: SourceCounts;
}

interface ImportMetrics {
  constraintsCreated: number;
  indexesCreated: number;
  importedNodes: number;
  importedRelationships: number;
}

const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const GRAPH_FILE = path.resolve(PROJECT_ROOT, 'domain-data/cultural-moma/output/codex/graph-data.json');
const REPORT_FILE = path.resolve(PROJECT_ROOT, 'domain-data/cultural-moma/output/codex/neo4j-import-report.json');
const DEFAULT_DATABASE = 'neo4j';
const DEFAULT_LABEL = 'Resource';
const PROGRESS_LOG_INTERVAL = 10;
const PARALLEL_IMPORT_THRESHOLD = 100_000;
const MAX_INDEXES_PER_LABEL = 2;

const BATCH_CONFIG = {
  nodesBatchSize: 5000,
  relsBatchSize: 2500,
  enablePeriodicCommit: true,
  parallelBatches: 4,
  indexesBeforeImport: true,
} as const;

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatRate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatMemoryUsage(): string {
  const usage = process.memoryUsage();
  return `heap ${(usage.heapUsed / 1024 / 1024).toFixed(0)}/${(usage.heapTotal / 1024 / 1024).toFixed(0)} MB | rss ${(usage.rss / 1024 / 1024).toFixed(0)} MB`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (neo4j.isInt(value)) {
    return (value as Integer).toNumber();
  }

  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }

  return 0;
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function normalizeScalar(value: unknown): Primitive {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return JSON.stringify(value);
}

function normalizeValue(value: unknown): PropertyValue {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeScalar(entry));
  }

  return normalizeScalar(value);
}

function normalizeProperties(properties: Record<string, unknown>): Record<string, PropertyValue> {
  const normalized: Record<string, PropertyValue> = {};

  for (const [key, value] of Object.entries(properties ?? {})) {
    normalized[key] = normalizeValue(value);
  }

  return normalized;
}

function uniqueLabels(labels: string[]): string[] {
  const filtered = labels.filter((label) => typeof label === 'string' && label.trim() !== '');
  return filtered.length > 0 ? Array.from(new Set(filtered)) : [DEFAULT_LABEL];
}

function labelsSignature(labels: string[]): string {
  return uniqueLabels(labels).slice().sort((a, b) => a.localeCompare(b)).join('||');
}

function labelsToCypher(labels: string[]): string {
  const allLabels = Array.from(new Set([DEFAULT_LABEL, ...uniqueLabels(labels)]));
  return allLabels.map((label) => quoteIdentifier(label)).join(':');
}

function ensureNodeProperties(node: GraphNode): Record<string, PropertyValue> {
  const nodeProperties = normalizeProperties(node.properties ?? {});
  if (!nodeProperties.id) {
    nodeProperties.id = node.id;
  }
  return nodeProperties;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    throw new Error(`Invalid chunk size: ${chunkSize}`);
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function incrementCounter(counter: Record<string, number>, key: string, amount = 1): void {
  counter[key] = (counter[key] ?? 0) + amount;
}

function buildProgressTracker(label: string, totalRecords: number, totalBatches: number): ProgressTracker {
  return {
    label,
    startedAt: Date.now(),
    totalRecords,
    totalBatches,
    processedRecords: 0,
    completedBatches: 0,
  };
}

function logProgress(tracker: ProgressTracker, recordsInBatch: number, force = false): void {
  tracker.processedRecords += recordsInBatch;
  tracker.completedBatches += 1;

  if (!force && tracker.completedBatches % PROGRESS_LOG_INTERVAL !== 0 && tracker.completedBatches !== tracker.totalBatches) {
    return;
  }

  const elapsedMs = Math.max(Date.now() - tracker.startedAt, 1);
  const throughput = tracker.processedRecords / (elapsedMs / 1000);
  const remaining = Math.max(tracker.totalRecords - tracker.processedRecords, 0);
  const etaMs = throughput > 0 ? (remaining / throughput) * 1000 : 0;

  console.log(
    `[${tracker.label}] Batch ${tracker.completedBatches}/${tracker.totalBatches} | ` +
      `${formatNumber(tracker.processedRecords)}/${formatNumber(tracker.totalRecords)} records | ` +
      `${formatRate(throughput)} rec/sec | ETA: ${formatDuration(Math.round(etaMs))} | ${formatMemoryUsage()}`
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}. Set ${name} before running the Neo4j importer.`);
  }
  return value;
}

function loadRuntimeConfig(): RuntimeConfig {
  return {
    uri: requireEnv('NEO4J_URI'),
    user: requireEnv('NEO4J_USER'),
    password: requireEnv('NEO4J_PASSWORD'),
    database: process.env.NEO4J_DATABASE?.trim() || DEFAULT_DATABASE,
  };
}

async function ensureReadableFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Required graph data file not found: ${filePath}`);
  }
}

async function loadGraphData(filePath: string): Promise<GraphData> {
  await ensureReadableFile(filePath);
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as GraphData;

  if (!Array.isArray(parsed.nodes)) {
    throw new Error(`Invalid graph data in ${filePath}: expected "nodes" array.`);
  }

  if (!Array.isArray(parsed.relationships)) {
    throw new Error(`Invalid graph data in ${filePath}: expected "relationships" array.`);
  }

  return parsed;
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

function validateSourceData(graphData: GraphData): void {
  const seenNodeIds = new Set<string>();

  for (let index = 0; index < graphData.nodes.length; index += 1) {
    const node = graphData.nodes[index];
    if (!node || typeof node.id !== 'string' || node.id.trim() === '') {
      throw new Error(`Invalid graph node at index ${index}: every node must have a non-empty string id.`);
    }

    if (seenNodeIds.has(node.id)) {
      throw new Error(`Duplicate node id found in source graph: ${node.id}`);
    }
    seenNodeIds.add(node.id);
  }

  for (let index = 0; index < graphData.relationships.length; index += 1) {
    const relationship = graphData.relationships[index];
    if (!relationship || typeof relationship.type !== 'string' || relationship.type.trim() === '') {
      throw new Error(`Invalid relationship at index ${index}: every relationship must have a non-empty type.`);
    }
    if (typeof relationship.from !== 'string' || relationship.from.trim() === '') {
      throw new Error(`Invalid relationship at index ${index}: missing "from" node id.`);
    }
    if (typeof relationship.to !== 'string' || relationship.to.trim() === '') {
      throw new Error(`Invalid relationship at index ${index}: missing "to" node id.`);
    }
  }
}

function analyzeSourceGraph(graphData: GraphData): SourceAnalysis {
  const nodeGroupMap = new Map<string, NodeGroup>();
  const relationshipGroupsByRawType = new Map<string, GraphRelationship[]>();
  const nodesByLabel: Record<string, number> = {};
  const relationshipsByType: Record<string, number> = {};

  for (const node of graphData.nodes) {
    const labels = uniqueLabels(node.labels);
    const signature = labelsSignature(labels);
    const existing = nodeGroupMap.get(signature);

    if (existing) {
      existing.nodes.push(node);
    } else {
      nodeGroupMap.set(signature, { labels, nodes: [node] });
    }

    for (const label of labels) {
      incrementCounter(nodesByLabel, label);
    }
  }

  for (const relationship of graphData.relationships) {
    const existing = relationshipGroupsByRawType.get(relationship.type);
    if (existing) {
      existing.push(relationship);
    } else {
      relationshipGroupsByRawType.set(relationship.type, [relationship]);
    }

    incrementCounter(relationshipsByType, relationship.type);
  }

  const usedNeo4jTypes = new Map<string, string>();
  const relationshipGroups: RelationshipGroup[] = [];

  for (const [rawType, relationships] of Array.from(relationshipGroupsByRawType.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    let neo4jType = sanitizeRelationshipType(rawType);
    const existingOwner = usedNeo4jTypes.get(neo4jType);
    if (existingOwner && existingOwner !== rawType) {
      neo4jType = `${neo4jType}_${hashSuffix(rawType)}`;
    }
    usedNeo4jTypes.set(neo4jType, rawType);

    relationshipGroups.push({
      rawType,
      neo4jType,
      relationships,
    });
  }

  return {
    nodeGroups: Array.from(nodeGroupMap.values()).sort((a, b) => b.nodes.length - a.nodes.length),
    relationshipGroups,
    sourceCounts: {
      nodesByLabel,
      relationshipsByType,
    },
  };
}

function calculateNodeBatchTotal(nodeGroups: NodeGroup[]): number {
  return nodeGroups.reduce((total, group) => total + Math.ceil(group.nodes.length / BATCH_CONFIG.nodesBatchSize), 0);
}

function calculateRelationshipBatchTotal(relationshipGroups: RelationshipGroup[]): number {
  return relationshipGroups.reduce((total, group) => total + Math.ceil(group.relationships.length / BATCH_CONFIG.relsBatchSize), 0);
}

function buildConstraintPlans(graphData: GraphData): ConstraintPlan[] {
  const labels = new Set<string>([DEFAULT_LABEL]);

  for (const node of graphData.nodes) {
    for (const label of uniqueLabels(node.labels)) {
      labels.add(label);
    }
  }

  return Array.from(labels)
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({
      label,
      query: `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${quoteIdentifier(label)}) REQUIRE n.id IS UNIQUE`,
    }));
}

function buildIndexPlans(graphData: GraphData): IndexPlan[] {
  const preferredOrder = ['name', 'title', 'label', 'prefLabel', 'displayName', 'sector'];
  const frequencyByLabel = new Map<string, Map<string, number>>();

  for (const node of graphData.nodes) {
    const labels = uniqueLabels(node.labels);
    for (const label of labels) {
      let propertyFrequency = frequencyByLabel.get(label);
      if (!propertyFrequency) {
        propertyFrequency = new Map<string, number>();
        frequencyByLabel.set(label, propertyFrequency);
      }

      for (const [property, value] of Object.entries(node.properties ?? {})) {
        if (property === 'id' || value === null || value === undefined) {
          continue;
        }
        propertyFrequency.set(property, (propertyFrequency.get(property) ?? 0) + 1);
      }
    }
  }

  const plans: IndexPlan[] = [];

  for (const [label, propertyFrequency] of Array.from(frequencyByLabel.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const selectedProperties = Array.from(propertyFrequency.entries())
      .sort((left, right) => {
        const leftPreference = preferredOrder.indexOf(left[0]);
        const rightPreference = preferredOrder.indexOf(right[0]);

        if (leftPreference !== rightPreference) {
          if (leftPreference === -1) {
            return 1;
          }
          if (rightPreference === -1) {
            return -1;
          }
          return leftPreference - rightPreference;
        }

        if (left[1] !== right[1]) {
          return right[1] - left[1];
        }

        return left[0].localeCompare(right[0]);
      })
      .slice(0, MAX_INDEXES_PER_LABEL);

    for (const [property] of selectedProperties) {
      plans.push({
        label,
        property,
        query: `CREATE INDEX IF NOT EXISTS FOR (n:${quoteIdentifier(label)}) ON (n.${quoteIdentifier(property)})`,
      });
    }
  }

  return plans;
}

function createDriver(config: RuntimeConfig): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
    maxConnectionPoolSize: Math.max(BATCH_CONFIG.parallelBatches + 4, 8),
    connectionAcquisitionTimeout: 120_000,
  });
}

async function runQuery(session: Session, query: string, params: Record<string, unknown> = {}) {
  return session.run(query, params);
}

async function inspectExistingState(driver: Driver, database: string): Promise<ExistingState> {
  const session = driver.session({ database });

  try {
    const nodeResult = await runQuery(session, 'MATCH (n) RETURN count(n) AS count');
    const relationshipResult = await runQuery(session, 'MATCH ()-[r]->() RETURN count(r) AS count');
    const labelResult = await runQuery(session, 'CALL db.labels() YIELD label RETURN label ORDER BY label');
    const typeResult = await runQuery(session, 'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType');
    const constraintResult = await runQuery(session, 'SHOW CONSTRAINTS YIELD name RETURN count(name) AS count');
    const indexResult = await runQuery(session, 'SHOW INDEXES YIELD name RETURN count(name) AS count');

    return {
      nodeCount: toNumber(nodeResult.records[0]?.get('count')),
      relationshipCount: toNumber(relationshipResult.records[0]?.get('count')),
      labels: labelResult.records.map((record) => String(record.get('label'))),
      relationshipTypes: typeResult.records.map((record) => String(record.get('relationshipType'))),
      constraintCount: toNumber(constraintResult.records[0]?.get('count')),
      indexCount: toNumber(indexResult.records[0]?.get('count')),
    };
  } finally {
    await session.close();
  }
}

function assertEmptyDatabase(existingState: ExistingState, database: string): void {
  if (existingState.nodeCount > 0 || existingState.relationshipCount > 0) {
    throw new Error(
      `Target Neo4j database "${database}" is not empty ` +
        `(nodes=${existingState.nodeCount}, relationships=${existingState.relationshipCount}). ` +
        'This importer uses CREATE for optimal performance and requires an empty target database.'
    );
  }
}

async function createConstraintsAndIndexes(
  driver: Driver,
  database: string,
  constraintPlans: ConstraintPlan[],
  indexPlans: IndexPlan[]
): Promise<{ constraintsCreated: number; indexesCreated: number }> {
  const session = driver.session({ database });
  let constraintsCreated = 0;
  let indexesCreated = 0;

  try {
    console.log(`Creating ${constraintPlans.length} uniqueness constraints before import...`);

    for (const plan of constraintPlans) {
      const result = await runQuery(session, plan.query);
      constraintsCreated += result.summary.counters.updates().constraintsAdded;
    }

    if (BATCH_CONFIG.indexesBeforeImport && indexPlans.length > 0) {
      console.log(`Creating ${indexPlans.length} property indexes before import...`);

      for (const plan of indexPlans) {
        const result = await runQuery(session, plan.query);
        indexesCreated += result.summary.counters.updates().indexesAdded;
      }
    } else {
      console.log('No additional frequently queried property indexes inferred from source data.');
    }

    await runQuery(session, 'CALL db.awaitIndexes(300)');
  } finally {
    await session.close();
  }

  return { constraintsCreated, indexesCreated };
}

async function runTasksWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const results = new Array<T>(tasks.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= tasks.length) {
        return;
      }

      results[currentIndex] = await tasks[currentIndex]();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function importNodeBatch(session: Session, labels: string[], batch: GraphNode[]): Promise<number> {
  const nodeImportQuery = `
    UNWIND $batch AS node
    CREATE (n:${labelsToCypher(labels)})
    SET n = node.properties
  `;

  const payload = batch.map((node) => ({
    properties: ensureNodeProperties(node),
  }));

  const result = await session.executeWrite((transaction) => transaction.run(nodeImportQuery, { batch: payload }));
  return result.summary.counters.updates().nodesCreated;
}

async function importNodeGroups(
  driver: Driver,
  database: string,
  groups: NodeGroup[],
  workerIndex: number,
  tracker: ProgressTracker,
  errors: string[]
): Promise<number> {
  const session = driver.session({ database });
  let imported = 0;

  try {
    for (const group of groups) {
      const batches = chunkArray(group.nodes, BATCH_CONFIG.nodesBatchSize);

      for (const batch of batches) {
        try {
          imported += await importNodeBatch(session, group.labels, batch);
        } catch (error) {
          const message =
            `Node batch failed in worker ${workerIndex + 1} for labels [${group.labels.join(', ')}]: ` +
            `${String(error instanceof Error ? error.message : error)}`;
          console.error(message);
          errors.push(message);
        } finally {
          logProgress(tracker, batch.length);
        }
      }
    }
  } finally {
    await session.close();
  }

  return imported;
}

function splitNodeGroupsForParallelImport(nodeGroups: NodeGroup[]): NodeGroup[][] {
  const chunks: NodeGroup[][] = Array.from({ length: BATCH_CONFIG.parallelBatches }, () => []);
  const totals = new Array<number>(BATCH_CONFIG.parallelBatches).fill(0);

  for (const group of nodeGroups.slice().sort((a, b) => b.nodes.length - a.nodes.length)) {
    let targetIndex = 0;
    for (let index = 1; index < totals.length; index += 1) {
      if (totals[index] < totals[targetIndex]) {
        targetIndex = index;
      }
    }
    chunks[targetIndex].push(group);
    totals[targetIndex] += group.nodes.length;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

async function diagnoseMissingRelationshipNodes(
  driver: Driver,
  database: string,
  batch: GraphRelationship[]
): Promise<string[]> {
  const ids = Array.from(new Set(batch.flatMap((relationship) => [relationship.from, relationship.to])));
  const session = driver.session({ database });

  try {
    const result = await runQuery(
      session,
      `
      UNWIND $ids AS id
      OPTIONAL MATCH (n:${quoteIdentifier(DEFAULT_LABEL)} {id: id})
      RETURN id, n IS NOT NULL AS exists
      `,
      { ids }
    );

    return result.records
      .filter((record) => !record.get('exists'))
      .map((record) => String(record.get('id')));
  } finally {
    await session.close();
  }
}

async function importRelationshipBatch(session: Session, group: RelationshipGroup, batch: GraphRelationship[]): Promise<number> {
  const relImportQuery = `
    UNWIND $batch AS rel
    MATCH (from:${quoteIdentifier(DEFAULT_LABEL)} {id: rel.from})
    MATCH (to:${quoteIdentifier(DEFAULT_LABEL)} {id: rel.to})
    CREATE (from)-[r:${quoteIdentifier(group.neo4jType)}]->(to)
    SET r = rel.properties
  `;

  const payload = batch.map((relationship) => ({
    from: relationship.from,
    to: relationship.to,
    properties: {
      ...normalizeProperties(relationship.properties ?? {}),
      id: relationship.id ?? null,
      sourceType: group.rawType,
    },
  }));

  const result = await session.executeWrite((transaction) => transaction.run(relImportQuery, { batch: payload }));
  return result.summary.counters.updates().relationshipsCreated;
}

async function importRelationships(
  driver: Driver,
  database: string,
  relationshipGroups: RelationshipGroup[],
  tracker: ProgressTracker,
  errors: string[]
): Promise<number> {
  let imported = 0;
  const tasks: Array<() => Promise<number>> = [];

  for (const group of relationshipGroups) {
    const batches = chunkArray(group.relationships, BATCH_CONFIG.relsBatchSize);

    for (const batch of batches) {
      tasks.push(async () => {
        const session = driver.session({ database });

        try {
          try {
            const created = await importRelationshipBatch(session, group, batch);
            if (created !== batch.length) {
              const missingNodeIds = await diagnoseMissingRelationshipNodes(driver, database, batch);
              const message =
                `Relationship batch created ${created}/${batch.length} for type "${group.rawType}" ` +
                `(Neo4j type "${group.neo4jType}"). Missing node IDs: ` +
                `${missingNodeIds.length > 0 ? missingNodeIds.slice(0, 25).join(', ') : 'none detected'}`;
              console.error(message);
              errors.push(message);
            }
            return created;
          } catch (error) {
            const missingNodeIds = await diagnoseMissingRelationshipNodes(driver, database, batch);
            const message =
              `Relationship batch failed for type "${group.rawType}" ` +
              `(Neo4j type "${group.neo4jType}"): ${String(error instanceof Error ? error.message : error)}. ` +
              `Missing node IDs: ${missingNodeIds.length > 0 ? missingNodeIds.slice(0, 25).join(', ') : 'none detected'}`;
            console.error(message);
            errors.push(message);
            return 0;
          }
        } finally {
          await session.close();
          logProgress(tracker, batch.length);
        }
      });
    }
  }

  const results = await runTasksWithConcurrency(tasks, BATCH_CONFIG.parallelBatches);
  for (const value of results) {
    imported += value;
  }

  return imported;
}

async function validateImport(driver: Driver, database: string): Promise<ValidationSummary> {
  const session = driver.session({ database });

  try {
    const nodeCountsResult = await runQuery(session, 'MATCH (n) RETURN labels(n) AS labels, count(*) AS count ORDER BY count DESC');
    const relationshipCountsResult = await runQuery(session, 'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC');
    const totalNodesResult = await runQuery(session, 'MATCH (n) RETURN count(n) AS count');
    const totalRelationshipsResult = await runQuery(session, 'MATCH ()-[r]->() RETURN count(r) AS count');
    const orphanedNodesResult = await runQuery(session, 'MATCH (n) WHERE NOT (n)--() RETURN count(n) AS count');
    const missingIdNodesResult = await runQuery(session, 'MATCH (n) WHERE n.id IS NULL RETURN count(n) AS count');

    return {
      actualNodes: toNumber(totalNodesResult.records[0]?.get('count')),
      actualRelationships: toNumber(totalRelationshipsResult.records[0]?.get('count')),
      orphanedNodes: toNumber(orphanedNodesResult.records[0]?.get('count')),
      missingIdNodes: toNumber(missingIdNodesResult.records[0]?.get('count')),
      nodeCountsRaw: nodeCountsResult.records.map((record) => ({
        labels: (record.get('labels') as string[]) ?? [],
        count: toNumber(record.get('count')),
      })),
      relationshipCounts: relationshipCountsResult.records.map((record) => ({
        type: String(record.get('type')),
        count: toNumber(record.get('count')),
      })),
    };
  } finally {
    await session.close();
  }
}

function buildReport(
  graphData: GraphData,
  sourceCounts: SourceCounts,
  metrics: ImportMetrics,
  validation: ValidationSummary,
  startedAt: number,
  nodePhaseMs: number,
  relationshipPhaseMs: number,
  errors: string[]
): ImportReport {
  const duration = Date.now() - startedAt;
  const expectedNodes = graphData.statistics?.totalNodes ?? graphData.nodes.length;
  const expectedRelationships = graphData.statistics?.totalRelationships ?? graphData.relationships.length;

  let status: ImportReport['status'] = 'success';
  if (errors.length > 0) {
    status = metrics.importedNodes > 0 || metrics.importedRelationships > 0 ? 'partial' : 'failed';
  }

  if (
    validation.actualNodes !== expectedNodes ||
    validation.actualRelationships !== expectedRelationships ||
    validation.missingIdNodes > 0
  ) {
    status = status === 'failed' ? 'failed' : 'partial';
  }

  return {
    status,
    duration,
    throughput: {
      nodesPerSecond: nodePhaseMs > 0 ? graphData.nodes.length / (nodePhaseMs / 1000) : 0,
      relationshipsPerSecond: relationshipPhaseMs > 0 ? graphData.relationships.length / (relationshipPhaseMs / 1000) : 0,
    },
    imported: {
      nodes: metrics.importedNodes,
      relationships: metrics.importedRelationships,
      nodesByLabel: sourceCounts.nodesByLabel,
      relationshipsByType: sourceCounts.relationshipsByType,
    },
    optimization: {
      constraintsCreated: metrics.constraintsCreated,
      indexesCreated: metrics.indexesCreated,
      batchSize: {
        nodes: BATCH_CONFIG.nodesBatchSize,
        relationships: BATCH_CONFIG.relsBatchSize,
      },
    },
    validation: {
      expectedNodes,
      actualNodes: validation.actualNodes,
      expectedRelationships,
      actualRelationships: validation.actualRelationships,
      orphanedNodes: validation.orphanedNodes,
    },
    errors,
  };
}

async function writeReport(report: ImportReport): Promise<void> {
  await fs.mkdir(path.dirname(REPORT_FILE), { recursive: true });
  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

function printValidationDetails(validation: ValidationSummary): void {
  console.log('Node counts by labels:');
  for (const entry of validation.nodeCountsRaw) {
    console.log(`- [${entry.labels.join(', ')}] ${formatNumber(entry.count)}`);
  }

  console.log('Relationship counts by type:');
  for (const entry of validation.relationshipCounts) {
    console.log(`- ${entry.type} ${formatNumber(entry.count)}`);
  }

  console.log(`Nodes missing id property: ${formatNumber(validation.missingIdNodes)}`);
}

function printSummary(report: ImportReport): void {
  console.log('\nImport Summary');
  console.log(`Status: ${report.status}`);
  console.log(`Duration: ${formatDuration(report.duration)}`);
  console.log(`Nodes imported: ${formatNumber(report.imported.nodes)} at ${formatRate(report.throughput.nodesPerSecond)} nodes/sec`);
  console.log(
    `Relationships imported: ${formatNumber(report.imported.relationships)} at ${formatRate(report.throughput.relationshipsPerSecond)} relationships/sec`
  );
  console.log(
    `Validation: nodes ${formatNumber(report.validation.actualNodes)}/${formatNumber(report.validation.expectedNodes)}, ` +
      `relationships ${formatNumber(report.validation.actualRelationships)}/${formatNumber(report.validation.expectedRelationships)}, ` +
      `orphaned nodes ${formatNumber(report.validation.orphanedNodes)}`
  );
  console.log(
    `Optimization: constraints ${formatNumber(report.optimization.constraintsCreated)}, ` +
      `indexes ${formatNumber(report.optimization.indexesCreated)}, ` +
      `batch sizes nodes=${BATCH_CONFIG.nodesBatchSize}, relationships=${BATCH_CONFIG.relsBatchSize}, ` +
      `parallel workers=${BATCH_CONFIG.parallelBatches}`
  );

  if (report.errors.length > 0) {
    console.log('Errors:');
    for (const error of report.errors) {
      console.log(`- ${error}`);
    }
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let driver: Driver | undefined;

  try {
    const runtimeConfig = loadRuntimeConfig();
    const graphData = await loadGraphData(GRAPH_FILE);
    validateSourceData(graphData);

    const analysis = analyzeSourceGraph(graphData);
    const constraintPlans = buildConstraintPlans(graphData);
    const indexPlans = buildIndexPlans(graphData);

    driver = createDriver(runtimeConfig);
    await driver.verifyConnectivity();

    const existingState = await inspectExistingState(driver, runtimeConfig.database);
    console.log(
      `Existing database state: nodes=${formatNumber(existingState.nodeCount)}, ` +
        `relationships=${formatNumber(existingState.relationshipCount)}, ` +
        `constraints=${formatNumber(existingState.constraintCount)}, ` +
        `indexes=${formatNumber(existingState.indexCount)}`
    );
    assertEmptyDatabase(existingState, runtimeConfig.database);

    if (BATCH_CONFIG.enablePeriodicCommit) {
      console.log(
        'Periodic commit is enabled in config, but neo4j-driver UNWIND imports do not support USING PERIODIC COMMIT. ' +
          'The importer uses optimized batched transactional writes instead.'
      );
    }

    const { constraintsCreated, indexesCreated } = await createConstraintsAndIndexes(
      driver,
      runtimeConfig.database,
      constraintPlans,
      indexPlans
    );

    const totalNodeBatches = calculateNodeBatchTotal(analysis.nodeGroups);
    const nodeTracker = buildProgressTracker('Nodes', graphData.nodes.length, totalNodeBatches);
    const nodePhaseStartedAt = Date.now();
    let importedNodes = 0;

    if (graphData.nodes.length > PARALLEL_IMPORT_THRESHOLD) {
      const chunks = splitNodeGroupsForParallelImport(analysis.nodeGroups);
      console.log(`Importing ${formatNumber(graphData.nodes.length)} nodes with ${chunks.length} parallel workers...`);
      const results = await Promise.all(
        chunks.map((chunk, index) => importNodeGroups(driver as Driver, runtimeConfig.database, chunk, index, nodeTracker, errors))
      );
      importedNodes = results.reduce((sum, value) => sum + value, 0);
    } else {
      importedNodes = await importNodeGroups(driver, runtimeConfig.database, analysis.nodeGroups, 0, nodeTracker, errors);
    }
    const nodePhaseMs = Date.now() - nodePhaseStartedAt;

    const totalRelationshipBatches = calculateRelationshipBatchTotal(analysis.relationshipGroups);
    const relationshipTracker = buildProgressTracker('Relationships', graphData.relationships.length, totalRelationshipBatches);
    const relationshipPhaseStartedAt = Date.now();
    const importedRelationships = await importRelationships(
      driver,
      runtimeConfig.database,
      analysis.relationshipGroups,
      relationshipTracker,
      errors
    );
    const relationshipPhaseMs = Date.now() - relationshipPhaseStartedAt;

    const validation = await validateImport(driver, runtimeConfig.database);
    printValidationDetails(validation);

    const report = buildReport(
      graphData,
      analysis.sourceCounts,
      {
        constraintsCreated,
        indexesCreated,
        importedNodes,
        importedRelationships,
      },
      validation,
      startedAt,
      nodePhaseMs,
      relationshipPhaseMs,
      errors
    );

    await writeReport(report);
    printSummary(report);

    if (report.status === 'failed') {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedReport: ImportReport = {
      status: 'failed',
      duration: Date.now() - startedAt,
      throughput: {
        nodesPerSecond: 0,
        relationshipsPerSecond: 0,
      },
      imported: {
        nodes: 0,
        relationships: 0,
        nodesByLabel: {},
        relationshipsByType: {},
      },
      optimization: {
        constraintsCreated: 0,
        indexesCreated: 0,
        batchSize: {
          nodes: BATCH_CONFIG.nodesBatchSize,
          relationships: BATCH_CONFIG.relsBatchSize,
        },
      },
      validation: {
        expectedNodes: 0,
        actualNodes: 0,
        expectedRelationships: 0,
        actualRelationships: 0,
        orphanedNodes: 0,
      },
      errors: [message],
    };

    try {
      await writeReport(failedReport);
    } catch (reportError) {
      console.error(`Failed to write import report: ${String(reportError)}`);
    }

    console.error(`Neo4j import failed: ${message}`);
    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.close();
    }
  }
}

void main();
