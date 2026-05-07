import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { parse } from "csv-parse";
import { parse as parseSync } from "csv-parse/sync";

type RawValue = string | null;
type CleanValue = string | number | boolean | null;
type RawRow = Record<string, RawValue>;
type CleanRow = Record<string, CleanValue>;
type Severity = "info" | "warning" | "critical";
type SupportedDatatype =
  | "xsd:string"
  | "xsd:integer"
  | "xsd:decimal"
  | "xsd:boolean"
  | "xsd:date"
  | "xsd:dateTime"
  | "xsd:gYear"
  | "xsd:anyURI";

interface OntologyClass {
  uri: string;
  label: string;
  superClasses?: string[];
}

interface ObjectProperty {
  uri: string;
  label: string;
  domain?: string[];
  range?: string[];
}

interface DataProperty {
  uri: string;
  label: string;
  domain?: string[];
  range?: string;
}

interface OntologyStructure {
  metadata: {
    title: string;
    version: string;
    namespaces: Record<string, string>;
  };
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  identifierColumn: string;
  compliant: boolean;
}

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  targetEntity: string;
  datatype: string;
  compliant: boolean;
}

interface RelationshipMapping {
  columnName: string;
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  compliant: boolean;
}

interface MappingStrategy {
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
}

interface SupplementaryFileDescriptor {
  name?: string;
  path?: string;
  filePath?: string;
  location?: string;
  format?: string;
  description?: string;
  columns?: string[];
}

interface SupplementaryLookup {
  fileName: string;
  normalizedColumns: string[];
  validCodes: Set<string>;
  labelByCode: Map<string, string>;
}

interface IssueSummary {
  type: string;
  count: number;
  severity: Severity;
}

interface TypeCoercionSummary {
  column: string;
  successCount: number;
  failCount: number;
}

interface CleaningReport {
  originalRows: number;
  cleanedRows: number;
  rowsRemoved: number;
  issues: IssueSummary[];
  typeCoercions: TypeCoercionSummary[];
}

interface DataPropertyConstraint {
  columnName: string;
  property: string;
  targetEntity: string;
  datatype: SupportedDatatype;
  propertyDomain: string[];
}

interface RelationshipConstraint {
  columnName: string;
  relationship: string;
  sourceEntity: string;
  targetEntity: string;
  propertyDomain: string[];
  propertyRange: string[];
}

interface Context {
  headers: string[];
  namespaces: Record<string, string>;
  classHierarchy: Map<string, Set<string>>;
  primaryIdentifierColumn: string;
  dataPropertyConstraints: Map<string, DataPropertyConstraint>;
  relationshipConstraints: Map<string, RelationshipConstraint>;
  labelishColumns: Set<string>;
  entityColumnsByIdentifier: Map<string, string[]>;
  recordTypeClasses: Map<string, string>;
  validRecordTypes: Set<string>;
  supplementaryLookupsByColumn: Map<string, SupplementaryLookup>;
}

interface RowIssue {
  type: string;
  severity: Severity;
}

interface CoercionCounter {
  successCount: number;
  failCount: number;
}

interface ProcessedRowResult {
  row: CleanRow | null;
  issues: RowIssue[];
  coercions: Map<string, CoercionCounter>;
}

interface PartitionEntry {
  s: string;
  v: string[];
}

interface AggregateState {
  originalRows: number;
  cleanedRows: number;
  rowsRemoved: number;
  issueCounts: Map<string, { count: number; severity: Severity }>;
  coercionCounts: Map<string, CoercionCounter>;
  cleanedHeaderWritten: boolean;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/scientific-dblp";
const INPUT_PATH = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const ONTOLOGY_PATH = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const MAPPING_PATH = path.resolve(OUTPUT_DIR, "mapping-strategy.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");
const OUTPUT_CSV_PATH = path.resolve(OUTPUT_DIR, "dataset-cleaned.csv");
const OUTPUT_REPORT_PATH = path.resolve(OUTPUT_DIR, "cleaning-report.json");

const CHUNK_THRESHOLD = 10_000;
const CHUNK_SIZE = 5_000;
const PARTITION_COUNT = 64;
const NULL_TOKENS = new Set([
  "",
  "null",
  "n/a",
  "na",
  "none",
  "nil",
  "undefined",
  "unknown",
  "-",
  "--",
  "\\n",
  "\\N",
  "tbd",
]);
const BOOLEAN_TRUE = new Set(["true", "1", "yes", "y"]);
const BOOLEAN_FALSE = new Set(["false", "0", "no", "n"]);
const LABELISH_PATTERN = /(label|name|title)$/i;
const CODE_COLUMN_PATTERN = /(code|abbr|abbreviation|id|identifier|key|symbol)$/i;
const LABEL_COLUMN_PATTERN = /(label|name|title|description)$/i;
const CRITICAL_ISSUES = new Set([
  "missing_primary_identifier",
  "missing_record_type",
  "invalid_record_type",
  "invalid_record_type_mapping",
  "invalid_domain_constraint",
  "invalid_range_constraint",
]);

const readUtf8 = (filePath: string): string => fs.readFileSync(filePath, "utf8");

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const loadJson = <T>(filePath: string): T => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }

  return JSON.parse(readUtf8(filePath)) as T;
};

const loadOptionalJson = <T>(filePath: string): T | null =>
  fs.existsSync(filePath) ? (JSON.parse(readUtf8(filePath)) as T) : null;

const normalizeText = (value: string): string => value.trim().toLowerCase();

const normalizeColumnName = (value: string): string =>
  normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();

const normalizeLookupKey = (value: string): string => normalizeText(value);

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const appendIssue = (issues: RowIssue[], type: string, severity: Severity): RowIssue[] => [
  ...issues,
  { type, severity },
];

const mergeCoercion = (
  coercions: Map<string, CoercionCounter>,
  column: string,
  success: boolean,
): Map<string, CoercionCounter> => {
  const current = coercions.get(column) ?? { successCount: 0, failCount: 0 };
  const next = success
    ? { successCount: current.successCount + 1, failCount: current.failCount }
    : { successCount: current.successCount, failCount: current.failCount + 1 };
  const merged = new Map(coercions);
  merged.set(column, next);
  return merged;
};

const resolvePrefixedTerm = (term: string, namespaces: Record<string, string>): string => {
  if (!term.includes(":")) {
    return term;
  }

  const [prefix, localName] = term.split(/:(.+)/);
  const namespace = namespaces[prefix];
  return namespace ? `${namespace}${localName}` : term;
};

const normalizeDatatype = (datatype: string): SupportedDatatype => {
  const normalized = datatype
    .replace("http://www.w3.org/2001/XMLSchema#", "xsd:")
    .replace("http://www.w3.org/2001/XMLSchema/", "xsd:");

  if (
    normalized === "xsd:integer" ||
    normalized === "xsd:decimal" ||
    normalized === "xsd:boolean" ||
    normalized === "xsd:date" ||
    normalized === "xsd:dateTime" ||
    normalized === "xsd:gYear" ||
    normalized === "xsd:anyURI"
  ) {
    return normalized;
  }

  if (normalized === "xsd:float" || normalized === "xsd:double") {
    return "xsd:decimal";
  }

  return "xsd:string";
};

const loadCsvHeaders = async (filePath: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const parser = parse({ bom: true });
    const stream = fs.createReadStream(filePath);
    let resolved = false;

    parser.on("readable", () => {
      if (resolved) {
        return;
      }

      const row = parser.read() as string[] | null;
      if (row) {
        resolved = true;
        stream.destroy();
        parser.end();
        resolve(row.map((value) => String(value)));
      }
    });

    parser.on("error", reject);
    stream.on("error", reject);
    stream.pipe(parser);
  });

const buildClassHierarchy = (classes: OntologyClass[]): Map<string, Set<string>> => {
  const superMap = new Map(classes.map((ontologyClass) => [ontologyClass.uri, ontologyClass.superClasses ?? []]));

  const visit = (classUri: string, trail: Set<string>): Set<string> => {
    const direct = superMap.get(classUri) ?? [];
    const inherited = direct.reduce<Set<string>>((accumulator, parent) => {
      if (trail.has(parent)) {
        return accumulator;
      }

      return new Set([
        ...Array.from(accumulator),
        parent,
        ...Array.from(visit(parent, new Set([...Array.from(trail), parent]))),
      ]);
    }, new Set<string>());

    return new Set([classUri, ...Array.from(inherited)]);
  };

  return new Map(classes.map((ontologyClass) => [ontologyClass.uri, visit(ontologyClass.uri, new Set([ontologyClass.uri]))]));
};

