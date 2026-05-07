import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";
import { parse } from "csv-parse";

type PrimitiveType = "string" | "integer" | "float" | "date" | "boolean" | "url" | "mixed";
type Row = Record<string, string>;
type UniqueCountMethod = "exact" | "approximate";

interface NumericStats {
  min: number;
  max: number;
  mean: number;
}

interface ColumnProfile {
  name: string;
  inferredType: PrimitiveType;
  nonMissingCount: number;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  uniqueCountMethod: UniqueCountMethod;
  sampleValues: string[];
  numericStats?: NumericStats;
  relatedSupplementaryFile?: string;
  supplementaryContext?: string;
}

interface DatasetProfile {
  datasetPath: string;
  totalRows: number;
  totalColumns: number;
  fileSizeBytes: number;
  generatedAt: string;
  profilingTimeSec: number;
  supplementaryIndexPath: string;
  supplementaryFilesLoaded: boolean;
  supplementaryFilesInspected: string[];
  columns: ColumnProfile[];
}

interface SupplementaryFileEntry {
  name: string;
  path: string;
  format: string;
  description?: string;
  columns?: string[];
  rowCount?: number;
}

interface SupplementaryLookup {
  file: SupplementaryFileEntry;
  valueColumns: string[];
  descriptiveColumns: string[];
  values: Set<string>;
  context: string;
}

interface TypeCounts {
  string: number;
  integer: number;
  float: number;
  date: number;
  boolean: number;
  url: number;
}

interface UniqueTracker {
  mode: UniqueCountMethod;
  exactValues?: Set<string>;
  registers?: Uint8Array;
}

interface ColumnAccumulator {
  name: string;
  nonMissingCount: number;
  missingCount: number;
  typeCounts: TypeCounts;
  numericCount: number;
  numericSum: number;
  numericMin: number;
  numericMax: number;
  sampleValues: string[];
  sampleSet: Set<string>;
  uniqueTracker: UniqueTracker;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/scientific-dblp";
const INPUT_FILE = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, "dataset-profile.json");
const SUPPLEMENTARY_INDEX_FILE = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const SAMPLE_LIMIT = 5;
const PROGRESS_INTERVAL = 500_000;
const MAX_EXACT_UNIQUES = 20_000;
const SUPPLEMENTARY_ROW_LIMIT = 20_000;
const SUPPLEMENTARY_VALUE_LIMIT = 100_000;
const HLL_PRECISION = 12;
const HLL_REGISTERS = 1 << HLL_PRECISION;
const HLL_ALPHA = 0.7213 / (1 + 1.079 / HLL_REGISTERS);
const MISSING_TOKENS = new Set(["", "null", "n/a", "na", "none"]);
const DATE_PATTERNS = [/^\d{4}-\d{2}-\d{2}$/, /^\d{4}\/\d{2}\/\d{2}$/, /^\d{4}$/];
const BOOLEAN_TOKENS = new Set(["true", "false", "yes", "no", "y", "n", "0", "1"]);

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const ensureDirectory = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const cleanCell = (value: unknown): string => String(value ?? "").trim();

const isMissing = (value: string): boolean => MISSING_TOKENS.has(value.trim().toLowerCase());

const isInteger = (value: string): boolean => /^-?\d+$/.test(value);

const isFloat = (value: string): boolean => /^-?(?:\d+\.\d+|\d+)$/.test(value);

const isDate = (value: string): boolean => DATE_PATTERNS.some((pattern) => pattern.test(value));

const isBoolean = (value: string): boolean => BOOLEAN_TOKENS.has(value.toLowerCase());

const isUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value);

const classifyValue = (value: string): Exclude<PrimitiveType, "mixed"> => {
  if (isBoolean(value)) return "boolean";
  if (isInteger(value)) return "integer";
  if (isFloat(value)) return value.includes(".") ? "float" : "integer";
  if (isDate(value)) return "date";
  if (isUrl(value)) return "url";
  return "string";
};

const inferType = (typeCounts: TypeCounts): PrimitiveType => {
  const total = Object.values(typeCounts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return "string";

  const ordered = (Object.entries(typeCounts) as [Exclude<PrimitiveType, "mixed">, number][])
    .sort((left, right) => right[1] - left[1]);
  const [topType, topCount] = ordered[0];

  if (topCount === total) {
    return topType;
  }

  if ((typeCounts.integer + typeCounts.float) / total >= 0.95) {
    return typeCounts.float > 0 ? "float" : "integer";
  }

  if (topCount / total >= 0.95) {
    return topType;
  }

  return "mixed";
};

const createTypeCounts = (): TypeCounts => ({
  string: 0,
  integer: 0,
  float: 0,
  date: 0,
  boolean: 0,
  url: 0,
});

const createUniqueTracker = (): UniqueTracker => ({
  mode: "exact",
  exactValues: new Set<string>(),
});

const fnv1a32 = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const createRegisters = (): Uint8Array => new Uint8Array(HLL_REGISTERS);

const hllRank = (hash: number): number => {
  const shifted = (hash << HLL_PRECISION) >>> 0;
  return Math.min(32 - HLL_PRECISION + 1, Math.clz32(shifted) + 1);
};

const updateRegisters = (registers: Uint8Array, value: string): void => {
  const hash = fnv1a32(value);
  const index = hash >>> (32 - HLL_PRECISION);
  const rank = hllRank(hash);
  if (rank > registers[index]) {
    registers[index] = rank;
  }
};

const exactToApproximate = (values: Iterable<string>): UniqueTracker => {
  const registers = createRegisters();
  for (const value of values) {
    updateRegisters(registers, value);
  }
  return {
    mode: "approximate",
    registers,
  };
};

const updateUniqueTracker = (tracker: UniqueTracker, value: string): void => {
  if (tracker.mode === "exact") {
    tracker.exactValues?.add(value);
    if ((tracker.exactValues?.size ?? 0) > MAX_EXACT_UNIQUES) {
      const approximate = exactToApproximate(tracker.exactValues ?? []);
      tracker.mode = approximate.mode;
      tracker.registers = approximate.registers;
      delete tracker.exactValues;
    }
    return;
  }

  if (tracker.registers) {
    updateRegisters(tracker.registers, value);
  }
};

const estimateUniqueCount = (tracker: UniqueTracker): { count: number; method: UniqueCountMethod } => {
  if (tracker.mode === "exact") {
    return {
      count: tracker.exactValues?.size ?? 0,
      method: "exact",
    };
  }

  const registers = tracker.registers ?? createRegisters();
  let harmonicDenominator = 0;
  let zeroCount = 0;

  for (const register of registers) {
    harmonicDenominator += 2 ** -register;
    if (register === 0) {
      zeroCount += 1;
    }
  }

  let estimate = HLL_ALPHA * HLL_REGISTERS * HLL_REGISTERS / harmonicDenominator;

  if (estimate <= 2.5 * HLL_REGISTERS && zeroCount > 0) {
    estimate = HLL_REGISTERS * Math.log(HLL_REGISTERS / zeroCount);
  }

  if (estimate > (2 ** 32) / 30) {
    estimate = -(2 ** 32) * Math.log(1 - estimate / 2 ** 32);
  }

  return {
    count: Math.max(0, Math.round(estimate)),
    method: "approximate",
  };
};

const createColumnAccumulator = (name: string): ColumnAccumulator => ({
  name,
  nonMissingCount: 0,
  missingCount: 0,
  typeCounts: createTypeCounts(),
  numericCount: 0,
  numericSum: 0,
  numericMin: Number.POSITIVE_INFINITY,
  numericMax: Number.NEGATIVE_INFINITY,
  sampleValues: [],
  sampleSet: new Set<string>(),
  uniqueTracker: createUniqueTracker(),
});

const updateColumnAccumulator = (accumulator: ColumnAccumulator, rawValue: unknown): void => {
  const value = cleanCell(rawValue);

  if (isMissing(value)) {
    accumulator.missingCount += 1;
    return;
  }

  accumulator.nonMissingCount += 1;
  updateUniqueTracker(accumulator.uniqueTracker, value);

  if (accumulator.sampleValues.length < SAMPLE_LIMIT && !accumulator.sampleSet.has(value)) {
    accumulator.sampleValues.push(value);
    accumulator.sampleSet.add(value);
  }

  const valueType = classifyValue(value);
  accumulator.typeCounts[valueType] += 1;

  if (valueType === "integer" || valueType === "float") {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      accumulator.numericCount += 1;
      accumulator.numericSum += numericValue;
      accumulator.numericMin = Math.min(accumulator.numericMin, numericValue);
      accumulator.numericMax = Math.max(accumulator.numericMax, numericValue);
    }
  }
};

const normalizeSupplementaryEntries = (raw: unknown, indexPath: string): SupplementaryFileEntry[] => {
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>).files ??
          (raw as Record<string, unknown>).supplementaryFiles ??
          []) as unknown[]
      : [];

  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const rawPath = String(entry.path ?? entry.filePath ?? entry.location ?? "").trim();
      const resolvedPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(path.dirname(indexPath), rawPath);
      return {
        name: String(entry.name ?? path.basename(rawPath || "unknown")).trim(),
        path: resolvedPath,
        format: String(entry.format ?? path.extname(rawPath).replace(/^\./, "")).trim().toLowerCase(),
        description: typeof entry.description === "string" ? entry.description : undefined,
        columns: Array.isArray(entry.columns) ? entry.columns.map((value) => String(value)) : undefined,
        rowCount: typeof entry.rowCount === "number" ? entry.rowCount : undefined,
      };
    })
    .filter((entry) => entry.path.length > 0 && fs.existsSync(entry.path));
};

const loadSupplementaryIndex = (indexPath: string): SupplementaryFileEntry[] => {
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const text = fs.readFileSync(indexPath, "utf8");
  return normalizeSupplementaryEntries(JSON.parse(text), indexPath);
};

const isLookupCandidateColumn = (columnName: string): boolean =>
  /(code|id|identifier|key|type|class|category|country|admin|status|kind|role)/i.test(columnName);

const isLookupDescriptionColumn = (columnName: string): boolean =>
  /(label|name|title|description|meaning|definition|term)/i.test(columnName);

const looksLikeLookupFile = (file: SupplementaryFileEntry): boolean => {
  const haystack = [file.name, file.description ?? "", ...(file.columns ?? [])].join(" ").toLowerCase();
  return /(code|label|lookup|reference|category|country|admin|status|type|definition|mapping)/.test(haystack);
};

const parseDelimitedText = (text: string, delimiter: string): Row[] => {
  const result = Papa.parse<Row>(text, {
    header: true,
    delimiter,
    skipEmptyLines: true,
    preview: SUPPLEMENTARY_ROW_LIMIT,
    transformHeader: (header) => header.trim(),
  });

  if (result.errors.length > 0) {
    throw new Error(result.errors[0].message);
  }

  return result.data.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim(), cleanCell(value)])),
  );
};

const parseJsonRows = (text: string): Row[] => {
  const parsed = JSON.parse(text) as unknown;

  if (Array.isArray(parsed)) {
    return parsed
      .slice(0, SUPPLEMENTARY_ROW_LIMIT)
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), cleanCell(value)])));
  }

  if (typeof parsed === "object" && parsed !== null) {
    const firstArray = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
    if (Array.isArray(firstArray)) {
      return firstArray
        .slice(0, SUPPLEMENTARY_ROW_LIMIT)
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), cleanCell(value)])));
    }
  }

  return [];
};

const parseJsonlRows = (text: string): Row[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, SUPPLEMENTARY_ROW_LIMIT)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), cleanCell(value)])));

const parseSupplementaryRows = (file: SupplementaryFileEntry): Row[] => {
  if (!looksLikeLookupFile(file) || !fs.existsSync(file.path)) {
    return [];
  }

  const stat = fs.statSync(file.path);
  if (stat.size > 25 * 1024 * 1024) {
    return [];
  }

  const text = fs.readFileSync(file.path, "utf8");
  const extension = path.extname(file.path).toLowerCase();
  const format = file.format || extension.replace(/^\./, "");

  if (format === "csv" || extension === ".csv") {
    return parseDelimitedText(text, ",");
  }

  if (format === "tsv" || extension === ".tsv" || extension === ".tab") {
    return parseDelimitedText(text, "\t");
  }

  if (format === "json" || extension === ".json") {
    return parseJsonRows(text);
  }

  if (format === "jsonl") {
    return parseJsonlRows(text);
  }

  return [];
};

const normalizeLookupValue = (value: string): string => value.trim().toLowerCase();

const buildSupplementaryContext = (
  file: SupplementaryFileEntry,
  valueColumns: string[],
  descriptiveColumns: string[],
): string =>
  [
    file.description,
    valueColumns.length > 0 ? `lookup columns: ${valueColumns.join(", ")}` : undefined,
    descriptiveColumns.length > 0 ? `descriptions: ${descriptiveColumns.join(", ")}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ");

const buildSupplementaryLookup = (file: SupplementaryFileEntry): SupplementaryLookup | null => {
  const rows = parseSupplementaryRows(file);
  if (rows.length === 0) {
    return null;
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((column) => set.add(column));
      return set;
    }, new Set<string>()),
  );

  const valueColumns = columns.filter(isLookupCandidateColumn);
  const descriptiveColumns = columns.filter(isLookupDescriptionColumn);
  const chosenValueColumns = valueColumns.length > 0 ? valueColumns : columns.slice(0, 1);

  const values = new Set<string>();
  for (const row of rows) {
    for (const column of chosenValueColumns) {
      const value = normalizeLookupValue(cleanCell(row[column]));
      if (value.length > 0) {
        values.add(value);
      }
      if (values.size >= SUPPLEMENTARY_VALUE_LIMIT) {
        break;
      }
    }
    if (values.size >= SUPPLEMENTARY_VALUE_LIMIT) {
      break;
    }
  }

  if (values.size === 0) {
    return null;
  }

  return {
    file,
    valueColumns: chosenValueColumns,
    descriptiveColumns,
    values,
    context: buildSupplementaryContext(file, chosenValueColumns, descriptiveColumns),
  };
};

const sampleLooksCodeLike = (samples: string[]): boolean =>
  samples.some((sample) => /^[A-Z0-9._:-]{2,20}$/i.test(sample) && !/\s/.test(sample));

const columnLooksCodeLike = (columnName: string, samples: string[]): boolean =>
  isLookupCandidateColumn(columnName) || sampleLooksCodeLike(samples);

const findRelatedSupplementaryLookup = (
  columnName: string,
  sampleValues: string[],
  lookups: SupplementaryLookup[],
): { relatedSupplementaryFile?: string; supplementaryContext?: string } => {
  if (!columnLooksCodeLike(columnName, sampleValues) || sampleValues.length === 0) {
    return {};
  }

  const normalizedSamples = sampleValues.map(normalizeLookupValue).filter((value) => value.length > 0);
  const matches = lookups
    .map((lookup) => {
      const valueMatches = normalizedSamples.filter((sample) => lookup.values.has(sample)).length;
      const nameMatches =
        lookup.file.name.toLowerCase().includes(columnName.toLowerCase()) ||
        lookup.valueColumns.some((column) => column.toLowerCase() === columnName.toLowerCase()) ||
        (lookup.file.columns ?? []).some((column) => column.toLowerCase() === columnName.toLowerCase());

      return {
        lookup,
        score: valueMatches * 10 + (nameMatches ? 3 : 0),
      };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);

  if (matches.length === 0) {
    return {};
  }

  return {
    relatedSupplementaryFile: matches[0].lookup.file.name,
    supplementaryContext: matches[0].lookup.context || undefined,
  };
};

const finalizeColumnProfile = (
  accumulator: ColumnAccumulator,
  totalRows: number,
  lookups: SupplementaryLookup[],
): ColumnProfile => {
  const inferredType = inferType(accumulator.typeCounts);
  const unique = estimateUniqueCount(accumulator.uniqueTracker);
  const lookupInfo = findRelatedSupplementaryLookup(accumulator.name, accumulator.sampleValues, lookups);

  return {
    name: accumulator.name,
    inferredType,
    nonMissingCount: accumulator.nonMissingCount,
    missingCount: accumulator.missingCount,
    missingPercent: totalRows === 0 ? 0 : Number(((accumulator.missingCount / totalRows) * 100).toFixed(2)),
    uniqueCount: unique.count,
    uniqueCountMethod: unique.method,
    sampleValues: accumulator.sampleValues,
    numericStats:
      inferredType === "integer" || inferredType === "float"
        ? {
            min: accumulator.numericMin,
            max: accumulator.numericMax,
            mean: Number((accumulator.numericSum / Math.max(accumulator.numericCount, 1)).toFixed(4)),
          }
        : undefined,
    relatedSupplementaryFile: lookupInfo.relatedSupplementaryFile,
    supplementaryContext: lookupInfo.supplementaryContext,
  };
};

const summarizeProfile = (profile: DatasetProfile): string => {
  const numericColumns = profile.columns.filter((column) => column.numericStats);
  const linkedColumns = profile.columns.filter((column) => column.relatedSupplementaryFile);
  const mostMissing = [...profile.columns]
    .sort((left, right) => right.missingCount - left.missingCount)
    .slice(0, 5)
    .map((column) => `${column.name} (${formatNumber(column.missingCount)})`);

  return [
    "Dataset profile completed",
    `Dataset: ${profile.datasetPath}`,
    `File size: ${formatBytes(profile.fileSizeBytes)}`,
    `Rows: ${formatNumber(profile.totalRows)}`,
    `Columns: ${formatNumber(profile.totalColumns)}`,
    `Profile time: ${profile.profilingTimeSec}s`,
    `Supplementary index loaded: ${profile.supplementaryFilesLoaded ? "yes" : "no"}`,
    `Supplementary files inspected: ${profile.supplementaryFilesInspected.join(", ") || "none"}`,
    `Numeric columns: ${numericColumns.map((column) => column.name).join(", ") || "none"}`,
    `Columns linked to supplementary files: ${linkedColumns.map((column) => `${column.name} -> ${column.relatedSupplementaryFile}`).join(", ") || "none"}`,
    `Most missing columns: ${mostMissing.join(", ") || "none"}`,
  ].join("\n");
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const buildColumnAccumulators = (headers: string[]): ColumnAccumulator[] => headers.map(createColumnAccumulator);

const profileDataset = async (
  inputPath: string,
  lookups: SupplementaryLookup[],
  supplementaryFiles: SupplementaryFileEntry[],
): Promise<DatasetProfile> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const fileSizeBytes = fs.statSync(inputPath).size;
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
      trim: false,
    });

    let totalRows = 0;
    let headers: string[] = [];
    let accumulators: ColumnAccumulator[] = [];

    parser.on("readable", () => {
      let row: Row | null = parser.read();
      while (row !== null) {
        if (headers.length === 0) {
          headers = Object.keys(row).map((header) => header.trim());
          accumulators = buildColumnAccumulators(headers);
        }

        for (let index = 0; index < headers.length; index += 1) {
          const header = headers[index];
          updateColumnAccumulator(accumulators[index], row[header] ?? "");
        }

        totalRows += 1;
        if (totalRows % PROGRESS_INTERVAL === 0) {
          console.log(`Processed ${formatNumber(totalRows)} rows...`);
        }

        row = parser.read();
      }
    });

    parser.on("error", (error) => reject(error));
    parser.on("end", () => {
      const profile: DatasetProfile = {
        datasetPath: inputPath,
        totalRows,
        totalColumns: headers.length,
        fileSizeBytes,
        generatedAt: new Date().toISOString(),
        profilingTimeSec: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        supplementaryIndexPath: SUPPLEMENTARY_INDEX_FILE,
        supplementaryFilesLoaded: supplementaryFiles.length > 0,
        supplementaryFilesInspected: supplementaryFiles.map((file) => file.name),
        columns: accumulators.map((accumulator) => finalizeColumnProfile(accumulator, totalRows, lookups)),
      };

      resolve(profile);
    });

    fs.createReadStream(inputPath, {
      encoding: "utf8",
      highWaterMark: 256 * 1024,
    })
      .on("error", reject)
      .pipe(parser);
  });

const main = async (): Promise<void> => {
  ensureDirectory(OUTPUT_DIR);

  const supplementaryFiles = loadSupplementaryIndex(SUPPLEMENTARY_INDEX_FILE);
  const supplementaryLookups = supplementaryFiles
    .map((file) => {
      try {
        return buildSupplementaryLookup(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Skipping supplementary file ${file.name}: ${message}`);
        return null;
      }
    })
    .filter((lookup): lookup is SupplementaryLookup => lookup !== null);

  const profile = await profileDataset(INPUT_FILE, supplementaryLookups, supplementaryFiles);
  writeJson(OUTPUT_FILE, profile);
  console.log(summarizeProfile(profile));
  console.log(`\nProfile written to ${OUTPUT_FILE}`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
