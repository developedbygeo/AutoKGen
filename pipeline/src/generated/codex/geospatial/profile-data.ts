import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";

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
  nonMissingCount: number;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  numericStats?: NumericStats;
  relatedSupplementaryFile?: string;
  supplementaryContext?: string;
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
  keys: Set<string>;
  keyColumns: string[];
  descriptiveColumns: string[];
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
  uniqueValues: Set<string>;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/geospatial";
const INPUT_FILE = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, "dataset-profile.json");
const SUPPLEMENTARY_INDEX_FILE = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const SAMPLE_LIMIT = 5;
const SUPPLEMENTARY_ROW_LIMIT = 50_000;
const SUPPLEMENTARY_VALUE_LIMIT = 100_000;
const MISSING_TOKENS = new Set(["", "null", "n/a", "na", "none"]);
const BOOLEAN_TOKENS = new Set(["true", "false", "yes", "no", "y", "n", "0", "1"]);
const DATE_PATTERNS = [/^\d{4}-\d{2}-\d{2}$/, /^\d{4}\/\d{2}\/\d{2}$/, /^\d{4}$/];
const TXT_DELIMITER = "\t";
const GEOSPATIAL_LOOKUP_HINTS: Record<
  string,
  { fileMatchers: RegExp[]; description: string; expectedKeyPrefixes?: string[] }
> = {
  feature_code: {
    fileMatchers: [/featurecodes/i],
    description: "GeoNames feature code definitions",
    expectedKeyPrefixes: ["A.", "H.", "L.", "P.", "R.", "S.", "T.", "U.", "V."],
  },
  country_code: {
    fileMatchers: [/countryinfo/i],
    description: "ISO country code reference",
  },
  cc2: {
    fileMatchers: [/countryinfo/i],
    description: "secondary country code reference",
  },
  admin1_code: {
    fileMatchers: [/admin1/i],
    description: "GeoNames first-order administrative division codes",
  },
};

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const cleanCell = (value: unknown): string => String(value ?? "").trim();

const shortenText = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

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

const createTypeCounts = (): TypeCounts => ({
  string: 0,
  integer: 0,
  float: 0,
  date: 0,
  boolean: 0,
  url: 0,
});

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

const toNumericStats = (accumulator: ColumnAccumulator): NumericStats | undefined => {
  if (accumulator.numericCount === 0) return undefined;
  return {
    min: accumulator.numericMin,
    max: accumulator.numericMax,
    mean: Number((accumulator.numericSum / accumulator.numericCount).toFixed(4)),
  };
};

const createAccumulator = (name: string): ColumnAccumulator => ({
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
  uniqueValues: new Set<string>(),
});

const updateAccumulator = (accumulator: ColumnAccumulator, rawValue: string): ColumnAccumulator => {
  const value = cleanCell(rawValue);

  if (isMissing(value)) {
    accumulator.missingCount += 1;
    return accumulator;
  }

  accumulator.nonMissingCount += 1;
  accumulator.uniqueValues.add(value);

  if (!accumulator.sampleSet.has(value) && accumulator.sampleValues.length < SAMPLE_LIMIT) {
    accumulator.sampleValues.push(value);
    accumulator.sampleSet.add(value);
  }

  const type = classifyValue(value);
  accumulator.typeCounts[type] += 1;

  if (type === "integer" || type === "float") {
    const numericValue = Number(value);
    accumulator.numericCount += 1;
    accumulator.numericSum += numericValue;
    accumulator.numericMin = Math.min(accumulator.numericMin, numericValue);
    accumulator.numericMax = Math.max(accumulator.numericMax, numericValue);
  }

  return accumulator;
};

const createContext = (file: SupplementaryFileEntry, keyColumns: string[], descriptiveColumns: string[]): string => {
  const columnText = keyColumns.join(", ");
  const description = file.description ? shortenText(file.description.trim(), 180) : undefined;

  if (descriptiveColumns.length > 0 && description) {
    return `${file.name} provides lookup values via ${columnText} with descriptive columns ${descriptiveColumns.join(", ")}. ${description}`;
  }

  if (descriptiveColumns.length > 0) {
    return `${file.name} provides lookup values via ${columnText} with descriptive columns ${descriptiveColumns.join(", ")}.`;
  }

  if (description) {
    return `${file.name} provides lookup values via ${columnText}. ${description}`;
  }

  return `${file.name} provides lookup values via ${columnText}.`;
};

const parseCsvText = (text: string, delimiter: string): Row[] => {
  const result = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true,
    delimiter,
    comments: delimiter === TXT_DELIMITER ? "#" : undefined,
  });

  if (result.errors.length > 0) {
    throw new Error(`Failed to parse delimited text: ${result.errors[0].message}`);
  }

  return result.data.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim(), cleanCell(value)])),
  );
};

const parseSupplementaryRows = (file: SupplementaryFileEntry): Row[] => {
  if (!fs.existsSync(file.path)) return [];

  const text = fs.readFileSync(file.path, "utf8");
  const format = file.format.toLowerCase();
  const extension = path.extname(file.path).toLowerCase();

  if (format === "csv" || extension === ".csv") {
    return parseCsvText(text, ",").slice(0, SUPPLEMENTARY_ROW_LIMIT);
  }

  if (format === "tsv" || extension === ".tsv" || extension === ".tab") {
    return parseCsvText(text, "\t").slice(0, SUPPLEMENTARY_ROW_LIMIT);
  }

  if (format === "txt" || extension === ".txt") {
    const declaredColumns = file.columns ?? [];
    if (declaredColumns.length > 0) {
      const normalizedText = [declaredColumns.join(TXT_DELIMITER), text]
        .join("\n")
        .split(/\r?\n/)
        .filter((line, index) => index === 0 || !line.trimStart().startsWith("#"))
        .join("\n");
      return parseCsvText(normalizedText, TXT_DELIMITER).slice(0, SUPPLEMENTARY_ROW_LIMIT);
    }
  }

  return [];
};

const normalizeSupplementaryIndex = (raw: unknown, indexPath: string): SupplementaryFileEntry[] => {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const rawPath = String(entry.path ?? "").trim();
      const resolvedPath = rawPath ? path.resolve(DATA_DIR, rawPath) : path.resolve(path.dirname(indexPath), rawPath);

      return {
        name: String(entry.name ?? path.basename(rawPath || "unknown")).trim(),
        path: resolvedPath,
        format: String(entry.format ?? path.extname(rawPath).replace(/^\./, "")).trim().toLowerCase(),
        description: typeof entry.description === "string" ? entry.description : undefined,
        columns: Array.isArray(entry.columns) ? entry.columns.map((value) => String(value).trim()) : undefined,
        rowCount: typeof entry.rowCount === "number" ? entry.rowCount : undefined,
      };
    })
    .filter((entry) => entry.path.length > 0);
};

const readSupplementaryFiles = (): { loaded: boolean; files: SupplementaryFileEntry[] } => {
  if (!fs.existsSync(SUPPLEMENTARY_INDEX_FILE)) {
    return { loaded: false, files: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(SUPPLEMENTARY_INDEX_FILE, "utf8")) as unknown;
  return {
    loaded: true,
    files: normalizeSupplementaryIndex(parsed, SUPPLEMENTARY_INDEX_FILE),
  };
};

const selectKeyColumns = (file: SupplementaryFileEntry, rows: Row[]): string[] => {
  const availableColumns = file.columns ?? Object.keys(rows[0] ?? {});
  const prioritized = availableColumns.filter(
    (column) =>
      /(code|fips|geonameid|id)$/i.test(column) ||
      /^iso_/i.test(column) ||
      /alpha\d|numeric/i.test(column),
  );
  return prioritized.length > 0 ? prioritized : availableColumns.slice(0, 1);
};

const selectDescriptiveColumns = (file: SupplementaryFileEntry, rows: Row[]): string[] => {
  const availableColumns = file.columns ?? Object.keys(rows[0] ?? {});
  return availableColumns.filter((column) =>
    /(^name$|description|country$|capital|continent|currency_name|name_ascii)/i.test(column),
  );
};

const buildLookupKeys = (rows: Row[], keyColumns: string[]): Set<string> =>
  rows.reduce((values, row) => {
    for (const keyColumn of keyColumns) {
      const rawValue = cleanCell(row[keyColumn]);
      if (!rawValue) continue;
      values.add(rawValue.toLowerCase());
      if (values.size >= SUPPLEMENTARY_VALUE_LIMIT) {
        return values;
      }
    }
    return values;
  }, new Set<string>());

const buildSupplementaryLookups = (files: SupplementaryFileEntry[]): SupplementaryLookup[] =>
  files
    .map((file) => {
      const rows = parseSupplementaryRows(file);
      if (rows.length === 0) return undefined;

      const keyColumns = selectKeyColumns(file, rows);
      const descriptiveColumns = selectDescriptiveColumns(file, rows);
      const keys = buildLookupKeys(rows, keyColumns);

      return {
        file,
        keys,
        keyColumns,
        descriptiveColumns,
        context: createContext(file, keyColumns, descriptiveColumns),
      } satisfies SupplementaryLookup;
    })
    .filter((lookup): lookup is SupplementaryLookup => lookup !== undefined);

const buildFeatureCodeCandidate = (value: string, row: Row): string | undefined => {
  const featureClass = cleanCell(row.feature_class);
  if (!value) return undefined;
  if (value.includes(".")) return value.toLowerCase();
  if (!featureClass) return undefined;
  return `${featureClass}.${value}`.toLowerCase();
};

const columnLooksLikeCode = (columnName: string): boolean =>
  /(^|_)(code|id|identifier)$/.test(columnName.toLowerCase()) || columnName.toLowerCase() === "cc2";

const lookupSupportsColumn = (columnName: string, lookup: SupplementaryLookup): boolean => {
  const hints = GEOSPATIAL_LOOKUP_HINTS[columnName];
  if (!hints) return columnLooksLikeCode(columnName);
  return hints.fileMatchers.some((pattern) => pattern.test(lookup.file.name));
};

const matchesLookupValue = (columnName: string, value: string, row: Row, lookup: SupplementaryLookup): boolean => {
  const normalized = value.toLowerCase();
  if (lookup.keys.has(normalized)) return true;

  if (columnName === "cc2") {
    return value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0)
      .some((part) => lookup.keys.has(part));
  }

  if (columnName === "feature_code") {
    const candidate = buildFeatureCodeCandidate(value, row);
    return candidate ? lookup.keys.has(candidate) : false;
  }

  if (columnName === "admin1_code") {
    const countryCode = cleanCell(row.country_code);
    if (!countryCode) return false;
    return lookup.keys.has(`${countryCode}.${value}`.toLowerCase());
  }

  return false;
};

const sampleNonMissingRows = (rows: Row[], columnName: string, limit: number): Row[] =>
  rows
    .filter((row) => cleanCell(row[columnName]).length > 0)
    .slice(0, limit);

const findColumnSupplementaryLookup = (
  columnName: string,
  rows: Row[],
  lookups: SupplementaryLookup[],
): SupplementaryLookup | undefined => {
  if (!columnLooksLikeCode(columnName)) return undefined;

  const candidates = lookups.filter((lookup) => lookupSupportsColumn(columnName, lookup));
  if (candidates.length === 0) return undefined;

  const sampledRows = sampleNonMissingRows(rows, columnName, 500);
  if (sampledRows.length === 0) return undefined;

  const threshold = Math.max(3, Math.ceil(sampledRows.length * 0.2));

  return candidates.find((lookup) => {
    const matches = sampledRows.reduce((count, row) => {
      const value = cleanCell(row[columnName]);
      return count + (matchesLookupValue(columnName, value, row, lookup) ? 1 : 0);
    }, 0);

    return matches >= threshold;
  });
};

const finalizeColumnProfile = (
  accumulator: ColumnAccumulator,
  totalRows: number,
  supplementaryLookup?: SupplementaryLookup,
): ColumnProfile => {
  const inferredType = inferType(accumulator.typeCounts);
  const missingPercent = totalRows === 0 ? 0 : Number(((accumulator.missingCount / totalRows) * 100).toFixed(2));
  const numericStats =
    inferredType === "integer" || inferredType === "float" ? toNumericStats(accumulator) : undefined;

  return {
    name: accumulator.name,
    inferredType,
    nonMissingCount: accumulator.nonMissingCount,
    missingCount: accumulator.missingCount,
    missingPercent,
    uniqueCount: accumulator.uniqueValues.size,
    sampleValues: accumulator.sampleValues,
    ...(numericStats ? { numericStats } : {}),
    ...(supplementaryLookup ? { relatedSupplementaryFile: supplementaryLookup.file.name } : {}),
    ...(supplementaryLookup ? { supplementaryContext: supplementaryLookup.context } : {}),
  };
};

const readDataset = (filePath: string): Row[] => {
  const text = fs.readFileSync(filePath, "utf8");
  const result = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0) {
    throw new Error(`Failed to parse dataset CSV: ${result.errors[0].message}`);
  }

  return result.data.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim(), cleanCell(value)])),
  );
};

const profileColumns = (rows: Row[], columns: string[], lookups: SupplementaryLookup[]): ColumnProfile[] => {
  const accumulators = columns.map(createAccumulator);

  for (const row of rows) {
    columns.forEach((column, index) => {
      updateAccumulator(accumulators[index], row[column] ?? "");
    });
  }

  return accumulators.map((accumulator) =>
    finalizeColumnProfile(
      accumulator,
      rows.length,
      findColumnSupplementaryLookup(accumulator.name, rows, lookups),
    ),
  );
};

const createDatasetProfile = (
  rows: Row[],
  columns: string[],
  supplementaryFilesLoaded: boolean,
  supplementaryFiles: SupplementaryFileEntry[],
  lookups: SupplementaryLookup[],
): DatasetProfile => ({
  datasetPath: INPUT_FILE,
  totalRows: rows.length,
  totalColumns: columns.length,
  generatedAt: new Date().toISOString(),
  supplementaryIndexPath: SUPPLEMENTARY_INDEX_FILE,
  supplementaryFilesLoaded,
  supplementaryFilesInspected: supplementaryFiles.map((file) => file.name),
  columns: profileColumns(rows, columns, lookups),
});

const writeProfile = (profile: DatasetProfile): void => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
};

const summarizeColumn = (column: ColumnProfile): string => {
  const base = [
    `${column.name}: type=${column.inferredType}`,
    `missing=${formatNumber(column.missingCount)}/${formatNumber(column.missingCount + column.nonMissingCount)} (${column.missingPercent}%)`,
    `unique=${formatNumber(column.uniqueCount)}`,
    `samples=[${column.sampleValues.map((value) => JSON.stringify(value)).join(", ")}]`,
  ];

  if (column.numericStats) {
    base.push(
      `numeric(min=${column.numericStats.min}, max=${column.numericStats.max}, mean=${column.numericStats.mean})`,
    );
  }

  if (column.relatedSupplementaryFile) {
    base.push(`lookup=${column.relatedSupplementaryFile}`);
  }

  return base.join(" | ");
};

const printSummary = (profile: DatasetProfile): void => {
  console.log(`Profile written to ${OUTPUT_FILE}`);
  console.log(`Dataset: ${profile.datasetPath}`);
  console.log(`Rows: ${formatNumber(profile.totalRows)}`);
  console.log(`Columns: ${formatNumber(profile.totalColumns)}`);
  console.log(
    `Supplementary files: ${profile.supplementaryFilesLoaded ? profile.supplementaryFilesInspected.join(", ") || "loaded" : "not found"}`,
  );
  console.log("");
  for (const column of profile.columns) {
    console.log(`- ${summarizeColumn(column)}`);
  }
};

const main = (): void => {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Merged dataset not found: ${INPUT_FILE}`);
  }

  const rows = readDataset(INPUT_FILE);
  const columns = Object.keys(rows[0] ?? {});
  const { loaded, files } = readSupplementaryFiles();
  const lookups = buildSupplementaryLookups(files);
  const profile = createDatasetProfile(rows, columns, loaded, files, lookups);

  writeProfile(profile);
  printSummary(profile);
};

main();
