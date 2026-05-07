import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import neo4j, { Driver } from 'neo4j-driver';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { chain } from 'stream-chain';
import { pick } from 'stream-json/filters/Pick';

// ─── Configuration ───────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || 'domain-data/scientific-dblp';
const GRAPH_FILE = path.resolve(DATA_DIR, 'output', 'graph-data.json');
const REPORT_FILE = path.resolve(DATA_DIR, 'output', 'neo4j-import-report.json');

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || '123123123';
const NEO4J_DATABASE = process.env.NEO4J_DATABASE || 'neo4j';

const BATCH_CONFIG = {
  nodesBatchSize: 5000,
  relsBatchSize: 2500,
  parallelBatches: 4,
  indexesBeforeImport: true,
  progressInterval: 10,
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface GraphRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
  _meta?: Record<string, unknown>;
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
    batchSize: { nodes: number; relationships: number };
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function memUsageMB(): string {
  const used = process.memoryUsage();
  return `heap: ${(used.heapUsed / 1024 / 1024).toFixed(0)}MB / ${(used.heapTotal / 1024 / 1024).toFixed(0)}MB`;
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}

function sanitizeRelType(type: string): string {
  return type.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

// ─── Read metadata & statistics without loading entire file ──────────────────

async function readGraphMetadata(): Promise<{
  totalNodes: number;
  totalRelationships: number;
  nodesByType: Record<string, number>;
  relationshipsByType: Record<string, number>;
}> {
  // Read the last portion of the file for statistics
  const fileSize = fs.statSync(GRAPH_FILE).size;
  const tailSize = Math.min(5000, fileSize);
  const buffer = Buffer.alloc(tailSize);
  const fd = fs.openSync(GRAPH_FILE, 'r');
  fs.readSync(fd, buffer, 0, tailSize, fileSize - tailSize);
  fs.closeSync(fd);
  const tail = buffer.toString('utf-8');

  const statsMatch = tail.match(/"statistics"\s*:\s*(\{[\s\S]*?\})\s*\}/);
  if (!statsMatch) {
    throw new Error('Could not find statistics section in graph-data.json');
  }
  const stats = JSON.parse(statsMatch[1] + '}');
  return {
    totalNodes: stats.totalNodes,
    totalRelationships: stats.totalRelationships,
    nodesByType: stats.nodesByType || {},
    relationshipsByType: stats.relationshipsByType || {},
  };
}

// ─── Neo4j Driver ────────────────────────────────────────────────────────────

function createDriver(): Driver {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

async function runQuery(driver: Driver, query: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
  const session = driver.session({ database: NEO4J_DATABASE });
  try {
    const result = await session.run(query, params);
    return result.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
}

// ─── Step 1: Create constraints & indexes ────────────────────────────────────

async function createConstraintsAndIndexes(
  driver: Driver,
  nodesByType: Record<string, number>
): Promise<{ constraintsCreated: number; indexesCreated: number }> {
  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log('│  Creating Constraints & Indexes                         │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  let constraintsCreated = 0;
  let indexesCreated = 0;

  // Extract unique labels from nodesByType keys (strip prefix like "fabio:" or "foaf:")
  const labels = new Set<string>();
  for (const typeKey of Object.keys(nodesByType)) {
    const colonIdx = typeKey.indexOf(':');
    const label = colonIdx >= 0 ? typeKey.substring(colonIdx + 1) : typeKey;
    labels.add(sanitizeLabel(label));
  }

  // Create uniqueness constraints on id for each label
  for (const label of labels) {
    try {
      await runQuery(driver, `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
      constraintsCreated++;
      console.log(`  ✓ Constraint: ${label}.id UNIQUE`);
    } catch (err: any) {
      console.log(`  ⚠ Constraint for ${label}: ${err.message}`);
    }
  }

  // Create indexes on common properties
  const indexableProps: Record<string, string[]> = {
    Person: ['name'],
    Chapter: ['title'],
    JournalArticle: ['title'],
    ConferencePaper: ['title'],
    AcademicProceedings: ['title'],
    ConferenceProceedings: ['title'],
    Book: ['title'],
    Journal: ['title'],
    WebContent: ['title'],
  };

  for (const [label, props] of Object.entries(indexableProps)) {
    if (!labels.has(label)) continue;
    for (const prop of props) {
      try {
        await runQuery(driver, `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${prop})`);
        indexesCreated++;
        console.log(`  ✓ Index: ${label}.${prop}`);
      } catch (err: any) {
        console.log(`  ⚠ Index for ${label}.${prop}: ${err.message}`);
      }
    }
  }

  // Create Resource constraint for cross-label relationship lookups
  try {
    await runQuery(driver, 'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Resource) REQUIRE n.id IS UNIQUE');
    constraintsCreated++;
    console.log('  ✓ Constraint: Resource.id UNIQUE');
  } catch (err: any) {
    console.log(`  ⚠ Constraint for Resource: ${err.message}`);
  }

  // Wait for indexes to come online
  console.log('\n  Waiting for indexes to come online...');
  await runQuery(driver, 'CALL db.awaitIndexes(300)');
  console.log('  ✓ All indexes online\n');

  return { constraintsCreated, indexesCreated };
}

// ─── Add Resource label to all nodes (for indexed relationship lookups) ──────

async function addResourceLabel(driver: Driver, labels: Set<string>): Promise<void> {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│  Adding Resource Label (for relationship indexing)       │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const existingResult = await runQuery(driver, 'MATCH (n) WHERE NOT n:Resource RETURN count(n) AS count') as any[];
  const remaining = existingResult[0]?.count?.toNumber?.() ?? Number(existingResult[0]?.count ?? 0);

  if (remaining === 0) {
    console.log('  ✓ All nodes already have Resource label\n');
    return;
  }

  console.log(`  ${formatNumber(remaining)} nodes need Resource label\n`);

  for (const label of labels) {
    let added = 0;
    while (true) {
      const session = driver.session({ database: NEO4J_DATABASE });
      try {
        const res = await session.run(
          `MATCH (n:${label}) WHERE NOT n:Resource WITH n LIMIT 500000 SET n:Resource`
        );
        const labelsAdded = res.summary.counters.updates().labelsAdded;
        if (labelsAdded === 0) break;
        added += labelsAdded;
        console.log(`  ${label}: +${formatNumber(labelsAdded)} (total: ${formatNumber(added)})`);
      } finally {
        await session.close();
      }
    }
  }

  console.log('  ✓ Resource label applied to all nodes\n');
}

// ─── Step 2: Stream-import nodes ─────────────────────────────────────────────

async function importNodes(
  driver: Driver,
  totalExpected: number
): Promise<{ imported: number; byLabel: Record<string, number>; duration: number; errors: string[] }> {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│  Importing Nodes                                        │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const startTime = Date.now();
  const byLabel: Record<string, number> = {};
  const errors: string[] = [];
  let totalImported = 0;
  let batchCount = 0;

  // Group nodes by label for efficient batching
  const labelBatches: Map<string, GraphNode[]> = new Map();

  return new Promise((resolve, reject) => {
    const pipeline = chain([
      fs.createReadStream(GRAPH_FILE, { highWaterMark: 64 * 1024 }),
      parser(),
      pick({ filter: 'nodes' }),
      streamArray(),
    ]);

    let pendingFlush = Promise.resolve();

    pipeline.on('data', (data: { key: number; value: GraphNode }) => {
      const node = data.value;
      const label = sanitizeLabel(node.labels[0] || 'Unknown');

      if (!labelBatches.has(label)) {
        labelBatches.set(label, []);
      }
      labelBatches.get(label)!.push(node);

      // Check if any label batch is full
      for (const [lbl, batch] of labelBatches) {
        if (batch.length >= BATCH_CONFIG.nodesBatchSize) {
          const toFlush = batch.splice(0, BATCH_CONFIG.nodesBatchSize);
          pipeline.pause();
          pendingFlush = pendingFlush
            .then(() => flushNodeBatch(driver, lbl, toFlush, errors))
            .then((count) => {
              totalImported += count;
              byLabel[lbl] = (byLabel[lbl] || 0) + count;
              batchCount++;

              if (batchCount % BATCH_CONFIG.progressInterval === 0) {
                const elapsed = Date.now() - startTime;
                const rate = totalImported / (elapsed / 1000);
                const eta = ((totalExpected - totalImported) / rate) * 1000;
                console.log(
                  `  [Nodes] Batch ${batchCount} | ${formatNumber(totalImported)}/${formatNumber(totalExpected)} | ` +
                  `${formatNumber(Math.round(rate))} rec/sec | ETA: ${formatDuration(eta)} | ${memUsageMB()}`
                );
              }
              pipeline.resume();
            })
            .catch((err) => {
              errors.push(`Node batch error: ${err.message}`);
              pipeline.resume();
            });
        }
      }
    });

    pipeline.on('end', async () => {
      // Flush remaining batches
      await pendingFlush;
      for (const [lbl, batch] of labelBatches) {
        if (batch.length > 0) {
          try {
            const count = await flushNodeBatch(driver, lbl, batch, errors);
            totalImported += count;
            byLabel[lbl] = (byLabel[lbl] || 0) + count;
            batchCount++;
          } catch (err: any) {
            errors.push(`Final node batch error (${lbl}): ${err.message}`);
          }
        }
      }

      const duration = Date.now() - startTime;
      console.log(
        `\n  ✓ Nodes complete: ${formatNumber(totalImported)} imported in ${formatDuration(duration)}\n`
      );

      resolve({ imported: totalImported, byLabel, duration, errors });
    });

    pipeline.on('error', (err: Error) => {
      reject(new Error(`Node stream error: ${err.message}`));
    });
  });
}

async function flushNodeBatch(
  driver: Driver,
  label: string,
  nodes: GraphNode[],
  errors: string[]
): Promise<number> {
  const session = driver.session({ database: NEO4J_DATABASE });
  try {
    const batch = nodes.map((node) => {
      const props: Record<string, unknown> = { ...node.properties };
      props.id = node.id; // CRITICAL: ensure id is always in properties
      // Remove _meta from properties to keep graph clean
      delete (props as any)._meta;
      return { properties: props };
    });

    const query = `
      UNWIND $batch AS node
      CREATE (n:${label})
      SET n = node.properties
    `;

    await session.run(query, { batch });
    return nodes.length;
  } catch (err: any) {
    errors.push(`Failed batch for ${label} (${nodes.length} nodes): ${err.message}`);
    return 0;
  } finally {
    await session.close();
  }
}

// ─── Find byte offset of a key in JSON file ─────────────────────────────────

function findKeyOffset(filePath: string, key: string): number {
  const fd = fs.openSync(filePath, 'r');
  const fileSize = fs.statSync(filePath).size;
  const CHUNK = 4 * 1024 * 1024; // 4MB for faster scanning
  const buf = Buffer.alloc(CHUNK);
  // Use byte-level Buffer search to avoid string/byte position drift with multi-byte chars
  const needleBuf = Buffer.from(`\n  "${key}": [`, 'utf-8');
  const keyOffset = Buffer.from(`\n  `, 'utf-8').length; // bytes to skip for key start
  let pos = 0;

  while (pos < fileSize) {
    const bytesRead = fs.readSync(fd, buf, 0, CHUNK, pos);
    const idx = buf.indexOf(needleBuf, 0);
    if (idx !== -1 && idx < bytesRead) {
      fs.closeSync(fd);
      return pos + idx + keyOffset; // Return byte offset of the '"key"' part
    }
    pos += CHUNK - needleBuf.length; // overlap to handle boundary
  }
  fs.closeSync(fd);
  return -1;
}

// ─── Step 3: Stream-import relationships (async iteration) ──────────────────

async function importRelationships(
  driver: Driver,
  totalExpected: number
): Promise<{ imported: number; byType: Record<string, number>; duration: number; errors: string[] }> {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│  Importing Relationships                                │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const startTime = Date.now();
  const byType: Record<string, number> = {};
  const errors: string[] = [];
  let totalImported = 0;
  let batchCount = 0;

  // Find byte offset of the relationships array
  console.log('  Locating relationships section in graph file...');
  const relKeyOffset = findKeyOffset(GRAPH_FILE, 'relationships');
  if (relKeyOffset === -1) {
    throw new Error('Could not find "relationships" key in graph-data.json');
  }
  const headerBuf = Buffer.alloc(50);
  const fd = fs.openSync(GRAPH_FILE, 'r');
  fs.readSync(fd, headerBuf, 0, 50, relKeyOffset);
  fs.closeSync(fd);
  const headerStr = headerBuf.toString('utf-8');
  const bracketIdx = headerStr.indexOf('[');
  const arrayStartOffset = relKeyOffset + bracketIdx + 1;
  console.log(`  Array starts at byte offset ${arrayStartOffset} (${(arrayStartOffset / 1024 / 1024 / 1024).toFixed(1)} GB)\n`);

  const readStream = fs.createReadStream(GRAPH_FILE, {
    start: arrayStartOffset,
    highWaterMark: 256 * 1024,
    encoding: 'utf-8',
  });

  const rl = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity,
  });

  // Collect relationships into type-grouped batches, flush when full
  const typeBatches: Map<string, GraphRelationship[]> = new Map();
  let totalParsed = 0;

  async function flushFullBatches(): Promise<void> {
    for (const [type, batch] of typeBatches) {
      while (batch.length >= BATCH_CONFIG.relsBatchSize) {
        const toFlush = batch.splice(0, BATCH_CONFIG.relsBatchSize);
        try {
          const count = await flushRelBatch(driver, type, toFlush, errors);
          totalImported += count;
          byType[type] = (byType[type] || 0) + count;
          batchCount++;

          if (batchCount % BATCH_CONFIG.progressInterval === 0) {
            const elapsed = Date.now() - startTime;
            const rate = totalImported / (elapsed / 1000);
            const eta = totalImported > 0 ? ((totalExpected - totalImported) / rate) * 1000 : 0;
            console.log(
              `  [Rels] Batch ${batchCount} | ${formatNumber(totalImported)}/${formatNumber(totalExpected)} | ` +
              `${formatNumber(Math.round(rate))} rec/sec | ETA: ${formatDuration(eta)} | ${memUsageMB()}`
            );
          }
        } catch (err: any) {
          errors.push(`Rel batch error (${type}): ${err.message}`);
        }
      }
    }
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[' || trimmed === ']' || trimmed === '],') continue;

    const jsonStr = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;

    if (jsonStr.startsWith('"statistics"') || jsonStr === '}') break;
    if (!jsonStr.startsWith('{')) continue;

    let rel: GraphRelationship;
    try {
      rel = JSON.parse(jsonStr);
    } catch {
      continue;
    }

    const relType = sanitizeRelType(rel.type);
    if (!typeBatches.has(relType)) {
      typeBatches.set(relType, []);
    }
    typeBatches.get(relType)!.push(rel);
    totalParsed++;

    // Flush any full batches every 5000 parsed lines
    if (totalParsed % BATCH_CONFIG.relsBatchSize === 0) {
      await flushFullBatches();
    }
  }

  // Flush all remaining
  await flushFullBatches();
  for (const [type, batch] of typeBatches) {
    if (batch.length > 0) {
      try {
        const count = await flushRelBatch(driver, type, batch, errors);
        totalImported += count;
        byType[type] = (byType[type] || 0) + count;
        batchCount++;
      } catch (err: any) {
        errors.push(`Final rel batch error (${type}): ${err.message}`);
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `\n  ✓ Relationships complete: ${formatNumber(totalImported)} imported in ${formatDuration(duration)}\n`
  );

  return { imported: totalImported, byType, duration, errors };
}

async function flushRelBatch(
  driver: Driver,
  relType: string,
  rels: GraphRelationship[],
  errors: string[]
): Promise<number> {
  const session = driver.session({ database: NEO4J_DATABASE });
  try {
    const batch = rels.map((rel) => {
      const props: Record<string, unknown> = { ...rel.properties };
      delete (props as any)._meta;
      return {
        from: rel.from,
        to: rel.to,
        properties: props,
      };
    });

    // Use MATCH with Resource label for indexed lookup via unique constraint
    const query = `
      UNWIND $batch AS rel
      MATCH (from:Resource {id: rel.from})
      MATCH (to:Resource {id: rel.to})
      CREATE (from)-[r:${relType}]->(to)
      SET r = rel.properties
    `;

    const result = await session.run(query, { batch });
    const created = result.summary.counters.updates().relationshipsCreated;
    return created;
  } catch (err: any) {
    errors.push(`Failed batch for ${relType} (${rels.length} rels): ${err.message}`);
    return 0;
  } finally {
    await session.close();
  }
}

// ─── Step 4: Post-import validation ──────────────────────────────────────────

async function validateImport(
  driver: Driver,
  expectedNodes: number,
  expectedRels: number
): Promise<{ actualNodes: number; actualRels: number; orphanedNodes: number; nodesByLabel: Record<string, number>; relsByType: Record<string, number> }> {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│  Post-Import Validation                                 │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  // Count nodes by label
  const nodeResults = await runQuery(driver, 'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count') as any[];
  const nodesByLabel: Record<string, number> = {};
  let actualNodes = 0;
  for (const row of nodeResults) {
    const label = row.label;
    const count = typeof row.count === 'object' && 'toNumber' in row.count ? row.count.toNumber() : Number(row.count);
    nodesByLabel[label] = count;
    actualNodes += count;
  }

  // Count relationships by type
  const relResults = await runQuery(driver, 'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count') as any[];
  const relsByType: Record<string, number> = {};
  let actualRels = 0;
  for (const row of relResults) {
    const type = row.type;
    const count = typeof row.count === 'object' && 'toNumber' in row.count ? row.count.toNumber() : Number(row.count);
    relsByType[type] = count;
    actualRels += count;
  }

  // Check orphaned nodes
  const orphanResult = await runQuery(driver, 'MATCH (n) WHERE NOT (n)--() RETURN count(n) AS count') as any[];
  const orphanedNodes = orphanResult.length > 0
    ? (typeof orphanResult[0].count === 'object' && 'toNumber' in orphanResult[0].count ? orphanResult[0].count.toNumber() : Number(orphanResult[0].count))
    : 0;

  console.log('  Nodes by label:');
  for (const [label, count] of Object.entries(nodesByLabel).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label}: ${formatNumber(count)}`);
  }

  console.log('\n  Relationships by type:');
  for (const [type, count] of Object.entries(relsByType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${formatNumber(count)}`);
  }

  console.log(`\n  Total nodes: ${formatNumber(actualNodes)} (expected: ${formatNumber(expectedNodes)})`);
  console.log(`  Total relationships: ${formatNumber(actualRels)} (expected: ${formatNumber(expectedRels)})`);
  console.log(`  Orphaned nodes: ${formatNumber(orphanedNodes)}`);

  const nodeMatch = actualNodes === expectedNodes ? '✓' : '✗';
  const relMatch = actualRels === expectedRels ? '✓' : '✗';
  console.log(`\n  ${nodeMatch} Node count match`);
  console.log(`  ${relMatch} Relationship count match\n`);

  return { actualNodes, actualRels, orphanedNodes, nodesByLabel, relsByType };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const overallStart = Date.now();
  const allErrors: string[] = [];

  console.log('╔═════════════════════════════════════════════════════════╗');
  console.log('║      Neo4j Import — Scientific DBLP Knowledge Graph    ║');
  console.log('╚═════════════════════════════════════════════════════════╝\n');

  // Verify input file exists
  if (!fs.existsSync(GRAPH_FILE)) {
    console.error(`ERROR: Graph file not found: ${GRAPH_FILE}`);
    process.exit(1);
  }

  const fileSizeMB = (fs.statSync(GRAPH_FILE).size / (1024 * 1024)).toFixed(0);
  console.log(`  Input: ${GRAPH_FILE} (${fileSizeMB} MB)`);
  console.log(`  Neo4j: ${NEO4J_URI} / ${NEO4J_DATABASE}`);
  console.log(`  Batch config: nodes=${BATCH_CONFIG.nodesBatchSize}, rels=${BATCH_CONFIG.relsBatchSize}`);

  // Read metadata
  console.log('\n  Reading graph metadata...');
  const metadata = await readGraphMetadata();
  console.log(`  Expected: ${formatNumber(metadata.totalNodes)} nodes, ${formatNumber(metadata.totalRelationships)} relationships\n`);

  // Create driver
  const driver = createDriver();

  try {
    // Verify connectivity
    await runQuery(driver, 'RETURN 1 AS check');
    console.log('  ✓ Neo4j connection verified\n');

    // Check existing state for resume capability
    const existingCountResult = await runQuery(driver, 'MATCH (n) RETURN count(n) AS count') as any[];
    const existingNodes = existingCountResult.length > 0
      ? (typeof existingCountResult[0].count === 'object' && 'toNumber' in existingCountResult[0].count ? existingCountResult[0].count.toNumber() : Number(existingCountResult[0].count))
      : 0;
    const existingRelResult = await runQuery(driver, 'MATCH ()-[r]->() RETURN count(r) AS count') as any[];
    const existingRels = existingRelResult.length > 0
      ? (typeof existingRelResult[0].count === 'object' && 'toNumber' in existingRelResult[0].count ? existingRelResult[0].count.toNumber() : Number(existingRelResult[0].count))
      : 0;

    console.log(`  Existing state: ${formatNumber(existingNodes)} nodes, ${formatNumber(existingRels)} relationships\n`);

    // Step 1: Create constraints and indexes
    const { constraintsCreated, indexesCreated } = await createConstraintsAndIndexes(driver, metadata.nodesByType);

    // Step 2: Import nodes (streaming) — skip if already imported
    let nodeResult: { imported: number; byLabel: Record<string, number>; duration: number; errors: string[] };
    if (existingNodes >= metadata.totalNodes) {
      console.log('┌─────────────────────────────────────────────────────────┐');
      console.log('│  Importing Nodes — SKIPPED (already imported)            │');
      console.log('└─────────────────────────────────────────────────────────┘\n');
      nodeResult = { imported: existingNodes, byLabel: {}, duration: 0, errors: [] };
    } else {
      nodeResult = await importNodes(driver, metadata.totalNodes);
      allErrors.push(...nodeResult.errors);
    }

    // Step 2b: Add Resource label for cross-label indexed lookups
    const labels = new Set<string>();
    for (const typeKey of Object.keys(metadata.nodesByType)) {
      const colonIdx = typeKey.indexOf(':');
      const label = colonIdx >= 0 ? typeKey.substring(colonIdx + 1) : typeKey;
      labels.add(sanitizeLabel(label));
    }
    await addResourceLabel(driver, labels);

    // Step 3: Import relationships (streaming) — skip if already imported
    let relResult: { imported: number; byType: Record<string, number>; duration: number; errors: string[] };
    if (existingRels >= metadata.totalRelationships) {
      console.log('┌─────────────────────────────────────────────────────────┐');
      console.log('│  Importing Relationships — SKIPPED (already imported)    │');
      console.log('└─────────────────────────────────────────────────────────┘\n');
      relResult = { imported: existingRels, byType: {}, duration: 0, errors: [] };
    } else {
      relResult = await importRelationships(driver, metadata.totalRelationships);
      allErrors.push(...relResult.errors);
    }

    // Step 4: Validate
    const validation = await validateImport(driver, metadata.totalNodes, metadata.totalRelationships);

    // Build report
    const overallDuration = Date.now() - overallStart;
    const report: ImportReport = {
      status: allErrors.length === 0 ? 'success' : (nodeResult.imported > 0 ? 'partial' : 'failed'),
      duration: overallDuration,
      throughput: {
        nodesPerSecond: nodeResult.duration > 0 ? Math.round(nodeResult.imported / (nodeResult.duration / 1000)) : 0,
        relationshipsPerSecond: relResult.duration > 0 ? Math.round(relResult.imported / (relResult.duration / 1000)) : 0,
      },
      imported: {
        nodes: nodeResult.imported,
        relationships: relResult.imported,
        nodesByLabel: nodeResult.byLabel,
        relationshipsByType: relResult.byType,
      },
      optimization: {
        constraintsCreated,
        indexesCreated,
        batchSize: {
          nodes: BATCH_CONFIG.nodesBatchSize,
          relationships: BATCH_CONFIG.relsBatchSize,
        },
      },
      validation: {
        expectedNodes: metadata.totalNodes,
        actualNodes: validation.actualNodes,
        expectedRelationships: metadata.totalRelationships,
        actualRelationships: validation.actualRels,
        orphanedNodes: validation.orphanedNodes,
      },
      errors: allErrors,
    };

    // Save report
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`  Report saved: ${REPORT_FILE}`);

    // Print summary
    console.log('\n╔═════════════════════════════════════════════════════════╗');
    console.log('║                    Import Summary                       ║');
    console.log('╠═════════════════════════════════════════════════════════╣');
    console.log(`║  Status:         ${report.status.toUpperCase().padEnd(38)}║`);
    console.log(`║  Duration:       ${formatDuration(overallDuration).padEnd(38)}║`);
    console.log(`║  Nodes:          ${formatNumber(nodeResult.imported).padEnd(38)}║`);
    console.log(`║  Relationships:  ${formatNumber(relResult.imported).padEnd(38)}║`);
    console.log(`║  Node rate:      ${(formatNumber(report.throughput.nodesPerSecond) + '/sec').padEnd(38)}║`);
    console.log(`║  Rel rate:       ${(formatNumber(report.throughput.relationshipsPerSecond) + '/sec').padEnd(38)}║`);
    console.log(`║  Constraints:    ${String(constraintsCreated).padEnd(38)}║`);
    console.log(`║  Indexes:        ${String(indexesCreated).padEnd(38)}║`);
    console.log(`║  Errors:         ${String(allErrors.length).padEnd(38)}║`);
    console.log('╚═════════════════════════════════════════════════════════╝\n');

    if (allErrors.length > 0) {
      console.log('  Errors (first 20):');
      for (const err of allErrors.slice(0, 20)) {
        console.log(`    - ${err}`);
      }
      console.log('');
    }
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
