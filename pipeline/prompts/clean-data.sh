#!/bin/bash
#  Clean the dataset based on ontology constraints

echo "========================================"
echo " Cleaning Dataset"
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
    init_logging "clean-data" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Clean Data"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

run_provider "Clean the dataset based on ontology constraints. Write TypeScript code that:

1. Load '$DATA_DIR/input/dataset-merged.csv' (CSV format — the merge step already converted all input formats to CSV)
2. Load '$OUTPUT_DIR/ontology-structure.json'
3. Load '$OUTPUT_DIR/mapping-strategy.json'
4. Optionally load '$OUTPUT_DIR/supplementary-files-index.json' and the actual
   supplementary files from '$DATA_DIR/supplementary-files/' if they exist.
   Use supplementary lookup tables to:
   - Validate coded values (e.g., country codes, feature codes, category codes)
     against the reference data — flag invalid codes rather than removing rows
   - Resolve abbreviations or codes to full values where the mapping strategy
     indicates a column maps to a label/name property but contains codes

5. Apply cleaning operations in this order:
   a) Remove exact duplicate rows
   b) Trim whitespace from all string values
   c) Normalize null values (empty strings, 'null', 'N/A', etc. → null)
   d) Type coercion based on ontology data property ranges:
      - xsd:integer → parse to number, remove non-integers
      - xsd:decimal → parse to float
      - xsd:boolean → convert 'true'/'false'/'1'/'0'/'yes'/'no'
      - xsd:date → parse to ISO date format
   e) Validate constraints from ontology (domain/range)
   f) Remove rows that violate critical constraints

6. Process in chunks if dataset > 10,000 rows (use 5,000 row chunks)

7. Generate a cleaning report:
   {
     originalRows, cleanedRows, rowsRemoved,
     issues: [{ type, count, severity }],
     typeCoercions: [{ column, successCount, failCount }]
   }

8. Save cleaned data to '$OUTPUT_DIR/dataset-cleaned.csv'
9. Save report to '$OUTPUT_DIR/cleaning-report.json'
10. Print summary to console
11. Save code to '$GENERATED_DIR/clean-data.ts'

Use functional programming with pure functions and immutable transformations.
Execute after writing."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_file_operation "write" "$OUTPUT_DIR/dataset-cleaned.csv" "cleaned dataset"
    log_file_operation "write" "$OUTPUT_DIR/cleaning-report.json" "cleaning report"
    log_file_operation "write" "$GENERATED_DIR/clean-data.ts" "generated code"
    log_success "Clean Data completed"
    echo ""
    echo "Data cleaned! Check $OUTPUT_DIR/dataset-cleaned.csv"
    echo ""
else
    log_error "Clean Data failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE