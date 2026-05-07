import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse";

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
  | "geo:wktLiteral"
  | "unknown";

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
  requiredProperties?: string[];
  compliant: boolean;
}

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  targetEntity: string;
  datatype?: string;
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

interface SupplementaryIndexEntry {
  path?: string;
  name?: string;
  format?: string;
  description?: string;
  columns?: string[];
}

interface SupplementaryLookup {
  fileName: string;
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

interface RowIssue {
  type: string;
  severity: Severity;
}

interface CoercionCounter {
  successCount: number;
  failCount: number;
}

interface DataConstraint {
  columnName: string;
  propertyUri: string;
  targetEntity: string;
  datatype: SupportedDatatype;
  propertyDomain: string[];
}

interface RelationshipConstraint {
  columnName: string;
  propertyUri: string;
  sourceEntity: string;
  targetEntity: string;
  propertyDomain: string[];
  propertyRange: string[];
}

interface Context {
  headers: string[];
  classHierarchy: Map<string, Set<string>>;
  entityClassesByColumn: Map<string, string>;
  dataConstraintsByColumn: Map<string, DataConstraint[]>;
  relationshipConstraintsByColumn: Map<string, RelationshipConstraint[]>;
  requiredColumnsByEntity: Map<string, string[]>;
  validLabelResolutionColumns: Set<string>;
  supplementaryLookupsByColumn: Map<string, SupplementaryLookup>;
  identifierColumns: Set<string>;
}

interface ProcessedRow {
  row: CleanRow | null;
  issues: RowIssue[];
  coercions: Map<string, CoercionCounter>;
}

interface AggregateState {
  originalRows: number;
  cleanedRows: number;
  issueCounts: Map<string, { count: number; severity: Severity }>;
  coercionCounts: Map<string, CoercionCounter>;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/geospatial";
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const INPUT_PATH = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const ONTOLOGY_PATH = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const MAPPING_PATH = path.resolve(OUTPUT_DIR, "mapping-strategy.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");
const OUTPUT_CSV_PATH = path.resolve(OUTPUT_DIR, "dataset-cleaned.csv");
const OUTPUT_REPORT_PATH = path.resolve(OUTPUT_DIR, "cleaning-report.json");

const CHUNK_THRESHOLD = 10_000;
const CHUNK_SIZE = 5_000;
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
  ".",
  "?",
  "\\n",
  "\\N",
  "tbd",
]);
const BOOLEAN_TRUE = new Set(["true", "1", "yes", "y"]);
const BOOLEAN_FALSE = new Set(["false", "0", "no", "n"]);
const CRITICAL_ISSUE_TYPES = new Set([
  "missing_identifier",
  "missing_required_property",
  "invalid_integer",
  "invalid_decimal",
  "invalid_boolean",
  "invalid_date",
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
  normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const normalizeDatatype = (datatype: string | undefined): SupportedDatatype => {
  const normalized = (datatype ?? "unknown")
    .replace("http://www.w3.org/2001/XMLSchema#", "xsd:")
    .replace("https://www.w3.org/2001/XMLSchema#", "xsd:")
    .replace("http://www.opengis.net/ont/geosparql#", "geo:");

  if (normalized === "xsd:integer") return normalized;
  if (normalized === "xsd:decimal" || normalized === "xsd:double" || normalized === "xsd:float") return "xsd:decimal";
  if (normalized === "xsd:boolean") return normalized;
  if (normalized === "xsd:date") return normalized;
  if (normalized === "xsd:string") return normalized;
  if (normalized === "geo:wktLiteral") return normalized;
  return "unknown";
};

const splitCompositeColumn = (columnName: string): string[] =>
  columnName.split("+").map((part) => part.trim()).filter((part) => part.length > 0);

const appendIssue = (issues: RowIssue[], type: string, severity: Severity): RowIssue[] => [
  ...issues,
  { type, severity },
];

const mergeCounter = (
  counters: Map<string, CoercionCounter>,
  column: string,
  success: boolean,
): Map<string, CoercionCounter> => {
  const current = counters.get(column) ?? { successCount: 0, failCount: 0 };
  const next = success
    ? { successCount: current.successCount + 1, failCount: current.failCount }
    : { successCount: current.successCount, failCount: current.failCount + 1 };
  const merged = new Map(counters);
  merged.set(column, next);
  return merged;
};

const mergeIssueCounts = (
  counts: Map<string, { count: number; severity: Severity }>,
  issues: RowIssue[],
): Map<string, { count: number; severity: Severity }> =>
  issues.reduce((acc, issue) => {
    const current = acc.get(issue.type) ?? { count: 0, severity: issue.severity };
    const next = new Map(acc);
    next.set(issue.type, { count: current.count + 1, severity: current.severity });
    return next;
  }, counts);

const mergeCoercionCounts = (
  counts: Map<string, CoercionCounter>,
  additions: Map<string, CoercionCounter>,
): Map<string, CoercionCounter> => {
  const next = new Map(counts);
  for (const [column, addition] of Array.from(additions.entries())) {
    const current = next.get(column) ?? { successCount: 0, failCount: 0 };
    next.set(column, {
      successCount: current.successCount + addition.successCount,
      failCount: current.failCount + addition.failCount,
    });
  }
  return next;
};

const escapeCsvField = (value: CleanValue): string => {
  if (value === null) return "";
  const text = typeof value === "string" ? value : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
};

const serializeCsvRow = (row: CleanRow, headers: string[]): string =>
  headers.map((header) => escapeCsvField(row[header] ?? null)).join(",");

const hashRow = (row: RawRow, headers: string[]): string => {
  const hash = crypto.createHash("sha1");
  for (const header of headers) {
    hash.update(row[header] ?? "");
    hash.update("\u0000");
  }
  return hash.digest("hex");
};

const trimStrings = (row: RawRow): RawRow =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]),
  );

