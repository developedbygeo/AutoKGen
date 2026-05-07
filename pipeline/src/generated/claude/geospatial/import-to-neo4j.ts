import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import neo4j, { Driver, Session } from "neo4j-driver";

// ============================================================
// Configuration
// ============================================================

const DATA_DIR = process.env.DATA_DIR || "domain-data/geospatial";
const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "123123123";
const NEO4J_DATABASE = process.env.NEO4J_DATABASE || "neo4j";

const BATCH_CONFIG = {
  nodesBatchSize: 5000,
  relsBatchSize: 2500,
  parallelBatches: 4,
  indexesBeforeImport: true,
  logEveryNBatches: 10,
};

// Relationship type -> (fromLabel, toLabel) mapping for label-aware MATCH
const REL_LABEL_MAP: Record<string, { from: string; to: string }> = {
  hasGeometry: { from: "Feature", to: "Geometry" },
  sfWithin: { from: "Feature", to: "Feature" },
};

const INPUT_FILE = path.resolve(DATA_DIR, "output", "graph-data.json");
const REPORT_FILE = path.resolve(DATA_DIR, "output", "neo4j-import-report.json");

// ============================================================
// Types
// ============================================================

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
  status: "success" | "partial" | "failed";
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

// ============================================================
// Progress Tracker
// ============================================================

function createProgressTracker(phase: string, total: number) {
  const startTime = Date.now();
  let processed = 0;

  return {
    update(count: number) {
      processed += count;
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed > 0 ? Math.round(processed / elapsed) : 0;
      const remaining = rate > 0 ? Math.round((total - processed) / rate) : 0;
      const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
      process.stdout.write(
        `\r  [${phase}] ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ${rate.toLocaleString()} rec/sec | ETA: ${remaining}s   `
      );
    },
    finish() {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed > 0 ? Math.round(processed / elapsed) : 0;
      console.log(
        `\n  [${phase}] Done: ${processed.toLocaleString()} records in ${elapsed.toFixed(1)}s (${rate.toLocaleString()} rec/sec)`
      );
      return { processed, elapsed, rate };
    },
  };
}

// ============================================================
// Streaming JSON Parser
// ============================================================

async function streamParseArray(
  filePath: string,
  arrayKey: string,
  onItem: (item: unknown) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let inArray = false;
    let buffer = "";
    let count = 0;
    const arrayPattern = new RegExp(`"${arrayKey}"\\s*:\\s*\\[`);

    rl.on("line", (line: string) => {
      const trimmed = line.trim();

      if (!inArray) {
        if (arrayPattern.test(trimmed)) {
          inArray = true;
          const bracketIdx = trimmed.indexOf("[");
          const after = trimmed.substring(bracketIdx + 1).trim();
          if (after && after !== "]") {
            buffer = after;
          }
        }
        return;
      }

      if (trimmed === "]" || trimmed === "],") {
        if (buffer) {
          let cleaned = buffer.trim();
          if (cleaned.endsWith(",")) cleaned = cleaned.slice(0, -1);
          try {
            const obj = JSON.parse(cleaned);
            onItem(obj);
            count++;
          } catch {
            // incomplete or trailing
          }
          buffer = "";
        }
        inArray = false;
        return;
      }

      buffer += (buffer ? "\n" : "") + line;

      let cleaned = buffer.trim();
      if (cleaned.endsWith(",")) cleaned = cleaned.slice(0, -1);
      if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
        try {
          const obj = JSON.parse(cleaned);
          onItem(obj);
          count++;
          buffer = "";
        } catch {
          // Incomplete, keep buffering
        }
      }
    });

    rl.on("close", () => resolve(count));
    rl.on("error", reject);
  });
}

// ============================================================
// Neo4j Import Functions
// ============================================================

