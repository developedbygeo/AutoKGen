#!/bin/bash
#  Profile the dataset

echo "========================================"
echo " Profiling Dataset"
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
    init_logging "profile-data" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Profile Dataset"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

run_provider "Analyze the merged dataset at '$DATA_DIR/input/dataset-merged.csv'. Write TypeScript code that:

1. Reads the merged dataset (CSV format — the merge step already converted all input formats to CSV)

2. Check if '$OUTPUT_DIR/supplementary-files-index.json' exists. If it does, load it.
   Supplementary files provide reference/lookup data (e.g., code definitions, category labels,
   geographic reference tables). Use them to enrich the profile:
   - If a supplementary file contains definitions for codes that appear in dataset columns
     (e.g., feature codes, country codes, admin codes), note this in the profile as
     'relatedSupplementaryFile' for those columns.
   - If supplementary data helps clarify what a column contains, include that context.

3. Profiles the dataset by analyzing:
   - Total rows and columns
   - Data types for each column (infer from values)
   - Missing value counts per column
   - Unique value counts per column
   - Sample values (first 5 unique values per column)
   - Basic statistics for numeric columns (min, max, mean)
   - For columns that look like codes/identifiers: check if any supplementary file
     provides a lookup table for those codes. If so, note the supplementary file name.

4. Save the profile as JSON to '$OUTPUT_DIR/dataset-profile.json'
5. Print a human-readable summary to console
6. Save the code you write to '$GENERATED_DIR/profile-data.ts'

Use functional programming style with pure functions. Do not use classes.

Execute the code after writing it."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_file_operation "write" "$OUTPUT_DIR/dataset-profile.json" "dataset profile"
    log_file_operation "write" "$GENERATED_DIR/profile-data.ts" "generated code"
    log_success "Profile Dataset completed"
    echo ""
    echo "Profile complete! Check $OUTPUT_DIR/dataset-profile.json"
    echo ""
else
    log_error "Profile Dataset failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE