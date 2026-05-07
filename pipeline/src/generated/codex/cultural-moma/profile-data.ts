import * as fs from "fs";
import * as path from "path";
import * as Papa from "papaparse";

type PrimitiveType = "string" | "integer" | "float" | "date" | "boolean" | "url" | "mixed";
type Row = Record<string, string>;

interface NumericStats {
  min: number;
  max: number;
  mean: number;
}

interface ColumnProfile {
  name: string;
  inferredType: PrimitiveType;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  relatedSupplementaryFile?: string;
  supplementaryContext?: string;
  numericStats?: NumericStats;
}

interface DatasetProfile {
  datasetPath: string;
  totalRows: number;
  totalColumns: number;
  generatedAt: string;
  supplementaryIndexPath: string;
  supplementaryFilesLoaded: boolean;
  supplementaryFilesInspected: string[];
  columns: ColumnProfile[];
}

interface NormalizedSupplementaryFile {
  name: string;
  path: string;
  format: string;
  description?: string;
  columns?: string[];
  rowCount?: number;
}

interface SupplementaryLookup {
  file: NormalizedSupplementaryFile;
  valueColumns: string[];
  values: Set<string>;
  context: string;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
const INPUT_FILE = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, "dataset-profile.json");
const SUPPLEMENTARY_INDEX_FILE = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const SAMPLE_LIMIT = 5;
const LOOKUP_VALUE_LIMIT = 20_000;
const LOOKUP_ROW_LIMIT = 10_000;
const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{4}\/\d{2}\/\d{2}$/,
  /^\d{4}$/,
];
const BOOLEAN_TRUE = new Set(["true", "false", "y", "n", "yes", "no"]);
const MISSING_TOKENS = new Set(["", "null", "n/a", "na"]);

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const toMissing = (value: string): boolean => MISSING_TOKENS.has(value.trim().toLowerCase());

const isInteger = (value: string): boolean => /^-?\d+$/.test(value);

const isFloat = (value: string): boolean => /^-?(?:\d+\.\d+|\d+)$/.test(value);

const isDate = (value: string): boolean => DATE_PATTERNS.some((pattern) => pattern.test(value));

const isUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value);

const isBoolean = (value: string): boolean => BOOLEAN_TRUE.has(value.toLowerCase());

const classifyValue = (value: string): Exclude<PrimitiveType, "mixed"> => {
  if (isBoolean(value)) return "boolean";
  if (isInteger(value)) return "integer";
  if (isFloat(value)) return value.includes(".") ? "float" : "integer";
  if (isDate(value)) return "date";
  if (isUrl(value)) return "url";
  return "string";
};

const inferType = (counts: Record<Exclude<PrimitiveType, "mixed">, number>): PrimitiveType => {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return "string";

  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topType, topCount] = ordered[0];

  if (topCount === total) {
    return topType as PrimitiveType;
  }

  if ((counts.integer + counts.float) / total >= 0.95) {
    return counts.float > 0 ? "float" : "integer";
  }

  if (topCount / total >= 0.95) {
    return topType as PrimitiveType;
  }

  return "mixed";
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const toNumericStats = (values: number[]): NumericStats | undefined => {
  if (values.length === 0) return undefined;
  const { min, max } = values.reduce(
    (range, value) => ({
      min: value < range.min ? value : range.min,
      max: value > range.max ? value : range.max,
    }),
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
  );
  return {
    min,
    max,
    mean: Number(mean(values).toFixed(4)),
  };
};

const normalizeLookupValue = (value: string): string => value.trim().toLowerCase();

const isCodeLikeColumnName = (name: string): boolean =>
  /(^|[\s_])(id|code|qid|ulan|key|identifier|type|classification|department|gender|nationality|cataloged|onview)([\s_]|$)/i.test(
    name,
  );

const isLookupDescriptionColumn = (name: string): boolean =>
  /(label|name|description|meaning|title|category|definition)/i.test(name);

const isLookupValueColumn = (name: string): boolean =>
  /(code|id|qid|ulan|key|identifier|type|classification|department|gender|nationality|cataloged|onview)/i.test(name);

const cleanCell = (value: unknown): string => String(value ?? "").trim();

const readTextFile = (filePath: string): string => fs.readFileSync(filePath, "utf8");

const parseCsv = (text: string, delimiter = ","): Row[] => {
  const result = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true,
    delimiter,
  });

  if (result.errors.length > 0) {
    throw new Error(`Failed to parse CSV data: ${result.errors[0].message}`);
  }

  return result.data.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim(), cleanCell(value)])),
  );
};

