#!/bin/bash
#  Generate ontology-compliant knowledge graph from cleaned data

echo "========================================"
echo " Generating Knowledge Graph"
echo "========================================"


DATA_DIR="${DATA_DIR:-data}"
DOMAIN="${DOMAIN:-$(basename "$DATA_DIR")}"
# Source logging utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/logger.sh"
source "$SCRIPT_DIR/../lib/provider.sh"
init_generated_dir "$DOMAIN"
_SELF_INIT_LOGGING=false
if [ -z "$LOG_DIR" ]; then
    init_logging "generate-graph" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Generate Knowledge Graph"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

REQUIRED_INPUTS=(
    "$OUTPUT_DIR/dataset-cleaned.csv"
    "$OUTPUT_DIR/mapping-strategy.json"
    "$OUTPUT_DIR/ontology-structure.json"
    "$OUTPUT_DIR/ontology-mapping-guide.json"
)

for required_file in "${REQUIRED_INPUTS[@]}"; do
    if [ ! -f "$required_file" ]; then
        log_error "Required graph-generation artifact missing: $required_file"
        echo "Graph generation blocked: $required_file does not exist."
        EXIT_CODE=1
        if [ "$_SELF_INIT_LOGGING" = true ]; then
            finalize_logging $EXIT_CODE
        fi
        exit $EXIT_CODE
    fi
done

run_provider "Generate an ontology-compliant knowledge graph. Write TypeScript code that:

1. Load required files:
   - '$OUTPUT_DIR/dataset-cleaned.csv'
   - '$OUTPUT_DIR/mapping-strategy.json'
   - '$OUTPUT_DIR/ontology-structure.json'
   - '$OUTPUT_DIR/ontology-mapping-guide.json'

   Also check for optional supplementary data:
   - '$OUTPUT_DIR/supplementary-files-index.json' (if it exists)
   - If supplementary files exist, load the actual files from '$DATA_DIR/supplementary-files/'.
     Use them for graph ENRICHMENT:
     a) Resolve coded values to human-readable labels for node properties
        (e.g., country code 'DE' → 'Germany', feature code 'P.PPL' → 'populated place')
     b) Create additional nodes from supplementary reference data when the mapping strategy
        references entities defined in supplementary files (e.g., country nodes, category nodes)
     c) Create relationships between main data nodes and supplementary reference nodes
        (e.g., a location node -[:locatedIn]-> country node)
     d) All enrichment MUST still comply with the ontology — only add nodes/relationships
        using classes and properties from ontology-structure.json

2. **ONTOLOGY COMPLIANCE VALIDATION** (Before Generation):

   a) Check mapping-strategy.json compliance:
      - Verify complianceScore >= 80 (threshold for proceeding)
      - If score < 80, print warning and list violations
      - Continue but mark graph as 'non-compliant'

   b) Load valid classes and properties from ontology-structure.json
   c) Load valid namespaces from ontology-structure.json metadata.namespaces

3. **Transform Data into Graph Structure**:

   For each row in the CSV:

   a) **Create Entity Nodes**:

      For each entity mapping (from mapping-strategy.json):
      {
        id: generateStableURI(entityClass, identifierValue),
        labels: [ontologyClass],  // Use the class label from ontology-structure.json
        properties: {
          // Map all attribute columns to ontology properties
          // Include ONLY properties from compliant attribute mappings
          ...mappedProperties
        },
        _meta: {
          sourceRow: rowIndex,
          confidence: mappingConfidence,
          compliant: true
        }
      }

   b) **Create Relationships**:

      For each relationship mapping:
      {
        id: generateStableURI('rel', sourceId, relationshipType, targetId),
        type: ontologyRelationship,  // From mapping-strategy.json
        from: sourceNodeId,
        to: targetNodeId,
        properties: {},
        _meta: {
          confidence: mappingConfidence,
          compliant: true
        }
      }

   c) **Handle Unmapped Columns**:
      - For columns marked as 'unmapped' in mapping-strategy.json
      - Skip them by default
      - Log all unmapped data for review

4. **In-Flight Validation** (During Generation):

   a) Validate each node:
      - Label exists in ontology-structure.json classes
      - All properties exist in ontology (objectProperties or dataProperties)
      - Property domains match node class
      - Property datatypes are correct
      - If validation fails, log error and skip or flag node

   b) Validate each relationship:
      - Relationship type exists in ontology objectProperties
      - Source node class matches domain constraint
      - Target node class matches range constraint
      - If validation fails, log error and skip or flag relationship

   c) Track validation metrics:
      - validNodes, invalidNodes
      - validRelationships, invalidRelationships
      - violationsByType

5. **Generate Multiple Output Formats**:

   a) **JSON format** (graph-data.json):
   {
     metadata: {
       generatedAt: ISO timestamp,
       ontologyName: string,     // From ontology-structure.json metadata.title
       ontologyVersion: string,  // From ontology-structure.json metadata.version
       complianceScore: number,
       validation: {
         compliant: boolean,
         errors: number,
         warnings: number
       }
     },
     nodes: [
       { id, labels, properties, _meta }
     ],
     relationships: [
       { id, type, from, to, properties, _meta }
     ],
     statistics: {
       totalNodes: number,
       nodesByType: { [className: string]: number },
       totalRelationships: number,
       relationshipsByType: { [relType: string]: number }
     }
   }

   b) **Cypher format** (graph-import.cypher):
   Generate Neo4j import statements using the actual ontology class names as labels
   and ontology property names for relationships.
   Create uniqueness constraints dynamically based on the entity classes found.

   c) **RDF/Turtle format** (graph-data.ttl) [BONUS]:
   Use the namespace prefixes from ontology-structure.json metadata.namespaces
   to generate proper @prefix declarations and RDF triples.

