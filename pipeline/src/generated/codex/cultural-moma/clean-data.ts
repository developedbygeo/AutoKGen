import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";

type RawValue = string | null;
type CleanValue = string | number | boolean | null;
type RawRow = Record<string, RawValue>;
type CleanRow = Record<string, CleanValue>;
type Severity = "info" | "warning" | "critical";
type Datatype = "xsd:integer" | "xsd:decimal" | "xsd:boolean" | "xsd:date";

interface OntologyClass {
  uri: string;
  label: string;
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
  datatype: string;
  targetEntity: string;
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
  name: string;
  path: string;
  format: string;
  description?: string;
  columns?: string[];
}

interface SupplementaryLookup {
  fileName: string;
  normalizedColumns: string[];
  codeValues: Set<string>;
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

interface ProcessingContext {
  headers: string[];
  typedColumns: Map<string, Datatype>;
  classByUri: Map<string, OntologyClass>;
  objectPropertyByUri: Map<string, ObjectProperty>;
  entityMappings: EntityMapping[];
  relationshipMappings: RelationshipMapping[];
  supplementaryLookups: SupplementaryLookup[];
  primaryIdentifierColumns: Set<string>;
  relationshipTargetIdentifierColumns: Set<string>;
}

interface ProcessedRowResult {
  row: CleanRow | null;
  issues: Array<{ type: string; severity: Severity }>;
  coercions: Map<string, { successCount: number; failCount: number }>;
}

interface ChunkResult {
  rows: CleanRow[];
  issues: Array<{ type: string; severity: Severity }>;
  coercions: Map<string, { successCount: number; failCount: number }>;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
const INPUT_PATH = path.resolve(DATA_DIR, "input", "dataset-merged.csv");
const ONTOLOGY_PATH = path.resolve(DATA_DIR, "output", "codex", "ontology-structure.json");
const MAPPING_PATH = path.resolve(DATA_DIR, "output", "codex", "mapping-strategy.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(DATA_DIR, "output", "codex", "supplementary-files-index.json");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");
const OUTPUT_CSV_PATH = path.resolve(DATA_DIR, "output", "codex", "dataset-cleaned.csv");
const OUTPUT_REPORT_PATH = path.resolve(DATA_DIR, "output", "codex", "cleaning-report.json");

const CHUNK_THRESHOLD = 10_000;
const CHUNK_SIZE = 5_000;
const COERCION_FAILED = Symbol("coercion-failed");
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
  "tbd",
]);
const BOOLEAN_TRUE = new Set(["true", "1", "yes", "y"]);
const BOOLEAN_FALSE = new Set(["false", "0", "no", "n"]);
const LABELISH_PROPERTY_PATTERN = /(label|name|title)$/i;
const CODEISH_COLUMN_PATTERN = /(^|[\s_])(code|id|qid|ulan|key|identifier|classification|department|gender|nationality|cataloged|onview)([\s_]|$)/i;

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

const normalizeKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const normalizeLookupValue = (value: string): string => value.trim().toLowerCase();

const getLocalName = (uri: string): string => {
  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0) return uri.slice(hashIndex + 1);
  const slashIndex = uri.lastIndexOf("/");
  return slashIndex >= 0 ? uri.slice(slashIndex + 1) : uri;
};

const cleanRawCell = (value: unknown): RawValue => String(value ?? "");

const parseCsv = (csvText: string, delimiter = ","): RawRow[] => {
  const result = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    delimiter,
  });

  if (result.errors.length > 0) {
    throw new Error(`Failed to parse CSV: ${result.errors[0].message}`);
  }

  return result.data.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key), cleanRawCell(value)])),
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
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key), cleanRawCell(value)])))
    : [];
};

const parseJsonlRows = (text: string): RawRow[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key), cleanRawCell(value)])));

const normalizeSupplementaryDescriptor = (
  baseDir: string,
  indexDir: string,
  entry: Record<string, unknown>,
): SupplementaryFileDescriptor | null => {
  const rawPath = String(entry.path ?? entry.filePath ?? entry.location ?? "").trim();
  const fileName = String(entry.name ?? path.basename(rawPath || "")).trim();
  const resolvedPath = rawPath
    ? path.isAbsolute(rawPath)
      ? rawPath
      : fs.existsSync(path.resolve(indexDir, rawPath))
        ? path.resolve(indexDir, rawPath)
        : path.resolve(baseDir, rawPath)
    : "";
  const format = String(entry.format ?? path.extname(resolvedPath).replace(/^\./, "")).trim().toLowerCase();

  if (!resolvedPath) {
    return null;
  }

  return {
    name: fileName || path.basename(resolvedPath),
    path: resolvedPath,
    format,
    description: typeof entry.description === "string" ? entry.description : undefined,
    columns: Array.isArray(entry.columns) ? entry.columns.map((value) => String(value)) : undefined,
  };
};