const isClassCompatible = (
  actualClass: string,
  expectedClasses: string[],
  hierarchy: Map<string, Set<string>>,
): boolean => {
  if (expectedClasses.length === 0) {
    return true;
  }

  const resolvedActual = hierarchy.get(actualClass) ?? new Set([actualClass]);
  return expectedClasses.some((expectedClass) => resolvedActual.has(expectedClass));
};

const parseDelimitedRows = (text: string, delimiter: string): RawRow[] => {
  const parsed = parseSync(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    delimiter,
    relax_column_count: true,
  });

  return parsed.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, value === undefined ? "" : String(value)]),
    ),
  );
};

const parseJsonRows = (text: string): RawRow[] => {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? Object.values(parsed as Record<string, unknown>).find(Array.isArray) ?? []
      : [];

  return Array.isArray(rows)
    ? rows
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key), value === undefined ? "" : String(value)])))
    : [];
};

const parseJsonlRows = (text: string): RawRow[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key), value === undefined ? "" : String(value)])));

const normalizeSupplementaryDescriptor = (
  entry: SupplementaryFileDescriptor,
  indexDir: string,
): { fileName: string; filePath: string; format: string; columns: string[] } | null => {
  const rawPath = String(entry.path ?? entry.filePath ?? entry.location ?? "").trim();
  const fileName = String(entry.name ?? path.basename(rawPath)).trim();

  if (!rawPath && !fileName) {
    return null;
  }

  const filePath = rawPath
    ? path.isAbsolute(rawPath)
      ? rawPath
      : fs.existsSync(path.resolve(indexDir, rawPath))
        ? path.resolve(indexDir, rawPath)
        : path.resolve(SUPPLEMENTARY_DIR, rawPath)
    : path.resolve(SUPPLEMENTARY_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const format = String(entry.format ?? path.extname(filePath).slice(1)).trim().toLowerCase();

  return {
    fileName: fileName || path.basename(filePath),
    filePath,
    format,
    columns: Array.isArray(entry.columns) ? entry.columns.map((value) => String(value)) : [],
  };
};

const deriveLookup = (
  rows: RawRow[],
  descriptor: { fileName: string; columns: string[] },
): SupplementaryLookup | null => {
  if (rows.length === 0) {
    return null;
  }

  const sample = rows[0];
  const columns = Object.keys(sample);
  const codeColumn =
    columns.find((column) => CODE_COLUMN_PATTERN.test(column)) ??
    columns.find((column) => normalizeColumnName(column).includes("code")) ??
    columns[0];
  const labelColumn =
    columns.find((column) => LABEL_COLUMN_PATTERN.test(column) && column !== codeColumn) ??
    columns.find((column) => column !== codeColumn);

  if (!codeColumn) {
    return null;
  }

  const entries = rows
    .map((row) => ({
      code: row[codeColumn],
      label: labelColumn ? row[labelColumn] : null,
    }))
    .filter((entry): entry is { code: string; label: string | null } => typeof entry.code === "string" && entry.code.trim().length > 0);

  if (entries.length === 0) {
    return null;
  }

  return {
    fileName: descriptor.fileName,
    normalizedColumns: unique(
      [...descriptor.columns, descriptor.fileName.replace(path.extname(descriptor.fileName), ""), codeColumn, labelColumn ?? ""]
        .filter((value) => value.length > 0)
        .map(normalizeColumnName),
    ),
    validCodes: new Set(entries.map((entry) => normalizeLookupKey(entry.code))),
    labelByCode: new Map(
      entries
        .filter((entry) => entry.label !== null && String(entry.label).trim().length > 0)
        .map((entry) => [normalizeLookupKey(entry.code), String(entry.label).trim()]),
    ),
  };
};

const loadSupplementaryLookups = (): SupplementaryLookup[] => {
  const rawIndex = loadOptionalJson<unknown>(SUPPLEMENTARY_INDEX_PATH);
  if (!rawIndex || !fs.existsSync(SUPPLEMENTARY_DIR)) {
    return [];
  }

  const descriptorsSource = (() => {
    if (Array.isArray(rawIndex)) {
      return rawIndex as SupplementaryFileDescriptor[];
    }

    if (typeof rawIndex === "object" && rawIndex !== null) {
      const files = (rawIndex as { files?: SupplementaryFileDescriptor[] }).files;
      return Array.isArray(files) ? files : [];
    }

    return [];
  })();

  const indexDir = path.dirname(SUPPLEMENTARY_INDEX_PATH);

  return descriptorsSource
    .map((entry) => normalizeSupplementaryDescriptor(entry, indexDir))
    .filter((entry): entry is { fileName: string; filePath: string; format: string; columns: string[] } => entry !== null)
    .map((entry) => {
      const text = readUtf8(entry.filePath);
      if (entry.format === "csv") {
        return deriveLookup(parseDelimitedRows(text, ","), entry);
      }
      if (entry.format === "tsv") {
        return deriveLookup(parseDelimitedRows(text, "\t"), entry);
      }
      if (entry.format === "json") {
        return deriveLookup(parseJsonRows(text), entry);
      }
      if (entry.format === "jsonl" || entry.format === "ndjson") {
        return deriveLookup(parseJsonlRows(text), entry);
      }

      return null;
    })
    .filter((lookup): lookup is SupplementaryLookup => lookup !== null);
};

const mapSupplementaryLookupsByColumn = (
  headers: string[],
  lookups: SupplementaryLookup[],
): Map<string, SupplementaryLookup> =>
  new Map(
    headers.flatMap((header) => {
      const normalizedHeader = normalizeColumnName(header);
      const lookup = lookups.find((candidate) => candidate.normalizedColumns.includes(normalizedHeader));
      return lookup ? [[header, lookup] as const] : [];
    }),
  );

const getRawSignature = (headers: string[], row: RawRow): string =>
  JSON.stringify(headers.map((header) => row[header] ?? ""));

const getPartitionIndex = (signature: string): number => {
  const digest = crypto.createHash("sha1").update(signature).digest();
  return digest.readUInt16BE(0) % PARTITION_COUNT;
};

const trimRow = (row: RawRow, headers: string[]): RawRow =>
  Object.fromEntries(headers.map((header) => [header, typeof row[header] === "string" ? row[header]!.trim() : row[header] ?? null]));

const normalizeNullValue = (value: RawValue): RawValue => {
  if (value === null) {
    return null;
  }

  return NULL_TOKENS.has(normalizeText(value)) ? null : value;
};

const normalizeNullRow = (row: RawRow, headers: string[]): RawRow =>
  Object.fromEntries(headers.map((header) => [header, normalizeNullValue(row[header] ?? null)]));

const parseInteger = (value: string): number | null => (/^[+-]?\d+$/.test(value) ? Number(value) : null);

const parseDecimal = (value: string): number | null => {
  const normalized = value.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseBoolean = (value: string): boolean | null => {
  const normalized = normalizeText(value);
  if (BOOLEAN_TRUE.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE.has(normalized)) {
    return false;
  }
  return null;
};

const parseIsoDate = (value: string): string | null => {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : trimmed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

const parseIsoDateTime = (value: string): string | null => {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T00:00:00Z`).toISOString();
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const parseGYear = (value: string): number | null => {
  const parsed = parseInteger(value);
  return parsed !== null && parsed >= 1000 && parsed <= 9999 ? parsed : null;
};

const parseUri = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.includes("/") ? trimmed : null;
};

const coerceValue = (value: RawValue, datatype: SupportedDatatype): CleanValue | null => {
  if (value === null) {
    return null;
  }

  if (datatype === "xsd:integer") {
    return parseInteger(value);
  }
  if (datatype === "xsd:decimal") {
    return parseDecimal(value);
  }
  if (datatype === "xsd:boolean") {
    return parseBoolean(value);
  }
  if (datatype === "xsd:date") {
    return parseIsoDate(value);
  }
  if (datatype === "xsd:dateTime") {
    return parseIsoDateTime(value);
  }
  if (datatype === "xsd:gYear") {
    return parseGYear(value);
  }
  if (datatype === "xsd:anyURI") {
    return parseUri(value);
  }

  return value;
};

const coerceTypedColumns = (
  row: RawRow,
  constraints: Map<string, DataPropertyConstraint>,
): { row: CleanRow; issues: RowIssue[]; coercions: Map<string, CoercionCounter> } => {
  const initial = { row: {} as CleanRow, issues: [] as RowIssue[], coercions: new Map<string, CoercionCounter>() };

  return Object.keys(row).reduce((state, columnName) => {
    const constraint = constraints.get(columnName);
    const rawValue = row[columnName] ?? null;

    if (!constraint) {
      return {
        ...state,
        row: { ...state.row, [columnName]: rawValue },
      };
    }

    if (rawValue === null) {
      return {
        ...state,
        row: { ...state.row, [columnName]: null },
      };
    }

    const coercedValue = coerceValue(rawValue, constraint.datatype);
    const nextCoercions = mergeCoercion(state.coercions, columnName, coercedValue !== null);
    const nextIssues =
      coercedValue === null
        ? appendIssue(state.issues, `type_coercion_failed:${columnName}`, columnName === "year" || columnName === "mdate" ? "critical" : "warning")
        : state.issues;

    return {
      row: { ...state.row, [columnName]: coercedValue },
      issues: nextIssues,
      coercions: nextCoercions,
    };
  }, initial);
};

const resolveSupplementaryValue = (
  columnName: string,
  value: CleanValue,
  lookup: SupplementaryLookup | undefined,
  isLabelish: boolean,
): { value: CleanValue; issues: RowIssue[] } => {
  if (!lookup || value === null || typeof value !== "string") {
    return { value, issues: [] };
  }

  const normalized = normalizeLookupKey(value);
  if (!lookup.validCodes.has(normalized)) {
    return {
      value,
      issues: [{ type: `invalid_reference_code:${columnName}`, severity: "warning" }],
    };
  }

  if (isLabelish && lookup.labelByCode.has(normalized)) {
    return { value: lookup.labelByCode.get(normalized) ?? value, issues: [] };
  }

  return { value, issues: [] };
};

const getRowEntityClasses = (row: CleanRow, context: Context): string[] => {
  const baseType = row.record_type;
  if (typeof baseType !== "string") {
    return [];
  }

  const specific = context.recordTypeClasses.get(normalizeText(baseType));
  return specific ? unique(["core:Endeavour", specific]) : ["core:Endeavour"];
};

const validatePrimaryConstraints = (row: CleanRow, context: Context): RowIssue[] => {
  const identifier = row[context.primaryIdentifierColumn];
  const recordType = row.record_type;

  const missingIdentifier =
    identifier === null || (typeof identifier === "string" && normalizeText(identifier).length === 0);
  if (missingIdentifier) {
    return [{ type: "missing_primary_identifier", severity: "critical" }];
  }

  if (recordType === null || typeof recordType !== "string" || normalizeText(recordType).length === 0) {
    return [{ type: "missing_record_type", severity: "critical" }];
  }

  if (!context.validRecordTypes.has(normalizeText(recordType))) {
    return [{ type: "invalid_record_type", severity: "critical" }];
  }

  if (!context.recordTypeClasses.has(normalizeText(recordType))) {
    return [{ type: "invalid_record_type_mapping", severity: "critical" }];
  }

  return [];
};

const validateDataPropertyConstraints = (row: CleanRow, context: Context): RowIssue[] =>
  Array.from(context.dataPropertyConstraints.values()).flatMap((constraint) => {
    const value = row[constraint.columnName];
    if (value === null) {
      return [];
    }

    return isClassCompatible(constraint.targetEntity, constraint.propertyDomain, context.classHierarchy)
      ? []
      : [{ type: `invalid_domain_constraint:${constraint.columnName}`, severity: "critical" }];
  });

const validateRelationshipConstraints = (row: CleanRow, context: Context): RowIssue[] =>
  Array.from(context.relationshipConstraints.values()).flatMap((constraint) => {
    const value = row[constraint.columnName];
    if (value === null || typeof value !== "string" || value.trim().length === 0) {
      return [];
    }

    const domainValid = isClassCompatible(constraint.sourceEntity, constraint.propertyDomain, context.classHierarchy);
    const rangeValid = isClassCompatible(constraint.targetEntity, constraint.propertyRange, context.classHierarchy);

    return [
      ...(domainValid ? [] : [{ type: `invalid_domain_constraint:${constraint.columnName}`, severity: "critical" as const }]),
      ...(rangeValid ? [] : [{ type: `invalid_range_constraint:${constraint.columnName}`, severity: "critical" as const }]),
    ];
  });

const applySupplementaryLookups = (row: CleanRow, context: Context): { row: CleanRow; issues: RowIssue[] } =>
  Object.keys(row).reduce(
    (state, columnName) => {
      const resolved = resolveSupplementaryValue(
        columnName,
        row[columnName],
        context.supplementaryLookupsByColumn.get(columnName),
        context.labelishColumns.has(columnName),
      );

      return {
        row: { ...state.row, [columnName]: resolved.value },
        issues: [...state.issues, ...resolved.issues],
      };
    },
    { row: {} as CleanRow, issues: [] as RowIssue[] },
  );

const removeCriticalViolations = (issues: RowIssue[]): boolean => issues.some((issue) => CRITICAL_ISSUES.has(issue.type.split(":")[0]));

const processRow = (rawRow: RawRow, context: Context): ProcessedRowResult => {
  const trimmedRow = trimRow(rawRow, context.headers);
  const normalizedRow = normalizeNullRow(trimmedRow, context.headers);
  const typed = coerceTypedColumns(normalizedRow, context.dataPropertyConstraints);
  const supplemented = applySupplementaryLookups(typed.row, context);
  const primaryIssues = validatePrimaryConstraints(supplemented.row, context);
  const dataConstraintIssues = validateDataPropertyConstraints(supplemented.row, context);
  const relationshipIssues = validateRelationshipConstraints(supplemented.row, context);
  const issues = [...typed.issues, ...supplemented.issues, ...primaryIssues, ...dataConstraintIssues, ...relationshipIssues];

  return {
    row: removeCriticalViolations(issues) ? null : supplemented.row,
    issues,
    coercions: typed.coercions,
  };
};

const serializeCsvValue = (value: CleanValue): string => {
  if (value === null) {
    return "";
  }

  const stringValue = String(value);
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replace(/"/g, "\"\"")}"` : stringValue;
};

const serializeRows = (headers: string[], rows: CleanRow[], includeHeader: boolean): string => {
  const lines = rows.map((row) => headers.map((header) => serializeCsvValue(row[header] ?? null)).join(","));
  return `${includeHeader ? `${headers.map((header) => serializeCsvValue(header)).join(",")}\n` : ""}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
};

const accumulateIssues = (
  issueCounts: Map<string, { count: number; severity: Severity }>,
  issues: RowIssue[],
): Map<string, { count: number; severity: Severity }> => {
  const next = new Map(issueCounts);

  issues.forEach((issue) => {
    const current = next.get(issue.type);
    next.set(issue.type, {
      count: (current?.count ?? 0) + 1,
      severity: current?.severity ?? issue.severity,
    });
  });

  return next;
};

const accumulateCoercions = (
  current: Map<string, CoercionCounter>,
  incoming: Map<string, CoercionCounter>,
): Map<string, CoercionCounter> => {
  const next = new Map(current);

  incoming.forEach((counter, column) => {
    const previous = next.get(column) ?? { successCount: 0, failCount: 0 };
    next.set(column, {
      successCount: previous.successCount + counter.successCount,
      failCount: previous.failCount + counter.failCount,
    });
  });

  return next;
};

const flushChunk = (rows: CleanRow[], state: AggregateState, headers: string[]): AggregateState => {
  if (rows.length === 0) {
    return state;
  }

  fs.appendFileSync(OUTPUT_CSV_PATH, serializeRows(headers, rows, !state.cleanedHeaderWritten));
  return {
    ...state,
    cleanedRows: state.cleanedRows + rows.length,
    cleanedHeaderWritten: true,
  };
};

const createContext = (
  headers: string[],
  ontology: OntologyStructure,
  mapping: MappingStrategy,
  supplementaryLookups: SupplementaryLookup[],
): Context => {
  const namespaces = ontology.metadata.namespaces;
  const dataPropertyByUri = new Map(
    ontology.dataProperties.map((property) => [property.uri, property]),
  );
  const objectPropertyByUri = new Map(
    ontology.objectProperties.map((property) => [property.uri, property]),
  );

  const dataPropertyConstraints = new Map(
    mapping.attributeMappings
      .filter((attribute) => attribute.compliant)
      .map((attribute) => {
        const propertyUri = resolvePrefixedTerm(attribute.ontologyProperty, namespaces);
        const property = dataPropertyByUri.get(propertyUri);
        const datatype = normalizeDatatype(property?.range ?? attribute.datatype);
        return [
          attribute.columnName,
          {
            columnName: attribute.columnName,
            property: attribute.ontologyProperty,
            targetEntity: attribute.targetEntity,
            datatype,
            propertyDomain: property?.domain ?? [],
          } satisfies DataPropertyConstraint,
        ] as const;
      }),
  );

  const relationshipConstraints = new Map(
    mapping.relationshipMappings
      .filter((relationship) => relationship.compliant)
      .map((relationship) => {
        const propertyUri = resolvePrefixedTerm(relationship.ontologyRelationship, namespaces);
        const property = objectPropertyByUri.get(propertyUri);
        return [
          relationship.columnName,
          {
            columnName: relationship.columnName,
            relationship: relationship.ontologyRelationship,
            sourceEntity: relationship.sourceEntity,
            targetEntity: relationship.targetEntity,
            propertyDomain: property?.domain ?? [],
            propertyRange: property?.range ?? [],
          } satisfies RelationshipConstraint,
        ] as const;
      }),
  );

  const recordTypeClasses = new Map(
    mapping.entityMappings
      .filter((entity) => entity.columnName.startsWith("record_type=") && entity.compliant)
      .map((entity) => [normalizeText(entity.columnName.split("=")[1] ?? ""), entity.ontologyClass]),
  );

  const entityColumnsByIdentifier = new Map<string, string[]>();
  mapping.entityMappings
    .filter((entity) => entity.compliant)
    .forEach((entity) => {
      const current = entityColumnsByIdentifier.get(entity.identifierColumn) ?? [];
      entityColumnsByIdentifier.set(entity.identifierColumn, unique([...current, entity.columnName]));
    });

  const labelishColumns = new Set(
    mapping.attributeMappings
      .filter((attribute) => attribute.compliant && LABELISH_PATTERN.test(attribute.ontologyProperty))
      .map((attribute) => attribute.columnName),
  );

  return {
    headers,
    namespaces,
    classHierarchy: buildClassHierarchy(ontology.classes),
    primaryIdentifierColumn: "key",
    dataPropertyConstraints,
    relationshipConstraints,
    labelishColumns,
    entityColumnsByIdentifier,
    recordTypeClasses,
    validRecordTypes: new Set(recordTypeClasses.keys()),
    supplementaryLookupsByColumn: mapSupplementaryLookupsByColumn(headers, supplementaryLookups),
  };
};

const partitionInputRows = async (headers: string[], partitionsDir: string): Promise<number> => {
  const streams = Array.from({ length: PARTITION_COUNT }, (_, index) =>
    fs.createWriteStream(path.join(partitionsDir, `partition-${String(index).padStart(2, "0")}.jsonl`), {
      encoding: "utf8",
    }),
  );

  const parser = parse({
    columns: true,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });

  let originalRows = 0;

  const finish = async (): Promise<void> => {
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve, reject) => {
            stream.on("error", reject);
            stream.end(resolve);
          }),
      ),
    );
  };

  await new Promise<void>((resolve, reject) => {
    parser.on("readable", () => {
      let record = parser.read() as Record<string, unknown> | null;
      while (record !== null) {
        originalRows += 1;
        if (originalRows % 1_000_000 === 0) {
          logProgress(`partitioned ${originalRows} rows`);
        }
        const row = Object.fromEntries(
          headers.map((header) => [header, record?.[header] === undefined ? "" : String(record[header])]),
        ) as RawRow;
        const signature = getRawSignature(headers, row);
        const partitionIndex = getPartitionIndex(signature);
        const line = JSON.stringify({ s: signature, v: headers.map((header) => row[header] ?? "") } satisfies PartitionEntry);
        streams[partitionIndex].write(`${line}\n`);
        record = parser.read() as Record<string, unknown> | null;
      }
    });

    parser.on("error", reject);
    parser.on("end", resolve);
    fs.createReadStream(INPUT_PATH).on("error", reject).pipe(parser);
  });

  await finish();
  return originalRows;
};

const processPartitions = async (
  headers: string[],
  partitionsDir: string,
  context: Context,
): Promise<AggregateState> => {
  const initialState: AggregateState = {
    originalRows: 0,
    cleanedRows: 0,
    rowsRemoved: 0,
    issueCounts: new Map(),
    coercionCounts: new Map(),
    cleanedHeaderWritten: false,
  };

  let state = initialState;

  for (let index = 0; index < PARTITION_COUNT; index += 1) {
    const partitionPath = path.join(partitionsDir, `partition-${String(index).padStart(2, "0")}.jsonl`);
    if (!fs.existsSync(partitionPath) || fs.statSync(partitionPath).size === 0) {
      continue;
    }

    logProgress(`processing partition ${index + 1}/${PARTITION_COUNT}`);

    const seenSignatures = new Set<string>();
    const reader = readline.createInterface({
      input: fs.createReadStream(partitionPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let chunk: CleanRow[] = [];

    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }

      const entry = JSON.parse(line) as PartitionEntry;
      if (seenSignatures.has(entry.s)) {
        state = {
          ...state,
          rowsRemoved: state.rowsRemoved + 1,
          issueCounts: accumulateIssues(state.issueCounts, [{ type: "exact_duplicate_row", severity: "info" }]),
        };
        continue;
      }

      seenSignatures.add(entry.s);

      const rawRow = Object.fromEntries(headers.map((header, position) => [header, entry.v[position] ?? ""])) as RawRow;
      const processed = processRow(rawRow, context);
      state = {
        ...state,
        issueCounts: accumulateIssues(state.issueCounts, processed.issues),
        coercionCounts: accumulateCoercions(state.coercionCounts, processed.coercions),
      };

      if (processed.row === null) {
        state = { ...state, rowsRemoved: state.rowsRemoved + 1 };
        continue;
      }

      chunk = [...chunk, processed.row];
      if (chunk.length >= CHUNK_SIZE) {
        state = flushChunk(chunk, state, headers);
        chunk = [];
      }
    }

    state = flushChunk(chunk, state, headers);
  }

  return state;
};

const buildReport = (state: AggregateState): CleaningReport => ({
  originalRows: state.originalRows,
  cleanedRows: state.cleanedRows,
  rowsRemoved: state.rowsRemoved,
  issues: Array.from(state.issueCounts.entries())
    .map(([type, value]) => ({ type, count: value.count, severity: value.severity }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
  typeCoercions: Array.from(state.coercionCounts.entries())
    .map(([column, counters]) => ({
      column,
      successCount: counters.successCount,
      failCount: counters.failCount,
    }))
    .sort((left, right) => left.column.localeCompare(right.column)),
});

const saveReport = (report: CleaningReport): void => {
  fs.writeFileSync(OUTPUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
};

const printSummary = (report: CleaningReport, chunked: boolean): void => {
  const topIssues = report.issues.slice(0, 8).map((issue) => `${issue.type}=${issue.count} [${issue.severity}]`);
  console.log(`Original rows: ${report.originalRows}`);
  console.log(`Cleaned rows: ${report.cleanedRows}`);
  console.log(`Rows removed: ${report.rowsRemoved}`);
  console.log(`Chunked processing: ${chunked ? `yes (${CHUNK_SIZE} rows)` : "no"}`);
  console.log(`Issues: ${topIssues.length > 0 ? topIssues.join(", ") : "none"}`);
  console.log(`Cleaned dataset: ${OUTPUT_CSV_PATH}`);
  console.log(`Cleaning report: ${OUTPUT_REPORT_PATH}`);
};

const logProgress = (message: string): void => {
  console.log(`[clean-data] ${message}`);
};

const main = async (): Promise<void> => {
  ensureDir(path.dirname(OUTPUT_CSV_PATH));
  fs.writeFileSync(OUTPUT_CSV_PATH, "", "utf8");

  const headers = await loadCsvHeaders(INPUT_PATH);
  const ontology = loadJson<OntologyStructure>(ONTOLOGY_PATH);
  const mapping = loadJson<MappingStrategy>(MAPPING_PATH);
  const supplementaryLookups = loadSupplementaryLookups();
  const context = createContext(headers, ontology, mapping, supplementaryLookups);
  const shouldChunk = fs.statSync(INPUT_PATH).size > CHUNK_THRESHOLD;
  const partitionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "scientific-dblp-clean-"));

  try {
    logProgress(`partitioning input into ${PARTITION_COUNT} buckets`);
    const originalRows = await partitionInputRows(headers, partitionsDir);
    logProgress(`partitioning complete: ${originalRows} rows`);
    logProgress("processing partitions");
    const state = await processPartitions(headers, partitionsDir, context);
    const finalState = { ...state, originalRows };
    const report = buildReport(finalState);
    saveReport(report);
    printSummary(report, shouldChunk);
  } finally {
    fs.rmSync(partitionsDir, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