async function createConstraintsAndIndexes(
  session: Session,
  labels: string[]
): Promise<{ constraints: number; indexes: number }> {
  let constraints = 0;
  let indexes = 0;

  console.log("\n  Creating constraints and indexes...");

  for (const label of labels) {
    try {
      await session.run(
        `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`
      );
      constraints++;
      console.log(`    Constraint: ${label}.id IS UNIQUE`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    Constraint skipped for ${label}: ${msg}`);
    }
  }

  const indexConfigs: Array<{ label: string; property: string }> = [
    { label: "Feature", property: "label" },
    { label: "Feature", property: "type" },
    { label: "Feature", property: "spatial" },
    { label: "Feature", property: "notation" },
    { label: "Geometry", property: "asWKT" },
  ];

  for (const { label, property } of indexConfigs) {
    if (!labels.includes(label)) continue;
    try {
      await session.run(
        `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${property})`
      );
      indexes++;
      console.log(`    Index: ${label}.${property}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    Index skipped for ${label}.${property}: ${msg}`);
    }
  }

  try {
    await session.run("CALL db.awaitIndexes(120)");
    console.log("    All indexes online.");
  } catch {
    console.log("    Warning: index wait timed out, continuing...");
  }

  return { constraints, indexes };
}

async function importNodeBatch(
  session: Session,
  nodes: GraphNode[],
  label: string
): Promise<number> {
  const batch = nodes.map((n) => {
    const props = { ...n.properties };
    if (!props.id) props.id = n.id;
    return { properties: props };
  });

  const result = await session.run(
    `UNWIND $batch AS node CREATE (n:${label}) SET n = node.properties`,
    { batch }
  );

  return result.summary.counters.updates().nodesCreated;
}

async function importRelBatch(
  session: Session,
  rels: GraphRelationship[],
  relType: string,
  fromLabel: string,
  toLabel: string
): Promise<{ created: number; failed: string[] }> {
  const batch = rels.map((r) => ({
    from: r.from,
    to: r.to,
    properties: r.properties || {},
  }));

  // Use label-aware MATCH to leverage uniqueness constraint indexes
  const result = await session.run(
    `UNWIND $batch AS rel
     MATCH (from:${fromLabel} {id: rel.from})
     MATCH (to:${toLabel} {id: rel.to})
     CREATE (from)-[r:${relType}]->(to)
     SET r = rel.properties`,
    { batch }
  );

  const created = result.summary.counters.updates().relationshipsCreated;
  const failed: string[] = [];
  if (created < batch.length) {
    failed.push(
      `${batch.length - created} of ${batch.length} ${relType} rels failed (missing nodes)`
    );
  }
  return { created, failed };
}

// ============================================================
// Parallel Chunk Import
// ============================================================

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function importNodesParallel(
  driver: Driver,
  nodesByLabel: Map<string, GraphNode[]>,
  progress: ReturnType<typeof createProgressTracker>
): Promise<{ total: number; byLabel: Record<string, number>; errors: string[] }> {
  let total = 0;
  const byLabel: Record<string, number> = {};
  const errors: string[] = [];

  for (const [label, nodes] of nodesByLabel) {
    console.log(`\n  Importing ${nodes.length.toLocaleString()} ${label} nodes...`);
    const batches = chunkArray(nodes, BATCH_CONFIG.nodesBatchSize);

    for (let i = 0; i < batches.length; i += BATCH_CONFIG.parallelBatches) {
      const group = batches.slice(i, i + BATCH_CONFIG.parallelBatches);
      const results = await Promise.all(
        group.map(async (batch) => {
          const session = driver.session({ database: NEO4J_DATABASE });
          try {
            return await importNodeBatch(session, batch, label);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Node batch error (${label}): ${msg}`);
            return 0;
          } finally {
            await session.close();
          }
        })
      );

      const created = results.reduce((s, c) => s + c, 0);
      total += created;
      byLabel[label] = (byLabel[label] || 0) + created;
      progress.update(created);

      if (
        (Math.floor((i + BATCH_CONFIG.parallelBatches) / BATCH_CONFIG.parallelBatches) %
          BATCH_CONFIG.logEveryNBatches === 0) ||
        i + BATCH_CONFIG.parallelBatches >= batches.length
      ) {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        process.stdout.write(` | Heap: ${heapMB}MB`);
      }
    }
  }

  return { total, byLabel, errors };
}

async function importRelsParallel(
  driver: Driver,
  relsByType: Map<string, GraphRelationship[]>,
  progress: ReturnType<typeof createProgressTracker>
): Promise<{ total: number; byType: Record<string, number>; errors: string[] }> {
  let total = 0;
  const byType: Record<string, number> = {};
  const errors: string[] = [];

  for (const [relType, rels] of relsByType) {
    const labelMap = REL_LABEL_MAP[relType];
    if (!labelMap) {
      errors.push(`Unknown relationship type: ${relType} — no label mapping, skipping`);
      continue;
    }

    console.log(
      `\n  Importing ${rels.length.toLocaleString()} ${relType} rels (${labelMap.from} -> ${labelMap.to})...`
    );
    const batches = chunkArray(rels, BATCH_CONFIG.relsBatchSize);

    for (let i = 0; i < batches.length; i += BATCH_CONFIG.parallelBatches) {
      const group = batches.slice(i, i + BATCH_CONFIG.parallelBatches);
      const results = await Promise.all(
        group.map(async (batch) => {
          const session = driver.session({ database: NEO4J_DATABASE });
          try {
            return await importRelBatch(session, batch, relType, labelMap.from, labelMap.to);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Rel batch error (${relType}): ${msg}`);
            return { created: 0, failed: [msg] };
          } finally {
            await session.close();
          }
        })
      );

      let created = 0;
      for (const r of results) {
        created += r.created;
        errors.push(...r.failed);
      }
      total += created;
      byType[relType] = (byType[relType] || 0) + created;
      progress.update(created);

      if (
        (Math.floor((i + BATCH_CONFIG.parallelBatches) / BATCH_CONFIG.parallelBatches) %
          BATCH_CONFIG.logEveryNBatches === 0) ||
        i + BATCH_CONFIG.parallelBatches >= batches.length
      ) {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        process.stdout.write(` | Heap: ${heapMB}MB`);
      }
    }
  }

  return { total, byType, errors };
}

// ============================================================
// Validation
// ============================================================

async function validateImport(
  session: Session,
  expectedNodes: number,
  expectedRels: number
): Promise<{
  actualNodes: number;
  actualRels: number;
  orphanedNodes: number;
  nodesByLabel: Record<string, number>;
  relsByType: Record<string, number>;
}> {
  console.log("\n  Validating import...");

  const toNum = (val: unknown): number =>
    typeof val === "object" && val !== null && "low" in val
      ? (val as { low: number }).low
      : (val as number);

  const nodeResult = await session.run(
    "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count"
  );
  const nodesByLabel: Record<string, number> = {};
  let actualNodes = 0;
  for (const record of nodeResult.records) {
    const label = record.get("label") as string;
    const count = toNum(record.get("count"));
    nodesByLabel[label] = count;
    actualNodes += count;
  }

  const relResult = await session.run(
    "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count"
  );
  const relsByType: Record<string, number> = {};
  let actualRels = 0;
  for (const record of relResult.records) {
    const type = record.get("type") as string;
    const count = toNum(record.get("count"));
    relsByType[type] = count;
    actualRels += count;
  }

  const orphanResult = await session.run(
    "MATCH (n) WHERE NOT (n)--() RETURN count(n) AS count"
  );
  const orphanedNodes = toNum(orphanResult.records[0].get("count"));

  console.log(`    Nodes: ${actualNodes.toLocaleString()} (expected ${expectedNodes.toLocaleString()})`);
  console.log(`    Relationships: ${actualRels.toLocaleString()} (expected ${expectedRels.toLocaleString()})`);
  console.log(`    Orphaned nodes: ${orphanedNodes.toLocaleString()}`);

  return { actualNodes, actualRels, orphanedNodes, nodesByLabel, relsByType };
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("=".repeat(70));
  console.log("  Neo4j Import — Geospatial Knowledge Graph");
  console.log("=".repeat(70));
  console.log(`  Source: ${INPUT_FILE}`);
  console.log(`  Neo4j:  ${NEO4J_URI} (db: ${NEO4J_DATABASE})`);
  console.log(`  Batch:  ${BATCH_CONFIG.nodesBatchSize} nodes, ${BATCH_CONFIG.relsBatchSize} rels, ${BATCH_CONFIG.parallelBatches} parallel`);

  const overallStart = Date.now();
  const errors: string[] = [];

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`\n  ERROR: Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const fileSizeMB = Math.round(fs.statSync(INPUT_FILE).size / 1024 / 1024);
  console.log(`  File:   ${fileSizeMB} MB`);

  // Connect to Neo4j
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  try {
    await driver.verifyConnectivity();
    console.log("\n  Connected to Neo4j.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ERROR: Cannot connect to Neo4j: ${msg}`);
    process.exit(1);
  }

  // ---- Check existing state ----
  const checkSession = driver.session({ database: NEO4J_DATABASE });
  let existingNodes = 0;
  let existingRels = 0;
  try {
    const nr = await checkSession.run("MATCH (n) RETURN count(n) AS c");
    existingNodes = typeof nr.records[0].get("c") === "object"
      ? (nr.records[0].get("c") as { low: number }).low
      : (nr.records[0].get("c") as number);
    const rr = await checkSession.run("MATCH ()-[r]->() RETURN count(r) AS c");
    existingRels = typeof rr.records[0].get("c") === "object"
      ? (rr.records[0].get("c") as { low: number }).low
      : (rr.records[0].get("c") as number);
    console.log(`  Existing: ${existingNodes.toLocaleString()} nodes, ${existingRels.toLocaleString()} rels`);
  } finally {
    await checkSession.close();
  }

  const skipNodes = existingNodes > 0;
  const skipRels = existingRels > 0;

  // ---- Phase 1: Stream and collect nodes ----
  let totalExpectedNodes = 0;
  let nodeStats = { processed: 0, elapsed: 0, rate: 0 };
  let nodeImportResult = { total: 0, byLabel: {} as Record<string, number>, errors: [] as string[] };
  let labels: string[] = [];

  if (!skipNodes) {
    console.log("\n" + "-".repeat(70));
    console.log("  Phase 1: Loading nodes from graph-data.json (streaming)...");

    const nodesByLabel = new Map<string, GraphNode[]>();
    const nodeLoadStart = Date.now();
    await streamParseArray(INPUT_FILE, "nodes", (item) => {
      const node = item as GraphNode;
      const label = node.labels[0] || "Unknown";
      if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
      nodesByLabel.get(label)!.push(node);
      totalExpectedNodes++;
      if (totalExpectedNodes % 100000 === 0) {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        process.stdout.write(
          `\r  Loading nodes: ${totalExpectedNodes.toLocaleString()} | Heap: ${heapMB}MB   `
        );
      }
    });
    const nodeLoadTime = ((Date.now() - nodeLoadStart) / 1000).toFixed(1);
    console.log(`\n  Loaded ${totalExpectedNodes.toLocaleString()} nodes in ${nodeLoadTime}s`);

    for (const [label, nodes] of nodesByLabel) {
      console.log(`    ${label}: ${nodes.length.toLocaleString()}`);
    }

    // ---- Phase 2: Create constraints and indexes ----
    console.log("\n" + "-".repeat(70));
    console.log("  Phase 2: Creating constraints and indexes...");
    labels = [...nodesByLabel.keys()];
    const setupSession = driver.session({ database: NEO4J_DATABASE });
    try {
      await createConstraintsAndIndexes(setupSession, labels);
    } finally {
      await setupSession.close();
    }

    // ---- Phase 3: Import nodes ----
    console.log("\n" + "-".repeat(70));
    console.log("  Phase 3: Importing nodes...");

    const nodeProgress = createProgressTracker("Nodes", totalExpectedNodes);
    nodeImportResult = await importNodesParallel(driver, nodesByLabel, nodeProgress);
    nodeStats = nodeProgress.finish();
    nodesByLabel.clear();
  } else {
    console.log(`\n  Skipping node import — ${existingNodes.toLocaleString()} nodes already exist.`);
    totalExpectedNodes = existingNodes;
    nodeImportResult = { total: existingNodes, byLabel: {}, errors: [] };

    // Ensure constraints exist
    labels = ["Feature", "Geometry"];
    const setupSession = driver.session({ database: NEO4J_DATABASE });
    try {
      await createConstraintsAndIndexes(setupSession, labels);
    } finally {
      await setupSession.close();
    }
  }

  // ---- Phase 4: Stream and collect relationships ----
  let totalExpectedRels = 0;
  let relStats = { processed: 0, elapsed: 0, rate: 0 };
  let relImportResult = { total: 0, byType: {} as Record<string, number>, errors: [] as string[] };

  if (!skipRels) {
    console.log("\n" + "-".repeat(70));
    console.log("  Phase 4: Loading relationships from graph-data.json (streaming)...");

    const relsByType = new Map<string, GraphRelationship[]>();
    const relLoadStart = Date.now();
    await streamParseArray(INPUT_FILE, "relationships", (item) => {
      const rel = item as GraphRelationship;
      if (!relsByType.has(rel.type)) relsByType.set(rel.type, []);
      relsByType.get(rel.type)!.push(rel);
      totalExpectedRels++;
      if (totalExpectedRels % 100000 === 0) {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        process.stdout.write(
          `\r  Loading rels: ${totalExpectedRels.toLocaleString()} | Heap: ${heapMB}MB   `
        );
      }
    });
    const relLoadTime = ((Date.now() - relLoadStart) / 1000).toFixed(1);
    console.log(`\n  Loaded ${totalExpectedRels.toLocaleString()} relationships in ${relLoadTime}s`);

    for (const [type, rels] of relsByType) {
      console.log(`    ${type}: ${rels.length.toLocaleString()}`);
    }

    // ---- Phase 5: Import relationships ----
    console.log("\n" + "-".repeat(70));
    console.log("  Phase 5: Importing relationships...");

    const relProgress = createProgressTracker("Rels", totalExpectedRels);
    relImportResult = await importRelsParallel(driver, relsByType, relProgress);
    relStats = relProgress.finish();
    relsByType.clear();
  } else {
    console.log(`\n  Skipping rel import — ${existingRels.toLocaleString()} rels already exist.`);
    totalExpectedRels = existingRels;
    relImportResult = { total: existingRels, byType: {}, errors: [] };
  }

  errors.push(...nodeImportResult.errors, ...relImportResult.errors);

  // ---- Phase 6: Validate ----
  console.log("\n" + "-".repeat(70));
  console.log("  Phase 6: Post-import validation...");

  const validateSession = driver.session({ database: NEO4J_DATABASE });
  let validation;
  try {
    validation = await validateImport(validateSession, totalExpectedNodes, totalExpectedRels);
  } finally {
    await validateSession.close();
  }

  // ---- Generate report ----
  const totalDuration = Date.now() - overallStart;
  const constraintsCreated = labels.length;
  const indexesCreated = 5; // Feature: label, type, spatial, notation + Geometry: asWKT

  const report: ImportReport = {
    status:
      validation.actualNodes === totalExpectedNodes &&
      validation.actualRels === totalExpectedRels
        ? "success"
        : validation.actualNodes > 0
          ? "partial"
          : "failed",
    duration: totalDuration,
    throughput: {
      nodesPerSecond: nodeStats.elapsed > 0 ? Math.round(nodeImportResult.total / nodeStats.elapsed) : 0,
      relationshipsPerSecond: relStats.elapsed > 0 ? Math.round(relImportResult.total / relStats.elapsed) : 0,
    },
    imported: {
      nodes: nodeImportResult.total,
      relationships: relImportResult.total,
      nodesByLabel: validation.nodesByLabel,
      relationshipsByType: validation.relsByType,
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
      expectedNodes: totalExpectedNodes,
      actualNodes: validation.actualNodes,
      expectedRelationships: totalExpectedRels,
      actualRelationships: validation.actualRels,
      orphanedNodes: validation.orphanedNodes,
    },
    errors: errors.filter((e) => e.length > 0),
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

  // Print summary
  console.log("\n" + "=".repeat(70));
  console.log("  IMPORT SUMMARY");
  console.log("=".repeat(70));
  console.log(`  Status:        ${report.status.toUpperCase()}`);
  console.log(`  Duration:      ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`  Nodes:         ${validation.actualNodes.toLocaleString()} / ${totalExpectedNodes.toLocaleString()}`);
  for (const [label, count] of Object.entries(validation.nodesByLabel)) {
    console.log(`    ${label}: ${count.toLocaleString()}`);
  }
  console.log(`  Relationships: ${validation.actualRels.toLocaleString()} / ${totalExpectedRels.toLocaleString()}`);
  for (const [type, count] of Object.entries(validation.relsByType)) {
    console.log(`    ${type}: ${count.toLocaleString()}`);
  }
  if (report.throughput.nodesPerSecond > 0) {
    console.log(`  Throughput:    ${report.throughput.nodesPerSecond.toLocaleString()} nodes/sec, ${report.throughput.relationshipsPerSecond.toLocaleString()} rels/sec`);
  }
  console.log(`  Constraints:   ${constraintsCreated}`);
  console.log(`  Indexes:       ${indexesCreated}`);
  console.log(`  Orphaned:      ${validation.orphanedNodes.toLocaleString()}`);
  if (report.errors.length > 0) {
    console.log(`  Errors:        ${report.errors.length}`);
    for (const e of report.errors.slice(0, 10)) {
      console.log(`    - ${e}`);
    }
    if (report.errors.length > 10) {
      console.log(`    ... and ${report.errors.length - 10} more`);
    }
  }
  console.log(`\n  Report saved: ${REPORT_FILE}`);
  console.log("=".repeat(70));

  await driver.close();
  process.exit(report.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  console.error("\n  FATAL ERROR:", err);
  process.exit(1);
});
