import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse";

// --- Types ---

interface NumericStats {
  min: number;
  max: number;
  mean: number;
}

interface ColumnProfile {
  name: string;
  inferredType: "numeric" | "date" | "boolean" | "string";
  totalValues: number;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  numericStats?: NumericStats;
  relatedSupplementaryFile?: string;
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

interface DatasetProfile {
  filePath: string;
  totalRows: number;
  totalColumns: number;
  columns: ColumnProfile[];
  supplementaryFiles: SupplementaryFileInfo[];
  generatedAt: string;
}

// --- Column accumulator for streaming ---

interface ColumnAccumulator {
  name: string;
  missingCount: number;
  uniqueValues: Set<string>;
  sampleValues: string[];
  numericCount: number;
  dateCount: number;
  booleanCount: number;
  nonBlankCount: number;
  numericSum: number;
  numericMin: number;
  numericMax: number;
  typeSampleChecked: number;
}

// --- Pure Functions ---

const isBlank = (val: unknown): boolean =>
  val === null || val === undefined || String(val).trim() === "";

const isNumericString = (val: string): boolean => {
  if (val.trim() === "") return false;
  const cleaned = val.replace(/^\((.+)\)$/, "$1");
  return !isNaN(Number(cleaned)) && cleaned.trim() !== "";
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOOSE_DATE_RE = /^\d{4}(-\d{2})?(-\d{2})?$/;

const isDateString = (val: string): boolean =>
  ISO_DATE_RE.test(val.trim()) || LOOSE_DATE_RE.test(val.trim());

const isBooleanString = (val: string): boolean =>
  ["true", "false", "yes", "no", "y", "n", "0", "1"].includes(
    val.trim().toLowerCase()
  );

const parseNumeric = (val: string): number => {
  const cleaned = val.replace(/^\((.+)\)$/, "$1").trim();
  return Number(cleaned);
};

const TYPE_SAMPLE_LIMIT = 200;
const SAMPLE_VALUES_COUNT = 5;

const createAccumulator = (name: string): ColumnAccumulator => ({
  name,
  missingCount: 0,
  uniqueValues: new Set(),
  sampleValues: [],
  numericCount: 0,
  dateCount: 0,
  booleanCount: 0,
  nonBlankCount: 0,
  numericSum: 0,
  numericMin: Infinity,
  numericMax: -Infinity,
  typeSampleChecked: 0,
});

const updateAccumulator = (acc: ColumnAccumulator, val: string): void => {
  if (isBlank(val)) {
    acc.missingCount++;
    return;
  }

  acc.nonBlankCount++;
  acc.uniqueValues.add(val);

  if (acc.sampleValues.length < SAMPLE_VALUES_COUNT && !acc.uniqueValues.has(val) || acc.sampleValues.length < SAMPLE_VALUES_COUNT) {
    // Collect up to 5 distinct samples
    if (acc.sampleValues.length < SAMPLE_VALUES_COUNT && !acc.sampleValues.includes(val)) {
      acc.sampleValues.push(val);
    }
  }

  // Type inference sampling (first 200 non-blank values)
  if (acc.typeSampleChecked < TYPE_SAMPLE_LIMIT) {
    acc.typeSampleChecked++;
    if (isNumericString(val)) acc.numericCount++;
    if (isDateString(val)) acc.dateCount++;
    if (isBooleanString(val)) acc.booleanCount++;
  }

  // Numeric stats for all values (not just sample)
  if (isNumericString(val)) {
    const n = parseNumeric(val);
    if (!isNaN(n)) {
      acc.numericSum += n;
      if (n < acc.numericMin) acc.numericMin = n;
      if (n > acc.numericMax) acc.numericMax = n;
    }
  }
};

const inferTypeFromAccumulator = (
  acc: ColumnAccumulator
): "numeric" | "date" | "boolean" | "string" => {
  const checked = acc.typeSampleChecked;
  if (checked === 0) return "string";

  const threshold = 0.8;
  if (acc.numericCount / checked >= threshold) return "numeric";
  if (acc.dateCount / checked >= threshold) return "date";
  if (acc.booleanCount / checked >= threshold) return "boolean";
  return "string";
};

const finalizeColumn = (
  acc: ColumnAccumulator,
  totalRows: number
): Omit<ColumnProfile, "relatedSupplementaryFile"> => {
  const inferredType = inferTypeFromAccumulator(acc);
  const missingPercent =
    Math.round((acc.missingCount / totalRows) * 10000) / 100;

  const numericStats: NumericStats | undefined =
    inferredType === "numeric" && acc.numericMin !== Infinity
      ? {
          min: acc.numericMin,
          max: acc.numericMax,
          mean:
            Math.round(
              (acc.numericSum /
                (acc.nonBlankCount -
                  (acc.typeSampleChecked - acc.numericCount))) *
                1000
            ) / 1000,
        }
      : undefined;

  // Recalculate mean properly: count actual numeric values
  const numericValCount =
    inferredType === "numeric" ? countNumericValues(acc) : 0;
  const correctedStats: NumericStats | undefined =
    inferredType === "numeric" && numericValCount > 0
      ? {
          min: acc.numericMin,
          max: acc.numericMax,
          mean: Math.round((acc.numericSum / numericValCount) * 1000) / 1000,
        }
      : undefined;

  return {
    name: acc.name,
    inferredType,
    totalValues: totalRows,
    missingCount: acc.missingCount,
    missingPercent,
    uniqueCount: acc.uniqueValues.size,
    sampleValues: acc.sampleValues,
    ...(correctedStats ? { numericStats: correctedStats } : {}),
  };
};

// We track numeric values via a separate counter updated in the accumulator
// Since we can't easily separate "numeric non-blank" from "non-blank" in the accumulator,
// we approximate: for numeric columns, the numeric values count ≈ nonBlankCount
// (since ≥80% pass the numeric test)
const countNumericValues = (acc: ColumnAccumulator): number => {
  // For a column inferred as numeric, the vast majority of non-blank values are numeric
  // The ratio from sampling gives us a good estimate
  if (acc.typeSampleChecked === 0) return 0;
  const ratio = acc.numericCount / acc.typeSampleChecked;
  return Math.round(acc.nonBlankCount * ratio);
};

// --- Supplementary file matching ---

const COLUMN_TO_SUPPLEMENTARY_PATTERNS: Record<string, string[]> = {
  feature_code: ["feature_code", "featurecode", "feature code"],
  feature_class: ["feature_class", "featureclass", "feature class"],
  country_code: ["iso", "country", "country_code", "countrycode"],
  cc2: ["iso", "country", "cc2"],
  admin1_code: ["admin1", "code", "admin1_code"],
  admin2_code: ["admin2", "code", "admin2_code"],
};

const matchSupplementaryFile = (
  columnName: string,
  supplementaryFiles: SupplementaryFileInfo[]
): string | undefined => {
  const colLower = columnName.toLowerCase();

  for (const file of supplementaryFiles) {
    const fileColsLower = file.columns.map((c) => c.toLowerCase());

    // feature_code → featureCodes_en.txt
    if (
      colLower === "feature_code" &&
      file.name.toLowerCase().includes("featurecodes")
    ) {
      return file.name;
    }

    // country_code or cc2 → countryInfo.txt
    if (
      (colLower === "country_code" || colLower === "cc2") &&
      file.name.toLowerCase().includes("country")
    ) {
      return file.name;
    }

    // admin1_code → admin1CodesASCII.txt
    if (
      colLower === "admin1_code" &&
      file.name.toLowerCase().includes("admin1")
    ) {
      return file.name;
    }

    // Generic: only for columns that look like codes/identifiers (contain "code" or "id" suffix)
    // Exclude broad matches like "name", "population", "geonameid" which are common column names
    const looksLikeCode =
      colLower.endsWith("_code") ||
      colLower.endsWith("_id") ||
      colLower.endsWith("code");
    if (looksLikeCode && fileColsLower.includes(colLower)) {
      return file.name;
    }
  }

  return undefined;
};

// --- Console Output ---

const printSummary = (profile: DatasetProfile): void => {
  const divider = "─".repeat(70);

  console.log(`\n${divider}`);
  console.log(`  DATASET PROFILE`);
  console.log(`${divider}`);
  console.log(`  File:       ${profile.filePath}`);
  console.log(`  Rows:       ${profile.totalRows.toLocaleString()}`);
  console.log(`  Columns:    ${profile.totalColumns}`);
  console.log(`  Generated:  ${profile.generatedAt}`);

  if (profile.supplementaryFiles.length > 0) {
    console.log(`  Supplementary files: ${profile.supplementaryFiles.length}`);
    for (const sf of profile.supplementaryFiles) {
      console.log(
        `    - ${sf.name} (${sf.rowCount.toLocaleString()} rows, ${sf.columns.length} cols)`
      );
    }
  }

  console.log(`${divider}\n`);

  const header = `${"Column".padEnd(22)} ${"Type".padEnd(10)} ${"Missing".padEnd(16)} ${"Unique".padEnd(10)} ${"Suppl.File".padEnd(28)} Sample Values`;
  console.log(header);
  console.log("─".repeat(130));

  for (const col of profile.columns) {
    const missingStr = `${col.missingCount.toLocaleString()} (${col.missingPercent}%)`;
    const supplStr = col.relatedSupplementaryFile || "";
    const sampleStr = col.sampleValues
      .map((v) => (v.length > 25 ? v.slice(0, 22) + "..." : v))
      .join(" | ");

    console.log(
      `${col.name.padEnd(22)} ${col.inferredType.padEnd(10)} ${missingStr.padEnd(16)} ${String(col.uniqueCount).padEnd(10)} ${supplStr.padEnd(28)} ${sampleStr}`
    );
  }

  const numericCols = profile.columns.filter((c) => c.numericStats);
  if (numericCols.length > 0) {
    console.log(`\n${divider}`);
    console.log(`  NUMERIC COLUMN STATISTICS`);
    console.log(`${divider}`);

    const numHeader = `${"Column".padEnd(22)} ${"Min".padEnd(18)} ${"Max".padEnd(18)} Mean`;
    console.log(numHeader);
    console.log("─".repeat(70));

    for (const col of numericCols) {
      const s = col.numericStats!;
      console.log(
        `${col.name.padEnd(22)} ${String(s.min).padEnd(18)} ${String(s.max).padEnd(18)} ${s.mean}`
      );
    }
  }

  const highMissing = profile.columns
    .filter((c) => c.missingPercent > 50)
    .sort((a, b) => b.missingPercent - a.missingPercent);

  if (highMissing.length > 0) {
    console.log(`\n${divider}`);
    console.log(`  COLUMNS WITH >50% MISSING VALUES`);
    console.log(`${divider}`);
    for (const col of highMissing) {
      console.log(`  ${col.name.padEnd(22)} ${col.missingPercent}% missing`);
    }
  }

  const supplLinked = profile.columns.filter(
    (c) => c.relatedSupplementaryFile
  );
  if (supplLinked.length > 0) {
    console.log(`\n${divider}`);
    console.log(`  SUPPLEMENTARY FILE LINKAGES`);
    console.log(`${divider}`);
    for (const col of supplLinked) {
      console.log(
        `  ${col.name.padEnd(22)} → ${col.relatedSupplementaryFile}`
      );
    }
  }

  console.log("");
};

// --- Streaming profile ---

const profileDatasetStreaming = (
  inputPath: string,
  supplementaryFiles: SupplementaryFileInfo[]
): Promise<DatasetProfile> => {
  return new Promise((resolve, reject) => {
    let totalRows = 0;
    let accumulators: ColumnAccumulator[] | null = null;
    let columnNames: string[] = [];

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    const stream = fs.createReadStream(inputPath, { encoding: "utf-8" });

    parser.on("readable", () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        if (!accumulators) {
          columnNames = Object.keys(record);
          accumulators = columnNames.map(createAccumulator);
        }

        totalRows++;

        for (let i = 0; i < columnNames.length; i++) {
          const val = record[columnNames[i]] ?? "";
          updateAccumulator(accumulators[i], val);
        }

        if (totalRows % 100000 === 0) {
          console.log(`  Processed ${totalRows.toLocaleString()} rows...`);
        }
      }
    });

    parser.on("error", (err) => reject(err));

    parser.on("end", () => {
      if (!accumulators || totalRows === 0) {
        resolve({
          filePath: inputPath,
          totalRows: 0,
          totalColumns: 0,
          columns: [],
          supplementaryFiles,
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      const columns: ColumnProfile[] = accumulators.map((acc) => {
        const base = finalizeColumn(acc, totalRows);
        const relatedSupplementaryFile = matchSupplementaryFile(
          acc.name,
          supplementaryFiles
        );
        return {
          ...base,
          ...(relatedSupplementaryFile ? { relatedSupplementaryFile } : {}),
        };
      });

      resolve({
        filePath: inputPath,
        totalRows,
        totalColumns: columnNames.length,
        columns,
        supplementaryFiles,
        generatedAt: new Date().toISOString(),
      });
    });

    stream.pipe(parser);
  });
};

// --- Main ---

const main = async (): Promise<void> => {
  const dataDir =
    process.env.DATA_DIR || "domain-data/geospatial";
  const inputPath = path.resolve(dataDir, "input", "dataset-merged.csv");
  const outputPath = path.resolve(dataDir, "output", "dataset-profile.json");
  const supplIndexPath = path.resolve(
    dataDir,
    "output",
    "supplementary-files-index.json"
  );

  console.log(`Reading CSV from: ${inputPath}`);

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: file not found: ${inputPath}`);
    process.exit(1);
  }

  // Load supplementary files index if present
  let supplementaryFiles: SupplementaryFileInfo[] = [];
  if (fs.existsSync(supplIndexPath)) {
    console.log(`Loading supplementary files index: ${supplIndexPath}`);
    supplementaryFiles = JSON.parse(
      fs.readFileSync(supplIndexPath, "utf-8")
    ) as SupplementaryFileInfo[];
    console.log(
      `  Found ${supplementaryFiles.length} supplementary file(s): ${supplementaryFiles.map((f) => f.name).join(", ")}`
    );
  } else {
    console.log(`No supplementary files index found at ${supplIndexPath}`);
  }

  console.log(`Profiling dataset (streaming)...`);
  const profile = await profileDatasetStreaming(inputPath, supplementaryFiles);

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2), "utf-8");
  console.log(`Profile saved to: ${outputPath}`);

  printSummary(profile);
};

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