const parseJsonRows = (text: string): Row[] => {
  const parsed = JSON.parse(text) as unknown;

  if (Array.isArray(parsed)) {
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) =>
        Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), cleanCell(value)])),
      );
  }

  if (typeof parsed === "object" && parsed !== null) {
    const container = parsed as Record<string, unknown>;
    const firstArray = Object.values(container).find(Array.isArray);
    if (Array.isArray(firstArray)) {
      return firstArray
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) =>
          Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), cleanCell(value)])),
        );
    }
  }

  return [];
};

const parseJsonlRows = (text: string): Row[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, LOOKUP_ROW_LIMIT)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), cleanCell(value)])));

const parseSupplementaryRows = (file: NormalizedSupplementaryFile): Row[] => {
  if (!fs.existsSync(file.path)) {
    return [];
  }

  const text = readTextFile(file.path);
  const extension = path.extname(file.path).toLowerCase();

  if (file.format === "csv" || extension === ".csv") {
    return parseCsv(text, ",").slice(0, LOOKUP_ROW_LIMIT);
  }

  if (file.format === "tsv" || extension === ".tsv" || extension === ".tab") {
    return parseCsv(text, "\t").slice(0, LOOKUP_ROW_LIMIT);
  }

  if (file.format === "json" || extension === ".json") {
    return parseJsonRows(text).slice(0, LOOKUP_ROW_LIMIT);
  }

  if (file.format === "jsonl") {
    return parseJsonlRows(text);
  }

  return [];
};

const normalizeSupplementaryIndex = (
  raw: unknown,
  indexPath: string,
): NormalizedSupplementaryFile[] => {
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
      const resolvedPath = rawPath
        ? path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(path.dirname(indexPath), rawPath)
        : "";

      return {
        name: String(entry.name ?? path.basename(rawPath || "unknown")).trim(),
        path: resolvedPath,
        format: String(entry.format ?? path.extname(rawPath).replace(/^\./, "") ?? "").trim().toLowerCase(),
        description: typeof entry.description === "string" ? entry.description : undefined,
        columns: Array.isArray(entry.columns) ? entry.columns.map((value) => String(value)) : undefined,
        rowCount: typeof entry.rowCount === "number" ? entry.rowCount : undefined,
      };
    })
    .filter((entry) => entry.path.length > 0);
};

const loadSupplementaryFiles = (indexPath: string): NormalizedSupplementaryFile[] => {
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  return normalizeSupplementaryIndex(JSON.parse(readTextFile(indexPath)), indexPath);
};

const buildLookupContext = (file: NormalizedSupplementaryFile, columns: string[]): string => {
  const columnText = columns.length > 0 ? `lookup columns: ${columns.join(", ")}` : "lookup columns not identified";
  return [file.description, columnText].filter(Boolean).join(" | ");
};

const buildSupplementaryLookup = (file: NormalizedSupplementaryFile): SupplementaryLookup | null => {
  const rows = parseSupplementaryRows(file);
  if (rows.length === 0) {
    return null;
  }

  const columns = Array.from(
    rows.reduce((all, row) => {
      Object.keys(row).forEach((key) => all.add(key));
      return all;
    }, new Set<string>()),
  );

  const candidateColumns = columns.filter((column) => isLookupValueColumn(column) || isLookupDescriptionColumn(column));
  const valueColumns = candidateColumns.length > 0 ? candidateColumns : columns.slice(0, 2);

  const values = rows.reduce((set, row) => {
    valueColumns.forEach((column) => {
      const value = cleanCell(row[column]);
      if (value.length > 0 && set.size < LOOKUP_VALUE_LIMIT) {
        set.add(normalizeLookupValue(value));
      }
    });
    return set;
  }, new Set<string>());

  if (values.size === 0) {
    return null;
  }

  return {
    file,
    valueColumns,
    values,
    context: buildLookupContext(file, valueColumns),
  };
};