const discoverSupplementaryFiles = (): SupplementaryFileDescriptor[] => {
  const fromIndex = (() => {
    const raw = loadOptionalJson<unknown>(SUPPLEMENTARY_INDEX_PATH);
    if (raw === null) return [];
    const entries = Array.isArray(raw)
      ? raw
      : typeof raw === "object" && raw !== null
        ? (((raw as Record<string, unknown>).files ??
            (raw as Record<string, unknown>).supplementaryFiles ??
            []) as unknown[])
        : [];

    return entries
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => normalizeSupplementaryDescriptor(SUPPLEMENTARY_DIR, path.dirname(SUPPLEMENTARY_INDEX_PATH), entry))
      .filter((entry): entry is SupplementaryFileDescriptor => entry !== null);
  })();

  if (fromIndex.length > 0) {
    return fromIndex.filter((entry) => fs.existsSync(entry.path));
  }

  if (!fs.existsSync(SUPPLEMENTARY_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SUPPLEMENTARY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolutePath = path.resolve(SUPPLEMENTARY_DIR, entry.name);
      return {
        name: entry.name,
        path: absolutePath,
        format: path.extname(entry.name).replace(/^\./, "").toLowerCase(),
      } satisfies SupplementaryFileDescriptor;
    });
};

const loadSupplementaryRows = (file: SupplementaryFileDescriptor): RawRow[] => {
  const content = readUtf8(file.path);

  if (file.format === "csv") {
    return parseCsv(content, ",");
  }

  if (file.format === "tsv" || file.format === "tab") {
    return parseCsv(content, "\t");
  }

  if (file.format === "json") {
    return parseJsonRows(content);
  }

  if (file.format === "jsonl") {
    return parseJsonlRows(content);
  }

  return [];
};

const chooseCodeColumn = (headers: string[]): string | null =>
  headers.find((header) => CODEISH_COLUMN_PATTERN.test(header)) ?? headers[0] ?? null;

const chooseLabelColumn = (headers: string[], codeColumn: string | null): string | null =>
  headers.find((header) => header !== codeColumn && LABELISH_PROPERTY_PATTERN.test(header)) ?? null;

const buildSupplementaryLookup = (file: SupplementaryFileDescriptor, rows: RawRow[]): SupplementaryLookup | null => {
  if (rows.length === 0) {
    return null;
  }

  const headers = Object.keys(rows[0] ?? {});
  const codeColumn = chooseCodeColumn(headers);
  if (!codeColumn) {
    return null;
  }

  const labelColumn = chooseLabelColumn(headers, codeColumn);
  const codeValues = new Set(
    rows
      .map((row) => row[codeColumn])
      .filter((value): value is string => typeof value === "string")
      .map(normalizeLookupValue)
      .filter((value) => value.length > 0),
  );

  const labelByCode = new Map(
    rows
      .map((row) => [row[codeColumn], labelColumn ? row[labelColumn] : null] as const)
      .filter(
        (pair): pair is readonly [string, string] =>
          typeof pair[0] === "string" &&
          pair[0].trim().length > 0 &&
          typeof pair[1] === "string" &&
          pair[1].trim().length > 0,
      )
      .map(([code, label]) => [normalizeLookupValue(code), label.trim()] as const),
  );

  return codeValues.size === 0
    ? null
    : {
        fileName: file.name,
        normalizedColumns: headers.map(normalizeKey),
        codeValues,
        labelByCode,
      };
};

const buildSupplementaryLookups = (): SupplementaryLookup[] =>
  discoverSupplementaryFiles()
    .map((file) => buildSupplementaryLookup(file, loadSupplementaryRows(file)))
    .filter((lookup): lookup is SupplementaryLookup => lookup !== null);

const canonicalRowSignature = (headers: string[], row: RawRow): string =>
  JSON.stringify(headers.map((header) => row[header] ?? ""));

const deduplicateRows = (headers: string[], rows: RawRow[]): { rows: RawRow[]; duplicatesRemoved: number } => {
  const seen = new Set<string>();
  const uniqueRows: RawRow[] = [];
  let duplicatesRemoved = 0;

  rows.forEach((row) => {
    const signature = canonicalRowSignature(headers, row);
    if (seen.has(signature)) {
      duplicatesRemoved += 1;
      return;
    }

    seen.add(signature);
    uniqueRows.push(row);
  });

  return { rows: uniqueRows, duplicatesRemoved };
};

const trimRowStrings = (headers: string[], row: RawRow): RawRow =>
  Object.fromEntries(headers.map((header) => [header, (row[header] ?? "").trim()]));

const normalizeNullToken = (value: RawValue): string | null => {
  if (value === null) return null;
  const normalized = value.trim();
  return NULL_TOKENS.has(normalized.toLowerCase()) ? null : normalized;
};

const normalizeNulls = (headers: string[], row: RawRow): RawRow =>
  Object.fromEntries(headers.map((header) => [header, normalizeNullToken(row[header] ?? null)]));

const mapDatatype = (range: string, explicitDatatype?: string): Datatype | null => {
  const datatype = explicitDatatype?.trim().toLowerCase();
  if (datatype === "xsd:integer") return "xsd:integer";
  if (datatype === "xsd:decimal" || datatype === "xsd:float" || datatype === "xsd:double") return "xsd:decimal";
  if (datatype === "xsd:boolean") return "xsd:boolean";
  if (datatype === "xsd:date" || datatype === "xsd:datetime") return "xsd:date";

  const normalizedRange = range.trim().toLowerCase();
  if (normalizedRange.endsWith("#integer")) return "xsd:integer";
  if (normalizedRange.endsWith("#decimal") || normalizedRange.endsWith("#float") || normalizedRange.endsWith("#double")) {
    return "xsd:decimal";
  }
  if (normalizedRange.endsWith("#boolean")) return "xsd:boolean";
  if (normalizedRange.endsWith("#date") || normalizedRange.endsWith("#datetime")) return "xsd:date";
  return null;
};

const buildTypedColumns = (ontology: OntologyStructure, mapping: MappingStrategy): Map<string, Datatype> => {
  const dataPropertyByUri = new Map(ontology.dataProperties.map((property) => [property.uri, property]));
  return new Map(
    mapping.attributeMappings
      .filter((attribute) => attribute.compliant)
      .map((attribute) => {
        const property = dataPropertyByUri.get(attribute.ontologyProperty);
        const datatype = mapDatatype(property?.range ?? "", attribute.datatype);
        return datatype ? ([attribute.columnName, datatype] as const) : null;
      })
      .filter((entry): entry is readonly [string, Datatype] => entry !== null),
  );
};

const parseInteger = (value: string): number | null => (/^-?\d+$/.test(value) ? Number.parseInt(value, 10) : null);

const parseDecimal = (value: string): number | null =>
  /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number.parseFloat(value) : null;

const parseBoolean = (value: string): boolean | null => {
  const normalized = value.toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return null;
};

const parseDate = (value: string): string | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Number.isNaN(Date.parse(value)) ? null : value;
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) {
    const normalized = value.replace(/\//g, "-");
    return Number.isNaN(Date.parse(normalized)) ? null : normalized;
  }

  return null;
};

const coerceValue = (value: string | null, datatype: Datatype): CleanValue | typeof COERCION_FAILED => {
  if (value === null) return null;
  if (datatype === "xsd:integer") return parseInteger(value) ?? COERCION_FAILED;
  if (datatype === "xsd:decimal") return parseDecimal(value) ?? COERCION_FAILED;
  if (datatype === "xsd:boolean") return parseBoolean(value) ?? COERCION_FAILED;
  return parseDate(value) ?? COERCION_FAILED;
};

const findMatchingLookup = (columnName: string, lookups: SupplementaryLookup[]): SupplementaryLookup | null => {
  const normalized = normalizeKey(columnName);
  return lookups.find((lookup) => lookup.normalizedColumns.includes(normalized)) ?? null;
};

const resolveLabelFromLookup = (
  columnName: string,
  value: string | null,
  propertyUri: string,
  lookups: SupplementaryLookup[],
): string | null => {
  if (value === null || !LABELISH_PROPERTY_PATTERN.test(getLocalName(propertyUri))) {
    return value;
  }

  const lookup = findMatchingLookup(columnName, lookups);
  const resolved = lookup?.labelByCode.get(normalizeLookupValue(value)) ?? null;
  return resolved ?? value;
};

const isAbsoluteHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const emptyCoercionMap = (): Map<string, { successCount: number; failCount: number }> => new Map();

const mergeCoercionMaps = (
  left: Map<string, { successCount: number; failCount: number }>,
  right: Map<string, { successCount: number; failCount: number }>,
): Map<string, { successCount: number; failCount: number }> => {
  const merged = new Map(left);
  right.forEach((value, key) => {
    const previous = merged.get(key) ?? { successCount: 0, failCount: 0 };
    merged.set(key, {
      successCount: previous.successCount + value.successCount,
      failCount: previous.failCount + value.failCount,
    });
  });
  return merged;
};

const addCoercionStat = (
  coercions: Map<string, { successCount: number; failCount: number }>,
  column: string,
  success: boolean,
): Map<string, { successCount: number; failCount: number }> => {
  const current = coercions.get(column) ?? { successCount: 0, failCount: 0 };
  return new Map(coercions).set(column, {
    successCount: current.successCount + (success ? 1 : 0),
    failCount: current.failCount + (success ? 0 : 1),
  });
};

const addIssue = (
  issues: Array<{ type: string; severity: Severity }>,
  type: string,
  severity: Severity,
): Array<{ type: string; severity: Severity }> => [...issues, { type, severity }];

const validateSupplementaryCode = (
  columnName: string,
  value: string | null,
  lookups: SupplementaryLookup[],
): Array<{ type: string; severity: Severity }> => {
  if (value === null) return [];
  const lookup = findMatchingLookup(columnName, lookups);
  if (!lookup) return [];
  return lookup.codeValues.has(normalizeLookupValue(value))
    ? []
    : [{ type: `invalid_supplementary_code:${columnName}`, severity: "warning" }];
};

const buildRelationshipIssueType = (relationship: string, suffix: string): string =>
  `relationship_constraint:${getLocalName(relationship)}:${suffix}`;

const processRow = (rawRow: RawRow, context: ProcessingContext, mapping: MappingStrategy): ProcessedRowResult => {
  const trimmed = trimRowStrings(context.headers, rawRow);
  const normalized = normalizeNulls(context.headers, trimmed);

  const resolvedAttributeValues = new Map(
    mapping.attributeMappings.map((attribute) => [
      attribute.columnName,
      resolveLabelFromLookup(
        attribute.columnName,
        normalized[attribute.columnName] ?? null,
        attribute.ontologyProperty,
        context.supplementaryLookups,
      ),
    ]),
  );

  const startRow = Object.fromEntries(
    context.headers.map((header) => [header, resolvedAttributeValues.get(header) ?? normalized[header] ?? null]),
  ) as CleanRow;

  const typedResult = context.headers.reduce<{
    row: CleanRow;
    issues: Array<{ type: string; severity: Severity }>;
    coercions: Map<string, { successCount: number; failCount: number }>;
  }>(
    (accumulator, header) => {
      const datatype = context.typedColumns.get(header);
      if (!datatype) {
        return accumulator;
      }

      const rawValue = typeof accumulator.row[header] === "string" || accumulator.row[header] === null
        ? (accumulator.row[header] as string | null)
        : String(accumulator.row[header]);
      const coerced = coerceValue(rawValue, datatype);
      if (coerced === COERCION_FAILED) {
        return {
          row: { ...accumulator.row, [header]: null },
          issues: addIssue(accumulator.issues, `type_coercion_failed:${header}`, "warning"),
          coercions: addCoercionStat(accumulator.coercions, header, false),
        };
      }

      return {
        row: { ...accumulator.row, [header]: coerced },
        issues: accumulator.issues,
        coercions: addCoercionStat(accumulator.coercions, header, true),
      };
    },
    {
      row: startRow,
      issues: [] as Array<{ type: string; severity: Severity }>,
      coercions: emptyCoercionMap(),
    },
  );

  const supplementaryIssues = context.headers.flatMap((header) =>
    validateSupplementaryCode(header, normalized[header] ?? null, context.supplementaryLookups),
  );

  const identifierIssues = context.entityMappings.reduce((issues, entityMapping) => {
    const identifierValue = typedResult.row[entityMapping.identifierColumn];
    if (identifierValue !== null && identifierValue !== "") {
      return issues;
    }

    const issueType = `missing_identifier:${entityMapping.identifierColumn}`;
    const severity = context.primaryIdentifierColumns.has(entityMapping.identifierColumn) ? "critical" : "warning";
    return addIssue(issues, issueType, severity);
  }, [] as Array<{ type: string; severity: Severity }>);

  const relationshipIssues = context.relationshipMappings.reduce((issues, relationshipMapping) => {
    const property = context.objectPropertyByUri.get(relationshipMapping.ontologyRelationship);
    const sourceIdentifier = context.entityMappings.find(
      (entityMapping) => entityMapping.ontologyClass === relationshipMapping.sourceEntity,
    )?.identifierColumn;
    const sourceValue = sourceIdentifier ? typedResult.row[sourceIdentifier] : null;
    const targetValue = typedResult.row[relationshipMapping.columnName];

    if (sourceValue === null || sourceValue === "") {
      const severity = context.primaryIdentifierColumns.has(sourceIdentifier ?? "") ? "critical" : "warning";
      return addIssue(
        issues,
        buildRelationshipIssueType(relationshipMapping.ontologyRelationship, "missing_source_identifier"),
        severity,
      );
    }

    if (targetValue === null || targetValue === "") {
      return context.relationshipTargetIdentifierColumns.has(relationshipMapping.columnName)
        ? addIssue(
            issues,
            buildRelationshipIssueType(relationshipMapping.ontologyRelationship, "missing_target_identifier"),
            "warning",
          )
        : issues;
    }

    const targetClassAllowed =
      !property?.range || property.range.length === 0 || property.range.includes(relationshipMapping.targetEntity);
    if (!targetClassAllowed) {
      return addIssue(
        issues,
        buildRelationshipIssueType(relationshipMapping.ontologyRelationship, "range_mismatch"),
        "critical",
      );
    }

    if (relationshipMapping.targetEntity === "http://www.europeana.eu/schemas/edm/WebResource") {
      return typeof targetValue === "string" && isAbsoluteHttpUrl(targetValue)
        ? issues
        : addIssue(
            issues,
            buildRelationshipIssueType(relationshipMapping.ontologyRelationship, "invalid_webresource_url"),
            "warning",
          );
    }

    return issues;
  }, [] as Array<{ type: string; severity: Severity }>);

  const allIssues = [...typedResult.issues, ...supplementaryIssues, ...identifierIssues, ...relationshipIssues];
  const hasCriticalIssue = allIssues.some((issue) => issue.severity === "critical");

  return {
    row: hasCriticalIssue ? null : typedResult.row,
    issues: hasCriticalIssue ? addIssue(allIssues, "row_removed:critical_constraint", "critical") : allIssues,
    coercions: typedResult.coercions,
  };
};

