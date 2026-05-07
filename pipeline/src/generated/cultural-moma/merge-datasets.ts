import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import Papa from "papaparse";
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

interface ParsedFile {
  name: string;
  format: string;
  sizeBytes: number;
  columns: string[];
  hasHeader: boolean;
  rows: Record<string, string>[];
}

// ── Configuration ──────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
const INPUT_DIR = path.resolve(DATA_DIR, "input");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output");
const SUPP_DIR = path.resolve(DATA_DIR, "supplementary-files");
const MERGED_OUTPUT = path.resolve(INPUT_DIR, "dataset-merged.csv");
const REPORT_OUTPUT = path.resolve(OUTPUT_DIR, "merge-report.json");
const SUPP_INDEX_OUTPUT = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const CHUNK_SIZE = 50_000;
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB

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

// ── Delimiter detection for TXT files ──────────────────────────────────────

function detectDelimiter(lines: string[]): string {
  const candidates = ["\t", "|", ";", ","];
  let bestDelimiter = "\t";
  let bestConsistency = -1;

  for (const delim of candidates) {
    const counts = lines.map((l) => l.split(delim).length);
    if (counts[0] <= 1) continue;
    const allSame = counts.every((c) => c === counts[0]);
    const consistency = allSame ? counts[0] : 0;
    if (consistency > bestConsistency) {
      bestConsistency = consistency;
      bestDelimiter = delim;
    }
  }
  return bestDelimiter;
}

function looksLikeHeader(line: string, delimiter: string): boolean {
  const fields = line.split(delimiter);
  const numericCount = fields.filter((f) => /^\d+(\.\d+)?$/.test(f.trim())).length;
  return numericCount / fields.length < 0.5;
}

// ── CSV/TSV parsing ────────────────────────────────────────────────────────

async function parseCsvFile(filePath: string, delimiter: string = ","): Promise<ParsedFile> {
  const name = path.basename(filePath);
  const stats = fs.statSync(filePath);

  if (stats.size > LARGE_FILE_THRESHOLD) {
    return parseCsvStreaming(filePath, delimiter);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const result = Papa.parse(content, {
    header: true,
    delimiter,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  const columns = result.meta.fields || [];
  return {
    name,
    format: delimiter === "\t" ? "tsv" : "csv",
    sizeBytes: stats.size,
    columns,
    hasHeader: true,
    rows: result.data as Record<string, string>[],
  };
}

async function parseCsvStreaming(filePath: string, delimiter: string = ","): Promise<ParsedFile> {
  const name = path.basename(filePath);
  const stats = fs.statSync(filePath);
  const rows: Record<string, string>[] = [];
  let columns: string[] = [];

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    Papa.parse(stream, {
      header: true,
      delimiter,
      skipEmptyLines: true,
      dynamicTyping: false,
      step: (result: Papa.ParseStepResult<Record<string, string>>) => {
        if (columns.length === 0 && result.meta.fields) {
          columns = result.meta.fields;
        }
        rows.push(result.data);
      },
      complete: () => {
        resolve({
          name,
          format: delimiter === "\t" ? "tsv" : "csv",
          sizeBytes: stats.size,
          columns,
          hasHeader: true,
          rows,
        });
      },
      error: (err: Error) => reject(err),
    });
  });
}

// ── TXT parsing ────────────────────────────────────────────────────────────

async function parseTxtFile(filePath: string): Promise<ParsedFile> {
  const name = path.basename(filePath);
  const stats = fs.statSync(filePath);

  // Read first few lines to detect format
  const sampleLines: string[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (line.startsWith("#") || line.trim() === "") continue;
    sampleLines.push(line);
    count++;
    if (count >= 10) break;
  }

  if (sampleLines.length === 0) {
    return { name, format: "txt", sizeBytes: stats.size, columns: [], hasHeader: false, rows: [] };
  }

  const delimiter = detectDelimiter(sampleLines);
  const hasHeader = looksLikeHeader(sampleLines[0], delimiter);

  let columns: string[];
  if (hasHeader) {
    columns = sampleLines[0].split(delimiter).map((c) => c.trim());
  } else {
    // Check supplementary files for schema info
    const fieldCount = sampleLines[0].split(delimiter).length;
    columns = Array.from({ length: fieldCount }, (_, i) => `col_${i + 1}`);
  }

  // Now read all rows
  const rows: Record<string, string>[] = [];
  const rl2 = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let isFirstLine = true;
  for await (const line of rl2) {
    if (line.startsWith("#") || line.trim() === "") continue;
    if (isFirstLine && hasHeader) {
      isFirstLine = false;
      continue;
    }
    isFirstLine = false;

    const fields = line.split(delimiter);
    const row: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = (fields[i] || "").trim();
    }
    rows.push(row);
  }

  return { name, format: "txt", sizeBytes: stats.size, columns, hasHeader, rows };
}

// ── JSON/JSONL parsing ─────────────────────────────────────────────────────

async function parseJsonFile(filePath: string): Promise<ParsedFile> {
  const name = path.basename(filePath);
  const stats = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".jsonl" || name.endsWith(".jsonl")) {
    return parseJsonlFile(filePath);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);

  let rows: Record<string, string>[];
  if (Array.isArray(data)) {
    rows = data.map((item) => flattenObject(item));
  } else if (typeof data === "object") {
    // Try to find array value in the object
    const arrayKey = Object.keys(data).find((k) => Array.isArray(data[k]));
    if (arrayKey) {
      rows = data[arrayKey].map((item: any) => flattenObject(item));
    } else {
      rows = [flattenObject(data)];
    }
  } else {
    rows = [];
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { name, format: "json", sizeBytes: stats.size, columns, hasHeader: true, rows };
}

async function parseJsonlFile(filePath: string): Promise<ParsedFile> {
  const name = path.basename(filePath);
  const stats = fs.statSync(filePath);
  const rows: Record<string, string>[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    try {
      rows.push(flattenObject(JSON.parse(trimmed)));
    } catch {
      // skip malformed lines
    }
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { name, format: "jsonl", sizeBytes: stats.size, columns, hasHeader: true, rows };
}

function flattenObject(obj: any, prefix: string = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}_${key}` : key;
    if (value === null || value === undefined) {
      result[newKey] = "";
    } else if (typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else if (Array.isArray(value)) {
      result[newKey] = value.map(String).join("|");
    } else {
      result[newKey] = String(value);
    }
  }
  return result;
}

// ── XML SAX streaming parsing ──────────────────────────────────────────────

async function parseXmlFile(filePath: string): Promise<ParsedFile> {
  const name = path.basename(filePath);
  const stats = fs.statSync(filePath);

  // Check for DTD
  const dir = path.dirname(filePath);
  const dtdFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".dtd"));
  if (dtdFiles.length > 0) {
    console.log(`  Found DTD: ${dtdFiles.join(", ")}`);
  }

  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    const parser = sax.createStream(false, {
      trim: false,
      normalize: false,
      lowercase: true,
      position: true,
    });

    // Detect repeating record element by counting depth-2 tags
    const tagCounts: Record<string, number> = {};
    let depth = 0;
    let currentRecordTag: string | null = null;
    let currentRecord: Record<string, string[]> = {};
    let currentElement: string | null = null;
    let textBuffer = "";
    let insideRecord = false;
    let detectedRecordTag: string | null = null;
    let firstPassDone = false;

    parser.on("opentag", (node: sax.Tag) => {
      depth++;
      const tagName = node.name.toLowerCase();

      if (depth === 2) {
        tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;

        // After seeing enough tags, detect the record element
        if (!detectedRecordTag) {
          const totalTags = Object.values(tagCounts).reduce((a, b) => a + b, 0);
          if (totalTags >= 10) {
            detectedRecordTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0][0];
          }
        }

        if (detectedRecordTag && tagName === detectedRecordTag) {
          insideRecord = true;
          currentRecordTag = tagName;
          currentRecord = {};
          // Extract attributes
          for (const [attr, val] of Object.entries(node.attributes)) {
            const attrName = attr.toLowerCase();
            currentRecord[attrName] = [val as string];
          }
        }
      } else if (depth === 3 && insideRecord) {
        currentElement = tagName;
        textBuffer = "";
        // Capture attributes of child elements too
        for (const [attr, val] of Object.entries(node.attributes)) {
          const attrKey = `${tagName}_${attr.toLowerCase()}`;
          if (!currentRecord[attrKey]) currentRecord[attrKey] = [];
          currentRecord[attrKey].push(val as string);
        }
      }
    });

    parser.on("text", (text: string) => {
      if (insideRecord && currentElement !== null) {
        textBuffer += text;
      }
    });

    parser.on("closetag", () => {
      if (depth === 3 && insideRecord && currentElement !== null) {
        const value = textBuffer.trim();
        if (value) {
          if (!currentRecord[currentElement]) currentRecord[currentElement] = [];
          currentRecord[currentElement].push(value);
        }
        currentElement = null;
        textBuffer = "";
      } else if (depth === 2 && insideRecord) {
        // Flatten multi-value fields
        const row: Record<string, string> = {};
        for (const [key, values] of Object.entries(currentRecord)) {
          row[key] = values.length === 1 ? values[0] : values.join("|");
        }
        rows.push(row);

        insideRecord = false;
        currentRecordTag = null;
        currentRecord = {};

        if (rows.length % CHUNK_SIZE === 0) {
          process.stdout.write(`\r  Parsed ${formatNumber(rows.length)} XML records`);
        }
      }
      depth--;
    });

    parser.on("error", (err: Error) => {
      (parser as any)._parser.error = null;
      (parser as any)._parser.resume();
    });

    parser.on("end", () => {
      // Collect all unique columns
      const columnSet = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          columnSet.add(key);
        }
      }
      const columns = Array.from(columnSet).sort();

      if (rows.length > 0) {
        process.stdout.write(`\r  Parsed ${formatNumber(rows.length)} XML records\n`);
      }

      resolve({
        name,
        format: "xml",
        sizeBytes: stats.size,
        columns,
        hasHeader: false,
        rows,
      });
    });

    const readStream = fs.createReadStream(filePath, {
      encoding: "utf-8",
      highWaterMark: 64 * 1024,
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
      const fields = firstDataLine.split(delimiter);
      const isHeader = looksLikeHeader(firstDataLine, delimiter);
      if (isHeader) {
        columns = fields.map((f) => f.trim());
      } else {
        columns = Array.from({ length: fields.length }, (_, i) => `col_${i + 1}`);
      }
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

// ── Merge strategies ───────────────────────────────────────────────────────

function detectJoinKeys(parsedFiles: ParsedFile[]): string[] {
  if (parsedFiles.length < 2) return [];

  // Find columns shared across files that look like keys
  const keyPatterns = [/id$/i, /_id$/i, /^id$/i, /key$/i, /code$/i];
  const allColumnSets = parsedFiles.map((f) => new Set(f.columns.map((c) => c.toLowerCase())));

  const sharedColumns: string[] = [];
  for (const col of parsedFiles[0].columns) {
    const colLower = col.toLowerCase();
    const sharedAcrossAll = allColumnSets.every((set) => set.has(colLower));
    if (sharedAcrossAll) {
      sharedColumns.push(col);
    }
  }

  // Prioritize columns matching key patterns
  const joinKeys = sharedColumns.filter((col) =>
    keyPatterns.some((pattern) => pattern.test(col))
  );

  if (joinKeys.length > 0) return joinKeys;

  // Fallback: check for foreign key relationships
  // e.g., file1 has "ConstituentID" as primary, file2 also has "ConstituentID"
  for (const col of sharedColumns) {
    // Check if the column has high cardinality in at least one file (likely a key)
    for (const file of parsedFiles) {
      const values = new Set(file.rows.map((r) => r[col]));
      if (values.size > file.rows.length * 0.5) {
        return [col];
      }
    }
  }

  return sharedColumns.length > 0 ? [sharedColumns[0]] : [];
}

function determineStrategy(
  parsedFiles: ParsedFile[],
  joinKeys: string[]
): MergeReport["strategy"] {
  if (parsedFiles.length === 1) return "single-conversion";

  // Check if all files have identical schemas (union)
  const colSets = parsedFiles.map((f) =>
    new Set(f.columns.map((c) => c.toLowerCase()))
  );
  const allIdentical = colSets.every(
    (set) =>
      set.size === colSets[0].size &&
      [...set].every((c) => colSets[0].has(c))
  );

  if (allIdentical) return "union";

  // Check for join keys
  if (joinKeys.length > 0) return "join";

  return "merge";
}

function mergeUnion(parsedFiles: ParsedFile[]): { rows: Record<string, string>[]; columns: string[]; conflicts: Conflict[] } {
  const allColumns = new Set<string>();
  for (const file of parsedFiles) {
    for (const col of file.columns) allColumns.add(col);
  }
  const columns = Array.from(allColumns);

  const rows: Record<string, string>[] = [];
  for (const file of parsedFiles) {
    for (const row of file.rows) {
      const newRow: Record<string, string> = { source_file: file.name };
      for (const col of columns) {
        newRow[col] = row[col] || "";
      }
      rows.push(newRow);
    }
  }

  return { rows, columns: ["source_file", ...columns], conflicts: [] };
}

function mergeJoin(
  parsedFiles: ParsedFile[],
  joinKeys: string[]
): { rows: Record<string, string>[]; columns: string[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];

  // Identify the "primary" file — the one with more rows (likely the detail table)
  // and the "lookup" file(s)
  const sorted = [...parsedFiles].sort((a, b) => b.rows.length - a.rows.length);
  const primary = sorted[0];
  const lookups = sorted.slice(1);

  console.log(`  Primary table: ${primary.name} (${formatNumber(primary.rows.length)} rows)`);
  for (const lk of lookups) {
    console.log(`  Lookup table:  ${lk.name} (${formatNumber(lk.rows.length)} rows)`);
  }
  console.log(`  Join key(s):   ${joinKeys.join(", ")}`);

  // Build lookup index from smaller tables
  const lookupMaps: Map<string, Record<string, string>>[] = [];
  const lookupExclusiveColumns: string[][] = [];

  for (const lk of lookups) {
    const map = new Map<string, Record<string, string>>();
    for (const row of lk.rows) {
      const keyValue = joinKeys.map((k) => row[k] || "").join("|");
      if (keyValue && keyValue !== "|".repeat(joinKeys.length - 1)) {
        map.set(keyValue, row);
      }
    }
    lookupMaps.push(map);

    // Columns exclusive to this lookup (not in primary, except join keys)
    const primaryColSet = new Set(primary.columns.map((c) => c.toLowerCase()));
    const exclusive = lk.columns.filter(
      (c) => !primaryColSet.has(c.toLowerCase()) || joinKeys.includes(c)
    );
    lookupExclusiveColumns.push(exclusive);
  }

  // Determine shared columns (possible conflicts)
  const primaryColSet = new Set(primary.columns);
  const joinKeySet = new Set(joinKeys);
  for (const lk of lookups) {
    for (const col of lk.columns) {
      if (primaryColSet.has(col) && !joinKeySet.has(col)) {
        conflicts.push({
          column: col,
          resolution: `Kept value from primary file (${primary.name}); lookup (${lk.name}) value available as ${col}_artist`,
        });
      }
    }
  }

  // Build output columns: primary columns + exclusive lookup columns + renamed shared lookup columns
  const outputColumns = [...primary.columns];
  for (let i = 0; i < lookups.length; i++) {
    const lk = lookups[i];
    for (const col of lk.columns) {
      if (joinKeySet.has(col)) continue;
      if (primaryColSet.has(col)) {
        // Rename conflicting column
        const suffix = path.basename(lk.name, path.extname(lk.name));
        const renamedCol = `${col}_${suffix}`;
        if (!outputColumns.includes(renamedCol)) {
          outputColumns.push(renamedCol);
        }
      } else {
        if (!outputColumns.includes(col)) {
          outputColumns.push(col);
        }
      }
    }
  }

  // Perform LEFT JOIN: iterate primary rows, enrich from lookups
  const rows: Record<string, string>[] = [];
  let matchCount = 0;

  for (const primaryRow of primary.rows) {
    const keyValue = joinKeys.map((k) => primaryRow[k] || "").join("|");
    const newRow: Record<string, string> = {};

    // Copy primary columns
    for (const col of primary.columns) {
      newRow[col] = primaryRow[col] || "";
    }

    // Enrich from lookups
    for (let i = 0; i < lookups.length; i++) {
      const lookupRow = lookupMaps[i].get(keyValue);
      const lk = lookups[i];

      if (lookupRow) {
        matchCount++;
        for (const col of lk.columns) {
          if (joinKeySet.has(col)) continue;
          if (primaryColSet.has(col)) {
            const suffix = path.basename(lk.name, path.extname(lk.name));
            newRow[`${col}_${suffix}`] = lookupRow[col] || "";
          } else {
            newRow[col] = lookupRow[col] || "";
          }
        }
      } else {
        // No match — fill lookup columns with empty
        for (const col of lk.columns) {
          if (joinKeySet.has(col)) continue;
          if (primaryColSet.has(col)) {
            const suffix = path.basename(lk.name, path.extname(lk.name));
            newRow[`${col}_${suffix}`] = "";
          } else {
            newRow[col] = "";
          }
        }
      }
    }

    rows.push(newRow);
  }

  console.log(`  Matched rows:  ${formatNumber(matchCount)} / ${formatNumber(primary.rows.length)}`);

  return { rows, columns: outputColumns, conflicts };
}

function mergeSideBySide(parsedFiles: ParsedFile[]): { rows: Record<string, string>[]; columns: string[]; conflicts: Conflict[] } {
  const allColumns: string[] = [];
  const columnSources: Record<string, string> = {};
  const conflicts: Conflict[] = [];

  for (const file of parsedFiles) {
    for (const col of file.columns) {
      if (allColumns.includes(col)) {
        const renamed = `${col}_${path.basename(file.name, path.extname(file.name))}`;
        allColumns.push(renamed);
        columnSources[renamed] = file.name;
        conflicts.push({
          column: col,
          resolution: `Renamed to ${renamed} from ${file.name}`,
        });
      } else {
        allColumns.push(col);
        columnSources[col] = file.name;
      }
    }
  }

  const maxRows = Math.max(...parsedFiles.map((f) => f.rows.length));
  const rows: Record<string, string>[] = [];

  for (let i = 0; i < maxRows; i++) {
    const newRow: Record<string, string> = {};
    let colIdx = 0;
    for (const file of parsedFiles) {
      const row = file.rows[i] || {};
      for (const col of file.columns) {
        newRow[allColumns[colIdx]] = row[col] || "";
        colIdx++;
      }
    }
    rows.push(newRow);
  }

  return { rows, columns: allColumns, conflicts };
}

// ── Parse any file ─────────────────────────────────────────────────────────

async function parseFile(detected: DetectedFile): Promise<ParsedFile> {
  console.log(`  Parsing: ${detected.name} (${detected.format}, ${formatBytes(detected.sizeBytes)})`);

  switch (detected.format) {
    case "csv":
      return parseCsvFile(detected.fullPath, ",");
    case "tsv":
      return parseCsvFile(detected.fullPath, "\t");
    case "txt":
      return parseTxtFile(detected.fullPath);
    case "json":
    case "jsonl":
      return parseJsonFile(detected.fullPath);
    case "xml":
      return parseXmlFile(detected.fullPath);
    default:
      throw new Error(`Unsupported format: ${detected.format}`);
  }
}

// ── Write CSV output ───────────────────────────────────────────────────────

function writeCsv(
  outputPath: string,
  columns: string[],
  rows: Record<string, string>[]
): void {
  const writeStream = fs.createWriteStream(outputPath, { encoding: "utf-8" });
  writeStream.write(columns.map(escapeCsvField).join(",") + "\n");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = columns.map((col) => escapeCsvField(row[col] || "")).join(",");
    writeStream.write(line + "\n");

    if ((i + 1) % CHUNK_SIZE === 0) {
      process.stdout.write(`\r  Writing: ${formatNumber(i + 1)} / ${formatNumber(rows.length)} rows`);
    }
  }

  writeStream.end();
  if (rows.length > CHUNK_SIZE) {
    process.stdout.write(`\r  Writing: ${formatNumber(rows.length)} / ${formatNumber(rows.length)} rows\n`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== Data Merge Tool (Cultural-MoMA) ===\n");

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

  // 4. Parse all input files
  console.log("--- Parsing Input Files ---");
  const parsedFiles: ParsedFile[] = [];
  for (const detected of inputFiles) {
    const parsed = await parseFile(detected);
    parsedFiles.push(parsed);
    console.log(`    → ${formatNumber(parsed.rows.length)} rows, ${parsed.columns.length} columns`);
  }
  console.log();

  // 5. Analyze and determine strategy
  console.log("--- Strategy Analysis ---");

  const joinKeys = detectJoinKeys(parsedFiles);
  const strategy = determineStrategy(parsedFiles, joinKeys);

  console.log(`  Strategy: ${strategy.toUpperCase()}`);
  if (joinKeys.length > 0) {
    console.log(`  Join keys detected: ${joinKeys.join(", ")}`);
  }

  // Column overlap analysis
  if (parsedFiles.length > 1) {
    const colSets = parsedFiles.map((f) => new Set(f.columns));
    const shared = parsedFiles[0].columns.filter((c) =>
      colSets.slice(1).every((set) => set.has(c))
    );
    const unique = parsedFiles.map((f, i) => ({
      file: f.name,
      unique: f.columns.filter((c) =>
        colSets.filter((_, j) => j !== i).every((set) => !set.has(c))
      ),
    }));

    console.log(`  Shared columns: ${shared.join(", ")}`);
    for (const u of unique) {
      console.log(`  Unique to ${u.file}: ${u.unique.length} columns`);
    }
  }
  console.log();

  // 6. Execute merge
  console.log("--- Executing Merge ---");
  const startTime = Date.now();

  let mergedRows: Record<string, string>[];
  let mergedColumns: string[];
  let conflicts: Conflict[];

  switch (strategy) {
    case "single-conversion": {
      mergedRows = parsedFiles[0].rows;
      mergedColumns = parsedFiles[0].columns;
      conflicts = [];
      break;
    }
    case "union": {
      const result = mergeUnion(parsedFiles);
      mergedRows = result.rows;
      mergedColumns = result.columns;
      conflicts = result.conflicts;
      break;
    }
    case "join": {
      const result = mergeJoin(parsedFiles, joinKeys);
      mergedRows = result.rows;
      mergedColumns = result.columns;
      conflicts = result.conflicts;
      break;
    }
    case "merge": {
      const result = mergeSideBySide(parsedFiles);
      mergedRows = result.rows;
      mergedColumns = result.columns;
      conflicts = result.conflicts;
      break;
    }
  }

  // 7. Write output CSV
  console.log(`\n  Writing merged CSV...`);
  writeCsv(MERGED_OUTPUT, mergedColumns, mergedRows);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 8. Build report
  const outputStats = fs.statSync(MERGED_OUTPUT);
  const report: MergeReport = {
    strategy,
    inputFiles: parsedFiles.map((f) => ({
      name: f.name,
      format: f.format,
      sizeBytes: f.sizeBytes,
      rows: f.rows.length,
      columns: f.columns,
      hasHeader: f.hasHeader,
    })),
    outputRows: mergedRows.length,
    outputColumns: mergedColumns.length,
    conflicts,
    joinKeys,
    streamingUsed: parsedFiles.some((f) => f.sizeBytes > LARGE_FILE_THRESHOLD),
    chunkSize: CHUNK_SIZE,
    supplementaryFiles: suppIndex.map((s) => ({
      name: s.name,
      format: s.format,
      description: s.description,
    })),
  };

  // 9. Save report
  fs.writeFileSync(REPORT_OUTPUT, JSON.stringify(report, null, 2), "utf-8");

  // 10. Print summary
  console.log(`\n--- Merge Summary ---`);
  console.log(`  Strategy:        ${strategy.toUpperCase()}`);
  console.log(`  Input files:     ${parsedFiles.length}`);
  console.log(
    `  Input size:      ${formatBytes(parsedFiles.reduce((s, f) => s + f.sizeBytes, 0))}`
  );
  console.log(`  Output rows:     ${formatNumber(mergedRows.length)}`);
  console.log(`  Output columns:  ${mergedColumns.length}`);
  console.log(`  Output size:     ${formatBytes(outputStats.size)}`);
  console.log(`  Streaming used:  ${report.streamingUsed ? "Yes" : "No (files < 100MB)"}`);
  console.log(`  Time elapsed:    ${elapsed}s`);
  if (mergedRows.length > 0) {
    console.log(
      `  Throughput:      ${formatNumber(Math.round(mergedRows.length / parseFloat(elapsed)))} rows/sec`
    );
  }
  console.log(
    `  Conflicts:       ${conflicts.length > 0 ? conflicts.length : "None"}`
  );
  if (conflicts.length > 0) {
    for (const c of conflicts) {
      console.log(`    - ${c.column}: ${c.resolution}`);
    }
  }
  if (suppIndex.length > 0) {
    console.log(`  Supplementary:   ${suppIndex.length} reference file(s) indexed`);
  }
  console.log(`  Merged CSV:      ${MERGED_OUTPUT}`);
  console.log(`  Report:          ${REPORT_OUTPUT}`);
  if (suppIndex.length > 0) {
    console.log(`  Supp. index:     ${SUPP_INDEX_OUTPUT}`);
  }

  // Print column listing
  console.log(`\n--- Output Columns (${mergedColumns.length}) ---`);
  for (const col of mergedColumns) {
    console.log(`  ${col}`);
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