6. **Generate Comprehensive Statistics**:

   {
     summary: {
       totalNodes: number,
       totalRelationships: number,
       avgDegree: number,
       density: number
     },
     nodeStatistics: {
       byType: { [className: string]: number },
       withIssues: number,
       compliant: number
     },
     relationshipStatistics: {
       byType: { [relType: string]: number },
       withIssues: number,
       compliant: number
     },
     complianceMetrics: {
       overallScore: number,
       validNodesPercent: number,
       validRelationshipsPercent: number,
       unmappedDataPercent: number
     },
     issues: [
       { type, severity, count, examples }
     ]
   }

7. **URI Generation Strategy**:

   Make URIs stable and deterministic:
   - Base URI: http://data.example.org/
   - Pattern: [base]/[class-label-slugified]/[identifier-slugified]
   - Use slug-ified identifiers (lowercase, hyphens, no spaces)

8. **Error Handling**:

   - If compliance score < 60: STOP and report errors
   - If compliance score 60-79: Generate with warnings
   - If compliance score >= 80: Generate normally
   - Log all validation errors to separate file

9. **Save Outputs**:
   - '$OUTPUT_DIR/graph-data.json' (JSON graph)
   - '$OUTPUT_DIR/graph-import.cypher' (Neo4j import script)
   - '$OUTPUT_DIR/graph-data.ttl' (RDF Turtle, optional)
   - '$OUTPUT_DIR/graph-stats.json' (statistics)
   - '$OUTPUT_DIR/graph-validation-errors.json' (if errors exist)

10. **Console Output**:
    Print comprehensive summary including:
    - Compliance score
    - Node counts by type
    - Relationship counts by type
    - Validation results (valid/invalid percentages)
    - Unmapped column count
    - Output file list

11. Save code to '$GENERATED_DIR/generate-graph.ts'

**CRITICAL REQUIREMENTS**:
- ONLY use classes/properties from mapping-strategy.json that have 'compliant: true'
- All valid classes and properties come from ontology-structure.json — do NOT hardcode any ontology-specific terms
- Validate EVERY node and relationship before adding to graph
- Fail fast if compliance score is too low
- Be defensive: better to skip questionable data than create invalid graph
- AVOID O(n^2) or higher complexity — do NOT use nested loops over nodes/relationships for lookups. Use Maps/Sets for O(1) lookups (e.g., index nodes by ID in a Map before linking relationships). This is critical for datasets with thousands of rows

Write the code only. Do NOT execute it inside Codex. The shell wrapper will execute the generated graph builder after code generation."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    GRAPH_SCRIPT="$GENERATED_DIR/generate-graph.ts"
    TS_NODE_BIN="$SCRIPT_DIR/../node_modules/.bin/ts-node"
    REQUIRED_OUTPUTS=(
        "$OUTPUT_DIR/graph-data.json"
        "$OUTPUT_DIR/graph-import.cypher"
        "$OUTPUT_DIR/graph-stats.json"
    )

    if [ ! -f "$GRAPH_SCRIPT" ]; then
        log_error "Generated graph builder not found: $GRAPH_SCRIPT"
        EXIT_CODE=1
    elif [ ! -x "$TS_NODE_BIN" ]; then
        log_error "ts-node executable not found: $TS_NODE_BIN"
        EXIT_CODE=1
    else
        echo ""
        echo "Running generated graph builder with ts-node..."
        "$TS_NODE_BIN" "$GRAPH_SCRIPT"
        EXIT_CODE=$?
    fi

    for output_file in "${REQUIRED_OUTPUTS[@]}"; do
        if [ ! -f "$output_file" ]; then
            log_error "Expected graph output missing after generation: $output_file"
            EXIT_CODE=1
        fi
    done

    [ -f "$OUTPUT_DIR/graph-data.json" ] && log_file_operation "write" "$OUTPUT_DIR/graph-data.json" "graph data"
    [ -f "$OUTPUT_DIR/graph-import.cypher" ] && log_file_operation "write" "$OUTPUT_DIR/graph-import.cypher" "cypher import"
    [ -f "$OUTPUT_DIR/graph-stats.json" ] && log_file_operation "write" "$OUTPUT_DIR/graph-stats.json" "graph statistics"
    [ -f "$OUTPUT_DIR/graph-data.ttl" ] && log_file_operation "write" "$OUTPUT_DIR/graph-data.ttl" "rdf turtle"
    [ -f "$OUTPUT_DIR/graph-validation-errors.json" ] && log_file_operation "write" "$OUTPUT_DIR/graph-validation-errors.json" "graph validation errors"
    log_file_operation "write" "$GRAPH_SCRIPT" "generated code"

    if [ $EXIT_CODE -eq 0 ]; then
        log_success "Generate Knowledge Graph completed"
        echo ""
        echo "Knowledge Graph generated!"
        echo "Review:"
        echo "  - $OUTPUT_DIR/graph-data.json (graph structure)"
        echo "  - $OUTPUT_DIR/graph-import.cypher (Neo4j import)"
        echo "  - $OUTPUT_DIR/graph-stats.json (statistics)"
        echo ""
    else
        log_error "Generated graph builder execution failed (exit code: $EXIT_CODE)"
    fi
else
    log_error "Generate Knowledge Graph failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE
