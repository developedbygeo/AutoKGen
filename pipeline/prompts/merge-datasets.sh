#!/bin/bash
# Merge multiple input files (CSV, XML, JSON, TSV, TXT)

echo "========================================"
echo "Merging Multiple Datasets"
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
    init_logging "merge-datasets" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Merge Datasets"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

run_provider "Merge input data files into a unified CSV. Write TypeScript code that:

1. Scan '$DATA_DIR/input/' folder for all data files. Supported formats:
   - CSV (.csv)
   - TSV (.tsv, .tab)
   - TXT (.txt) — tab-delimited or other delimiter; may be headerless (see below)
   - JSON (.json, .jsonl)
   - XML (.xml) — look for a DTD (.dtd) file in the same directory for schema info

   IMPORTANT: Skip files that are clearly not data files (e.g., .dtd, .md, .log).
   IMPORTANT: Skip 'dataset-merged.csv' if it already exists (that is our output file).

2. Detect the format of each file by extension and inspect the first few KB of content.

3. For each format, use the appropriate parsing strategy:

   **CSV/TSV**: Load using papaparse with appropriate delimiter.

   **TXT (delimited text)**: These are often tab-delimited files without a header row
   (e.g., GeoNames data exports). Handle as follows:
   - Read the first few lines and auto-detect the delimiter (tab, pipe, semicolon, comma)
   - Check if the first line looks like a header (non-numeric, descriptive names) vs data
   - If HEADERLESS: check if a supplementary file exists at '$DATA_DIR/supplementary-files/'
     that describes the schema. Otherwise, assign positional column names (col_1, col_2, ...)
   - If multiple .txt files share the same column count and delimiter, they likely share a schema
   - Use streaming (readline) for large .txt files
   - Filter out comment lines (lines starting with '#')

   **JSON**: Load with fs. If array-of-objects, use directly. If nested, flatten to tabular.
   If JSONL (one JSON object per line), stream line-by-line.

   **XML**: Use SAX-based streaming parser (sax npm package) for memory efficiency —
   XML files can be very large (multiple GB). Do NOT load the entire file into memory.
   - Detect the repeating record element (the most frequently occurring child of root)
   - Extract attributes and child text elements as columns
   - If a DTD file exists alongside, read it to understand the schema structure
   - Stream records and convert each to a flat row
   - Process in chunks: accumulate N records (e.g., 10,000), write to intermediate CSV,
     then continue. Concatenate intermediate CSVs at the end if needed.

4. SUPPLEMENTARY FILES — check if '$DATA_DIR/supplementary-files/' directory exists.
   If it does, scan it for reference/lookup files (.txt, .csv, .json, .tsv).
   Do NOT merge supplementary files into the main dataset — they are reference data.
   Instead, create an index of discovered supplementary files:
   {
     path: string,
     name: string,
     format: string,
     sizeBytes: number,
     description: string (inferred from filename and first few lines),
     columns: string[] (if tabular),
     rowCount: number (if tabular)
   }
   Save this index as '$OUTPUT_DIR/supplementary-files-index.json'.
   Log which supplementary files were found.

5. Once all INPUT files are parsed into tabular form, apply the appropriate merge strategy:

   Strategy A - UNION (same schema, stack rows):
   - If all files have identical or nearly identical columns
   - Concatenate all rows
   - Add a 'source_file' column to track origin

   Strategy B - JOIN (related tables):
   - If files have a common key column (e.g., 'id', 'artist_id')
   - Perform LEFT JOIN or INNER JOIN
   - Detect foreign key relationships by column name patterns

   Strategy C - MERGE (different schemas, combine columns):
   - If files represent different aspects of same entities
   - Merge all columns side-by-side
   - Use a primary key if available, otherwise use row index

   Strategy D - SINGLE FILE CONVERSION:
   - If only one data file exists (e.g., a single large XML)
   - Convert it to CSV format directly
   - No merging needed, just format conversion

6. Handle conflicts:
   - If same column exists in multiple files with different values
   - Use naming strategy: column_name_from_file1, column_name_from_file2
   - OR take first non-null value with precedence order

7. MEMORY MANAGEMENT — critical for large files:
   - For files > 100MB, ALWAYS use streaming (SAX for XML, readline for TXT/CSV)
   - Never call fs.readFileSync on large files
   - Process in chunks and write intermediate results to disk
   - Use fs.statSync to check file sizes before deciding on strategy
   - Set a reasonable row limit per chunk (e.g., 50,000 rows)

8. Generate a merge report:
   {
     strategy: 'union' | 'join' | 'merge' | 'single-conversion',
     inputFiles: [{ name, format, sizeBytes, rows, columns, hasHeader: boolean }],
     outputRows: number,
     outputColumns: number,
     conflicts: [{ column, resolution }],
     joinKeys: string[] (if applicable),
     streamingUsed: boolean,
     chunkSize: number (if applicable),
     supplementaryFiles: [{ name, format, description }] (if any found)
   }

9. Save merged CSV to '$DATA_DIR/input/dataset-merged.csv'
10. Save report to '$OUTPUT_DIR/merge-report.json'
11. Save supplementary index to '$OUTPUT_DIR/supplementary-files-index.json' (if supplementary files exist)
12. Print summary to console
13. Save code to '$GENERATED_DIR/merge-datasets.ts'

IMPORTANT: The sax package is already installed (check package.json). Use it for XML parsing.
IMPORTANT: For very large XML files (>1GB), you MUST use streaming. Do NOT attempt to load them into memory.
IMPORTANT: .txt files are DATA files — do NOT skip them. They are commonly used for geographic, scientific, and tabular exports.

Be smart about detecting the right strategy. Look at:
- File formats present in the input directory
- Column name overlaps across parsed files
- Column name patterns (id, _id, foreign keys)
- Data cardinality
- File sizes (to decide streaming vs in-memory)

Execute after writing."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_file_operation "write" "$DATA_DIR/input/dataset-merged.csv" "merged dataset"
    log_file_operation "write" "$OUTPUT_DIR/merge-report.json" "merge report"
    log_file_operation "write" "$GENERATED_DIR/merge-datasets.ts" "generated code"
    log_success "Merge Datasets completed"
    echo ""
    echo "Datasets merged! Check $DATA_DIR/input/dataset-merged.csv"
    echo ""
else
    log_error "Merge Datasets failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE