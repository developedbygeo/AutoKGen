import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse } from "csv-parse";

// --- Types ---

interface OntologyDataProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string;
}

interface OntologyStructure {
  metadata: { namespaces: Record<string, string> };
  classes: Array<{ uri: string; label: string; superClasses: string[] }>;
  dataProperties: OntologyDataProperty[];
  objectProperties: Array<{ uri: string; domain: string[]; range: string[] }>;
}

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  propertyType: string;
  targetEntity: string;
  datatype: string;
  confidence: number;
  compliant: boolean;
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  confidence: number;
  identifierColumn: string;
  requiredProperties: string[];
  compliant: boolean;
}

interface RelationshipMapping {
  columnName: string;
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  confidence: number;
  compliant: boolean;
}

interface MappingStrategy {
  metadata: {
    ontologyCompliant: boolean;
    complianceScore: number;
    totalColumns: number;
    mappedColumns: number;
  };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
}

interface SupplementaryFileIndex {
  path: string;
  name: string;
  format: string;
  sizeBytes: number;
  description: string;
  columns: string[];
  rowCount: number;
}

interface CleaningIssue {
  type: string;
  count: number;
  severity: "info" | "warning" | "error";
}

interface TypeCoercion {
  column: string;
  targetType: string;
  successCount: number;
  failCount: number;
}

interface CleaningReport {
  originalRows: number;
  cleanedRows: number;
  rowsRemoved: number;
  duplicatesRemoved: number;
  issues: CleaningIssue[];
  typeCoercions: TypeCoercion[];
  supplementaryValidation: {
    countryCodeValidation: { valid: number; invalid: number; invalidCodes: string[] };
    featureCodeValidation: { valid: number; invalid: number; invalidCodes: string[] };
    featureClassValidation: { valid: number; invalid: number; invalidClasses: string[] };
    admin1CodeValidation: { valid: number; invalid: number; invalidCodes: string[] };
  };
  generatedAt: string;
}

// --- Constants ---

const DATA_DIR = process.env.DATA_DIR || "domain-data/geospatial";
const INPUT_PATH = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const ONTOLOGY_PATH = path.resolve(DATA_DIR, "output", "ontology-structure.json");
const MAPPING_PATH = path.resolve(DATA_DIR, "output", "mapping-strategy.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(DATA_DIR, "output", "supplementary-files-index.json");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");
const OUTPUT_CSV = path.resolve(DATA_DIR, "output", "dataset-cleaned.csv");
const OUTPUT_REPORT = path.resolve(DATA_DIR, "output", "cleaning-report.json");

const CHUNK_SIZE = 5_000;

const NULL_PATTERNS = new Set([
  "", "null", "NULL", "Null", "n/a", "N/A", "N/a",
  "na", "NA", "none", "None", "NONE", "undefined",
  "nil", "NIL", "-", "--", ".", "?", "unknown", "UNKNOWN",
]);

// DEM sentinel value indicating no data
const DEM_NO_DATA = -9999;

// --- Pure Functions ---

const loadJson = <T>(filePath: string): T =>
  JSON.parse(fs.readFileSync(filePath, "utf-8"));

const fileExists = (filePath: string): boolean => {
  try { fs.accessSync(filePath); return true; } catch { return false; }
};

const trimValue = (v: string): string => v.trim();

const normalizeNull = (v: string): string | null =>
  NULL_PATTERNS.has(v.trim()) ? null : v;

const buildDatatypeMap = (
  attributeMappings: AttributeMapping[]
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const attr of attributeMappings) {
    // Handle composite column names like "latitude+longitude"
    if (attr.columnName.includes("+")) {
      for (const col of attr.columnName.split("+")) {
        map.set(col.trim(), attr.datatype);
      }
    } else {
      map.set(attr.columnName, attr.datatype);
    }
  }
  return map;
};

// --- Type Coercion Functions ---

const coerceInteger = (v: string): { value: number | null; success: boolean } => {
  const trimmed = v.trim();
  if (trimmed === "") return { value: null, success: true };
  const parsed = Number(trimmed);
  if (Number.isInteger(parsed)) return { value: parsed, success: true };
  const cleaned = trimmed.replace(/[^0-9-]/g, "");
  const reParsed = Number(cleaned);
  if (cleaned !== "" && Number.isInteger(reParsed)) return { value: reParsed, success: true };
  return { value: null, success: false };
};

const coerceDecimal = (v: string): { value: number | null; success: boolean } => {
  const trimmed = v.trim();
  if (trimmed === "") return { value: null, success: true };
  const parsed = Number(trimmed);
  if (!isNaN(parsed) && isFinite(parsed)) return { value: parsed, success: true };
  return { value: null, success: false };
};

const coerceBoolean = (v: string): { value: boolean | null; success: boolean } => {
  const lower = v.trim().toLowerCase();
  if (lower === "") return { value: null, success: true };
  if (["true", "1", "yes"].includes(lower)) return { value: true, success: true };
  if (["false", "0", "no"].includes(lower)) return { value: false, success: true };
  return { value: null, success: false };
};

const coerceDate = (v: string): { value: string | null; success: boolean } => {
  const trimmed = v.trim();
  if (trimmed === "") return { value: null, success: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { value: trimmed, success: true };
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return { value: trimmed.split("T")[0], success: true };
  const d = new Date(trimmed);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1000) {
    return { value: d.toISOString().split("T")[0], success: true };
  }
  return { value: null, success: false };
};

type CoerceFn = (v: string) => { value: unknown; success: boolean };

const getCoercionFn = (xsdType: string): CoerceFn | null => {
  // Normalize full URIs to short form
  const normalized = xsdType
    .replace("http://www.w3.org/2001/XMLSchema#", "xsd:")
    .replace("http://www.w3.org/2001/XMLSchema#", "xsd:");

  switch (normalized) {
    case "xsd:integer":
    case "xsd:positiveInteger":
    case "xsd:nonNegativeInteger":
      return coerceInteger as CoerceFn;
    case "xsd:decimal":
    case "xsd:float":
    case "xsd:double":
      return coerceDecimal as CoerceFn;
    case "xsd:boolean":
      return coerceBoolean as CoerceFn;
    case "xsd:date":
      return coerceDate as CoerceFn;
    case "xsd:string":
    default:
      return null;
  }
};

const buildRowHash = (row: Record<string, string>, columns: string[]): string => {
  const h = crypto.createHash("md5");
  for (const col of columns) {
    h.update(row[col] ?? "");
    h.update("\x00");
  }
  return h.digest("base64");
};

const escapeCSVField = (field: string): string => {
  if (field.includes(",") || field.includes('"') || field.includes("\n") || field.includes("\r")) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
};

// --- Supplementary File Loaders ---

const loadCountryCodes = (filePath: string): Set<string> => {
  const codes = new Set<string>();
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length >= 1 && parts[0].length === 2) {
      codes.add(parts[0]);
    }
  }
  return codes;
};

const loadFeatureCodes = (filePath: string): { classes: Set<string>; codes: Set<string> } => {
  const classes = new Set<string>();
  const codes = new Set<string>();
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length >= 1) {
      const fullCode = parts[0]; // e.g., "A.ADM1"
      const dotIndex = fullCode.indexOf(".");
      if (dotIndex > 0) {
        const cls = fullCode.substring(0, dotIndex);
        const code = fullCode.substring(dotIndex + 1);
        classes.add(cls);
        codes.add(code);
      }
    }
  }
  return { classes, codes };
};

const loadAdmin1Codes = (filePath: string): Set<string> => {
  const codes = new Set<string>();
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length >= 1) {
      codes.add(parts[0]); // full code like "DE.01"
    }
  }
  return codes;
};

// --- Coordinate Validation ---

const isValidLatitude = (v: number): boolean => v >= -90 && v <= 90;
const isValidLongitude = (v: number): boolean => v >= -180 && v <= 180;

// --- Main Pipeline ---

const run = async (): Promise<void> => {
  console.log("=== Geospatial Data Cleaning Pipeline ===\n");

  // Load ontology and mapping
  console.log("Loading ontology structure...");
  const ontology = loadJson<OntologyStructure>(ONTOLOGY_PATH);
  console.log(`  Ontology: ${ontology.metadata.namespaces["geo"] ? "GeoSPARQL" : "unknown"} v${(ontology as any).metadata?.version || "?"}`);

  console.log("Loading mapping strategy...");
  const mapping = loadJson<MappingStrategy>(MAPPING_PATH);
  console.log(`  Compliance score: ${mapping.metadata.complianceScore}/100`);
  console.log(`  Mapped columns: ${mapping.metadata.mappedColumns}/${mapping.metadata.totalColumns}`);

  // Build datatype map from attribute mappings
  const datatypeMap = buildDatatypeMap(mapping.attributeMappings);

  // Override datatypes for columns where the mapping uses composite keys
  // latitude and longitude are WKT literal in mapping but are actually decimal numbers in CSV
  datatypeMap.set("latitude", "xsd:decimal");
  datatypeMap.set("longitude", "xsd:decimal");
  // population and elevation are xsd:integer per mapping
  datatypeMap.set("population", "xsd:integer");
  datatypeMap.set("elevation", "xsd:integer");
  datatypeMap.set("dem", "xsd:integer");
  // modification_date is xsd:date
  datatypeMap.set("modification_date", "xsd:date");

  // Load supplementary data for validation
  let validCountryCodes: Set<string> | null = null;
  let validFeatureClasses: Set<string> | null = null;
  let validFeatureCodes: Set<string> | null = null;
  let validAdmin1Codes: Set<string> | null = null;

  if (fileExists(SUPPLEMENTARY_INDEX_PATH)) {
    console.log("\nLoading supplementary files for validation...");
    const index = loadJson<SupplementaryFileIndex[]>(SUPPLEMENTARY_INDEX_PATH);

    for (const file of index) {
      if (file.name === "countryInfo.txt" && fileExists(file.path)) {
        validCountryCodes = loadCountryCodes(file.path);
        console.log(`  Country codes: ${validCountryCodes.size} valid codes loaded`);
      }
      if (file.name === "featureCodes_en.txt" && fileExists(file.path)) {
        const { classes, codes } = loadFeatureCodes(file.path);
        validFeatureClasses = classes;
        validFeatureCodes = codes;
        console.log(`  Feature classes: ${validFeatureClasses.size} | Feature codes: ${validFeatureCodes.size} loaded`);
      }
      if (file.name === "admin1CodesASCII.txt" && fileExists(file.path)) {
        validAdmin1Codes = loadAdmin1Codes(file.path);
        console.log(`  Admin1 codes: ${validAdmin1Codes.size} valid codes loaded`);
      }
    }
  } else {
    console.log("\n  No supplementary files index found — skipping supplementary validation.");
  }

  // Track metrics
  let originalRows = 0;
  let cleanedRows = 0;
  let duplicatesRemoved = 0;
  let nullsNormalized = 0;
  let whitespacesTrimmed = 0;
  let missingGeonameid = 0;
  let missingName = 0;
  let invalidCoordinates = 0;
  let demSentinelNulled = 0;

  const typeCoercions = new Map<string, { success: number; fail: number; targetType: string }>();
  const seenHashes = new Set<string>();

  // Supplementary validation tracking
  const suppValidation = {
    countryCodeValidation: { valid: 0, invalid: 0, invalidCodes: new Set<string>() },
    featureCodeValidation: { valid: 0, invalid: 0, invalidCodes: new Set<string>() },
    featureClassValidation: { valid: 0, invalid: 0, invalidClasses: new Set<string>() },
    admin1CodeValidation: { valid: 0, invalid: 0, invalidCodes: new Set<string>() },
  };

  // Initialize type coercion trackers for known columns
  for (const [col, dtype] of datatypeMap.entries()) {
    if (getCoercionFn(dtype)) {
      typeCoercions.set(col, { success: 0, fail: 0, targetType: dtype });
    }
  }

  // Prepare output
  const outputDir = path.dirname(OUTPUT_CSV);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(OUTPUT_CSV, { encoding: "utf-8" });
  let headerWritten = false;
  let columns: string[] = [];
  let chunk: Record<string, string>[] = [];

  const writeHeader = (cols: string[]): void => {
    writeStream.write(cols.map(escapeCSVField).join(",") + "\n");
    headerWritten = true;
  };

  const writeRows = (rows: Record<string, string | null>[], cols: string[]): void => {
    for (const row of rows) {
      const line = cols.map((col) => escapeCSVField(String(row[col] ?? ""))).join(",");
      writeStream.write(line + "\n");
    }
  };

  // --- Chunk Processing ---

  const processChunk = (rows: Record<string, string>[]): Record<string, string | null>[] => {
    const cleaned: Record<string, string | null>[] = [];

    for (const rawRow of rows) {
      // a) Deduplication via hash
      const hash = buildRowHash(rawRow, columns);
      if (seenHashes.has(hash)) {
        duplicatesRemoved++;
        continue;
      }
      seenHashes.add(hash);

      // b) Trim whitespace + c) Normalize nulls
      const row: Record<string, string | null> = {};
      for (const col of columns) {
        let val = rawRow[col] ?? "";
        const trimmed = trimValue(val);
        if (trimmed !== val) whitespacesTrimmed++;
        const normalized = normalizeNull(trimmed);
        if (normalized === null && trimmed !== "") nullsNormalized++;
        row[col] = normalized;
      }

      // Handle DEM sentinel: -9999 → null
      if (row["dem"] !== null) {
        const demVal = Number(row["dem"]);
        if (demVal === DEM_NO_DATA) {
          row["dem"] = null;
          demSentinelNulled++;
        }
      }

      // d) Type coercion based on ontology data property ranges
      for (const [col, dtype] of datatypeMap.entries()) {
        const fn = getCoercionFn(dtype);
        if (!fn || row[col] === null || row[col] === undefined) continue;
        const result = fn(row[col] as string);
        const tracker = typeCoercions.get(col);
        if (tracker) {
          if (result.success) {
            tracker.success++;
            row[col] = result.value === null ? null : String(result.value);
          } else {
            tracker.fail++;
            row[col] = null;
          }
        }
      }

      // e) Validate constraints from ontology (domain/range) and supplementary data

      // e1) Validate coordinates
      const lat = row["latitude"] !== null ? Number(row["latitude"]) : null;
      const lon = row["longitude"] !== null ? Number(row["longitude"]) : null;
      if (lat !== null && lon !== null) {
        if (!isValidLatitude(lat) || !isValidLongitude(lon)) {
          invalidCoordinates++;
          continue; // Remove rows with invalid coordinates — critical for geo:Geometry
        }
      }

      // e2) Validate country_code against supplementary data (flag, don't remove)
      if (validCountryCodes && row["country_code"] !== null) {
        if (validCountryCodes.has(row["country_code"])) {
          suppValidation.countryCodeValidation.valid++;
        } else {
          suppValidation.countryCodeValidation.invalid++;
          if (suppValidation.countryCodeValidation.invalidCodes.size < 50) {
            suppValidation.countryCodeValidation.invalidCodes.add(row["country_code"]);
          }
        }
      }

      // e3) Validate feature_class against supplementary data (flag, don't remove)
      if (validFeatureClasses && row["feature_class"] !== null) {
        if (validFeatureClasses.has(row["feature_class"])) {
          suppValidation.featureClassValidation.valid++;
        } else {
          suppValidation.featureClassValidation.invalid++;
          if (suppValidation.featureClassValidation.invalidClasses.size < 50) {
            suppValidation.featureClassValidation.invalidClasses.add(row["feature_class"]);
          }
        }
      }

      // e4) Validate feature_code against supplementary data (flag, don't remove)
      if (validFeatureCodes && row["feature_code"] !== null) {
        if (validFeatureCodes.has(row["feature_code"])) {
          suppValidation.featureCodeValidation.valid++;
        } else {
          suppValidation.featureCodeValidation.invalid++;
          if (suppValidation.featureCodeValidation.invalidCodes.size < 50) {
            suppValidation.featureCodeValidation.invalidCodes.add(row["feature_code"]);
          }
        }
      }

      // e5) Validate admin1_code against supplementary data (flag, don't remove)
      if (validAdmin1Codes && row["admin1_code"] !== null && row["country_code"] !== null) {
        const fullAdmin1 = `${row["country_code"]}.${row["admin1_code"]}`;
        if (validAdmin1Codes.has(fullAdmin1) || row["admin1_code"] === "" || row["admin1_code"] === "00") {
          suppValidation.admin1CodeValidation.valid++;
        } else {
          suppValidation.admin1CodeValidation.invalid++;
          if (suppValidation.admin1CodeValidation.invalidCodes.size < 50) {
            suppValidation.admin1CodeValidation.invalidCodes.add(fullAdmin1);
          }
        }
      }

      // f) Remove rows that violate critical constraints
      // Critical: geonameid must be present (identifier for geo:Feature)
      if (row["geonameid"] === null || row["geonameid"] === "") {
        missingGeonameid++;
        continue;
      }

      // Critical: name must be present (rdfs:label for the Feature)
      if (row["name"] === null || row["name"] === "") {
        missingName++;
        continue;
      }

      // Critical: latitude and longitude must be present for geo:Geometry
      if (lat === null || lon === null) {
        invalidCoordinates++;
        continue;
      }

      cleaned.push(row);
    }

    return cleaned;
  };

  // --- Streaming Pipeline ---

  console.log("\nProcessing dataset with streaming parser...");
  const inputStat = fs.statSync(INPUT_PATH);
  const inputSizeMB = (inputStat.size / 1024 / 1024).toFixed(1);
  console.log(`  Input file: ${inputSizeMB} MB`);

  const startTime = Date.now();
  let lastProgressReport = 0;

  await new Promise<void>((resolve, reject) => {
    const inputStream = fs.createReadStream(INPUT_PATH, { encoding: "utf-8" });
    const parser = inputStream.pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: false, // we handle trimming ourselves
        relax_column_count: true,
      })
    );

    parser.on("data", (record: Record<string, string>) => {
      originalRows++;

      if (columns.length === 0) {
        columns = Object.keys(record);
        writeHeader(columns);
      }

      chunk.push(record);

      if (chunk.length >= CHUNK_SIZE) {
        const cleaned = processChunk(chunk);
        writeRows(cleaned, columns);
        cleanedRows += cleaned.length;
        chunk = [];

        if (originalRows - lastProgressReport >= 100_000) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = (originalRows / ((Date.now() - startTime) / 1000)).toFixed(0);
          console.log(`  Processed ${(originalRows / 1_000).toFixed(0)}K rows (${elapsed}s, ${rate} rows/s)`);
          lastProgressReport = originalRows;
        }
      }
    });

    parser.on("end", () => {
      // Process remaining rows
      if (chunk.length > 0) {
        const cleaned = processChunk(chunk);
        writeRows(cleaned, columns);
        cleanedRows += cleaned.length;
        chunk = [];
      }
      writeStream.end(() => resolve());
    });

    parser.on("error", (err: Error) => reject(err));
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nProcessing complete in ${elapsed}s`);

  // Free memory
  seenHashes.clear();

  // --- Build Report ---

  const rowsRemoved = originalRows - cleanedRows;
  const issues: CleaningIssue[] = [];

  if (duplicatesRemoved > 0) {
    issues.push({ type: "duplicate_rows_removed", count: duplicatesRemoved, severity: "info" });
  }
  if (nullsNormalized > 0) {
    issues.push({ type: "null_values_normalized", count: nullsNormalized, severity: "info" });
  }
  if (whitespacesTrimmed > 0) {
    issues.push({ type: "whitespace_trimmed", count: whitespacesTrimmed, severity: "info" });
  }
  if (demSentinelNulled > 0) {
    issues.push({ type: "dem_sentinel_-9999_nulled", count: demSentinelNulled, severity: "info" });
  }
  if (invalidCoordinates > 0) {
    issues.push({ type: "invalid_coordinates_removed", count: invalidCoordinates, severity: "warning" });
  }
  if (missingGeonameid > 0) {
    issues.push({ type: "missing_geonameid_removed", count: missingGeonameid, severity: "error" });
  }
  if (missingName > 0) {
    issues.push({ type: "missing_name_removed", count: missingName, severity: "warning" });
  }

  // Supplementary validation issues (flagged, not removed)
  if (suppValidation.countryCodeValidation.invalid > 0) {
    issues.push({ type: "invalid_country_codes_flagged", count: suppValidation.countryCodeValidation.invalid, severity: "warning" });
  }
  if (suppValidation.featureClassValidation.invalid > 0) {
    issues.push({ type: "invalid_feature_classes_flagged", count: suppValidation.featureClassValidation.invalid, severity: "warning" });
  }
  if (suppValidation.featureCodeValidation.invalid > 0) {
    issues.push({ type: "invalid_feature_codes_flagged", count: suppValidation.featureCodeValidation.invalid, severity: "warning" });
  }
  if (suppValidation.admin1CodeValidation.invalid > 0) {
    issues.push({ type: "invalid_admin1_codes_flagged", count: suppValidation.admin1CodeValidation.invalid, severity: "warning" });
  }

  // Check for high coercion failure rates
  for (const [col, stats] of typeCoercions.entries()) {
    const total = stats.success + stats.fail;
    if (total > 0 && stats.fail / total > 0.1) {
      issues.push({
        type: `high_coercion_failure_${col}`,
        count: stats.fail,
        severity: "warning",
      });
    }
  }

  const typeCoercionResults: TypeCoercion[] = [];
  for (const [col, stats] of typeCoercions.entries()) {
    typeCoercionResults.push({
      column: col,
      targetType: stats.targetType,
      successCount: stats.success,
      failCount: stats.fail,
    });
  }

  const report: CleaningReport = {
    originalRows,
    cleanedRows,
    rowsRemoved,
    duplicatesRemoved,
    issues,
    typeCoercions: typeCoercionResults,
    supplementaryValidation: {
      countryCodeValidation: {
        valid: suppValidation.countryCodeValidation.valid,
        invalid: suppValidation.countryCodeValidation.invalid,
        invalidCodes: [...suppValidation.countryCodeValidation.invalidCodes],
      },
      featureCodeValidation: {
        valid: suppValidation.featureCodeValidation.valid,
        invalid: suppValidation.featureCodeValidation.invalid,
        invalidCodes: [...suppValidation.featureCodeValidation.invalidCodes],
      },
      featureClassValidation: {
        valid: suppValidation.featureClassValidation.valid,
        invalid: suppValidation.featureClassValidation.invalid,
        invalidClasses: [...suppValidation.featureClassValidation.invalidClasses],
      },
      admin1CodeValidation: {
        valid: suppValidation.admin1CodeValidation.valid,
        invalid: suppValidation.admin1CodeValidation.invalid,
        invalidCodes: [...suppValidation.admin1CodeValidation.invalidCodes],
      },
    },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_REPORT, JSON.stringify(report, null, 2));

  // --- Print Summary ---

  console.log("\n=== Cleaning Summary ===");
  console.log(`  Original rows:        ${originalRows.toLocaleString()}`);
  console.log(`  Cleaned rows:         ${cleanedRows.toLocaleString()}`);
  console.log(`  Rows removed:         ${rowsRemoved.toLocaleString()} (${((rowsRemoved / originalRows) * 100).toFixed(2)}%)`);
  console.log(`    - Duplicates:       ${duplicatesRemoved.toLocaleString()}`);
  console.log(`    - Invalid coords:   ${invalidCoordinates.toLocaleString()}`);
  console.log(`    - Missing geonameid:${missingGeonameid.toLocaleString()}`);
  console.log(`    - Missing name:     ${missingName.toLocaleString()}`);
  console.log(`  Nulls normalized:     ${nullsNormalized.toLocaleString()}`);
  console.log(`  Whitespace trims:     ${whitespacesTrimmed.toLocaleString()}`);
  console.log(`  DEM sentinels nulled: ${demSentinelNulled.toLocaleString()}`);

  console.log("\n  Type Coercions:");
  for (const tc of typeCoercionResults) {
    if (tc.successCount + tc.failCount > 0) {
      const total = tc.successCount + tc.failCount;
      const pct = ((tc.successCount / total) * 100).toFixed(1);
      console.log(`    ${tc.column} -> ${tc.targetType}: ${tc.successCount.toLocaleString()}/${total.toLocaleString()} (${pct}% success)`);
    }
  }

  if (validCountryCodes || validFeatureCodes || validAdmin1Codes) {
    console.log("\n  Supplementary Validation (flagged, not removed):");
    if (validCountryCodes) {
      const cc = suppValidation.countryCodeValidation;
      console.log(`    Country codes:  ${cc.valid.toLocaleString()} valid, ${cc.invalid.toLocaleString()} invalid${cc.invalidCodes.size > 0 ? ` [${[...cc.invalidCodes].slice(0, 10).join(", ")}]` : ""}`);
    }
    if (validFeatureClasses) {
      const fc = suppValidation.featureClassValidation;
      console.log(`    Feature classes: ${fc.valid.toLocaleString()} valid, ${fc.invalid.toLocaleString()} invalid${fc.invalidClasses.size > 0 ? ` [${[...fc.invalidClasses].slice(0, 10).join(", ")}]` : ""}`);
    }
    if (validFeatureCodes) {
      const fc = suppValidation.featureCodeValidation;
      console.log(`    Feature codes:  ${fc.valid.toLocaleString()} valid, ${fc.invalid.toLocaleString()} invalid${fc.invalidCodes.size > 0 ? ` [${[...fc.invalidCodes].slice(0, 10).join(", ")}]` : ""}`);
    }
    if (validAdmin1Codes) {
      const ac = suppValidation.admin1CodeValidation;
      console.log(`    Admin1 codes:   ${ac.valid.toLocaleString()} valid, ${ac.invalid.toLocaleString()} invalid${ac.invalidCodes.size > 0 ? ` [${[...ac.invalidCodes].slice(0, 10).join(", ")}]` : ""}`);
    }
  }

  console.log(`\n  Issues: ${issues.length}`);
  for (const issue of issues) {
    const icon = issue.severity === "error" ? "✗" : issue.severity === "warning" ? "⚠" : "ℹ";
    console.log(`    ${icon} ${issue.type}: ${issue.count.toLocaleString()}`);
  }

  console.log(`\n  Output: ${OUTPUT_CSV}`);
  console.log(`  Report: ${OUTPUT_REPORT}`);
  console.log("\n=== Done ===");
};

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
