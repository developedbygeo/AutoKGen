#!/bin/bash
# Validate Neo4j graph against ontology constraints

echo "========================================"
echo "Ontology Validation"
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
    init_logging "validate-ontology" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Validate Ontology Compliance"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

GRAPH_DATA_FILE="$OUTPUT_DIR/graph-data.json"
ONTOLOGY_STRUCTURE_FILE="$OUTPUT_DIR/ontology-structure.json"
ONTOLOGY_GUIDE_FILE="$OUTPUT_DIR/ontology-mapping-guide.json"

for required_file in "$GRAPH_DATA_FILE" "$ONTOLOGY_STRUCTURE_FILE" "$ONTOLOGY_GUIDE_FILE"; do
    if [ ! -f "$required_file" ]; then
        log_error "Required validation artifact missing: $required_file"
        echo "Validation blocked: $required_file does not exist."
        EXIT_CODE=1
        if [ "$_SELF_INIT_LOGGING" = true ]; then
            finalize_logging $EXIT_CODE
        fi
        exit $EXIT_CODE
    fi
done

run_provider "Validate the Neo4j graph against ontology constraints. Write TypeScript code that:

1. Load required files:
   - '$OUTPUT_DIR/ontology-structure.json' (parsed ontology)
   - '$OUTPUT_DIR/graph-data.json' (generated graph)
   - '$OUTPUT_DIR/ontology-mapping-guide.json' (ontology patterns)

2. Validation runtime strategy:
   - Do NOT call live MCP tools while generating this code.
   - The generated TypeScript should try live Neo4j validation at runtime using 'neo4j-driver' and the NEO4J_* environment variables.
   - If live Neo4j access is unavailable at runtime, fall back to validating '$OUTPUT_DIR/graph-data.json' as a snapshot.
   - The report MUST explicitly state which route was used: 'live-neo4j' or 'snapshot-fallback'.
   - The NEO4J_DATABASE environment variable specifies which database to query. Default database is 'neo4j' if not specified.
   - If live validation is unavailable, report that clearly instead of pretending the snapshot validated the database contents.

3. **Build Validation Rules Dynamically from ontology-structure.json**:

   IMPORTANT: Do NOT hardcode any class names, property names, or namespace prefixes.
   ALL validation rules must be derived from the loaded ontology-structure.json.

   a) **Class Validation**:
      - Extract all valid class labels from ontology-structure.json classes[]
      - Query Neo4j for all node labels
      - Compare against valid classes — flag any labels not in the ontology
      - Cypher: MATCH (n) RETURN DISTINCT labels(n) as nodeLabels, count(*) as count

   b) **Object Property Domain/Range Validation**:
      - For each objectProperty in ontology-structure.json that has domain[] and range[]:
        - Query Neo4j for relationships of that type
        - Verify source node labels match the domain constraint
        - Verify target node labels match the range constraint

   c) **Data Property Domain Validation**:
      - For each dataProperty in ontology-structure.json that has domain[]:
        - Query Neo4j for nodes with that property
        - Verify node labels match the domain constraint

   d) **Data Property Datatype Validation**:
      - For each dataProperty with a range (xsd:date, xsd:integer, xsd:boolean, etc.):
        - Query Neo4j for values of that property
        - Verify values match the expected datatype format

   e) **Required Properties Check**:
      - Use ontology-mapping-guide.json commonPatterns[].requiredProperties
      - For each class, verify required properties are present on nodes of that class

   f) **Structural Validation**:
      - Check for orphaned nodes (nodes with no relationships)
      - Verify the graph has at least one instance of the core entity classes

   g) **Property Namespace Validation**:
      - Extract all valid namespace prefixes from ontology-structure.json metadata.namespaces
      - Build a regex from those prefixes dynamically
      - Query for any node properties not matching valid namespace prefixes

4. **Generate Comprehensive Validation Report**:

   {
     metadata: {
       validatedAt: ISO timestamp,
       ontologyName: string,    // From ontology-structure.json metadata.title
       ontologyVersion: string, // From ontology-structure.json metadata.version
       graphSource: string,
       validationMode: 'live-neo4j' | 'snapshot-fallback'
     },

     overallCompliance: {
       isCompliant: boolean,
       score: number (0-100),
       grade: 'A' | 'B' | 'C' | 'D' | 'F'
     },

     statistics: {
       totalNodes: number,
       totalRelationships: number,
       nodesAnalyzed: number,
       relationshipsAnalyzed: number
     },

     violations: [
       {
         category: 'class' | 'objectProperty' | 'dataProperty' | 'required' | 'structure',
         type: string,
         property: string,
         severity: 'error' | 'warning' | 'info',
         count: number,
         description: string,
         examples: [{ nodeId, labels, properties, context }],
         fixStrategies: [{ strategy, cypherQuery, description, risk }]
       }
     ],

     violationSummary: {
       byCategory: { [category: string]: number },
       bySeverity: { errors: number, warnings: number, info: number },
       topViolations: [{ type, count, severity }]
     },

     ontologyRequirements: {
       validLabels: { met: boolean, invalid: string[] },
       validNamespaces: { met: boolean, invalid: string[] },
       validDomainRanges: { met: boolean, violations: number },
       hasRequiredProperties: { met: boolean, missing: string[] }
     },

     recommendations: [
       { priority, action, reasoning, impact }
     ]
   }

5. **Generate Automated Fixes** (fixes.cypher):

   For each violation, generate appropriate Cypher fix queries.
   Group by risk level:
   - Safe fixes: formatting corrections, adding missing labels, generating IDs
   - Moderate fixes: changing relationship types, adding inferred properties
   - Destructive fixes: deleting invalid nodes/relationships (commented out by default)

6. **Generate Human-Readable Report** (validation-report.txt):
   Include overall compliance score, grade, summary of errors/warnings/info,
   detailed violation descriptions, and next steps.

7. **Console Output**:
   Print summary with compliance score, grade, node/relationship counts,
   issue breakdown, and output file locations.

8. Save outputs:
   - '$OUTPUT_DIR/validation-report.json' (machine-readable)
   - '$OUTPUT_DIR/validation-report.txt' (human-readable)
   - '$OUTPUT_DIR/fixes.cypher' (fix queries)
   - '$OUTPUT_DIR/violations-details.json' (detailed examples)

9. Save code to '$GENERATED_DIR/validate-ontology.ts'

10. Return exit code:
    - 0: Fully compliant (score >= 95)
    - 1: Partially compliant (score 70-94)
    - 2: Non-compliant (score < 70)

**CRITICAL**: This validation is the final gatekeeper. Be thorough and provide actionable fixes.
ALL validation rules MUST be derived from ontology-structure.json — do NOT hardcode any class names, property names, or namespaces.
Write the code only. Do NOT execute it inside Codex. The shell wrapper will execute the generated validator after code generation."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    VALIDATOR_SCRIPT="$GENERATED_DIR/validate-ontology.ts"
    TS_NODE_BIN="$SCRIPT_DIR/../node_modules/.bin/ts-node"
    REPORT_FILE="$OUTPUT_DIR/validation-report.json"
    VALIDATION_MODE=""

    if [ ! -f "$VALIDATOR_SCRIPT" ]; then
        log_error "Generated validator not found: $VALIDATOR_SCRIPT"
        EXIT_CODE=1
    elif [ ! -x "$TS_NODE_BIN" ]; then
        log_error "ts-node executable not found: $TS_NODE_BIN"
        EXIT_CODE=1
    else
        echo ""
        echo "Running generated ontology validator with ts-node..."
        "$TS_NODE_BIN" "$VALIDATOR_SCRIPT"
        EXIT_CODE=$?
    fi

    if [ -f "$REPORT_FILE" ]; then
        VALIDATION_MODE=$(node -e "const fs=require('fs'); const p=process.argv[1]; const data=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(data?.metadata?.validationMode || ''));" "$REPORT_FILE" 2>/dev/null)
        log_file_operation "write" "$REPORT_FILE" "validation report"
    fi
    [ -f "$OUTPUT_DIR/validation-report.txt" ] && log_file_operation "write" "$OUTPUT_DIR/validation-report.txt" "readable report"
    [ -f "$OUTPUT_DIR/fixes.cypher" ] && log_file_operation "write" "$OUTPUT_DIR/fixes.cypher" "fix queries"
    [ -f "$OUTPUT_DIR/violations-details.json" ] && log_file_operation "write" "$OUTPUT_DIR/violations-details.json" "violation details"
    log_file_operation "write" "$VALIDATOR_SCRIPT" "generated code"

    if [ $EXIT_CODE -eq 0 ]; then
        log_success "Validate Ontology Compliance completed"
        echo ""
        echo "Validation complete!"
        echo "Mode: ${VALIDATION_MODE:-unknown}"
        echo "Review:"
        echo "  - $OUTPUT_DIR/validation-report.json (detailed report)"
        echo "  - $OUTPUT_DIR/validation-report.txt (readable summary)"
        echo "  - $OUTPUT_DIR/fixes.cypher (automated fixes)"
        echo ""
        echo "Apply fixes and re-run validation until fully compliant."
        echo ""
    else
        log_error "Generated ontology validator execution failed (exit code: $EXIT_CODE)"
    fi
else
    log_error "Validate Ontology Compliance failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE
