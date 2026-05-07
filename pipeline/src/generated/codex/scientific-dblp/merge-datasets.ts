import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import Papa from "papaparse";
import * as sax from "sax";

type MergeStrategy = "union" | "join" | "merge" | "single-conversion";
type Row = Record<string, string>;

interface Conflict {
  column: string;
  resolution: string;
}

interface FileInputInfo {
  name: string;
  format: string;
  sizeBytes: number;
  rows: number;
  columns: string[];
  hasHeader: boolean;
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
  strategy: MergeStrategy;
  inputFiles: FileInputInfo[];
  outputRows: number;
  outputColumns: number;
  conflicts: Conflict[];
  joinKeys: string[];
  streamingUsed: boolean;
  chunkSize: number;
  supplementaryFiles: { name: string; format: string; description: string }[];
}

interface DetectedFile {
  name: string;
  fullPath: string;
  extension: string;
  format: string;
  sizeBytes: number;
  sample: string;
}

interface ParsedFile {
  name: string;
  fullPath: string;
  format: string;
  sizeBytes: number;
  columns: string[];
  rows: Row[];
  rowCount: number;
  hasHeader: boolean;
  delimiter?: string;
  streamingUsed: boolean;
  tempJsonlPath?: string;
}

interface XmlSchemaInfo {
  dtdPath?: string;
  dtdElements: string[];
  rootTag?: string;
  recordTag?: string;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/scientific-dblp";
const INPUT_DIR = path.resolve(DATA_DIR, "input");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");
const CODEX_OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const TEMP_DIR = path.resolve(CODEX_OUTPUT_DIR, "tmp");
const MERGED_OUTPUT = path.resolve(INPUT_DIR, "dataset-merged.csv");
const REPORT_OUTPUT = path.resolve(CODEX_OUTPUT_DIR, "merge-report.json");
const SUPP_INDEX_OUTPUT = path.resolve(CODEX_OUTPUT_DIR, "supplementary-files-index.json");

const SAMPLE_BYTES = 16 * 1024;
const SAMPLE_LINES = 12;
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const VERY_LARGE_XML_THRESHOLD = 1024 * 1024 * 1024;
const CHUNK_SIZE = 50_000;

const DATA_FORMATS: Record<string, string> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".txt": "txt",
  ".json": "json",
  ".jsonl": "jsonl",
  ".xml": "xml",
};

const NON_DATA_EXTENSIONS = new Set([".dtd", ".md", ".log"]);
const DELIMITER_CANDIDATES = ["\t", "|", ";", ","];
const JOIN_KEY_PATTERNS = [/^id$/i, /id$/i, /_id$/i, /identifier$/i, /code$/i, /key$/i];

const DBLP_RECORD_TYPES = new Set([
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

const DBLP_OUTPUT_COLUMNS = [
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

const DBLP_FIELD_TO_COLUMN: Record<string, string> = {
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

function ensureDirectories(): void {
  fs.mkdirSync(CODEX_OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function cleanColumnName(value: string): string {
  const cleaned = stripBom(value).trim().replace(/\s+/g, " ");
  return cleaned || "unnamed_column";
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readSample(filePath: string, bytes: number = SAMPLE_BYTES): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buffer, 0, bytes, 0);
    return stripBom(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function inferFormat(extension: string, sample: string): string {
  if (extension === ".json") {
    const firstNonEmpty = sample
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstNonEmpty?.startsWith("{") && !sample.trimStart().startsWith("{")) {
      return "jsonl";
    }
  }

  if (extension === ".txt") {
    const trimmed = sample.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
    if (trimmed.startsWith("<")) return "xml";
  }

  return DATA_FORMATS[extension];
}

function detectInputFiles(inputDir: string): DetectedFile[] {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  return fs
    .readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name !== "dataset-merged.csv")
    .filter((entry) => !NON_DATA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .filter((entry) => Object.prototype.hasOwnProperty.call(DATA_FORMATS, path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const fullPath = path.join(inputDir, entry.name);
      const stat = fs.statSync(fullPath);
      const extension = path.extname(entry.name).toLowerCase();
      const sample = readSample(fullPath);
      return {
        name: entry.name,
        fullPath,
        extension,
        format: inferFormat(extension, sample),
        sizeBytes: stat.size,
        sample,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSampleLines(filePath: string, limit: number = SAMPLE_LINES): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (lines.length < limit) {
        lines.push(stripBom(line));
      }
      if (lines.length >= limit) {
        rl.close();
        stream.destroy();
      }
    });
    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

function detectDelimiter(lines: string[]): string {
  let bestDelimiter = "\t";
  let bestScore = -1;

  for (const delimiter of DELIMITER_CANDIDATES) {
    const fieldCounts = lines
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
      .slice(0, 8)
      .map((line) => line.split(delimiter).length);
    if (fieldCounts.length === 0) continue;
    const min = Math.min(...fieldCounts);
    const max = Math.max(...fieldCounts);
    if (max <= 1) continue;
    const score = min === max ? max * 10 : min - (max - min);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
}

function isNumericLike(value: string): boolean {
  const normalized = value.trim().replace(/[()[\]]/g, "");
  return normalized === "" || /^-?\d+([.,]\d+)?$/.test(normalized);
}

function looksLikeHeader(line: string, delimiter: string): boolean {
  const values = line
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (values.length === 0) return false;

  const descriptive = values.filter((value) => /^[A-Za-z_][A-Za-z0-9 _()./-]*$/.test(value)).length;
  const numeric = values.filter((value) => isNumericLike(value)).length;
  const duplicateCount = values.length - new Set(values.map((value) => value.toLowerCase())).size;

  return descriptive >= Math.ceil(values.length * 0.6) && numeric <= Math.floor(values.length * 0.2) && duplicateCount === 0;
}

function flattenObject(input: unknown, prefix = ""): Row {
  if (input === null || input === undefined) {
    return prefix ? { [prefix]: "" } : {};
  }

  if (typeof input !== "object") {
    return prefix ? { [prefix]: String(input) } : { value: String(input) };
  }

  const result: Row = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}_${key}` : key;
    if (value === null || value === undefined) {
      result[nextKey] = "";
    } else if (Array.isArray(value)) {
      if (value.every((entry) => typeof entry !== "object" || entry === null)) {
        result[nextKey] = value.map((entry) => (entry === null || entry === undefined ? "" : String(entry))).join("|");
      } else {
        value.forEach((entry, index) => {
          Object.assign(result, flattenObject(entry, `${nextKey}_${index + 1}`));
        });
      }
    } else if (typeof value === "object") {
      Object.assign(result, flattenObject(value, nextKey));
    } else {
      result[nextKey] = String(value);
    }
  }

  return result;
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectColumns(rows: Row[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      set.add(key);
    }
  }
  return Array.from(set);
}

function normalizeRow(row: Row, columns: string[]): Row {
  const normalized: Row = {};
  for (const column of columns) {
    normalized[column] = row[column] === undefined || row[column] === null ? "" : String(row[column]);
  }
  return normalized;
}

function inferDescriptionFromName(name: string, preview: string): string {
  const base = path.basename(name, path.extname(name)).replace(/[_-]+/g, " ").trim();
  return preview ? `${base}: ${preview}` : base;
}

async function countDelimitedRows(filePath: string, hasHeader: boolean): Promise<number> {
  let count = 0;
  let firstDataSeen = false;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = stripBom(line).trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!firstDataSeen) {
      firstDataSeen = true;
      if (hasHeader) continue;
    }
    count += 1;
  }

  return count;
}

async function countJsonlRows(filePath: string): Promise<number> {
  let count = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      count += 1;
    }
  }

  return count;
}

async function indexSupplementaryFiles(): Promise<SupplementaryFileInfo[]> {
  if (!fs.existsSync(SUPPLEMENTARY_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(SUPPLEMENTARY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => [".txt", ".csv", ".json", ".tsv", ".tab"].includes(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const index: SupplementaryFileInfo[] = [];

  for (const file of files) {
    const fullPath = path.join(SUPPLEMENTARY_DIR, file.name);
    const stat = fs.statSync(fullPath);
    const sample = readSample(fullPath);
    const lines = sample
      .split(/\r?\n/)
      .map((line) => stripBom(line))
      .filter((line) => line.trim() !== "");
    const extension = path.extname(file.name).toLowerCase();
    const format = inferFormat(extension, sample);

    let columns: string[] = [];
    let rowCount = 0;

    if (["csv", "tsv", "txt"].includes(format)) {
      const delimiter = format === "csv" ? "," : format === "tsv" ? "\t" : detectDelimiter(lines);
      const dataLines = await readSampleLines(fullPath, 200);
      const filtered = dataLines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
      if (filtered.length > 0) {
        const hasHeader = looksLikeHeader(filtered[0], delimiter);
        columns = (hasHeader ? filtered[0].split(delimiter) : filtered[0].split(delimiter).map((_, index) => `col_${index + 1}`)).map(cleanColumnName);
      }
      rowCount = await countDelimitedRows(fullPath, looksLikeHeader(filtered[0] ?? "", delimiter));
    } else if (format === "json" || format === "jsonl") {
      if (format === "jsonl") {
        const firstLine = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#")) ?? "";
        columns = firstLine ? Object.keys(flattenObject(safeParseJson(firstLine) ?? {})) : [];
        rowCount = await countJsonlRows(fullPath);
      } else {
        const parsed = safeParseJson(sample);
        const rows = parsed === null ? [] : materializeJsonRows(parsed);
        columns = collectColumns(rows);
        rowCount = rows.length;
      }
    }

    const preview = lines.slice(0, 3).join(" ").slice(0, 180);
    index.push({
      path: fullPath,
      name: file.name,
      format,
      sizeBytes: stat.size,
      description: inferDescriptionFromName(file.name, preview),
      columns,
      rowCount,
    });
  }

  return index;
}

function findSchemaForHeaderlessTxt(
  fileName: string,
  fieldCount: number,
  delimiter: string,
  supplementaryFiles: SupplementaryFileInfo[],
  sharedSchemas: Map<string, string[]>
): string[] | null {
  const signature = `${delimiter}:${fieldCount}`;
  const fromShared = sharedSchemas.get(signature);
  if (fromShared) return fromShared;

  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const match = supplementaryFiles.find((entry) => {
    const suppBase = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
    const sameBase = base.includes(suppBase) || suppBase.includes(base);
    return sameBase && entry.columns.length === fieldCount;
  });

  if (match) {
    sharedSchemas.set(signature, match.columns);
    return match.columns;
  }

  return null;
}

async function parseCsvOrTsvFile(file: DetectedFile, delimiter: string): Promise<ParsedFile> {
  const rows: Row[] = [];
  let columns: string[] = [];

  if (file.sizeBytes > LARGE_FILE_THRESHOLD) {
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(file.fullPath, { encoding: "utf8" });
      Papa.parse<Row>(stream, {
        header: true,
        delimiter,
        skipEmptyLines: true,
        transformHeader: (header) => cleanColumnName(header),
        step: (result) => {
          if (columns.length === 0 && result.meta.fields) {
            columns = result.meta.fields.map(cleanColumnName);
          }
          rows.push(normalizeRow(result.data, columns));
        },
        complete: () => resolve(),
        error: (error) => reject(error),
      });
    });
  } else {
    const content = fs.readFileSync(file.fullPath, "utf8");
    const parsed = Papa.parse<Row>(stripBom(content), {
      header: true,
      delimiter,
      skipEmptyLines: true,
      transformHeader: (header) => cleanColumnName(header),
    });
    columns = (parsed.meta.fields ?? []).map(cleanColumnName);
    for (const row of parsed.data) {
      rows.push(normalizeRow(row, columns));
    }
  }

  return {
    name: file.name,
    fullPath: file.fullPath,
    format: file.format,
    sizeBytes: file.sizeBytes,
    columns,
    rows,
    rowCount: rows.length,
    hasHeader: true,
    delimiter,
    streamingUsed: file.sizeBytes > LARGE_FILE_THRESHOLD,
  };
}

async function parseTxtFile(
  file: DetectedFile,
  supplementaryFiles: SupplementaryFileInfo[],
  sharedSchemas: Map<string, string[]>
): Promise<ParsedFile> {
  const sampleLines = await readSampleLines(file.fullPath, SAMPLE_LINES);
  const dataLines = sampleLines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

  if (dataLines.length === 0) {
    return {
      name: file.name,
      fullPath: file.fullPath,
      format: file.format,
      sizeBytes: file.sizeBytes,
      columns: [],
      rows: [],
      rowCount: 0,
      hasHeader: false,
      streamingUsed: true,
    };
  }

  const delimiter = detectDelimiter(dataLines);
  const hasHeader = looksLikeHeader(dataLines[0], delimiter);
  const fieldCount = dataLines[0].split(delimiter).length;
  const inferredSchema = !hasHeader
    ? findSchemaForHeaderlessTxt(file.name, fieldCount, delimiter, supplementaryFiles, sharedSchemas)
    : null;
  const columns = hasHeader
    ? dataLines[0].split(delimiter).map(cleanColumnName)
    : inferredSchema ?? Array.from({ length: fieldCount }, (_, index) => `col_${index + 1}`);

  if (!hasHeader) {
    sharedSchemas.set(`${delimiter}:${fieldCount}`, columns);
  }

  const rows: Row[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file.fullPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let firstDataHandled = false;
  for await (const line of rl) {
    const raw = stripBom(line);
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!firstDataHandled) {
      firstDataHandled = true;
      if (hasHeader) continue;
    }

    const values = raw.split(delimiter);
    const row: Row = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = (values[index] ?? "").trim();
    }
    rows.push(row);
  }

  return {
    name: file.name,
    fullPath: file.fullPath,
    format: file.format,
    sizeBytes: file.sizeBytes,
    columns,
    rows,
    rowCount: rows.length,
    hasHeader,
    delimiter,
    streamingUsed: true,
  };
}

function materializeJsonRows(parsed: unknown): Row[] {
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => flattenObject(entry));
  }
  if (parsed && typeof parsed === "object") {
    const objectValue = parsed as Record<string, unknown>;
    const arrayKey = Object.keys(objectValue).find((key) => Array.isArray(objectValue[key]));
    if (arrayKey) {
      return (objectValue[arrayKey] as unknown[]).map((entry) => flattenObject(entry));
    }
    return [flattenObject(parsed)];
  }
  return [];
}

async function parseJsonFile(file: DetectedFile): Promise<ParsedFile> {
  if (file.format === "jsonl") {
    return parseJsonlFile(file);
  }

  const content = fs.readFileSync(file.fullPath, "utf8");
  const parsed = JSON.parse(stripBom(content)) as unknown;
  const rows = materializeJsonRows(parsed);
  const columns = collectColumns(rows);

  return {
    name: file.name,
    fullPath: file.fullPath,
    format: "json",
    sizeBytes: file.sizeBytes,
    columns,
    rows: rows.map((row) => normalizeRow(row, columns)),
    rowCount: rows.length,
    hasHeader: true,
    streamingUsed: false,
  };
}

async function parseJsonlFile(file: DetectedFile): Promise<ParsedFile> {
  const rows: Row[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file.fullPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const parsed = safeParseJson(trimmed);
    if (parsed !== null) {
      rows.push(flattenObject(parsed));
    }
  }

  const columns = collectColumns(rows);
  return {
    name: file.name,
    fullPath: file.fullPath,
    format: "jsonl",
    sizeBytes: file.sizeBytes,
    columns,
    rows: rows.map((row) => normalizeRow(row, columns)),
    rowCount: rows.length,
    hasHeader: true,
    streamingUsed: true,
  };
}

function parseDtdElements(dtdContent: string): string[] {
  const matches = Array.from(dtdContent.matchAll(/<!ELEMENT\s+([A-Za-z0-9_.:-]+)/g));
  return Array.from(new Set(matches.map((match) => match[1])));
}

function getXmlSchemaInfo(file: DetectedFile): XmlSchemaInfo {
  const dir = path.dirname(file.fullPath);
  const dtdFile = fs.readdirSync(dir).find((name) => path.extname(name).toLowerCase() === ".dtd");
  const dtdPath = dtdFile ? path.join(dir, dtdFile) : undefined;
  const dtdElements = dtdPath ? parseDtdElements(fs.readFileSync(dtdPath, "utf8")) : [];
  return { dtdPath, dtdElements };
}

async function detectXmlRecordTag(filePath: string, dtdElements: string[]): Promise<{ rootTag?: string; recordTag?: string }> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { lowercase: true, trim: false, normalize: false });
    const counts = new Map<string, number>();
    let depth = 0;
    let rootTag: string | undefined;
    let resolved = false;
    const normalizedDtd = new Set(dtdElements.map((value) => value.toLowerCase()));
    let stream: fs.ReadStream;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      const ordered = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      const dtdPreferred = ordered.find(([tag]) => normalizedDtd.has(tag));
      resolve({ rootTag, recordTag: dtdPreferred?.[0] ?? ordered[0]?.[0] });
    };

    parser.on("opentag", (node: sax.Tag) => {
      depth += 1;
      const tag = node.name.toLowerCase();
      if (depth === 1) {
        rootTag = tag;
      } else if (depth === 2) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
        const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
        if (total >= 5000) {
          stream.destroy();
          finish();
        }
      }
    });

    parser.on("closetag", () => {
      depth -= 1;
    });
    parser.on("error", reject);
    parser.on("end", finish);

    stream = fs.createReadStream(filePath, { encoding: "utf8" });
    stream.on("error", reject);
    stream.pipe(parser);
  });
}

function isDblpXml(file: DetectedFile, schema: XmlSchemaInfo): boolean {
  const dtdName = schema.dtdPath ? path.basename(schema.dtdPath).toLowerCase() : "";
  const sample = file.sample.toLowerCase();
  return (
    file.name.toLowerCase() === "dblp.xml" ||
    dtdName === "dblp.dtd" ||
    sample.includes("<dblp") ||
    sample.includes('doctype dblp')
  );
}

async function streamDblpXmlToCsv(file: DetectedFile, schema: XmlSchemaInfo, outputPath: string): Promise<{ rowCount: number; columns: string[] }> {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath, { encoding: "utf8" });
    writer.write(`${DBLP_OUTPUT_COLUMNS.map(escapeCsvField).join(",")}\n`);

    const parser = sax.createStream(false, {
      trim: false,
      normalize: false,
      lowercase: true,
      position: true,
    });

    let depth = 0;
    let insideRecord = false;
    let currentRecordType: string | null = null;
    let currentRecord: Record<string, string[]> = {};
    let currentAttrs: Record<string, string> = {};
    let currentElement: string | null = null;
    let textBuffer = "";
    let totalRecords = 0;

    parser.on("opentag", (node: sax.Tag) => {
      depth += 1;
      const tagName = node.name.toLowerCase();

      if (depth === 2 && DBLP_RECORD_TYPES.has(tagName)) {
        insideRecord = true;
        currentRecordType = tagName;
        currentRecord = {};
        currentAttrs = {};
        for (const [attr, value] of Object.entries(node.attributes)) {
          currentAttrs[String(attr).toLowerCase()] = String(value);
        }
      } else if (depth === 3 && insideRecord) {
        currentElement = tagName;
        textBuffer = "";
      }
    });

    parser.on("text", (text: string) => {
      if (insideRecord && currentElement !== null) {
        textBuffer += text;
      }
    });

    parser.on("cdata", (text: string) => {
      if (insideRecord && currentElement !== null) {
        textBuffer += text;
      }
    });

    parser.on("closetag", (tagName: string) => {
      const tag = tagName.toLowerCase();

      if (depth === 3 && insideRecord && currentElement !== null) {
        const column = DBLP_FIELD_TO_COLUMN[currentElement];
        const value = textBuffer.trim();
        if (column && value) {
          if (!currentRecord[column]) {
            currentRecord[column] = [];
          }
          currentRecord[column].push(value);
        }
        currentElement = null;
        textBuffer = "";
      } else if (depth === 2 && insideRecord && DBLP_RECORD_TYPES.has(tag)) {
        const row = DBLP_OUTPUT_COLUMNS.map((column) => {
          if (column === "record_type") return escapeCsvField(currentRecordType ?? "");
          if (column === "key") return escapeCsvField(currentAttrs.key ?? "");
          if (column === "mdate") return escapeCsvField(currentAttrs.mdate ?? "");
          if (column === "publtype") return escapeCsvField(currentAttrs.publtype ?? "");
          return escapeCsvField((currentRecord[column] ?? []).join("|"));
        }).join(",");

        writer.write(`${row}\n`);
        totalRecords += 1;

        if (totalRecords % CHUNK_SIZE === 0) {
          const position = (parser as unknown as { _parser?: { position?: number } })._parser?.position ?? 0;
          const pct = file.sizeBytes > 0 ? ((position / file.sizeBytes) * 100).toFixed(1) : "?";
          process.stdout.write(`\r  Processing: ${formatNumber(totalRecords)} records (~${pct}%)`);
        }

        insideRecord = false;
        currentRecordType = null;
        currentRecord = {};
        currentAttrs = {};
      }

      depth -= 1;
    });

    parser.on("error", () => {
      (parser as unknown as { _parser: { error: Error | null; resume: () => void } })._parser.error = null;
      (parser as unknown as { _parser: { error: Error | null; resume: () => void } })._parser.resume();
    });

    parser.on("end", () => {
      writer.end(() => {
        process.stdout.write(`\r  Processing: ${formatNumber(totalRecords)} records (100%)     \n`);
        if (schema.dtdPath) {
          console.log(`  XML schema hint: ${path.basename(schema.dtdPath)}`);
        }
        resolve({ rowCount: totalRecords, columns: DBLP_OUTPUT_COLUMNS });
      });
    });

    const stream = fs.createReadStream(file.fullPath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    stream.on("error", reject);
    writer.on("error", reject);
    stream.pipe(parser);
  });
}

async function parseXmlFile(file: DetectedFile): Promise<ParsedFile> {
  const schema = getXmlSchemaInfo(file);
  const detected = await detectXmlRecordTag(file.fullPath, schema.dtdElements);
  schema.rootTag = detected.rootTag;
  schema.recordTag = detected.recordTag;

  if (!schema.recordTag) {
    throw new Error(`Could not detect a repeating XML record element for ${file.name}`);
  }

  const tempJsonlPath = path.join(TEMP_DIR, `${path.basename(file.name, path.extname(file.name))}.xml.rows.jsonl`);
  if (fs.existsSync(tempJsonlPath)) {
    fs.unlinkSync(tempJsonlPath);
  }

  const rows: Row[] = [];
  const columns = new Set<string>();
  let rowCount = 0;
  let chunkBuffer: string[] = [];
  const streamToDisk = file.sizeBytes > LARGE_FILE_THRESHOLD || file.sizeBytes > VERY_LARGE_XML_THRESHOLD;
  const writer = fs.createWriteStream(tempJsonlPath, { encoding: "utf8" });

  await new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, { lowercase: true, trim: false, normalize: false });
    const tagStack: string[] = [];
    const textStack: string[] = [];
    let insideRecord = false;
    let recordDepth = 0;
    let currentRow: Row = {};

    const flushChunk = () => {
      if (chunkBuffer.length > 0) {
        writer.write(chunkBuffer.join(""));
        chunkBuffer = [];
      }
    };

    const setValue = (row: Row, key: string, value: string) => {
      if (!value) return;
      if (row[key]) {
        row[key] = `${row[key]}|${value}`;
      } else {
        row[key] = value;
      }
    };

    parser.on("opentag", (node: sax.Tag) => {
      const tag = node.name.toLowerCase();
      tagStack.push(tag);
      textStack.push("");

      if (!insideRecord && tag === schema.recordTag) {
        insideRecord = true;
        recordDepth = tagStack.length;
        currentRow = {};
        for (const [attr, value] of Object.entries(node.attributes)) {
          setValue(currentRow, `@${String(attr).toLowerCase()}`, String(value));
        }
        return;
      }

      if (insideRecord) {
        const relativePath = tagStack.slice(recordDepth).join("_");
        for (const [attr, value] of Object.entries(node.attributes)) {
          setValue(currentRow, `${relativePath}@${String(attr).toLowerCase()}`, String(value));
        }
      }
    });

    parser.on("text", (text: string) => {
      if (insideRecord && textStack.length > 0) {
        textStack[textStack.length - 1] += text;
      }
    });

    parser.on("cdata", (text: string) => {
      if (insideRecord && textStack.length > 0) {
        textStack[textStack.length - 1] += text;
      }
    });

    parser.on("closetag", (tagName: string) => {
      const tag = tagName.toLowerCase();
      const text = (textStack.pop() ?? "").trim();

      if (insideRecord && tagStack.length >= recordDepth) {
        const relativePath = tagStack.slice(recordDepth).join("_");
        if (relativePath && text) {
          setValue(currentRow, relativePath, text);
        }
      }

      if (insideRecord && tag === schema.recordTag && tagStack.length === recordDepth) {
        rowCount += 1;
        for (const key of Object.keys(currentRow)) {
          columns.add(key);
        }

        if (streamToDisk) {
          chunkBuffer.push(`${JSON.stringify(currentRow)}\n`);
          if (chunkBuffer.length >= CHUNK_SIZE) {
            flushChunk();
          }
        } else {
          rows.push(currentRow);
        }

        insideRecord = false;
        currentRow = {};
      }

      tagStack.pop();
    });

    parser.on("error", reject);
    parser.on("end", () => {
      flushChunk();
      writer.end();
      resolve();
    });

    const stream = fs.createReadStream(file.fullPath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    stream.on("error", reject);
    stream.pipe(parser);
  });

  if (!streamToDisk && fs.existsSync(tempJsonlPath)) {
    fs.unlinkSync(tempJsonlPath);
  }

  const columnList = Array.from(columns);
  return {
    name: file.name,
    fullPath: file.fullPath,
    format: "xml",
    sizeBytes: file.sizeBytes,
    columns: columnList,
    rows: streamToDisk ? [] : rows.map((row) => normalizeRow(row, columnList)),
    rowCount,
    hasHeader: false,
    streamingUsed: true,
    tempJsonlPath: streamToDisk ? tempJsonlPath : undefined,
  };
}

async function materializeRowsFromTempJsonl(file: ParsedFile): Promise<Row[]> {
  if (!file.tempJsonlPath) {
    return file.rows;
  }

  const rows: Row[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file.tempJsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(normalizeRow(JSON.parse(trimmed) as Row, file.columns));
  }

  return rows;
}

async function parseFile(
  file: DetectedFile,
  supplementaryFiles: SupplementaryFileInfo[],
  sharedSchemas: Map<string, string[]>
): Promise<ParsedFile> {
  console.log(`  Parsing ${file.name} as ${file.format} (${formatBytes(file.sizeBytes)})`);
  switch (file.format) {
    case "csv":
      return parseCsvOrTsvFile(file, ",");
    case "tsv":
      return parseCsvOrTsvFile(file, "\t");
    case "txt":
      return parseTxtFile(file, supplementaryFiles, sharedSchemas);
    case "json":
    case "jsonl":
      return parseJsonFile(file);
    case "xml":
      return parseXmlFile(file);
    default:
      throw new Error(`Unsupported format: ${file.format}`);
  }
}

function normalizeColumnKey(column: string): string {
  return column.trim().toLowerCase();
}

function getSharedColumns(files: ParsedFile[]): string[] {
  if (files.length === 0) return [];
  const first = files[0].columns;
  const others = files.slice(1).map((file) => new Set(file.columns.map(normalizeColumnKey)));
  return first.filter((column) => others.every((set) => set.has(normalizeColumnKey(column))));
}

function detectJoinKeys(files: ParsedFile[]): string[] {
  if (files.length < 2) return [];

  const counts = new Map<string, number>();
  const originalNames = new Map<string, string>();

  for (const file of files) {
    const unique = new Set(file.columns.map(normalizeColumnKey));
    for (const column of unique) {
      counts.set(column, (counts.get(column) ?? 0) + 1);
      if (!originalNames.has(column)) {
        const original = file.columns.find((candidate) => normalizeColumnKey(candidate) === column);
        if (original) originalNames.set(column, original);
      }
    }
  }

  const candidates = Array.from(counts.entries())
    .filter(([, seenIn]) => seenIn >= 2)
    .map(([column]) => column)
    .filter((column) => JOIN_KEY_PATTERNS.some((pattern) => pattern.test(column)));

  const scored = candidates
    .map((column) => {
      let uniquenessScore = 0;
      for (const file of files) {
        const actual = file.columns.find((candidate) => normalizeColumnKey(candidate) === column);
        if (!actual || file.rows.length === 0) continue;
        const values = new Set(file.rows.map((row) => row[actual]).filter((value) => value !== ""));
        uniquenessScore = Math.max(uniquenessScore, values.size / Math.max(file.rows.length, 1));
      }
      return { column, score: uniquenessScore };
    })
    .sort((a, b) => b.score - a.score);

  return scored.filter((entry) => entry.score >= 0.2).map((entry) => originalNames.get(entry.column) ?? entry.column);
}

function determineStrategy(files: ParsedFile[], joinKeys: string[]): MergeStrategy {
  if (files.length === 1) {
    return "single-conversion";
  }

  const similarities: number[] = [];
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const left = new Set(files[i].columns.map(normalizeColumnKey));
      const right = new Set(files[j].columns.map(normalizeColumnKey));
      const intersection = Array.from(left).filter((value) => right.has(value)).length;
      const union = new Set([...left, ...right]).size;
      similarities.push(union === 0 ? 0 : intersection / union);
    }
  }

  const nearIdentical = similarities.length > 0 && similarities.every((value) => value >= 0.85);
  if (nearIdentical) return "union";
  if (joinKeys.length > 0) return "join";
  return "merge";
}

function buildLookupIndex(rows: Row[], key: string): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  for (const row of rows) {
    for (const token of tokenizeJoinValue(row[key] ?? "")) {
      const bucket = index.get(token) ?? [];
      bucket.push(row);
      index.set(token, bucket);
    }
  }
  return index;
}

function tokenizeJoinValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .replace(/^[\[(]\s*/, "")
    .replace(/\s*[\])]$/, "")
    .split(/[|,;/]/)
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function mergeUnion(files: ParsedFile[]): { rows: Row[]; columns: string[]; conflicts: Conflict[] } {
  const columns = collectColumns(files.flatMap((file) => file.rows));
  const mergedColumns = ["source_file", ...columns];
  const rows = files.flatMap((file) =>
    file.rows.map((row) => {
      const next: Row = { source_file: file.name };
      for (const column of columns) {
        next[column] = row[column] ?? "";
      }
      return next;
    })
  );
  return { rows, columns: mergedColumns, conflicts: [] };
}

function mergeJoin(files: ParsedFile[], joinKeys: string[]): { rows: Row[]; columns: string[]; conflicts: Conflict[] } {
  const sorted = [...files].sort((a, b) => b.rowCount - a.rowCount);
  const primary = sorted[0];
  const lookups = sorted.slice(1);
  const key = joinKeys[0];
  const primaryKey = primary.columns.find((column) => normalizeColumnKey(column) === normalizeColumnKey(key)) ?? key;
  const conflicts: Conflict[] = [];
  const outputColumns = [...primary.columns];

  const lookupDescriptors = lookups.map((lookup) => {
    const lookupKey = lookup.columns.find((column) => normalizeColumnKey(column) === normalizeColumnKey(key)) ?? key;
    const index = buildLookupIndex(lookup.rows, lookupKey);
    const suffix = path.basename(lookup.name, path.extname(lookup.name));
    const columnMap = new Map<string, string>();

    for (const column of lookup.columns) {
      if (normalizeColumnKey(column) === normalizeColumnKey(lookupKey)) continue;
      const alreadyExists = outputColumns.some((existing) => normalizeColumnKey(existing) === normalizeColumnKey(column));
      const outputName = alreadyExists ? `${column}_${suffix}` : column;
      columnMap.set(column, outputName);
      if (alreadyExists) {
        conflicts.push({
          column,
          resolution: `Preserved primary value and wrote ${lookup.name} values to ${outputName}`,
        });
      }
      if (!outputColumns.includes(outputName)) {
        outputColumns.push(outputName);
      }
    }

    return { lookupKey, index, columnMap };
  });

  const rows = primary.rows.map((row) => {
    const merged: Row = {};
    for (const column of outputColumns) {
      merged[column] = "";
    }
    for (const column of primary.columns) {
      merged[column] = row[column] ?? "";
    }

    const tokens = tokenizeJoinValue(row[primaryKey] ?? "");
    for (const descriptor of lookupDescriptors) {
      const matchedRows = tokens.flatMap((token) => descriptor.index.get(token) ?? []);
      for (const [sourceColumn, outputColumn] of descriptor.columnMap.entries()) {
        const values = Array.from(
          new Set(
            matchedRows
              .map((lookupRow) => lookupRow[sourceColumn] ?? "")
              .map((value) => value.trim())
              .filter((value) => value !== "")
          )
        );
        merged[outputColumn] = values.join("|");
      }
    }

    return merged;
  });

  return { rows, columns: outputColumns, conflicts };
}

function mergeSideBySide(files: ParsedFile[]): { rows: Row[]; columns: string[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const columns: string[] = [];
  const fileColumnMaps = new Map<string, Map<string, string>>();

  for (const file of files) {
    const suffix = path.basename(file.name, path.extname(file.name));
    const map = new Map<string, string>();
    for (const column of file.columns) {
      const existing = columns.find((candidate) => normalizeColumnKey(candidate) === normalizeColumnKey(column));
      const output = existing ? `${column}_${suffix}` : column;
      if (existing) {
        conflicts.push({
          column,
          resolution: `Renamed ${file.name} column to ${output}`,
        });
      }
      map.set(column, output);
      columns.push(output);
    }
    fileColumnMaps.set(file.name, map);
  }

  const maxRows = Math.max(...files.map((file) => file.rowCount), 0);
  const rows: Row[] = [];
  for (let index = 0; index < maxRows; index += 1) {
    const row: Row = {};
    for (const file of files) {
      const source = file.rows[index] ?? {};
      const columnMap = fileColumnMaps.get(file.name)!;
      for (const [sourceColumn, outputColumn] of columnMap.entries()) {
        row[outputColumn] = source[sourceColumn] ?? "";
      }
    }
    rows.push(row);
  }

  return { rows, columns, conflicts };
}

function writeCsv(outputPath: string, columns: string[], rows: Row[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outputPath, { encoding: "utf8" });
    stream.on("error", reject);
    stream.write(`${columns.map(escapeCsvField).join(",")}\n`);

    for (const row of rows) {
      stream.write(`${columns.map((column) => escapeCsvField(row[column] ?? "")).join(",")}\n`);
    }

    stream.end(() => resolve());
  });
}

async function streamJsonlToCsv(jsonlPath: string, outputPath: string, columns: string[]): Promise<number> {
  const reader = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const writer = fs.createWriteStream(outputPath, { encoding: "utf8" });
  writer.write(`${columns.map(escapeCsvField).join(",")}\n`);

  let rowCount = 0;
  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as Row;
    writer.write(`${columns.map((column) => escapeCsvField(row[column] ?? "")).join(",")}\n`);
    rowCount += 1;
  }

  await new Promise<void>((resolve) => writer.end(() => resolve()));
  return rowCount;
}

async function main(): Promise<void> {
  console.log("=== Scientific-DBLP Data Merger ===");
  ensureDirectories();

  const inputFiles = detectInputFiles(INPUT_DIR);
  if (inputFiles.length === 0) {
    throw new Error(`No supported data files found in ${INPUT_DIR}`);
  }

  console.log(`Found ${inputFiles.length} input data file(s):`);
  for (const file of inputFiles) {
    console.log(`  - ${file.name} (${file.format}, ${formatBytes(file.sizeBytes)})`);
  }

  const supplementaryFiles = await indexSupplementaryFiles();
  if (supplementaryFiles.length > 0) {
    fs.writeFileSync(SUPP_INDEX_OUTPUT, JSON.stringify(supplementaryFiles, null, 2), "utf8");
    console.log(`Indexed ${supplementaryFiles.length} supplementary file(s):`);
    for (const file of supplementaryFiles) {
      console.log(`  - ${file.name} (${file.format})`);
    }
  } else {
    console.log("No supplementary files found.");
  }

  const singleXml = inputFiles.length === 1 && inputFiles[0].format === "xml";
  if (singleXml) {
    const xmlFile = inputFiles[0];
    const schema = getXmlSchemaInfo(xmlFile);
    if (isDblpXml(xmlFile, schema)) {
      console.log("Detected DBLP-style XML dataset. Using SAX streaming single-file conversion.");
      const start = Date.now();
      const result = await streamDblpXmlToCsv(xmlFile, schema, MERGED_OUTPUT);
      const report: MergeReport = {
        strategy: "single-conversion",
        inputFiles: [
          {
            name: xmlFile.name,
            format: xmlFile.format,
            sizeBytes: xmlFile.sizeBytes,
            rows: result.rowCount,
            columns: result.columns,
            hasHeader: false,
          },
        ],
        outputRows: result.rowCount,
        outputColumns: result.columns.length,
        conflicts: [],
        joinKeys: [],
        streamingUsed: true,
        chunkSize: CHUNK_SIZE,
        supplementaryFiles: supplementaryFiles.map((file) => ({
          name: file.name,
          format: file.format,
          description: file.description,
        })),
      };
      fs.writeFileSync(REPORT_OUTPUT, JSON.stringify(report, null, 2), "utf8");

      const seconds = ((Date.now() - start) / 1000).toFixed(1);
      console.log("Summary:");
      console.log("  Strategy: single-conversion");
      console.log(`  Output rows: ${formatNumber(result.rowCount)}`);
      console.log(`  Output columns: ${result.columns.length}`);
      console.log("  Streaming used: yes");
      console.log(`  Time elapsed: ${seconds}s`);
      console.log(`  Merged CSV: ${MERGED_OUTPUT}`);
      console.log(`  Merge report: ${REPORT_OUTPUT}`);
      if (supplementaryFiles.length > 0) {
        console.log(`  Supplementary index: ${SUPP_INDEX_OUTPUT}`);
      }
      return;
    }
  }

  const sharedSchemas = new Map<string, string[]>();
  const parsedFiles: ParsedFile[] = [];
  for (const file of inputFiles) {
    const parsed = await parseFile(file, supplementaryFiles, sharedSchemas);
    if (parsed.tempJsonlPath && parsed.rowCount <= CHUNK_SIZE * 4) {
      parsed.rows = await materializeRowsFromTempJsonl(parsed);
    }
    parsedFiles.push(parsed);
    console.log(`    -> ${formatNumber(parsed.rowCount)} rows, ${parsed.columns.length} columns`);
  }

  const joinKeys = detectJoinKeys(parsedFiles);
  const strategy = determineStrategy(parsedFiles, joinKeys);
  const streamingUsed = parsedFiles.some((file) => file.streamingUsed);
  console.log(`Selected strategy: ${strategy}`);
  if (joinKeys.length > 0) {
    console.log(`Join key candidates: ${joinKeys.join(", ")}`);
  }
  const sharedColumns = getSharedColumns(parsedFiles);
  if (sharedColumns.length > 0) {
    console.log(`Shared columns: ${sharedColumns.join(", ")}`);
  }

  let outputRows = 0;
  let outputColumns: string[] = [];
  let conflicts: Conflict[] = [];

  if (strategy === "single-conversion" && parsedFiles[0].tempJsonlPath) {
    outputColumns = parsedFiles[0].columns;
    outputRows = await streamJsonlToCsv(parsedFiles[0].tempJsonlPath, MERGED_OUTPUT, outputColumns);
  } else {
    for (const parsed of parsedFiles) {
      if (parsed.rows.length === 0 && parsed.tempJsonlPath) {
        parsed.rows = await materializeRowsFromTempJsonl(parsed);
      }
    }

    let mergedRows: Row[] = [];
    if (strategy === "single-conversion") {
      mergedRows = parsedFiles[0].rows;
      outputColumns = parsedFiles[0].columns;
    } else if (strategy === "union") {
      const merged = mergeUnion(parsedFiles);
      mergedRows = merged.rows;
      outputColumns = merged.columns;
      conflicts = merged.conflicts;
    } else if (strategy === "join") {
      const merged = mergeJoin(parsedFiles, joinKeys);
      mergedRows = merged.rows;
      outputColumns = merged.columns;
      conflicts = merged.conflicts;
    } else {
      const merged = mergeSideBySide(parsedFiles);
      mergedRows = merged.rows;
      outputColumns = merged.columns;
      conflicts = merged.conflicts;
    }

    await writeCsv(MERGED_OUTPUT, outputColumns, mergedRows);
    outputRows = mergedRows.length;
  }

  const report: MergeReport = {
    strategy,
    inputFiles: parsedFiles.map((file) => ({
      name: file.name,
      format: file.format,
      sizeBytes: file.sizeBytes,
      rows: file.rowCount,
      columns: file.columns,
      hasHeader: file.hasHeader,
    })),
    outputRows,
    outputColumns: outputColumns.length,
    conflicts,
    joinKeys,
    streamingUsed,
    chunkSize: CHUNK_SIZE,
    supplementaryFiles: supplementaryFiles.map((file) => ({
      name: file.name,
      format: file.format,
      description: file.description,
    })),
  };

  fs.writeFileSync(REPORT_OUTPUT, JSON.stringify(report, null, 2), "utf8");

  console.log("Summary:");
  console.log(`  Strategy: ${strategy}`);
  console.log(`  Output rows: ${formatNumber(outputRows)}`);
  console.log(`  Output columns: ${outputColumns.length}`);
  console.log(`  Streaming used: ${streamingUsed ? "yes" : "no"}`);
  console.log(`  Merged CSV: ${MERGED_OUTPUT}`);
  console.log(`  Merge report: ${REPORT_OUTPUT}`);
  if (supplementaryFiles.length > 0) {
    console.log(`  Supplementary index: ${SUPP_INDEX_OUTPUT}`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