const processChunk = (rows: RawRow[], context: ProcessingContext, mapping: MappingStrategy): ChunkResult => {
  const cleanedRows: CleanRow[] = [];
  const issues: Array<{ type: string; severity: Severity }> = [];
  let coercions = emptyCoercionMap();

  rows.forEach((row) => {
    const processed = processRow(row, context, mapping);
    if (processed.row !== null) {
      cleanedRows.push(processed.row);
    }
    issues.push(...processed.issues);
    coercions = mergeCoercionMaps(coercions, processed.coercions);
  });

  return {
    rows: cleanedRows,
    issues,
    coercions,
  };
};

const chunkRows = <T>(rows: T[], chunkSize: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
};

const summarizeIssues = (
  issues: Array<{ type: string; severity: Severity }>,
  duplicatesRemoved: number,
): IssueSummary[] => {
  const aggregated = issues.reduce((map, issue) => {
    const previous = map.get(issue.type) ?? { count: 0, severity: issue.severity };
    map.set(issue.type, { count: previous.count + 1, severity: previous.severity });
    return map;
  }, new Map<string, { count: number; severity: Severity }>());

  if (duplicatesRemoved > 0) {
    aggregated.set("duplicate_rows_removed", { count: duplicatesRemoved, severity: "info" });
  }

  return [...aggregated.entries()]
    .map(([type, value]) => ({ type, count: value.count, severity: value.severity }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
};

const summarizeCoercions = (
  coercions: Map<string, { successCount: number; failCount: number }>,
): TypeCoercionSummary[] =>
  [...coercions.entries()]
    .map(([column, value]) => ({
      column,
      successCount: value.successCount,
      failCount: value.failCount,
    }))
    .sort((left, right) => left.column.localeCompare(right.column));

const buildContext = (headers: string[], ontology: OntologyStructure, mapping: MappingStrategy): ProcessingContext => {
  const classByUri = new Map(ontology.classes.map((ontologyClass) => [ontologyClass.uri, ontologyClass]));
  const objectPropertyByUri = new Map(ontology.objectProperties.map((property) => [property.uri, property]));
  const typedColumns = buildTypedColumns(ontology, mapping);
  const entityMappings = mapping.entityMappings.filter(
    (entityMapping) =>
      entityMapping.compliant && headers.includes(entityMapping.identifierColumn) && classByUri.has(entityMapping.ontologyClass),
  );
  const relationshipMappings = mapping.relationshipMappings.filter(
    (relationshipMapping) =>
      relationshipMapping.compliant &&
      headers.includes(relationshipMapping.columnName) &&
      objectPropertyByUri.has(relationshipMapping.ontologyRelationship),
  );
  const supplementaryLookups = buildSupplementaryLookups();
  const primaryIdentifierColumns = new Set(
    entityMappings
      .filter((entityMapping) => entityMapping.ontologyClass === "http://www.europeana.eu/schemas/edm/ProvidedCHO")
      .map((entityMapping) => entityMapping.identifierColumn),
  );
  const relationshipTargetIdentifierColumns = new Set(
    relationshipMappings
      .filter((relationshipMapping) => {
        const property = objectPropertyByUri.get(relationshipMapping.ontologyRelationship);
        return Boolean(property?.range && property.range.length > 0);
      })
      .map((relationshipMapping) => relationshipMapping.columnName),
  );

  return {
    headers,
    typedColumns,
    classByUri,
    objectPropertyByUri,
    entityMappings,
    relationshipMappings,
    supplementaryLookups,
    primaryIdentifierColumns,
    relationshipTargetIdentifierColumns,
  };
};

const serializeForCsv = (row: CleanRow, headers: string[]): Record<string, string> =>
  Object.fromEntries(
    headers.map((header) => {
      const value = row[header];
      return [header, value === null ? "" : String(value)];
    }),
  );

const main = (): void => {
  const ontology = loadJson<OntologyStructure>(ONTOLOGY_PATH);
  const mapping = loadJson<MappingStrategy>(MAPPING_PATH);
  const rawCsv = readUtf8(INPUT_PATH);
  const parsedRows = parseCsv(rawCsv);
  const headers = Object.keys(parsedRows[0] ?? {});

  if (headers.length === 0) {
    throw new Error(`No headers found in ${INPUT_PATH}`);
  }

  const { rows: deduplicatedRows, duplicatesRemoved } = deduplicateRows(headers, parsedRows);
  const context = buildContext(headers, ontology, mapping);
  const rowChunks =
    deduplicatedRows.length > CHUNK_THRESHOLD ? chunkRows(deduplicatedRows, CHUNK_SIZE) : [deduplicatedRows];

  const cleanedRows: CleanRow[] = [];
  const allIssues: Array<{ type: string; severity: Severity }> = [];
  let allCoercions = emptyCoercionMap();

  rowChunks.forEach((chunk) => {
    const chunkResult = processChunk(chunk, context, mapping);
    cleanedRows.push(...chunkResult.rows);
    allIssues.push(...chunkResult.issues);
    allCoercions = mergeCoercionMaps(allCoercions, chunkResult.coercions);
  });

  const report: CleaningReport = {
    originalRows: parsedRows.length,
    cleanedRows: cleanedRows.length,
    rowsRemoved: parsedRows.length - cleanedRows.length,
    issues: summarizeIssues(allIssues, duplicatesRemoved),
    typeCoercions: summarizeCoercions(allCoercions),
  };

  ensureDir(path.dirname(OUTPUT_CSV_PATH));
  const csvOutput = Papa.unparse(cleanedRows.map((row) => serializeForCsv(row, headers)), {
    columns: headers,
  });
  fs.writeFileSync(OUTPUT_CSV_PATH, csvOutput, "utf8");
  fs.writeFileSync(OUTPUT_REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`Cleaning completed for ${path.relative(process.cwd(), INPUT_PATH)}`);
  console.log(`Original rows: ${report.originalRows}`);
  console.log(`Cleaned rows: ${report.cleanedRows}`);
  console.log(`Rows removed: ${report.rowsRemoved}`);
  console.log(`Issues logged: ${report.issues.length}`);
  console.log(`Type coercion columns: ${report.typeCoercions.length}`);
  console.log(`Output CSV: ${path.relative(process.cwd(), OUTPUT_CSV_PATH)}`);
  console.log(`Output report: ${path.relative(process.cwd(), OUTPUT_REPORT_PATH)}`);
};

main();