const findRelatedLookup = (
  columnName: string,
  sampleValues: string[],
  lookups: SupplementaryLookup[],
): { fileName?: string; context?: string } => {
  if (!isCodeLikeColumnName(columnName)) {
    return {};
  }

  const normalizedSamples = sampleValues.map(normalizeLookupValue).filter((value) => value.length > 0);

  const matches = lookups
    .map((lookup) => {
      const sampleMatches = normalizedSamples.filter((value) => lookup.values.has(value)).length;
      const nameOverlap =
        lookup.valueColumns.some((column) => column.toLowerCase() === columnName.toLowerCase()) ||
        lookup.file.name.toLowerCase().includes(columnName.toLowerCase());

      return {
        lookup,
        score: sampleMatches * 10 + (nameOverlap ? 3 : 0),
      };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    return {};
  }

  return {
    fileName: matches[0].lookup.file.name,
    context: matches[0].lookup.context,
  };
};

const profileColumn = (
  name: string,
  values: string[],
  totalRows: number,
  lookups: SupplementaryLookup[],
): ColumnProfile => {
  const uniqueValues = new Set<string>();
  const sampleValues: string[] = [];
  const numericValues: number[] = [];
  const typeCounts: Record<Exclude<PrimitiveType, "mixed">, number> = {
    string: 0,
    integer: 0,
    float: 0,
    date: 0,
    boolean: 0,
    url: 0,
  };

  let missingCount = 0;

  values.forEach((rawValue) => {
    const value = cleanCell(rawValue);

    if (toMissing(value)) {
      missingCount += 1;
      return;
    }

    uniqueValues.add(value);

    if (sampleValues.length < SAMPLE_LIMIT && !sampleValues.includes(value)) {
      sampleValues.push(value);
    }

    const detectedType = classifyValue(value);
    typeCounts[detectedType] += 1;

    if (detectedType === "integer" || detectedType === "float") {
      numericValues.push(Number(value));
    }
  });

  const inferredType = inferType(typeCounts);
  const numericStats = inferredType === "integer" || inferredType === "float" ? toNumericStats(numericValues) : undefined;
  const lookup = findRelatedLookup(name, sampleValues, lookups);

  return {
    name,
    inferredType,
    missingCount,
    missingPercent: totalRows === 0 ? 0 : Number(((missingCount / totalRows) * 100).toFixed(2)),
    uniqueCount: uniqueValues.size,
    sampleValues,
    relatedSupplementaryFile: lookup.fileName,
    supplementaryContext: lookup.context,
    numericStats,
  };
};

const summarizeProfile = (profile: DatasetProfile): string => {
  const numericColumns = profile.columns.filter((column) => column.numericStats);
  const supplementaryColumns = profile.columns.filter((column) => column.relatedSupplementaryFile);
  const mostMissing = [...profile.columns]
    .sort((a, b) => b.missingCount - a.missingCount)
    .slice(0, 5)
    .map((column) => `${column.name} (${formatNumber(column.missingCount)} missing)`);

  return [
    `Dataset profile for ${profile.datasetPath}`,
    `Rows: ${formatNumber(profile.totalRows)}`,
    `Columns: ${formatNumber(profile.totalColumns)}`,
    `Supplementary index loaded: ${profile.supplementaryFilesLoaded ? "yes" : "no"}`,
    `Supplementary files inspected: ${profile.supplementaryFilesInspected.join(", ") || "none"}`,
    `Numeric columns: ${numericColumns.map((column) => column.name).join(", ") || "none"}`,
    `Columns linked to supplementary files: ${supplementaryColumns.map((column) => `${column.name} -> ${column.relatedSupplementaryFile}`).join(", ") || "none"}`,
    `Most missing columns: ${mostMissing.join(", ") || "none"}`,
  ].join("\n");
};

const ensureOutputDirectory = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const main = (): void => {
  ensureOutputDirectory(OUTPUT_DIR);

  const rows = parseCsv(readTextFile(INPUT_FILE));
  const supplementaryFiles = loadSupplementaryFiles(SUPPLEMENTARY_INDEX_FILE);
  const supplementaryLookups = supplementaryFiles
    .map(buildSupplementaryLookup)
    .filter((lookup): lookup is SupplementaryLookup => lookup !== null);
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  const profile: DatasetProfile = {
    datasetPath: INPUT_FILE,
    totalRows: rows.length,
    totalColumns: headers.length,
    generatedAt: new Date().toISOString(),
    supplementaryIndexPath: SUPPLEMENTARY_INDEX_FILE,
    supplementaryFilesLoaded: supplementaryFiles.length > 0,
    supplementaryFilesInspected: supplementaryFiles.map((file) => file.name),
    columns: headers.map((header) =>
      profileColumn(
        header,
        rows.map((row) => cleanCell(row[header] ?? "")),
        rows.length,
        supplementaryLookups,
      ),
    ),
  };

  writeJson(OUTPUT_FILE, profile);
  console.log(summarizeProfile(profile));
  console.log(`\nProfile written to ${OUTPUT_FILE}`);
};

main();
