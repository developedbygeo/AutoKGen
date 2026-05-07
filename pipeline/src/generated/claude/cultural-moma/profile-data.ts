import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse";

// ── Types ──────────────────────────────────────────────────────────────────

interface ColumnProfile {
  name: string;
  inferredType: "string" | "integer" | "float" | "date" | "boolean" | "mixed";
  totalValues: number;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  avgLength?: number;
  minNumeric?: number;
  maxNumeric?: number;
  meanNumeric?: number;
  relatedSupplementaryFile?: string;
}

interface DatasetProfile {
  dataset: string;
  totalRows: number;
  totalColumns: number;
  fileSizeBytes: number;
  columns: ColumnProfile[];
  supplementaryFilesUsed: boolean;
  profilingTimeSec: number;
}

interface SupplementaryFileEntry {
  path: string;
  name: string;
  format: string;
  sizeBytes: number;
  description: string;
  columns: string[];
  rowCount: number;
}

// ── Configuration ──────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
const INPUT_FILE = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output");
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, "dataset-profile.json");
const SUPP_INDEX_FILE = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const MAX_UNIQUE_TRACKED = 10_000;
const SAMPLE_COUNT = 5;
const PROGRESS_INTERVAL = 50_000;

// ── Helpers ────────────────────────────────────────────────────────────────

const formatNumber = (n: number): string => n.toLocaleString("en-US");

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const loadSupplementaryIndex = (): SupplementaryFileEntry[] | null => {
  if (!fs.existsSync(SUPP_INDEX_FILE)) return null;
  const raw = fs.readFileSync(SUPP_INDEX_FILE, "utf-8");
  return JSON.parse(raw) as SupplementaryFileEntry[];
};

// ── Type inference ─────────────────────────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_PATTERN = /^-?\d+$/;
const FLOAT_PATTERN = /^-?\d+\.\d+$/;

interface TypeAccumulator {
  string: number;
  integer: number;
  float: number;
  date: number;
  boolean: number;
}

const classifyValue = (value: string): keyof TypeAccumulator => {
  if (value === "true" || value === "false") return "boolean";
  if (DATE_PATTERN.test(value)) return "date";
  if (INTEGER_PATTERN.test(value)) return "integer";
  if (FLOAT_PATTERN.test(value)) return "float";
  return "string";
};

const resolveType = (acc: TypeAccumulator, total: number): ColumnProfile["inferredType"] => {
  if (total === 0) return "string";
  const dominant = (Object.entries(acc) as [keyof TypeAccumulator, number][])
    .sort((a, b) => b[1] - a[1])[0];
  const ratio = dominant[1] / total;
  if (ratio >= 0.9) return dominant[0];
  if ((acc.integer + acc.float) / total >= 0.9) return "float";
  return "mixed";
};

// ── Per-column accumulator ─────────────────────────────────────────────────

interface ColumnAccumulator {
  name: string;
  nonEmpty: number;
  missing: number;
  types: TypeAccumulator;
  uniqueValues: Set<string>;
  uniqueOverflow: boolean;
  samples: string[];
  totalLength: number;
  numericSum: number;
  numericCount: number;
  numericMin: number;
  numericMax: number;
}

const createColumnAccumulator = (name: string): ColumnAccumulator => ({
  name,
  nonEmpty: 0,
  missing: 0,
  types: { string: 0, integer: 0, float: 0, date: 0, boolean: 0 },
  uniqueValues: new Set(),
  uniqueOverflow: false,
  samples: [],
  totalLength: 0,
  numericSum: 0,
  numericCount: 0,
  numericMin: Infinity,
  numericMax: -Infinity,
});

const updateAccumulator = (acc: ColumnAccumulator, value: string): void => {
  const trimmed = value.trim();
  if (trimmed === "") {
    acc.missing++;
    return;
  }

  acc.nonEmpty++;
  acc.totalLength += trimmed.length;

  const type = classifyValue(trimmed);
  acc.types[type]++;

  if (!acc.uniqueOverflow) {
    acc.uniqueValues.add(trimmed);
    if (acc.uniqueValues.size > MAX_UNIQUE_TRACKED) {
      acc.uniqueOverflow = true;
    }
  }

  if (acc.samples.length < SAMPLE_COUNT) {
    if (!acc.samples.includes(trimmed)) {
      acc.samples.push(trimmed);
    }
  }

  if (type === "integer" || type === "float") {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      acc.numericSum += num;
      acc.numericCount++;
      if (num < acc.numericMin) acc.numericMin = num;
      if (num > acc.numericMax) acc.numericMax = num;
    }
  }
};

const finalizeColumn = (
  acc: ColumnAccumulator,
  totalRows: number,
  suppIndex: SupplementaryFileEntry[] | null
): ColumnProfile => {
  const total = acc.nonEmpty;
  const inferredType = resolveType(acc.types, total);

  const profile: ColumnProfile = {
    name: acc.name,
    inferredType,
    totalValues: total,
    missingCount: acc.missing,
    missingPercent: totalRows > 0 ? parseFloat(((acc.missing / totalRows) * 100).toFixed(2)) : 0,
    uniqueCount: acc.uniqueOverflow ? -1 : acc.uniqueValues.size,
    sampleValues: acc.samples,
  };

  if (total > 0) {
    profile.avgLength = parseFloat((acc.totalLength / total).toFixed(1));
  }

  if (acc.numericCount > 0 && (inferredType === "integer" || inferredType === "float")) {
    profile.minNumeric = acc.numericMin;
    profile.maxNumeric = acc.numericMax;
    profile.meanNumeric = parseFloat((acc.numericSum / acc.numericCount).toFixed(4));
  }

  if (suppIndex && suppIndex.length > 0) {
    const colLower = acc.name.toLowerCase();
    const matchedSupp = suppIndex.find((s) => {
      const suppName = s.name.toLowerCase().replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
      return (
        colLower.includes("code") ||
        colLower.includes("id") ||
        colLower.includes("type") ||
        colLower.includes("class")
      ) && (
        suppName.includes(colLower.replace(/_/g, " ")) ||
        colLower.includes(suppName.split(" ")[0])
      );
    });
    if (matchedSupp) {
      profile.relatedSupplementaryFile = matchedSupp.name;
    }
  }

  return profile;
};

// ── Streaming profiler ────────────────────────────────────────────────────

const profileDataset = (
  inputPath: string,
  suppIndex: SupplementaryFileEntry[] | null
): Promise<DatasetProfile> => {
  return new Promise((resolve, reject) => {
    const fileStats = fs.statSync(inputPath);
    const startTime = Date.now();

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
    });

    let headers: string[] | null = null;
    let accumulators: ColumnAccumulator[] = [];
    let rowCount = 0;

    const readStream = fs.createReadStream(inputPath, {
      encoding: "utf-8",
      highWaterMark: 64 * 1024,
    });

    parser.on("readable", () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        if (!headers) {
          headers = Object.keys(record);
          accumulators = headers.map(createColumnAccumulator);
        }

        for (let i = 0; i < headers.length; i++) {
          const value = record[headers[i]] ?? "";
          updateAccumulator(accumulators[i], value);
        }

        rowCount++;
        if (rowCount % PROGRESS_INTERVAL === 0) {
          process.stdout.write(`\r  Profiled ${formatNumber(rowCount)} rows...`);
        }
      }
    });

    parser.on("error", (err: Error) => {
      reject(err);
    });

    parser.on("end", () => {
      process.stdout.write(`\r  Profiled ${formatNumber(rowCount)} rows — done.     \n`);

      const columns = accumulators.map((acc) => finalizeColumn(acc, rowCount, suppIndex));
      const elapsed = (Date.now() - startTime) / 1000;

      const profile: DatasetProfile = {
        dataset: path.basename(inputPath),
        totalRows: rowCount,
        totalColumns: headers?.length ?? 0,
        fileSizeBytes: fileStats.size,
        columns,
        supplementaryFilesUsed: suppIndex !== null && suppIndex.length > 0,
        profilingTimeSec: parseFloat(elapsed.toFixed(1)),
      };

      resolve(profile);
    });

    readStream.pipe(parser);
  });
};

// ── Console summary ───────────────────────────────────────────────────────

const printSummary = (profile: DatasetProfile): void => {
  console.log("\n=== Dataset Profile Summary ===\n");
  console.log(`  Dataset:     ${profile.dataset}`);
  console.log(`  File size:   ${formatBytes(profile.fileSizeBytes)}`);
  console.log(`  Total rows:  ${formatNumber(profile.totalRows)}`);
  console.log(`  Columns:     ${profile.totalColumns}`);
  console.log(`  Time:        ${profile.profilingTimeSec}s`);
  if (profile.totalRows > 0) {
    console.log(
      `  Throughput:  ${formatNumber(Math.round(profile.totalRows / profile.profilingTimeSec))} rows/sec`
    );
  }
  console.log(`  Supplementary files: ${profile.supplementaryFilesUsed ? "Yes" : "No"}`);

  console.log("\n--- Column Details ---\n");
  console.log(
    "  " +
      "Column".padEnd(24) +
      "Type".padEnd(10) +
      "Non-null".padEnd(14) +
      "Missing%".padEnd(10) +
      "Unique".padEnd(12) +
      "Sample Values"
  );
  console.log("  " + "-".repeat(110));

  for (const col of profile.columns) {
    const uniqueStr = col.uniqueCount === -1 ? ">10K" : formatNumber(col.uniqueCount);
    const samples = col.sampleValues.slice(0, 3).map((v) =>
      v.length > 35 ? v.slice(0, 32) + "..." : v
    ).join(", ");
    console.log(
      "  " +
        col.name.padEnd(24) +
        col.inferredType.padEnd(10) +
        formatNumber(col.totalValues).padEnd(14) +
        `${col.missingPercent}%`.padEnd(10) +
        uniqueStr.padEnd(12) +
        samples
    );
  }

  const numericCols = profile.columns.filter((c) => c.minNumeric !== undefined);
  if (numericCols.length > 0) {
    console.log("\n--- Numeric Column Statistics ---\n");
    console.log(
      "  " +
        "Column".padEnd(24) +
        "Min".padEnd(16) +
        "Max".padEnd(16) +
        "Mean".padEnd(16)
    );
    console.log("  " + "-".repeat(72));
    for (const col of numericCols) {
      console.log(
        "  " +
          col.name.padEnd(24) +
          String(col.minNumeric).padEnd(16) +
          String(col.maxNumeric).padEnd(16) +
          String(col.meanNumeric).padEnd(16)
      );
    }
  }

  const highMissing = profile.columns
    .filter((c) => c.missingPercent > 50)
    .sort((a, b) => b.missingPercent - a.missingPercent);

  if (highMissing.length > 0) {
    console.log("\n--- High Missing Value Columns (>50%) ---\n");
    for (const col of highMissing) {
      console.log(`  ${col.name}: ${col.missingPercent}% missing`);
    }
  }

  console.log();
};

// ── Main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("\n=== Data Profiler (Cultural-MoMA — Streaming) ===\n");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const suppIndex = loadSupplementaryIndex();
  if (suppIndex) {
    console.log(`  Loaded supplementary files index: ${suppIndex.length} file(s)`);
  } else {
    console.log("  No supplementary files index found.");
  }
  console.log();

  console.log("--- Profiling Dataset ---\n");
  const profile = await profileDataset(INPUT_FILE, suppIndex);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(profile, null, 2), "utf-8");
  console.log(`\n  Profile saved to: ${OUTPUT_FILE}`);

  printSummary(profile);

  console.log("Done.\n");
};

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