const normalizeNullValue = (value: RawValue): RawValue =>
  typeof value === "string" && NULL_TOKENS.has(value.trim().toLowerCase()) ? null : value;

const normalizeNulls = (row: RawRow): RawRow =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeNullValue(value)]));

const hasNonNullValue = (row: CleanRow, columns: string[]): boolean =>
  columns.some((column) => row[column] !== null && row[column] !== undefined && row[column] !== "");

const getLocalName = (uri: string): string => {
  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0) return uri.slice(hashIndex + 1);
  const slashIndex = uri.lastIndexOf("/");
  return slashIndex >= 0 ? uri.slice(slashIndex + 1) : uri;
};

const parseInteger = (value: string): number | null => {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const parseDecimal = (value: string): number | null => {
  if (value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseBoolean = (value: string): boolean | null => {
  const normalized = value.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return null;
};

const parseDate = (value: string): string | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const resolvePrefixedUri = (term: string, namespaces: Record<string, string>): string => {
  if (!term.includes(":") || term.startsWith("http://") || term.startsWith("https://")) {
    return term;
  }

  const [prefix, suffix] = term.split(/:(.+)/);
  const namespace = namespaces[prefix];
  return namespace ? `${namespace}${suffix}` : term;
};

const buildClassHierarchy = (ontology: OntologyStructure): Map<string, Set<string>> => {
  const hierarchy = new Map<string, Set<string>>();
  const byUri = new Map(ontology.classes.map((item) => [item.uri, item] as const));

  const expand = (uri: string, seen: Set<string>): Set<string> => {
    if (seen.has(uri)) return new Set();
    const nextSeen = new Set(seen);
    nextSeen.add(uri);
    const ontologyClass = byUri.get(uri);
    const supers = ontologyClass?.superClasses ?? [];
    return supers.reduce((acc, superClass) => {
      const expanded = expand(resolvePrefixedUri(superClass, ontology.metadata.namespaces), nextSeen);
      return new Set([
        ...Array.from(acc),
        resolvePrefixedUri(superClass, ontology.metadata.namespaces),
        ...Array.from(expanded),
      ]);
    }, new Set<string>([uri]));
  };

  for (const ontologyClass of ontology.classes) {
    hierarchy.set(ontologyClass.uri, expand(ontologyClass.uri, new Set()));
  }

  return hierarchy;
};

const classSatisfies = (
  candidate: string,
  allowed: string[],
  hierarchy: Map<string, Set<string>>,
): boolean => {
  if (allowed.length === 0) return true;
  const closure = hierarchy.get(candidate) ?? new Set([candidate]);
  return allowed.some((term) => closure.has(term));
};

const parseDelimitedLookup = (filePath: string): string[][] =>
  readUtf8(filePath)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("\t"));

const buildLookupFromEntry = (entry: SupplementaryIndexEntry): SupplementaryLookup | null => {
  const rawPath = String(entry.path ?? "").trim();
  const resolvedPath = rawPath
    ? path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(DATA_DIR, rawPath)
    : "";

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return null;
  }

  const fileName = entry.name ?? path.basename(resolvedPath);
  const rows = parseDelimitedLookup(resolvedPath);
  const validCodes = new Set<string>();
  const labelByCode = new Map<string, string>();

  rows.forEach((parts) => {
    const code = parts[0]?.trim();
    const label = parts[1]?.trim();
    if (!code) return;
    validCodes.add(code);
    if (label) {
      labelByCode.set(code, label);
    }
  });

  if (fileName === "featureCodes_en.txt") {
    Array.from(validCodes).forEach((code) => {
      const prefix = code.split(".")[0];
      if (prefix) {
        validCodes.add(prefix);
      }
    });
  }

  return { fileName, validCodes, labelByCode };
};

const loadSupplementaryLookups = (): Map<string, SupplementaryLookup> => {
  const index = loadOptionalJson<SupplementaryIndexEntry[]>(SUPPLEMENTARY_INDEX_PATH);
  if (!index || !fs.existsSync(SUPPLEMENTARY_DIR)) {
    return new Map();
  }

  const lookups = index
    .map(buildLookupFromEntry)
    .filter((lookup): lookup is SupplementaryLookup => lookup !== null);

  const lookupByColumn = new Map<string, SupplementaryLookup>();
  for (const lookup of lookups) {
    if (lookup.fileName === "countryInfo.txt") {
      lookupByColumn.set("country_code", lookup);
      lookupByColumn.set("cc2", lookup);
    } else if (lookup.fileName === "featureCodes_en.txt") {
      lookupByColumn.set("feature_code", lookup);
      lookupByColumn.set("feature_class", lookup);
    } else if (lookup.fileName === "admin1CodesASCII.txt") {
      lookupByColumn.set("admin1_code", lookup);
    }
  }

  return lookupByColumn;
};

const isLabelLikeProperty = (propertyUri: string): boolean => /(?:label|name|title)$/i.test(getLocalName(propertyUri));

const buildContext = (
  ontology: OntologyStructure,
  mapping: MappingStrategy,
  headers: string[],
  supplementaryLookupsByColumn: Map<string, SupplementaryLookup>,
): Context => {
  const namespaces = ontology.metadata.namespaces;
  const dataPropertyByUri = new Map(ontology.dataProperties.map((item) => [item.uri, item] as const));
  const objectPropertyByUri = new Map(ontology.objectProperties.map((item) => [item.uri, item] as const));
  const classHierarchy = buildClassHierarchy(ontology);
  const entityClassesByColumn = new Map<string, string>();
  const identifierColumns = new Set<string>();

  mapping.entityMappings
    .filter((item) => item.compliant)
    .forEach((item) => {
      entityClassesByColumn.set(item.columnName, item.ontologyClass);
      identifierColumns.add(item.identifierColumn);
    });

  const dataConstraintsByColumn = mapping.attributeMappings
    .filter((item) => item.compliant)
    .reduce((acc, item) => {
      const property = dataPropertyByUri.get(item.ontologyProperty);
      const datatype = normalizeDatatype(item.datatype ?? property?.range);
      const columns = splitCompositeColumn(item.columnName);
      return columns.reduce((innerAcc, columnName) => {
        const next = new Map(innerAcc);
        const existing = next.get(columnName) ?? [];
        const constraint: DataConstraint = {
          columnName,
          propertyUri: item.ontologyProperty,
          targetEntity: item.targetEntity,
          datatype:
            columnName === "latitude" || columnName === "longitude"
              ? "xsd:decimal"
              : datatype,
          propertyDomain: (property?.domain ?? []).map((term) => resolvePrefixedUri(term, namespaces)),
        };
        next.set(columnName, [...existing, constraint]);
        return next;
      }, acc);
    }, new Map<string, DataConstraint[]>());

  const relationshipConstraintsByColumn = mapping.relationshipMappings
    .filter((item) => item.compliant)
    .reduce((acc, item) => {
      const property = objectPropertyByUri.get(item.ontologyRelationship);
      const columns = splitCompositeColumn(item.columnName);
      return columns.reduce((innerAcc, columnName) => {
        const next = new Map(innerAcc);
        const existing = next.get(columnName) ?? [];
        const constraint: RelationshipConstraint = {
          columnName,
          propertyUri: item.ontologyRelationship,
          sourceEntity: item.sourceEntity,
          targetEntity: item.targetEntity,
          propertyDomain: (property?.domain ?? []).map((term) => resolvePrefixedUri(term, namespaces)),
          propertyRange: (property?.range ?? []).map((term) => resolvePrefixedUri(term, namespaces)),
        };
        next.set(columnName, [...existing, constraint]);
        return next;
      }, acc);
    }, new Map<string, RelationshipConstraint[]>());

  const allMappings = [...mapping.attributeMappings, ...mapping.relationshipMappings];
  const requiredColumnsByEntity = mapping.entityMappings
    .filter((item) => item.compliant)
    .reduce((acc, entityMapping) => {
      const requiredColumns = (entityMapping.requiredProperties ?? []).flatMap((propertyUri) =>
        allMappings
          .filter((mappingItem) =>
            "ontologyProperty" in mappingItem
              ? mappingItem.ontologyProperty === propertyUri
              : mappingItem.ontologyRelationship === propertyUri,
          )
          .flatMap((mappingItem) => splitCompositeColumn(mappingItem.columnName)),
      );
      return new Map(acc).set(entityMapping.ontologyClass, requiredColumns);
    }, new Map<string, string[]>());

  const validLabelResolutionColumns = new Set(
    mapping.attributeMappings
      .filter((item) => item.compliant && isLabelLikeProperty(item.ontologyProperty))
      .flatMap((item) => splitCompositeColumn(item.columnName))
      .filter((columnName) => supplementaryLookupsByColumn.has(normalizeColumnName(columnName))),
  );

  return {
    headers,
    classHierarchy,
    entityClassesByColumn,
    dataConstraintsByColumn,
    relationshipConstraintsByColumn,
    requiredColumnsByEntity,
    validLabelResolutionColumns,
    supplementaryLookupsByColumn,
    identifierColumns,
  };
};

const coerceValue = (
  value: RawValue,
  column: string,
  constraints: DataConstraint[],
): { value: CleanValue; issues: RowIssue[]; coercions: Map<string, CoercionCounter> } => {
  if (value === null) {
    return { value: null, issues: [], coercions: new Map() };
  }

  const datatypes = Array.from(
    new Set(
      constraints
        .map((constraint) => constraint.datatype)
        .filter((datatype) => ["xsd:integer", "xsd:decimal", "xsd:boolean", "xsd:date"].includes(datatype)),
    ),
  );

  if (datatypes.length === 0) {
    return { value, issues: [], coercions: new Map() };
  }

  const datatype = datatypes[0];
  if (datatype === "xsd:integer") {
    const parsed = parseInteger(value);
    return parsed === null
      ? {
          value: null,
          issues: appendIssue([], "invalid_integer", "critical"),
          coercions: mergeCounter(new Map(), column, false),
        }
      : { value: parsed, issues: [], coercions: mergeCounter(new Map(), column, true) };
  }

  if (datatype === "xsd:decimal") {
    const parsed = parseDecimal(value);
    return parsed === null
      ? {
          value: null,
          issues: appendIssue([], "invalid_decimal", "critical"),
          coercions: mergeCounter(new Map(), column, false),
        }
      : { value: parsed, issues: [], coercions: mergeCounter(new Map(), column, true) };
  }

  if (datatype === "xsd:boolean") {
    const parsed = parseBoolean(value);
    return parsed === null
      ? {
          value: null,
          issues: appendIssue([], "invalid_boolean", "critical"),
          coercions: mergeCounter(new Map(), column, false),
        }
      : { value: parsed, issues: [], coercions: mergeCounter(new Map(), column, true) };
  }

  if (datatype === "xsd:date") {
    const parsed = parseDate(value);
    return parsed === null
      ? {
          value: null,
          issues: appendIssue([], "invalid_date", "critical"),
          coercions: mergeCounter(new Map(), column, false),
        }
      : { value: parsed, issues: [], coercions: mergeCounter(new Map(), column, true) };
  }

  return { value, issues: [], coercions: new Map() };
};

const resolveLabelValue = (
  column: string,
  value: CleanValue,
  context: Context,
): CleanValue => {
  if (typeof value !== "string") return value;
  if (!context.validLabelResolutionColumns.has(column)) return value;
  const lookup = context.supplementaryLookupsByColumn.get(normalizeColumnName(column));
  return lookup?.labelByCode.get(value) ?? value;
};

const validateLookupValue = (row: CleanRow, column: string, value: CleanValue, context: Context): RowIssue[] => {
  if (typeof value !== "string" || value.length === 0) return [];
  const lookup = context.supplementaryLookupsByColumn.get(normalizeColumnName(column));
  if (!lookup) return [];

  if (column === "feature_code") {
    const featureClass = typeof row.feature_class === "string" ? row.feature_class : "";
    return lookup.validCodes.has(value) || (featureClass && lookup.validCodes.has(`${featureClass}.${value}`))
      ? []
      : appendIssue([], "invalid_feature_code_code", "warning");
  }

  if (column === "admin1_code") {
    const countryCode = typeof row.country_code === "string" ? row.country_code : "";
    return lookup.validCodes.has(value) || (countryCode && lookup.validCodes.has(`${countryCode}.${value}`))
      ? []
      : appendIssue([], "invalid_admin1_code_code", "warning");
  }

  if (column === "cc2") {
    const codes = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    return codes.every((code) => lookup.validCodes.has(code))
      ? []
      : appendIssue([], "invalid_cc2_code", "warning");
  }

  return lookup.validCodes.has(value)
    ? []
    : appendIssue([], `invalid_${normalizeColumnName(column)}_code`, "warning");
};

const validateRequiredColumns = (row: CleanRow, context: Context): RowIssue[] =>
  Array.from(context.requiredColumnsByEntity.entries()).flatMap(([entityUri, columns]) => {
    if (!hasNonNullValue(row, columns)) {
      return appendIssue([], "missing_required_property", "critical");
    }
    const entitySpecificColumns = Array.from(context.entityClassesByColumn.entries())
      .filter(([, classUri]) => classUri === entityUri)
      .flatMap(([columnName]) => splitCompositeColumn(columnName));
    if (!hasNonNullValue(row, entitySpecificColumns)) {
      return [];
    }
    const missingColumns = columns.filter((column) => row[column] === null || row[column] === undefined || row[column] === "");
    return missingColumns.length > 0 ? appendIssue([], "missing_required_property", "critical") : [];
  });

const validateDomainRange = (row: CleanRow, context: Context): RowIssue[] => {
  const dataIssues = Array.from(context.dataConstraintsByColumn.entries()).flatMap(([column, constraints]) => {
    if (row[column] === null || row[column] === undefined || row[column] === "") return [];
    return constraints.flatMap((constraint) =>
      classSatisfies(constraint.targetEntity, constraint.propertyDomain, context.classHierarchy)
        ? []
        : appendIssue([], "invalid_domain_constraint", "critical"),
    );
  });

  const relationshipIssues = Array.from(context.relationshipConstraintsByColumn.entries()).flatMap(([column, constraints]) => {
    if (row[column] === null || row[column] === undefined || row[column] === "") return [];
    return constraints.flatMap((constraint) => {
      const domainOk = classSatisfies(constraint.sourceEntity, constraint.propertyDomain, context.classHierarchy);
      const rangeOk = classSatisfies(constraint.targetEntity, constraint.propertyRange, context.classHierarchy);
      const issues: RowIssue[] = [];
      return [
        ...(domainOk ? [] : appendIssue(issues, "invalid_domain_constraint", "critical")),
        ...(rangeOk ? [] : appendIssue([], "invalid_range_constraint", "critical")),
      ];
    });
  });

  return [...dataIssues, ...relationshipIssues];
};

const processRow = (rawRow: RawRow, context: Context): ProcessedRow => {
  const trimmedRow = trimStrings(rawRow);
  const normalizedRow = normalizeNulls(trimmedRow);

  const identifierIssues = Array.from(context.identifierColumns).flatMap((column) =>
    normalizedRow[column] === null || normalizedRow[column] === undefined || normalizedRow[column] === ""
      ? appendIssue([], "missing_identifier", "critical")
      : [],
  );

  const coerced = context.headers.reduce(
    (acc, column) => {
      const constraints = context.dataConstraintsByColumn.get(column) ?? [];
      const result = coerceValue(normalizedRow[column] ?? null, column, constraints);
      const resolvedValue = resolveLabelValue(column, result.value, context);
      const provisionalRow = { ...acc.row, [column]: resolvedValue };
      const lookupIssues = validateLookupValue(provisionalRow, column, resolvedValue, context);
      return {
        row: provisionalRow,
        issues: [...acc.issues, ...result.issues, ...lookupIssues],
        coercions: mergeCoercionCounts(acc.coercions, result.coercions),
      };
    },
    { row: {} as CleanRow, issues: identifierIssues, coercions: new Map<string, CoercionCounter>() },
  );

  const requiredIssues = validateRequiredColumns(coerced.row, context);
  const domainRangeIssues = validateDomainRange(coerced.row, context);
  const allIssues = [...coerced.issues, ...requiredIssues, ...domainRangeIssues];
  const hasCritical = allIssues.some((issue) => CRITICAL_ISSUE_TYPES.has(issue.type) || issue.severity === "critical");

  return {
    row: hasCritical ? null : coerced.row,
    issues: allIssues,
    coercions: coerced.coercions,
  };
};

const writeHeaders = (stream: fs.WriteStream, headers: string[]): void => {
  stream.write(`${headers.map((header) => escapeCsvField(header)).join(",")}\n`);
};

const finalizeReport = (state: AggregateState): CleaningReport => ({
  originalRows: state.originalRows,
  cleanedRows: state.cleanedRows,
  rowsRemoved: state.originalRows - state.cleanedRows,
  issues: Array.from(state.issueCounts.entries())
    .map(([type, value]) => ({ type, count: value.count, severity: value.severity }))
    .sort((left, right) => right.count - left.count),
  typeCoercions: Array.from(state.coercionCounts.entries())
    .map(([column, counts]) => ({
      column,
      successCount: counts.successCount,
      failCount: counts.failCount,
    }))
    .sort((left, right) => left.column.localeCompare(right.column)),
});

const createParser = () =>
  parse({
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: false,
  });

const processChunk = (
  rows: RawRow[],
  context: Context,
): { cleanedRows: CleanRow[]; issues: RowIssue[]; coercions: Map<string, CoercionCounter> } =>
  rows.reduce(
    (acc, row) => {
      const processed = processRow(row, context);
      return {
        cleanedRows: processed.row ? [...acc.cleanedRows, processed.row] : acc.cleanedRows,
        issues: [...acc.issues, ...processed.issues],
        coercions: mergeCoercionCounts(acc.coercions, processed.coercions),
      };
    },
    { cleanedRows: [] as CleanRow[], issues: [] as RowIssue[], coercions: new Map<string, CoercionCounter>() },
  );

const copyFallbackMappingIfNeeded = (): void => {
  if (fs.existsSync(MAPPING_PATH)) {
    return;
  }

  const claudePath = path.resolve(DATA_DIR, "output", "claude", "mapping-strategy.json");
  if (!fs.existsSync(claudePath)) {
    return;
  }

  ensureDir(path.dirname(MAPPING_PATH));
  fs.copyFileSync(claudePath, MAPPING_PATH);
  console.warn(`Copied fallback mapping-strategy.json from ${claudePath}`);
};

const run = async (): Promise<void> => {
  copyFallbackMappingIfNeeded();

  const ontology = loadJson<OntologyStructure>(ONTOLOGY_PATH);
  const mapping = loadJson<MappingStrategy>(MAPPING_PATH);
  const supplementaryLookupsByColumn = loadSupplementaryLookups();

  ensureDir(path.dirname(OUTPUT_CSV_PATH));
  const outputStream = fs.createWriteStream(OUTPUT_CSV_PATH, { encoding: "utf8" });
  const parser = createParser();
  const inputStream = fs.createReadStream(INPUT_PATH, { encoding: "utf8" });
  inputStream.pipe(parser);

  let headers: string[] = [];
  let context: Context | null = null;
  let chunk: RawRow[] = [];
  const rawRowsSeen = new Set<string>();
  let state: AggregateState = {
    originalRows: 0,
    cleanedRows: 0,
    issueCounts: new Map(),
    coercionCounts: new Map(),
  };

  for await (const record of parser) {
    const rawRow = Object.fromEntries(
      Object.entries(record as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")]),
    ) as RawRow;

    if (headers.length === 0) {
      headers = Object.keys(rawRow);
      context = buildContext(ontology, mapping, headers, supplementaryLookupsByColumn);
      writeHeaders(outputStream, headers);
    }

    const hash = hashRow(rawRow, headers);
    if (rawRowsSeen.has(hash)) {
      state = {
        ...state,
        originalRows: state.originalRows + 1,
        issueCounts: mergeIssueCounts(state.issueCounts, appendIssue([], "duplicate_row_removed", "info")),
      };
      continue;
    }

    rawRowsSeen.add(hash);
    chunk.push(rawRow);
    state = { ...state, originalRows: state.originalRows + 1 };

    if (chunk.length >= CHUNK_SIZE && context) {
      const result = processChunk(chunk, context);
      result.cleanedRows.forEach((row) => outputStream.write(`${serializeCsvRow(row, headers)}\n`));
      state = {
        ...state,
        cleanedRows: state.cleanedRows + result.cleanedRows.length,
        issueCounts: mergeIssueCounts(state.issueCounts, result.issues),
        coercionCounts: mergeCoercionCounts(state.coercionCounts, result.coercions),
      };
      chunk = [];
    }
  }

  if (chunk.length > 0 && context) {
    const result = processChunk(chunk, context);
    result.cleanedRows.forEach((row) => outputStream.write(`${serializeCsvRow(row, headers)}\n`));
    state = {
      ...state,
      cleanedRows: state.cleanedRows + result.cleanedRows.length,
      issueCounts: mergeIssueCounts(state.issueCounts, result.issues),
      coercionCounts: mergeCoercionCounts(state.coercionCounts, result.coercions),
    };
  }

  await new Promise<void>((resolve, reject) => {
    outputStream.end(() => resolve());
    outputStream.on("error", reject);
  });

  const report = finalizeReport(state);
  fs.writeFileSync(OUTPUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Cleaned ${report.cleanedRows} of ${report.originalRows} rows.`);
  console.log(`Removed ${report.rowsRemoved} rows.`);
  console.log(`Chunk mode: ${report.originalRows > CHUNK_THRESHOLD ? `enabled (${CHUNK_SIZE})` : "disabled"}`);
  console.log(`Report: ${OUTPUT_REPORT_PATH}`);
  console.log(`Cleaned CSV: ${OUTPUT_CSV_PATH}`);
};

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
