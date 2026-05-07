import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ── Types ──────────────────────────────────────────────────────────────────

interface FileInputInfo {
  name: string;
  format: string;
  sizeBytes: number;
  rows: number;
  columns: string[];
  hasHeader: boolean;
}

interface Conflict {
  column: string;
  resolution: string;
}

interface SupplementaryFileInfo {
  path: string;
  name: string;
  format: string;
  sizeBytes: number;
  description: string;
  columns: string[];
  rowCount: number;
}

interface MergeReport {
  strategy: "union" | "join" | "merge" | "single-conversion";
  inputFiles: FileInputInfo[];
  outputRows: number;
  outputColumns: number;
  conflicts: Conflict[];
  joinKeys: string[];
  streamingUsed: boolean;
  chunkSize: number;
  supplementaryFiles: { name: string; format: string; description: string }[];
}

// ── Configuration ──────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || "domain-data/geospatial";
const INPUT_DIR = path.resolve(DATA_DIR, "input");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output");
const SUPP_DIR = path.resolve(DATA_DIR, "supplementary-files");
const MERGED_OUTPUT = path.resolve(INPUT_DIR, "dataset-merged.csv");
const REPORT_OUTPUT = path.resolve(OUTPUT_DIR, "merge-report.json");
const SUPP_INDEX_OUTPUT = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const CHUNK_SIZE = 50_000;

// GeoNames column definitions (19 columns, no header row)
// See: https://download.geonames.org/export/dump/readme.txt
const GEONAMES_COLUMNS = [
  "geonameid",
  "name",
  "asciiname",
  "alternatenames",
  "latitude",
  "longitude",
  "feature_class",
  "feature_code",
  "country_code",
  "cc2",
  "admin1_code",
  "admin2_code",
  "admin3_code",
  "admin4_code",
  "population",
  "elevation",
  "dem",
  "timezone",
  "modification_date",
];

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeCsvField(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Delimiter detection ────────────────────────────────────────────────────

function detectDelimiter(lines: string[]): string {
  const candidates = ["\t", "|", ";", ","];
  const scores = candidates.map((delim) => {
    const counts = lines.map((line) => line.split(delim).length);
    // Good delimiter: consistent field count across lines, > 1 field
    const consistent = counts.every((c) => c === counts[0]);
    const fieldCount = counts[0] || 1;
    return { delim, consistent, fieldCount };
  });

  // Prefer delimiters that produce consistent columns and more than 1 field
  const valid = scores.filter((s) => s.consistent && s.fieldCount > 1);
  if (valid.length > 0) {
    // Prefer tab > pipe > semicolon > comma for .txt files
    return valid[0].delim;
  }
  return "\t"; // default to tab
}

function looksLikeHeader(line: string, delimiter: string): boolean {
  const fields = line.split(delimiter);
  // If first field is numeric (like a GeoNames ID), it's data, not a header
  if (fields.length > 0 && /^\d+$/.test(fields[0].trim())) {
    return false;
  }
  // If most fields are non-numeric short strings, likely a header
  const nonNumeric = fields.filter((f) => !/^\d+(\.\d+)?$/.test(f.trim()));
  return nonNumeric.length > fields.length * 0.7;
}

// ── File detection ─────────────────────────────────────────────────────────

interface DetectedFile {
  name: string;
  format: string;
  sizeBytes: number;
  fullPath: string;
}

function detectInputFiles(inputDir: string): DetectedFile[] {
  const supportedExtensions: Record<string, string> = {
    ".csv": "csv",
    ".tsv": "tsv",
    ".tab": "tsv",
    ".txt": "txt",
    ".json": "json",
    ".jsonl": "jsonl",
    ".xml": "xml",
  };

  const excludeFiles = new Set(["dataset-merged.csv"]);
  const metadataExtensions = new Set([".dtd", ".xsd", ".md", ".log"]);

  return fs
    .readdirSync(inputDir)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      if (excludeFiles.has(f)) return false;
      if (metadataExtensions.has(ext)) return false;
      return ext in supportedExtensions;
    })
    .map((f) => {
      const ext = path.extname(f).toLowerCase();
      const fullPath = path.resolve(inputDir, f);
      const stats = fs.statSync(fullPath);
      return {
        name: f,
        format: supportedExtensions[ext],
        sizeBytes: stats.size,
        fullPath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Streaming TXT processor ───────────────────────────────────────────────

async function analyzeTxtFile(
  filePath: string
): Promise<{
  delimiter: string;
  hasHeader: boolean;
  columnCount: number;
  sampleLines: string[];
}> {
  const sampleLines: string[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (line.startsWith("#")) continue; // skip comments
    if (line.trim() === "") continue;
    sampleLines.push(line);
    count++;
    if (count >= 10) break;
  }

  const delimiter = detectDelimiter(sampleLines);
  const hasHeader = sampleLines.length > 0 && looksLikeHeader(sampleLines[0], delimiter);
  const columnCount =
    sampleLines.length > 0 ? sampleLines[0].split(delimiter).length : 0;

  return { delimiter, hasHeader, columnCount, sampleLines };
}

async function streamTxtToMergedCsv(
  files: DetectedFile[],
  columns: string[],
  delimiter: string,
  hasHeader: boolean,
  writeStream: fs.WriteStream
): Promise<{ fileInfos: FileInputInfo[]; totalRows: number }> {
  const fileInfos: FileInputInfo[] = [];
  let totalRows = 0;

  for (const file of files) {
    let fileRows = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(file.fullPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let isFirstLine = true;
    for await (const line of rl) {
      if (line.startsWith("#")) continue;
      if (line.trim() === "") continue;

      if (isFirstLine && hasHeader) {
        isFirstLine = false;
        continue; // skip header line
      }
      isFirstLine = false;

      const fields = line.split(delimiter);
      // Build CSV row: map each field to its column, add source_file
      const csvFields: string[] = [];
      for (let i = 0; i < columns.length - 1; i++) {
        // -1 because last col is source_file
        csvFields.push(escapeCsvField(fields[i] ?? ""));
      }
      csvFields.push(escapeCsvField(file.name));

      writeStream.write(csvFields.join(",") + "\n");
      fileRows++;
      totalRows++;

      if (totalRows % CHUNK_SIZE === 0) {
        process.stdout.write(
          `\r  Processing: ${formatNumber(totalRows)} rows (${file.name})`
        );
      }
    }

    console.log(`  ${file.name}: ${formatNumber(fileRows)} rows`);
    fileInfos.push({
      name: file.name,
      format: file.format,
      sizeBytes: file.sizeBytes,
      rows: fileRows,
      columns: columns.slice(0, -1), // exclude source_file from per-file columns
      hasHeader,
    });
  }

  return { fileInfos, totalRows };
}

// ── Supplementary files indexing ───────────────────────────────────────────

async function indexSupplementaryFiles(): Promise<SupplementaryFileInfo[]> {
  if (!fs.existsSync(SUPP_DIR)) {
    return [];
  }

  const suppExtensions = new Set([".txt", ".csv", ".json", ".tsv"]);
  const files = fs
    .readdirSync(SUPP_DIR)
    .filter((f) => suppExtensions.has(path.extname(f).toLowerCase()))
    .sort();

  const index: SupplementaryFileInfo[] = [];

  for (const fileName of files) {
    const fullPath = path.resolve(SUPP_DIR, fileName);
    const stats = fs.statSync(fullPath);
    const ext = path.extname(fileName).toLowerCase();
    const format =
      ext === ".csv"
        ? "csv"
        : ext === ".tsv"
          ? "tsv"
          : ext === ".json"
            ? "json"
            : "txt";

    // Read first lines to infer description and columns
    const sampleLines: string[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(fullPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let totalLines = 0;
    let dataLines = 0;
    for await (const line of rl) {
      totalLines++;
      if (line.startsWith("#")) {
        if (sampleLines.length < 3) sampleLines.push(line);
        continue;
      }
      if (line.trim() === "") continue;
      dataLines++;
      if (sampleLines.length < 5) sampleLines.push(line);
    }

    // Detect columns from first data line
    let columns: string[] = [];
    const firstDataLine = sampleLines.find((l) => !l.startsWith("#"));
    if (firstDataLine) {
      const delimiter = detectDelimiter(
        sampleLines.filter((l) => !l.startsWith("#"))
      );
      const fieldCount = firstDataLine.split(delimiter).length;

      // Infer column names based on the file
      if (fileName === "featureCodes_en.txt") {
        columns = ["feature_code", "short_description", "full_description"];
      } else if (fileName === "admin1CodesASCII.txt") {
        columns = ["code", "name", "ascii_name", "geonameid"];
      } else if (fileName === "countryInfo.txt") {
        // Header is embedded as a comment line starting with #ISO
        // Re-read file to find it (it's in the comment block we filtered above)
        const rl2 = readline.createInterface({
          input: fs.createReadStream(fullPath, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        });
        let headerLine: string | undefined;
        for await (const line of rl2) {
          if (line.startsWith("#ISO")) {
            headerLine = line;
            break;
          }
        }
        if (headerLine) {
          columns = headerLine
            .replace(/^#/, "")
            .split("\t")
            .map((c) => c.trim())
            .filter(Boolean);
        } else {
          columns = Array.from(
            { length: fieldCount },
            (_, i) => `col_${i + 1}`
          );
        }
      } else {
        columns = Array.from(
          { length: fieldCount },
          (_, i) => `col_${i + 1}`
        );
      }
    }

    // Generate description from filename
    const baseName = path.basename(fileName, ext);
    const descriptions: Record<string, string> = {
      featureCodes_en:
        "GeoNames feature code definitions with short and full descriptions",
      admin1CodesASCII:
        "First-order administrative division codes (states/provinces) with names and GeoName IDs",
      countryInfo:
        "Country metadata including ISO codes, capitals, population, currencies, languages, and neighbors",
    };
    const description =
      descriptions[baseName] ||
      `Reference data file: ${baseName.replace(/[_-]/g, " ")}`;

    index.push({
      path: fullPath,
      name: fileName,
      format,
      sizeBytes: stats.size,
      description,
      columns,
      rowCount: dataLines,
    });
  }

  return index;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== Data Merge Tool (Geospatial — Streaming) ===\n");

  // 1. Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 2. Scan input directory
  const inputFiles = detectInputFiles(INPUT_DIR);

  if (inputFiles.length === 0) {
    console.error("No supported data files found in", INPUT_DIR);
    process.exit(1);
  }

  console.log(`Found ${inputFiles.length} data file(s):`);
  for (const f of inputFiles) {
    console.log(`  - ${f.name} (${f.format}, ${formatBytes(f.sizeBytes)})`);
  }
  console.log();

  // 3. Index supplementary files
  console.log("--- Supplementary Files ---");
  const suppIndex = await indexSupplementaryFiles();
  if (suppIndex.length > 0) {
    for (const s of suppIndex) {
      console.log(`  - ${s.name} (${s.format}, ${formatBytes(s.sizeBytes)})`);
      console.log(`    ${s.description}`);
      console.log(
        `    ${s.columns.length} columns, ${formatNumber(s.rowCount)} data rows`
      );
    }
    fs.writeFileSync(SUPP_INDEX_OUTPUT, JSON.stringify(suppIndex, null, 2), "utf-8");
    console.log(`\n  Index saved to: ${SUPP_INDEX_OUTPUT}`);
  } else {
    console.log("  No supplementary files found.");
  }
  console.log();

  // 4. Analyze file formats
  const txtFiles = inputFiles.filter((f) => f.format === "txt");
  const csvFiles = inputFiles.filter((f) => f.format === "csv");
  const xmlFiles = inputFiles.filter((f) => f.format === "xml");
  const jsonFiles = inputFiles.filter(
    (f) => f.format === "json" || f.format === "jsonl"
  );
  const tsvFiles = inputFiles.filter((f) => f.format === "tsv");

  // 5. Determine strategy based on files present
  console.log("--- Format Analysis ---");

  if (txtFiles.length > 0) {
    // Analyze first TXT file to understand the format
    const analysis = await analyzeTxtFile(txtFiles[0].fullPath);
    console.log(
      `  TXT files: ${txtFiles.length} files, delimiter=${JSON.stringify(analysis.delimiter)}, ` +
        `columns=${analysis.columnCount}, header=${analysis.hasHeader}`
    );

    // Check if all TXT files share the same schema
    let allSameSchema = true;
    for (const f of txtFiles.slice(1)) {
      const a = await analyzeTxtFile(f.fullPath);
      if (a.columnCount !== analysis.columnCount || a.delimiter !== analysis.delimiter) {
        allSameSchema = false;
        break;
      }
    }
    console.log(
      `  Schema consistency: ${allSameSchema ? "ALL files share same schema" : "MIXED schemas"}`
    );

    if (analysis.columnCount === GEONAMES_COLUMNS.length) {
      console.log(`  Detected GeoNames format (${GEONAMES_COLUMNS.length} columns)`);
    }
  }

  if (csvFiles.length > 0) {
    console.log(`  CSV files: ${csvFiles.length}`);
  }
  if (xmlFiles.length > 0) {
    console.log(`  XML files: ${xmlFiles.length}`);
  }
  if (jsonFiles.length > 0) {
    console.log(`  JSON files: ${jsonFiles.length}`);
  }
  if (tsvFiles.length > 0) {
    console.log(`  TSV files: ${tsvFiles.length}`);
  }
  console.log();

  // 6. Determine merge strategy
  // All TXT files with same schema → UNION
  // Single file → SINGLE-CONVERSION
  // Mixed formats → analyze column overlap
  let strategy: MergeReport["strategy"];
  if (inputFiles.length === 1) {
    strategy = "single-conversion";
  } else if (
    txtFiles.length === inputFiles.length ||
    csvFiles.length === inputFiles.length ||
    tsvFiles.length === inputFiles.length
  ) {
    strategy = "union";
  } else {
    strategy = "merge";
  }

  console.log(`Strategy: ${strategy.toUpperCase()}`);
  console.log();

  // 7. Execute merge
  const startTime = Date.now();
  let fileInfos: FileInputInfo[] = [];
  let totalRows = 0;
  let outputColumns: string[] = [];
  const conflicts: Conflict[] = [];

  if (txtFiles.length > 0 && txtFiles.length === inputFiles.length) {
    // All TXT files — UNION with streaming
    const analysis = await analyzeTxtFile(txtFiles[0].fullPath);

    // Determine column names
    let columns: string[];
    if (analysis.columnCount === GEONAMES_COLUMNS.length) {
      columns = [...GEONAMES_COLUMNS];
    } else if (analysis.hasHeader) {
      columns = analysis.sampleLines[0]
        .split(analysis.delimiter)
        .map((c) => c.trim());
    } else {
      columns = Array.from(
        { length: analysis.columnCount },
        (_, i) => `col_${i + 1}`
      );
    }

    // Add source_file tracking column
    columns.push("source_file");
    outputColumns = columns;

    console.log(`Output columns (${columns.length}):`);
    console.log(`  ${columns.join(", ")}`);
    console.log();

    // Write header and stream all files
    const writeStream = fs.createWriteStream(MERGED_OUTPUT, {
      encoding: "utf-8",
    });
    writeStream.write(columns.map(escapeCsvField).join(",") + "\n");

    console.log("--- Processing files ---");
    const result = await streamTxtToMergedCsv(
      txtFiles,
      columns,
      analysis.delimiter,
      analysis.hasHeader,
      writeStream
    );

    // Wait for write stream to finish
    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on("error", reject);
    });

    fileInfos = result.fileInfos;
    totalRows = result.totalRows;
    process.stdout.write(
      `\r  Total: ${formatNumber(totalRows)} rows processed                    \n`
    );
  } else if (inputFiles.length === 1) {
    // Single file conversion
    const file = inputFiles[0];

    if (file.format === "txt") {
      const analysis = await analyzeTxtFile(file.fullPath);
      let columns: string[];
      if (analysis.columnCount === GEONAMES_COLUMNS.length) {
        columns = [...GEONAMES_COLUMNS];
      } else if (analysis.hasHeader) {
        columns = analysis.sampleLines[0]
          .split(analysis.delimiter)
          .map((c) => c.trim());
      } else {
        columns = Array.from(
          { length: analysis.columnCount },
          (_, i) => `col_${i + 1}`
        );
      }
      columns.push("source_file");
      outputColumns = columns;

      const writeStream = fs.createWriteStream(MERGED_OUTPUT, {
        encoding: "utf-8",
      });
      writeStream.write(columns.map(escapeCsvField).join(",") + "\n");

      const result = await streamTxtToMergedCsv(
        [file],
        columns,
        analysis.delimiter,
        analysis.hasHeader,
        writeStream
      );

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on("error", reject);
      });

      fileInfos = result.fileInfos;
      totalRows = result.totalRows;
    } else {
      console.error(`Unsupported single-file format: ${file.format}`);
      process.exit(1);
    }
  } else {
    console.error(
      "Mixed-format merge not implemented for this file set:",
      inputFiles.map((f) => `${f.name} (${f.format})`)
    );
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 8. Build report
  const report: MergeReport = {
    strategy,
    inputFiles: fileInfos.map((f) => ({
      name: f.name,
      format: f.format,
      sizeBytes: f.sizeBytes,
      rows: f.rows,
      columns: f.columns,
      hasHeader: f.hasHeader,
    })),
    outputRows: totalRows,
    outputColumns: outputColumns.length,
    conflicts,
    joinKeys: [],
    streamingUsed: true,
    chunkSize: CHUNK_SIZE,
    supplementaryFiles: suppIndex.map((s) => ({
      name: s.name,
      format: s.format,
      description: s.description,
    })),
  };

  // 9. Save report
  fs.writeFileSync(REPORT_OUTPUT, JSON.stringify(report, null, 2), "utf-8");

  // 10. Verify output
  const outputStats = fs.statSync(MERGED_OUTPUT);

  // 11. Print summary
  console.log(`\n--- Merge Summary ---`);
  console.log(`  Strategy:        ${strategy.toUpperCase()}`);
  console.log(`  Input files:     ${fileInfos.length}`);
  console.log(
    `  Input size:      ${formatBytes(fileInfos.reduce((s, f) => s + f.sizeBytes, 0))}`
  );
  console.log(`  Output rows:     ${formatNumber(totalRows)}`);
  console.log(`  Output columns:  ${outputColumns.length}`);
  console.log(`  Output size:     ${formatBytes(outputStats.size)}`);
  console.log(`  Streaming used:  Yes`);
  console.log(`  Time elapsed:    ${elapsed}s`);
  if (totalRows > 0) {
    console.log(
      `  Throughput:      ${formatNumber(Math.round(totalRows / parseFloat(elapsed)))} rows/sec`
    );
  }
  console.log(`  Conflicts:       ${conflicts.length > 0 ? conflicts.length : "None"}`);
  if (suppIndex.length > 0) {
    console.log(`  Supplementary:   ${suppIndex.length} reference file(s) indexed`);
  }
  console.log(`  Merged CSV:      ${MERGED_OUTPUT}`);
  console.log(`  Report:          ${REPORT_OUTPUT}`);
  if (suppIndex.length > 0) {
    console.log(`  Supp. index:     ${SUPP_INDEX_OUTPUT}`);
  }
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
