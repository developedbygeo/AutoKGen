#!/bin/bash
# Optimized batch import to Neo4j using MCP tools

echo "========================================"
echo "Optimized Neo4j Import"
echo "========================================"

# Use DATA_DIR from environment or default
DATA_DIR="${DATA_DIR:-data}"
DOMAIN="${DOMAIN:-$(basename "$DATA_DIR")}"
# Source logging utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/logger.sh"
source "$SCRIPT_DIR/../lib/provider.sh"
init_generated_dir "$DOMAIN"
_SELF_INIT_LOGGING=false
if [ -z "$LOG_DIR" ]; then
    init_logging "import-to-neo4j" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Import to Neo4j"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

GRAPH_DATA_FILE="$OUTPUT_DIR/graph-data.json"
if [ ! -f "$GRAPH_DATA_FILE" ]; then
    log_error "Required graph artifact missing: $GRAPH_DATA_FILE"
    echo "Import blocked: $GRAPH_DATA_FILE does not exist."
    echo "Run/fix the graph generation step first."
    echo "If generate-graph stopped due to compliance gating, fix mapping-strategy.json / generation inputs before importing."
    EXIT_CODE=1
    if [ "$_SELF_INIT_LOGGING" = true ]; then
        finalize_logging $EXIT_CODE
    fi
    exit $EXIT_CODE
fi

run_provider "Import knowledge graph to Neo4j with optimal batching strategy. Write TypeScript code that:

IMPORTANT: Use these optimal batch sizes and techniques for large-scale imports.
IMPORTANT: Do NOT make live MCP tool calls while generating this code.
IMPORTANT: The generated TypeScript must perform Neo4j operations itself at runtime using the installed 'neo4j-driver' package and the NEO4J_* environment variables.
IMPORTANT: If runtime prerequisites are missing, fail with a precise error message instead of attempting interactive recovery.
The NEO4J_DATABASE environment variable (default: 'neo4j') specifies the target database.

1. Load '$OUTPUT_DIR/graph-data.json'

2. Configuration for optimal performance:
   const BATCH_CONFIG = {
     nodesBatchSize: 5000,        // Optimal for most cases
     relsBatchSize: 2500,         // Relationships are heavier
     enablePeriodicCommit: true,  // For very large imports
     parallelBatches: 4,          // Number of parallel workers
     indexesBeforeImport: true    // Create indexes first
   };

3. Pre-import optimization:
   a) Inspect existing state via Neo4j queries executed by the generated script at runtime

   b) Create constraints BEFORE importing (much faster):
      - Execute Cypher such as:
        CREATE CONSTRAINT IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS UNIQUE
        CREATE CONSTRAINT IF NOT EXISTS FOR (n:Company) REQUIRE n.id IS UNIQUE
        ... for each entity type

   c) Create indexes on frequently queried properties:
      - Execute Cypher such as:
        CREATE INDEX IF NOT EXISTS FOR (n:Person) ON (n.name)
        CREATE INDEX IF NOT EXISTS FOR (n:Company) ON (n.sector)

4. Node Import Strategy (OPTIMAL):

   CRITICAL: Ensure EVERY node has an 'id' property set for relationship matching!

   For each batch of nodes, group by label and import:

   // IMPORTANT: Always ensure id is in properties
   const nodeProperties = { ...node.properties };
   if (!nodeProperties.id) {
     nodeProperties.id = node.id;
   }

   const nodeImportQuery = \`
     UNWIND \$batch AS node
     CREATE (n:\${labels})
     SET n = node.properties
   \`;

   Key optimizations:
   - ALWAYS include node.id in the properties object before import
   - Use CREATE (2x faster than MERGE) since we're creating new data
   - Set labels dynamically based on ontology mapping
   - Process 5,000 nodes per batch
   - Group nodes by label for efficient batching
   - Log progress every 10 batches

5. Relationship Import Strategy (OPTIMAL):

   CRITICAL: Match nodes by 'id' property (which MUST be set during node import)!

   For each batch of relationships, group by type:

   const relImportQuery = \`
     UNWIND \$batch AS rel
     MATCH (from {id: rel.from})
     MATCH (to {id: rel.to})
     CREATE (from)-[r:\${relType}]->(to)
     SET r = rel.properties
   \`;

   Key optimizations:
   - Match source/target nodes using indexed 'id' property (fast with constraints)
   - Group relationships by type for efficient batching
   - Process 2,500 relationships per batch (heavier than nodes)
   - If any relationships fail, log which node IDs are missing
   - Use OPTIONAL MATCH to debug missing nodes if needed

6. Parallel Import (ADVANCED - for > 100k records):
   
   If total nodes > 100,000:
   - Split nodes into 4 chunks
   - Import each chunk in parallel (careful with constraints!)
   - Wait for all node imports to complete
   - Then import relationships
   
   Example structure:
   const chunks = chunkArray(nodes, Math.ceil(nodes.length / 4));
   await Promise.all(chunks.map((chunk, idx) => 
     importNodeChunk(chunk, idx)
   ));

7. Progress Monitoring:
   
   Track and log:
   - Current batch number / total batches
   - Records processed / total records
   - Estimated time remaining
   - Current throughput (records/sec)
   - Memory usage
   
   Example output:
   [Nodes] Batch 10/50 | 50,000/250,000 records | 12,500 rec/sec | ETA: 16s

8. Post-import Validation:
   
   After import completes:
   a) Execute Cypher to count nodes:
      MATCH (n) RETURN labels(n) as label, count(*) as count
      
   b) Execute Cypher to count relationships:
      MATCH ()-[r]->() RETURN type(r) as type, count(*) as count
      
   c) Verify against source data
   
   d) Check for orphaned nodes (nodes without relationships):
      MATCH (n) WHERE NOT (n)--() RETURN count(n)

9. Generate comprehensive import report:
   {
     status: 'success' | 'partial' | 'failed',
     duration: number (milliseconds),
     throughput: {
       nodesPerSecond: number,
       relationshipsPerSecond: number
     },
     imported: {
       nodes: number,
       relationships: number,
       nodesByLabel: { [label: string]: number },
       relationshipsByType: { [type: string]: number }
     },
     optimization: {
       constraintsCreated: number,
       indexesCreated: number,
       batchSize: { nodes: number, relationships: number }
     },
     validation: {
       expectedNodes: number,
       actualNodes: number,
       expectedRelationships: number,
       actualRelationships: number,
       orphanedNodes: number
     },
     errors: string[]
   }

10. Save report to '$OUTPUT_DIR/neo4j-import-report.json'
11. Print detailed summary with performance metrics
12. Save code to '$GENERATED_DIR/import-to-neo4j.ts'

PERFORMANCE TIPS:
- Always create constraints BEFORE import (10x faster)
- Use CREATE instead of MERGE when possible (2x faster)
- CRITICAL: Ensure node.id is ALWAYS in node.properties before import
- Batch sizes: 5k for nodes, 2.5k for relationships
- Import nodes first, then relationships
- Verify nodes have 'id' property before creating relationships
- Group nodes by label and relationships by type for efficiency
- Monitor memory usage during import

DEBUGGING TIPS:
- If relationships fail, verify nodes exist: MATCH (n) WHERE n.id IN ['node_id1', 'node_id2'] RETURN n
- Check if any nodes are missing 'id' property: MATCH (n) WHERE n.id IS NULL RETURN labels(n), count(*)
- Log failed relationship imports with the 'from' and 'to' IDs for investigation
- Do NOT run multiple queries concurrently on the same Neo4j session. If you want parallel reads, open separate sessions; otherwise run the queries sequentially.

Write the code only. Do NOT execute it inside Codex. The shell wrapper will execute the generated importer after code generation."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    IMPORT_SCRIPT="$GENERATED_DIR/import-to-neo4j.ts"
    REPORT_FILE="$OUTPUT_DIR/neo4j-import-report.json"
    REPORT_STATUS=""

    if [ ! -f "$IMPORT_SCRIPT" ]; then
        log_error "Generated importer not found: $IMPORT_SCRIPT"
        EXIT_CODE=1
    else
        TS_NODE_BIN="$SCRIPT_DIR/../node_modules/.bin/ts-node"
        if [ ! -x "$TS_NODE_BIN" ]; then
            log_error "ts-node executable not found: $TS_NODE_BIN"
            EXIT_CODE=1
        fi
    fi

    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo "Running generated importer with ts-node..."
        "$TS_NODE_BIN" "$IMPORT_SCRIPT"
        EXIT_CODE=$?
    fi

    if [ $EXIT_CODE -eq 0 ] && [ -f "$REPORT_FILE" ]; then
        REPORT_STATUS=$(node -e "const fs=require('fs'); const p=process.argv[1]; const data=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(data.status || ''));" "$REPORT_FILE" 2>/dev/null)
    fi

    if [ -f "$REPORT_FILE" ]; then
        log_file_operation "write" "$REPORT_FILE" "import report"
    fi
    log_file_operation "write" "$IMPORT_SCRIPT" "generated code"

    if [ $EXIT_CODE -eq 0 ] && { [ "$REPORT_STATUS" = "success" ] || [ "$REPORT_STATUS" = "partial" ]; }; then
        log_success "Import to Neo4j completed"
        echo ""
        echo "Graph imported to Neo4j with optimal performance!"
        echo "Check report: $REPORT_FILE"
        echo ""
    else
        if [ $EXIT_CODE -ne 0 ]; then
            log_error "Generated importer execution failed (exit code: $EXIT_CODE)"
        else
            log_error "Import report indicates failure${REPORT_STATUS:+ (status: $REPORT_STATUS)}"
            EXIT_CODE=1
        fi
        echo ""
        echo "Neo4j import did not complete successfully."
        echo "Check report: $REPORT_FILE"
        echo ""
    fi
else
    log_error "Import to Neo4j failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE
