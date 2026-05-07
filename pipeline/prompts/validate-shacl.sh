#!/bin/bash
# Validate Neo4j graph against SHACL shapes using neosemantics (n10s)

echo "========================================"
echo "SHACL Validation (n10s)"
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
    init_logging "validate-shacl" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

# Resolve SHACL shapes file
SHACL_FILE="${SHACL_FILE:-}"

if [ -z "$SHACL_FILE" ]; then
    # Auto-discover .ttl files in validation/ directory
    VALIDATION_DIR="$DATA_DIR/validation"
    if [ -d "$VALIDATION_DIR" ]; then
        TTL_FILES=($(find "$VALIDATION_DIR" -name "*.ttl" -type f 2>/dev/null | sort))
        if [ ${#TTL_FILES[@]} -eq 0 ]; then
            echo "No .ttl files found in $VALIDATION_DIR"
            echo "Place your SHACL shapes file(s) in $VALIDATION_DIR/ or pass SHACL_FILE=<path>"
            exit 1
        elif [ ${#TTL_FILES[@]} -eq 1 ]; then
            SHACL_FILE="${TTL_FILES[0]}"
            echo "Auto-discovered SHACL file: $SHACL_FILE"
        else
            echo "Multiple .ttl files found in $VALIDATION_DIR:"
            for i in "${!TTL_FILES[@]}"; do
                echo "  $((i+1))) $(basename "${TTL_FILES[$i]}")"
            done
            echo ""
            read -p "Select file (1-${#TTL_FILES[@]}): " selection
            if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le ${#TTL_FILES[@]} ]; then
                SHACL_FILE="${TTL_FILES[$((selection-1))]}"
            else
                echo "Invalid selection."
                exit 1
            fi
        fi
    else
        echo "No validation/ directory found at $VALIDATION_DIR"
        echo "Create it and add your SHACL shapes .ttl file, or pass SHACL_FILE=<path>"
        exit 1
    fi
fi

if [ ! -f "$SHACL_FILE" ]; then
    echo "SHACL file not found: $SHACL_FILE"
    exit 1
fi

echo ""
echo "SHACL file: $SHACL_FILE"
echo ""

log_info "Starting: SHACL Validation with n10s"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "SHACL file: $SHACL_FILE"
log_info "Generated code: $GENERATED_DIR"

GRAPH_DATA_FILE="$OUTPUT_DIR/graph-data.json"
if [ ! -f "$GRAPH_DATA_FILE" ]; then
    log_error "Required graph artifact missing: $GRAPH_DATA_FILE"
    echo "SHACL validation blocked: $GRAPH_DATA_FILE does not exist."
    EXIT_CODE=1
    if [ "$_SELF_INIT_LOGGING" = true ]; then
        finalize_logging $EXIT_CODE
    fi
    exit $EXIT_CODE
fi

run_provider "Validate the Neo4j graph using SHACL shapes via neosemantics (n10s).

1. Read the SHACL shapes file at '$SHACL_FILE'. This is a Turtle (.ttl) file containing SHACL NodeShapes.

2. Runtime strategy:
   - Do NOT call live MCP tools while generating this code.
   - The generated TypeScript should try live SHACL validation against Neo4j at runtime using 'neo4j-driver' and the NEO4J_* environment variables.
   - The preferred live path is to execute the n10s SHACL validation procedure in Neo4j.
   - If live Neo4j access or n10s is unavailable, fall back to a snapshot-based validation of '$OUTPUT_DIR/graph-data.json' against the SHACL file.
   - The report MUST explicitly state which route was used: 'live-neo4j-n10s' or 'snapshot-fallback'.
   - If snapshot fallback is used, say clearly that this did not validate the active database contents.

3. For the live Neo4j path, use the n10s SHACL validation procedure. The Cypher call is:

   CALL n10s.validation.shacl.import.inline('<TTL_CONTENTS>', 'Turtle')

   Where <TTL_CONTENTS> is the full contents of the .ttl file (properly escaped for Cypher string literals — escape single quotes, backslashes, etc.).

4. The procedure returns validation results. Capture and analyze the output.

5. Format the results into a clear report:
   - validationMode: 'live-neo4j-n10s' | 'snapshot-fallback'
   - Total shapes validated
   - Violations grouped by severity (sh:Violation, sh:Warning, sh:Info)
   - For each violation: the shape, focus node, path, message, and severity
   - Summary counts

6. Save outputs:
   - '$OUTPUT_DIR/shacl-validation-report.json' (structured results)
   - Print a human-readable summary to console

7. Console output should include:
   - Number of nodes validated per shape
   - Violations count by severity
   - Top violations with examples
   - Overall pass/fail status

IMPORTANT:
- The TTL contents must be properly escaped when embedded in the Cypher string.
- Single quotes in the TTL must be escaped as \\' for the Cypher call.
- If n10s is not installed or the call fails, report the error clearly with setup instructions.
- Do NOT modify the graph — this is a read-only validation step.
Write the code only. Do NOT execute it inside Codex. The shell wrapper will execute the generated SHACL validator after code generation."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    VALIDATOR_SCRIPT="$GENERATED_DIR/validate-shacl.ts"
    TS_NODE_BIN="$SCRIPT_DIR/../node_modules/.bin/ts-node"
    REPORT_FILE="$OUTPUT_DIR/shacl-validation-report.json"
    VALIDATION_MODE=""

    if [ ! -f "$VALIDATOR_SCRIPT" ]; then
        log_error "Generated SHACL validator not found: $VALIDATOR_SCRIPT"
        EXIT_CODE=1
    elif [ ! -x "$TS_NODE_BIN" ]; then
        log_error "ts-node executable not found: $TS_NODE_BIN"
        EXIT_CODE=1
    else
        echo ""
        echo "Running generated SHACL validator with ts-node..."
        "$TS_NODE_BIN" "$VALIDATOR_SCRIPT"
        EXIT_CODE=$?
    fi

    if [ -f "$REPORT_FILE" ]; then
        VALIDATION_MODE=$(node -e "const fs=require('fs'); const p=process.argv[1]; const data=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String(data.validationMode || data?.metadata?.validationMode || ''));" "$REPORT_FILE" 2>/dev/null)
        log_file_operation "write" "$REPORT_FILE" "SHACL validation report"
    fi
    [ -f "$VALIDATOR_SCRIPT" ] && log_file_operation "write" "$VALIDATOR_SCRIPT" "generated code"

    if [ $EXIT_CODE -eq 0 ]; then
        log_success "SHACL Validation completed"
        echo ""
        echo "SHACL validation complete!"
        echo "Mode: ${VALIDATION_MODE:-unknown}"
        echo "Review: $OUTPUT_DIR/shacl-validation-report.json"
        echo ""
    else
        log_error "Generated SHACL validator execution failed (exit code: $EXIT_CODE)"
    fi
else
    log_error "SHACL Validation failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE
