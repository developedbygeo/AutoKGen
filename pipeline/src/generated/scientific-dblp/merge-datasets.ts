import * as fs from "fs";
import * as path from "path";
import * as sax from "sax";

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

const DATA_DIR = process.env.DATA_DIR || "domain-data/scientific-dblp";
const INPUT_DIR = path.resolve(DATA_DIR, "input");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output");
const SUPP_DIR = path.resolve(DATA_DIR, "supplementary-files");
const MERGED_OUTPUT = path.resolve(INPUT_DIR, "dataset-merged.csv");
const REPORT_OUTPUT = path.resolve(OUTPUT_DIR, "merge-report.json");
const SUPP_INDEX_OUTPUT = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const CHUNK_SIZE = 50_000;

// DBLP record types (direct children of <dblp> root)
const RECORD_TYPES = new Set([
  "article",
  "inproceedings",
  "proceedings",
  "book",
  "incollection",
  "phdthesis",
  "mastersthesis",
  "www",
  "person",
  "data",
]);

// Output CSV columns (must match the established schema)
const OUTPUT_COLUMNS = [
  "record_type",
  "key",
  "mdate",
  "publtype",
  "title",
  "authors",
  "editors",
  "year",
  "journal",
  "booktitle",
  "pages",
  "volume",
  "number",
  "month",
  "publisher",
  "school",
  "series",
  "chapter",
  "isbn",
  "ee",
  "url",
  "crossref",
  "cite",
  "note",
  "cdrom",
  "publnr",
  "address",
  "stream",
  "rel",
];

// Fields that can appear multiple times per record — pipe-delimited in output
const MULTI_VALUE_FIELDS = new Set([
  "author",
  "editor",
  "ee",
  "cite",
  "url",
  "isbn",
  "note",
  "crossref",
  "rel",
  "stream",
]);

// Map XML child element names → CSV column names
// "author" → accumulated into "authors", "editor" → "editors"
const FIELD_TO_COLUMN: Record<string, string> = {
  author: "authors",
  editor: "editors",
  title: "title",
  booktitle: "booktitle",
  pages: "pages",
  year: "year",
  address: "address",
  journal: "journal",
  volume: "volume",
  number: "number",
  month: "month",
  url: "url",
  ee: "ee",
  cdrom: "cdrom",
  cite: "cite",
  publisher: "publisher",
  note: "note",
  crossref: "crossref",
  isbn: "isbn",
  series: "series",
  school: "school",
  chapter: "chapter",
  publnr: "publnr",
  stream: "stream",
  rel: "rel",
};

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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
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

// ── SAX XML streaming processor ──────────────────────────────────────────

function streamXmlToCsv(
  xmlPath: string,
  outputPath: string,
  fileSize: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath, { encoding: "utf-8" });

    // Write CSV header
    writeStream.write(OUTPUT_COLUMNS.map(escapeCsvField).join(",") + "\n");

    const parser = sax.createStream(false, {
      trim: false,
      normalize: false,
      lowercase: true,
      position: true,
    });

    let totalRecords = 0;
    let depth = 0;
    let currentRecordType: string | null = null;
    let currentRecord: Record<string, string[]> = {};
    let currentRecordAttrs: Record<string, string> = {};
    let currentElement: string | null = null;
    let textBuffer = "";
    let insideRecord = false;

    // Track record type counts for summary
    const recordTypeCounts: Record<string, number> = {};

    parser.on("opentag", (node: sax.Tag) => {
      depth++;
      const tagName = node.name.toLowerCase();

      if (depth === 2 && RECORD_TYPES.has(tagName)) {
        // Start of a new record
        insideRecord = true;
        currentRecordType = tagName;
        currentRecord = {};
        currentRecordAttrs = {};
        // Extract attributes (key, mdate, publtype, cdate, etc.)
        for (const [attr, val] of Object.entries(node.attributes)) {
          currentRecordAttrs[attr.toLowerCase()] = val as string;
        }
      } else if (depth === 3 && insideRecord) {
        // Child element of a record (author, title, year, etc.)
        currentElement = tagName;
        textBuffer = "";
      } else if (depth > 3 && insideRecord) {
        // Nested element inside a field (e.g. <sub>, <sup>, <i>, <tt>, <ref> inside <title>)
        // We just want the text content, so we continue accumulating
      }
    });

    parser.on("text", (text: string) => {
      if (insideRecord && currentElement !== null) {
        textBuffer += text;
      }
    });

    parser.on("closetag", (tagName: string) => {
      const tag = tagName.toLowerCase();

      if (depth === 3 && insideRecord && currentElement !== null) {
        // Closing a field element — store the accumulated text
        const column = FIELD_TO_COLUMN[currentElement];
        if (column) {
          const value = textBuffer.trim();
          if (value) {
            if (!currentRecord[column]) {
              currentRecord[column] = [];
            }
            currentRecord[column].push(value);
          }
        }
        currentElement = null;
        textBuffer = "";
      } else if (depth === 2 && insideRecord && RECORD_TYPES.has(tag)) {
        // End of record — emit CSV row
        const row: string[] = [];
        for (const col of OUTPUT_COLUMNS) {
          if (col === "record_type") {
            row.push(escapeCsvField(currentRecordType || ""));
          } else if (col === "key") {
            row.push(escapeCsvField(currentRecordAttrs["key"] || ""));
          } else if (col === "mdate") {
            row.push(escapeCsvField(currentRecordAttrs["mdate"] || ""));
          } else if (col === "publtype") {
            row.push(escapeCsvField(currentRecordAttrs["publtype"] || ""));
          } else {
            const values = currentRecord[col];
            if (values && values.length > 0) {
              row.push(escapeCsvField(values.join("|")));
            } else {
              row.push("");
            }
          }
        }

        writeStream.write(row.join(",") + "\n");
        totalRecords++;

        // Track counts
        const rt = currentRecordType || "unknown";
        recordTypeCounts[rt] = (recordTypeCounts[rt] || 0) + 1;

        // Progress reporting
        if (totalRecords % CHUNK_SIZE === 0) {
          const position = (parser as any)._parser?.position || 0;
          const pct = fileSize > 0 ? ((position / fileSize) * 100).toFixed(1) : "?";
          process.stdout.write(
            `\r  Processing: ${formatNumber(totalRecords)} records (~${pct}%)`
          );
        }

        // Reset
        insideRecord = false;
        currentRecordType = null;
        currentRecord = {};
        currentRecordAttrs = {};
      }

      depth--;
    });

    parser.on("error", (err: Error) => {
      // SAX errors on DBLP are common due to HTML entities — resume parsing
      (parser as any)._parser.error = null;
      (parser as any)._parser.resume();
    });

    parser.on("end", () => {
      writeStream.end(() => {
        process.stdout.write(
          `\r  Processing: ${formatNumber(totalRecords)} records (100%)     \n`
        );
        console.log("\n  Record type breakdown:");
        for (const [type, count] of Object.entries(recordTypeCounts).sort(
          (a, b) => b[1] - a[1]
        )) {
          console.log(`    ${type}: ${formatNumber(count)}`);
        }
        resolve(totalRecords);
      });
    });

    // Pipe the XML through SAX
    const readStream = fs.createReadStream(xmlPath, {
      encoding: "utf-8",
      highWaterMark: 64 * 1024, // 64KB chunks for efficient streaming
    });

    readStream.on("error", reject);
    readStream.pipe(parser);
  });
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
  const readline = require("readline");

  for (const fileName of files) {
    const fullPath = path.resolve(SUPP_DIR, fileName);
    const stats = fs.statSync(fullPath);
    const ext = path.extname(fileName).toLowerCase();
    const format =
      ext === ".csv" ? "csv" : ext === ".tsv" ? "tsv" : ext === ".json" ? "json" : "txt";

    const sampleLines: string[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(fullPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let dataLines = 0;
    for await (const line of rl) {
      if (line.startsWith("#")) {
        if (sampleLines.length < 3) sampleLines.push(line);
        continue;
      }
      if (line.trim() === "") continue;
      dataLines++;
      if (sampleLines.length < 5) sampleLines.push(line);
    }

    let columns: string[] = [];
    const firstDataLine = sampleLines.find((l: string) => !l.startsWith("#"));
    if (firstDataLine) {
      const delimiter = firstDataLine.includes("\t") ? "\t" : ",";
      const fieldCount = firstDataLine.split(delimiter).length;
      columns = Array.from({ length: fieldCount }, (_, i) => `col_${i + 1}`);
    }

    const baseName = path.basename(fileName, ext);
    const description = `Reference data file: ${baseName.replace(/[_-]/g, " ")}`;

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
  console.log("\n=== Data Merge Tool (Scientific-DBLP — SAX Streaming) ===\n");

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
      console.log(`    ${s.columns.length} columns, ${formatNumber(s.rowCount)} data rows`);
    }
    fs.writeFileSync(SUPP_INDEX_OUTPUT, JSON.stringify(suppIndex, null, 2), "utf-8");
    console.log(`\n  Index saved to: ${SUPP_INDEX_OUTPUT}`);
  } else {
    console.log("  No supplementary files found.");
  }
  console.log();

  // 4. Categorize files
  const xmlFiles = inputFiles.filter((f) => f.format === "xml");
  const csvFiles = inputFiles.filter((f) => f.format === "csv");
  const txtFiles = inputFiles.filter((f) => f.format === "txt");
  const jsonFiles = inputFiles.filter((f) => f.format === "json" || f.format === "jsonl");
  const tsvFiles = inputFiles.filter((f) => f.format === "tsv");

  console.log("--- Format Analysis ---");
  if (xmlFiles.length > 0) console.log(`  XML files: ${xmlFiles.length}`);
  if (csvFiles.length > 0) console.log(`  CSV files: ${csvFiles.length}`);
  if (txtFiles.length > 0) console.log(`  TXT files: ${txtFiles.length}`);
  if (jsonFiles.length > 0) console.log(`  JSON files: ${jsonFiles.length}`);
  if (tsvFiles.length > 0) console.log(`  TSV files: ${tsvFiles.length}`);

  // Check for DTD
  const dtdFiles = fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".dtd"));
  if (dtdFiles.length > 0) {
    console.log(`  DTD schema: ${dtdFiles.join(", ")}`);
  }
  console.log();

  // 5. Determine strategy
  let strategy: MergeReport["strategy"];
  if (inputFiles.length === 1) {
    strategy = "single-conversion";
  } else if (
    xmlFiles.length === inputFiles.length ||
    csvFiles.length === inputFiles.length ||
    txtFiles.length === inputFiles.length ||
    tsvFiles.length === inputFiles.length
  ) {
    strategy = "union";
  } else {
    strategy = "merge";
  }

  console.log(`Strategy: ${strategy.toUpperCase()}`);
  console.log();

  // 6. Execute merge
  const startTime = Date.now();
  let fileInfos: FileInputInfo[] = [];
  let totalRows = 0;
  const conflicts: Conflict[] = [];

  if (xmlFiles.length === 1 && inputFiles.length === 1) {
    // Single XML file — SAX streaming conversion
    const xmlFile = xmlFiles[0];
    console.log(`--- Streaming XML → CSV ---`);
    console.log(`  Input:  ${xmlFile.name} (${formatBytes(xmlFile.sizeBytes)})`);
    console.log(`  Output: ${path.basename(MERGED_OUTPUT)}`);
    console.log(`  Columns: ${OUTPUT_COLUMNS.length}`);
    console.log();

    totalRows = await streamXmlToCsv(xmlFile.fullPath, MERGED_OUTPUT, xmlFile.sizeBytes);

    fileInfos.push({
      name: xmlFile.name,
      format: "xml",
      sizeBytes: xmlFile.sizeBytes,
      rows: totalRows,
      columns: OUTPUT_COLUMNS,
      hasHeader: false,
    });
  } else if (xmlFiles.length > 0) {
    // Multiple XML files or mixed formats with XML
    console.log(`--- Processing ${xmlFiles.length} XML file(s) ---`);

    for (const xmlFile of xmlFiles) {
      console.log(`  Streaming: ${xmlFile.name} (${formatBytes(xmlFile.sizeBytes)})`);
      const tempOutput =
        xmlFiles.length === 1
          ? MERGED_OUTPUT
          : path.resolve(OUTPUT_DIR, `_temp_${xmlFile.name}.csv`);

      const rows = await streamXmlToCsv(xmlFile.fullPath, tempOutput, xmlFile.sizeBytes);
      totalRows += rows;

      fileInfos.push({
        name: xmlFile.name,
        format: "xml",
        sizeBytes: xmlFile.sizeBytes,
        rows,
        columns: OUTPUT_COLUMNS,
        hasHeader: false,
      });
    }

    // If multiple XML files, concatenate temp CSVs
    if (xmlFiles.length > 1) {
      const writeStream = fs.createWriteStream(MERGED_OUTPUT, { encoding: "utf-8" });
      writeStream.write(OUTPUT_COLUMNS.map(escapeCsvField).join(",") + "\n");

      for (const xmlFile of xmlFiles) {
        const tempPath = path.resolve(OUTPUT_DIR, `_temp_${xmlFile.name}.csv`);
        const readline = require("readline");
        const rl = readline.createInterface({
          input: fs.createReadStream(tempPath, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        });
        let isFirst = true;
        for await (const line of rl) {
          if (isFirst) {
            isFirst = false;
            continue; // skip header
          }
          writeStream.write(line + "\n");
        }
        fs.unlinkSync(tempPath);
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on("error", reject);
      });
    }
  } else {
    console.error(
      "No XML files found. This merge script is designed for DBLP XML data.",
      inputFiles.map((f) => `${f.name} (${f.format})`)
    );
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 7. Build report
  const outputStats = fs.statSync(MERGED_OUTPUT);
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
    outputColumns: OUTPUT_COLUMNS.length,
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

  // 8. Save report
  fs.writeFileSync(REPORT_OUTPUT, JSON.stringify(report, null, 2), "utf-8");

  // 9. Print summary
  console.log(`\n--- Merge Summary ---`);
  console.log(`  Strategy:        ${strategy.toUpperCase()}`);
  console.log(`  Input files:     ${fileInfos.length}`);
  console.log(
    `  Input size:      ${formatBytes(fileInfos.reduce((s, f) => s + f.sizeBytes, 0))}`
  );
  console.log(`  Output rows:     ${formatNumber(totalRows)}`);
  console.log(`  Output columns:  ${OUTPUT_COLUMNS.length}`);
  console.log(`  Output size:     ${formatBytes(outputStats.size)}`);
  console.log(`  Streaming used:  Yes (SAX)`);
  console.log(`  Time elapsed:    ${elapsed}s`);
  if (totalRows > 0) {
    console.log(
      `  Throughput:      ${formatNumber(Math.round(totalRows / parseFloat(elapsed)))} rows/sec`
    );
  }
  console.log(
    `  Conflicts:       ${conflicts.length > 0 ? conflicts.length : "None"}`
  );
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
