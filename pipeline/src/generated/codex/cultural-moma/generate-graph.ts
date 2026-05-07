import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse";
import * as Papa from "papaparse";

type CsvRow = Record<string, string>;
type JsonObject = Record<string, unknown>;

interface OntologyClass {
  uri: string;
  label: string;
  definition?: string;
  comment?: string;
  superClasses?: string[];
}

interface ObjectProperty {
  uri: string;
  label: string;
  definition?: string;
  domain?: string[];
  range?: string[];
  superProperties?: string[];
  inverseOf?: string;
  cardinalityConstraints?: string[];
}

interface DataProperty {
  uri: string;
  label: string;
  definition?: string;
  domain?: string[];
  range?: string;
}

interface OntologyStructure {
  metadata: {
    title: string;
    version: string;
    description?: string;
    namespaces: Record<string, string>;
  };
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  confidence: number;
  reasoning: string;
  identifierColumn: string;
  requiredProperties: string[];
  compliant: boolean;
}

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  propertyType: string;
  targetEntity: string;
  datatype: string;
  confidence: number;
  reasoning: string;
  compliant: boolean;
}

interface RelationshipMapping {
  columnName: string;
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  confidence: number;
  reasoning: string;
  compliant: boolean;
}

interface UnmappedColumn {
  columnName: string;
  reason: string;
  suggestion: string;
  severity: "info" | "warning" | "error";
}

interface MappingStrategy {
  metadata: {
    ontologyCompliant: boolean;
    complianceScore: number;
    ontologyName: string;
    ontologyVersion: string;
    allowedNamespaces: string[];
    totalColumns: number;
    mappedColumns: number;
    unmappedColumns: number;
    warnings?: string[];
  };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
  unmappedColumns: UnmappedColumn[];
  validationReport?: {
    classesUsed?: string[];
    propertiesUsed?: string[];
    namespacesUsed?: string[];
    customTermsDetected?: string[];
    recommendations?: string[];
  };
}

interface SupplementaryIndexEntry {
  name: string;
  path?: string;
  format?: string;
  description?: string;
  columns?: string[];
}

interface SupplementaryReferenceRow {
  key: string;
  label: string;
  raw: Record<string, string>;
}

interface SupplementaryDataset {
  fileName: string;
  keyColumn: string;
  labelColumn: string;
  rowsByKey: Map<string, SupplementaryReferenceRow>;
}

interface SupplementaryEntityBinding {
  entity: EntityMappingRuntime;
  dataset: SupplementaryDataset;
}

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, string | number | boolean>;
  _meta: {
    sourceRow: number;
    confidence: number;
    compliant: boolean;
    enriched?: boolean;
  };
}

interface GraphRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, string | number | boolean>;
  _meta: {
    confidence: number;
    compliant: boolean;
    sourceRow?: number;
    enriched?: boolean;
  };
}

interface ValidationIssue {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  rowIndex?: number;
  entityId?: string;
  relationshipId?: string;
  example?: JsonObject;
}

interface OutputGraph {
  metadata: {
    generatedAt: string;
    ontologyName: string;
    ontologyVersion: string;
    complianceScore: number;
    validation: {
      compliant: boolean;
      errors: number;
      warnings: number;
    };
  };
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  statistics: {
    totalNodes: number;
    nodesByType: Record<string, number>;
    totalRelationships: number;
    relationshipsByType: Record<string, number>;
  };
}

interface GraphStats {
  summary: {
    totalNodes: number;
    totalRelationships: number;
    avgDegree: number;
    density: number;
  };
  nodeStatistics: {
    byType: Record<string, number>;
    withIssues: number;
    compliant: number;
  };
  relationshipStatistics: {
    byType: Record<string, number>;
    withIssues: number;
    compliant: number;
  };
  complianceMetrics: {
    overallScore: number;
    validNodesPercent: number;
    validRelationshipsPercent: number;
    unmappedDataPercent: number;
  };
  issues: Array<{
    type: string;
    severity: "error" | "warning" | "info";
    count: number;
    examples: string[];
  }>;
  validationMetrics: {
    validNodes: number;
    invalidNodes: number;
    validRelationships: number;
    invalidRelationships: number;
    violationsByType: Record<string, number>;
  };
  unmappedColumns: {
    count: number;
    configured: string[];
    encounteredValues: Record<string, { nonEmptyCount: number; examples: string[] }>;
  };
  supplementary: {
    indexFound: boolean;
    filesLoaded: string[];
    referenceNodesCreated: number;
    enrichmentRelationshipsCreated: number;
  };
  complianceResolution: {
    source: string;
    inferred: boolean;
  };
}

interface EntityMappingRuntime {
  mapping: EntityMapping;
  classInfo: OntologyClass;
}

interface AttributeMappingRuntime {
  mapping: AttributeMapping;
  propertyLocalName: string;
  propertyInfo: DataProperty | ObjectProperty | null;
}

interface RelationshipMappingRuntime {
  mapping: RelationshipMapping;
  propertyInfo: ObjectProperty;
}

interface OntologyIndex {
  classByUri: Map<string, OntologyClass>;
  objectPropertyByUri: Map<string, ObjectProperty>;
  dataPropertyByUri: Map<string, DataProperty>;
  namespaces: Record<string, string>;
  classAncestors: Map<string, Set<string>>;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");

const INPUT_CSV = path.resolve(OUTPUT_DIR, "dataset-cleaned.csv");
const MAPPING_PATH = path.resolve(OUTPUT_DIR, "mapping-strategy.json");
const ONTOLOGY_PATH = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const MAPPING_GUIDE_PATH = path.resolve(OUTPUT_DIR, "ontology-mapping-guide.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const OUTPUT_GRAPH_PATH = path.resolve(OUTPUT_DIR, "graph-data.json");
const OUTPUT_CYPHER_PATH = path.resolve(OUTPUT_DIR, "graph-import.cypher");
const OUTPUT_TTL_PATH = path.resolve(OUTPUT_DIR, "graph-data.ttl");
const OUTPUT_STATS_PATH = path.resolve(OUTPUT_DIR, "graph-stats.json");
const OUTPUT_ERRORS_PATH = path.resolve(OUTPUT_DIR, "graph-validation-errors.json");

const BASE_URI = "http://data.example.org/";
const MAX_ISSUES = 10_000;
const MAX_UNMAPPED_EXAMPLES = 5;
const MAX_ISSUE_EXAMPLES = 5;

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readOptionalJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function normalizeCell(value: unknown): string {
  return String(value ?? "").trim();
}

function slugify(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "unknown";
}

function getLocalName(uri: string): string {
  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0) return uri.slice(hashIndex + 1);
  const slashIndex = uri.lastIndexOf("/");
  return slashIndex >= 0 ? uri.slice(slashIndex + 1) : uri;
}

function formatPercent(part: number, whole: number): number {
  if (whole === 0) return 100;
  return Number(((part / whole) * 100).toFixed(2));
}

function resolveComplianceScore(mapping: MappingStrategy): { score: number; source: string; inferred: boolean } {
  const candidateScores = [
    mapping.metadata?.complianceScore,
    (mapping as unknown as { complianceScore?: number }).complianceScore,
    (mapping.validationReport as unknown as { complianceScore?: number } | undefined)?.complianceScore,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (candidateScores.length > 0) {
    return {
      score: Number(candidateScores[0].toFixed(2)),
      source: "mapping-strategy.json",
      inferred: false,
    };
  }

  const compliantMappings =
    mapping.entityMappings.filter((entry) => entry.compliant).length +
    mapping.attributeMappings.filter((entry) => entry.compliant).length +
    mapping.relationshipMappings.filter((entry) => entry.compliant).length;

  const totalMappings =
    mapping.entityMappings.length + mapping.attributeMappings.length + mapping.relationshipMappings.length;

  if (totalMappings === 0) {
    return {
      score: mapping.metadata?.ontologyCompliant ? 100 : 0,
      source: "derived-from-ontologyCompliant-flag",
      inferred: true,
    };
  }

  const score = Number(((compliantMappings / totalMappings) * 100).toFixed(2));
  return {
    score,
    source: "derived-from-compliant-mappings",
    inferred: true,
  };
}

function generateStableURI(classLabel: string, identifierValue: string): string {
  return `${BASE_URI}${slugify(classLabel)}/${slugify(identifierValue)}`;
}

function generateRelationshipURI(sourceId: string, relationshipType: string, targetId: string): string {
  return `${BASE_URI}rel/${slugify(sourceId)}/${slugify(relationshipType)}/${slugify(targetId)}`;
}

function escapeCypherString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n");
}

function escapeTurtleString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n");
}

function uriToPrefixed(uri: string, namespaces: Record<string, string>): string | null {
  for (const [prefix, namespace] of Object.entries(namespaces)) {
    if (uri.startsWith(namespace)) {
      return `${prefix}:${uri.slice(namespace.length)}`;
    }
  }

  return null;
}

function toTurtleTerm(uri: string, namespaces: Record<string, string>): string {
  return uriToPrefixed(uri, namespaces) || `<${uri}>`;
}

function valueMatchesDatatype(value: string, datatype: string): boolean {
  const dt = datatype.toLowerCase();
  if (dt.endsWith("string") || dt.endsWith("literal")) return true;
  if (dt.endsWith("integer") || dt.endsWith("int")) return /^-?\d+$/.test(value);
  if (dt.endsWith("decimal") || dt.endsWith("float") || dt.endsWith("double")) return /^-?\d+(?:\.\d+)?$/.test(value);
  if (dt.endsWith("boolean")) return /^(true|false|1|0|y|n|yes|no)$/i.test(value);
  if (dt.endsWith("date")) return /^\d{4}(?:-\d{2}-\d{2})?$/.test(value);
  if (dt.endsWith("anyuri") || dt.endsWith("uri")) return /^https?:\/\/\S+$/i.test(value);
  return true;
}

function coerceValue(value: string, datatype: string): string | number | boolean {
  const dt = datatype.toLowerCase();
  if (dt.endsWith("integer") || dt.endsWith("int")) return Number.parseInt(value, 10);
  if (dt.endsWith("decimal") || dt.endsWith("float") || dt.endsWith("double")) return Number.parseFloat(value);
  if (dt.endsWith("boolean")) return /^(true|1|y|yes)$/i.test(value);
  return value;
}

function recordExample(bucket: string[], value: string, limit: number): void {
  if (bucket.length >= limit) return;
  if (!bucket.includes(value)) bucket.push(value);
}

function buildOntologyIndex(ontology: OntologyStructure): OntologyIndex {
  const classByUri = new Map<string, OntologyClass>();
  const objectPropertyByUri = new Map<string, ObjectProperty>();
  const dataPropertyByUri = new Map<string, DataProperty>();

  for (const cls of ontology.classes) {
    classByUri.set(cls.uri, cls);
  }

  for (const property of ontology.objectProperties) {
    objectPropertyByUri.set(property.uri, property);
  }

  for (const property of ontology.dataProperties) {
    dataPropertyByUri.set(property.uri, property);
  }

  const classAncestors = new Map<string, Set<string>>();

  const visitAncestors = (uri: string, trail: Set<string>): Set<string> => {
    if (classAncestors.has(uri)) {
      return classAncestors.get(uri)!;
    }

    const cls = classByUri.get(uri);
    const ancestors = new Set<string>();
    if (!cls?.superClasses) {
      classAncestors.set(uri, ancestors);
      return ancestors;
    }

    for (const parentUri of cls.superClasses) {
      if (trail.has(parentUri)) continue;
      ancestors.add(parentUri);
      const nextTrail = new Set(trail);
      nextTrail.add(parentUri);
      for (const ancestor of Array.from(visitAncestors(parentUri, nextTrail))) {
        ancestors.add(ancestor);
      }
    }

    classAncestors.set(uri, ancestors);
    return ancestors;
  };

  for (const cls of ontology.classes) {
    visitAncestors(cls.uri, new Set<string>([cls.uri]));
  }

  return {
    classByUri,
    objectPropertyByUri,
    dataPropertyByUri,
    namespaces: ontology.metadata.namespaces,
    classAncestors,
  };
}

function classSatisfiesConstraint(classUri: string, allowedUris: string[] | undefined, ontologyIndex: OntologyIndex): boolean {
  if (!allowedUris || allowedUris.length === 0) return true;
  if (allowedUris.includes(classUri)) return true;

  const ancestors = ontologyIndex.classAncestors.get(classUri);
  if (!ancestors) return false;

  return allowedUris.some((uri) => ancestors.has(uri));
}

function validateNodeProperty(
  nodeClassUri: string,
  propertyUri: string,
  value: string,
  attributeDatatype: string,
  ontologyIndex: OntologyIndex,
): { valid: boolean; message?: string } {
  const dataProperty = ontologyIndex.dataPropertyByUri.get(propertyUri);
  if (dataProperty) {
    if (!classSatisfiesConstraint(nodeClassUri, dataProperty.domain, ontologyIndex)) {
      return {
        valid: false,
        message: `Property domain mismatch for ${propertyUri} on class ${nodeClassUri}`,
      };
    }

    const ontologyDatatype = dataProperty.range || attributeDatatype;
    if (!valueMatchesDatatype(value, ontologyDatatype)) {
      return {
        valid: false,
        message: `Datatype mismatch for ${propertyUri}: value "${value}" does not match ${ontologyDatatype}`,
      };
    }

    return { valid: true };
  }

  const objectProperty = ontologyIndex.objectPropertyByUri.get(propertyUri);
  if (objectProperty) {
    if (!classSatisfiesConstraint(nodeClassUri, objectProperty.domain, ontologyIndex)) {
      return {
        valid: false,
        message: `Object property domain mismatch for ${propertyUri} on class ${nodeClassUri}`,
      };
    }

    return { valid: true };
  }

  return {
    valid: false,
    message: `Unknown ontology property: ${propertyUri}`,
  };
}

function validateRelationship(
  relationshipType: string,
  sourceClassUri: string,
  targetClassUri: string,
  ontologyIndex: OntologyIndex,
): { valid: boolean; message?: string } {
  const property = ontologyIndex.objectPropertyByUri.get(relationshipType);
  if (!property) {
    return {
      valid: false,
      message: `Unknown ontology relationship: ${relationshipType}`,
    };
  }

  if (!classSatisfiesConstraint(sourceClassUri, property.domain, ontologyIndex)) {
    return {
      valid: false,
      message: `Relationship domain mismatch for ${relationshipType}: ${sourceClassUri}`,
    };
  }

  if (!classSatisfiesConstraint(targetClassUri, property.range, ontologyIndex)) {
    return {
      valid: false,
      message: `Relationship range mismatch for ${relationshipType}: ${targetClassUri}`,
    };
  }

  return { valid: true };
}

function parseDelimitedText(text: string, delimiter: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, unknown>>(text, {
    skipEmptyLines: true,
    delimiter,
    header: true,
  });

  if (result.errors.length > 0) {
    return [];
  }

  return result.data.map((record) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [String(key).trim(), normalizeCell(value)]),
    ),
  );
}

function parseSupplementaryRows(filePath: string, format: string | undefined): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf8");
  const effectiveFormat = (format || path.extname(filePath).slice(1)).toLowerCase();

  if (effectiveFormat === "csv") {
    return parseDelimitedText(content, ",");
  }

  if (effectiveFormat === "tsv" || effectiveFormat === "tab") {
    return parseDelimitedText(content, "\t");
  }

  if (effectiveFormat === "json") {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), normalizeCell(value)])));
    }
  }

  return [];
}

function pickLookupColumns(rows: Record<string, string>[]): { keyColumn: string | null; labelColumn: string | null } {
  if (rows.length === 0) {
    return { keyColumn: null, labelColumn: null };
  }

  const columns = Object.keys(rows[0]);
  const keyColumn =
    columns.find((column) => /(code|id|key|identifier|qid|ulan)$/i.test(column)) ||
    columns.find((column) => /(code|id|key|identifier|qid|ulan)/i.test(column)) ||
    columns[0] ||
    null;

  const labelColumn =
    columns.find((column) => /(label|name|title|description|meaning|category)$/i.test(column)) ||
    columns.find((column) => /(label|name|title|description|meaning|category)/i.test(column)) ||
    columns.find((column) => column !== keyColumn) ||
    keyColumn;

  return { keyColumn, labelColumn };
}

function loadSupplementaryDatasets(
  entries: SupplementaryIndexEntry[] | null,
  issues: ValidationIssue[],
): SupplementaryDataset[] {
  if (!entries || entries.length === 0 || !fs.existsSync(SUPPLEMENTARY_DIR)) {
    return [];
  }

  const datasets: SupplementaryDataset[] = [];

  for (const entry of entries) {
    const fileName = path.basename(entry.path || entry.name);
    const filePath = path.resolve(SUPPLEMENTARY_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      issues.push({
        type: "supplementary_file_missing",
        severity: "warning",
        message: `Supplementary file listed but not found on disk: ${fileName}`,
      });
      continue;
    }

    const rows = parseSupplementaryRows(filePath, entry.format);
    const { keyColumn, labelColumn } = pickLookupColumns(rows);
    if (!keyColumn || !labelColumn) {
      continue;
    }

    const rowsByKey = new Map<string, SupplementaryReferenceRow>();
    for (const row of rows) {
      const key = normalizeCell(row[keyColumn]);
      const label = normalizeCell(row[labelColumn]);
      if (!key || !label) continue;

      rowsByKey.set(key.toLowerCase(), {
        key,
        label,
        raw: row,
      });
    }

    datasets.push({
      fileName,
      keyColumn,
      labelColumn,
      rowsByKey,
    });
  }

  return datasets;
}

function resolveSupplementaryLabel(value: string, datasets: SupplementaryDataset[]): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  for (const dataset of datasets) {
    const match = dataset.rowsByKey.get(normalized);
    if (match) {
      return match.label;
    }
  }

  return null;
}

async function main(): Promise<void> {
  ensureDir(OUTPUT_DIR);

  for (const requiredFile of [INPUT_CSV, MAPPING_PATH, ONTOLOGY_PATH, MAPPING_GUIDE_PATH]) {
    if (!fs.existsSync(requiredFile)) {
      throw new Error(`Required file not found: ${requiredFile}`);
    }
  }

  const mapping = readJsonFile<MappingStrategy>(MAPPING_PATH);
  const ontology = readJsonFile<OntologyStructure>(ONTOLOGY_PATH);
  readJsonFile<JsonObject>(MAPPING_GUIDE_PATH);
  const supplementaryIndex = readOptionalJsonFile<SupplementaryIndexEntry[]>(SUPPLEMENTARY_INDEX_PATH);

  const issues: ValidationIssue[] = [];
  const complianceResolution = resolveComplianceScore(mapping);
  const complianceScore = complianceResolution.score;

  if (complianceResolution.inferred) {
    issues.push({
      type: "compliance_score_inferred",
      severity: "warning",
      message: `Compliance score was missing or non-positive in mapping-strategy.json; inferred ${complianceScore} from ${complianceResolution.source}.`,
    });
  }

  if (complianceScore < 80) {
    issues.push({
      type: "mapping_compliance_warning",
      severity: complianceScore < 60 ? "error" : "warning",
      message: `mapping-strategy.json complianceScore is ${complianceScore}; expected at least 80.`,
    });

    for (const warning of mapping.metadata.warnings || []) {
      issues.push({
        type: "mapping_warning",
        severity: complianceScore < 60 ? "error" : "warning",
        message: warning,
      });
    }

    for (const violation of mapping.unmappedColumns) {
      issues.push({
        type: "mapping_violation",
        severity: violation.severity === "info" ? "info" : "warning",
        message: `${violation.columnName}: ${violation.reason}`,
        example: {
          columnName: violation.columnName,
          suggestion: violation.suggestion,
        },
      });
    }
  }

  if (complianceScore < 60) {
    fs.writeFileSync(
      OUTPUT_ERRORS_PATH,
      JSON.stringify(
        {
          metadata: {
            generatedAt: new Date().toISOString(),
            status: "stopped",
            reason: "Compliance score below 60",
            complianceScore,
          },
          issues,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.error(`Compliance score: ${complianceScore}`);
    console.error("Generation stopped because complianceScore < 60.");
    console.error(`Validation log: ${OUTPUT_ERRORS_PATH}`);
    process.exit(1);
  }

  const ontologyIndex = buildOntologyIndex(ontology);
  const validNamespaces = new Set(Object.values(ontology.metadata.namespaces));

  const compliantEntityMappings = mapping.entityMappings.filter((entry) => entry.compliant);
  const compliantAttributeMappings = mapping.attributeMappings.filter((entry) => entry.compliant);
  const compliantRelationshipMappings = mapping.relationshipMappings.filter((entry) => entry.compliant);

  for (const entityMapping of compliantEntityMappings) {
    if (!ontologyIndex.classByUri.has(entityMapping.ontologyClass)) {
      issues.push({
        type: "invalid_entity_class",
        severity: "error",
        message: `Entity mapping references unknown class ${entityMapping.ontologyClass}`,
      });
    }
  }

  for (const attributeMapping of compliantAttributeMappings) {
    const namespaceValid = [...validNamespaces].some((namespace) => attributeMapping.ontologyProperty.startsWith(namespace));
    if (!namespaceValid) {
      issues.push({
        type: "invalid_namespace",
        severity: "error",
        message: `Attribute mapping uses non-ontology namespace ${attributeMapping.ontologyProperty}`,
      });
    }
  }

  for (const relationshipMapping of compliantRelationshipMappings) {
    const namespaceValid = [...validNamespaces].some((namespace) => relationshipMapping.ontologyRelationship.startsWith(namespace));
    if (!namespaceValid) {
      issues.push({
        type: "invalid_namespace",
        severity: "error",
        message: `Relationship mapping uses non-ontology namespace ${relationshipMapping.ontologyRelationship}`,
      });
    }
  }

  const runtimeEntities = new Map<string, EntityMappingRuntime>();
  for (const entry of compliantEntityMappings) {
    const classInfo = ontologyIndex.classByUri.get(entry.ontologyClass);
    if (!classInfo) continue;
    runtimeEntities.set(entry.ontologyClass, { mapping: entry, classInfo });
  }

  const runtimeAttributes = new Map<string, AttributeMappingRuntime[]>();
  for (const entry of compliantAttributeMappings) {
    const property = ontologyIndex.dataPropertyByUri.get(entry.ontologyProperty) || ontologyIndex.objectPropertyByUri.get(entry.ontologyProperty) || null;
    const collection = runtimeAttributes.get(entry.targetEntity) || [];
    collection.push({
      mapping: entry,
      propertyLocalName: getLocalName(entry.ontologyProperty),
      propertyInfo: property,
    });
    runtimeAttributes.set(entry.targetEntity, collection);
  }

  const runtimeRelationships: RelationshipMappingRuntime[] = [];
  for (const entry of compliantRelationshipMappings) {
    const property = ontologyIndex.objectPropertyByUri.get(entry.ontologyRelationship);
    if (!property) {
      issues.push({
        type: "invalid_relationship_type",
        severity: "error",
        message: `Relationship mapping references unknown property ${entry.ontologyRelationship}`,
      });
      continue;
    }

    runtimeRelationships.push({ mapping: entry, propertyInfo: property });
  }

  const supplementaryDatasets = loadSupplementaryDatasets(supplementaryIndex, issues);
  const supplementaryEntityBindings = new Map<string, SupplementaryEntityBinding>();

  for (const runtimeEntity of Array.from(runtimeEntities.values())) {
    const dataset = supplementaryDatasets.find(
      (candidate) =>
        candidate.keyColumn === runtimeEntity.mapping.identifierColumn || candidate.keyColumn === runtimeEntity.mapping.columnName,
    );

    if (dataset) {
      supplementaryEntityBindings.set(runtimeEntity.mapping.ontologyClass, {
        entity: runtimeEntity,
        dataset,
      });
    }
  }

  const nodesById = new Map<string, GraphNode>();
  const nodeClassById = new Map<string, string>();
  const relationshipsById = new Map<string, GraphRelationship>();
  const nodesByType: Record<string, number> = {};
  const relationshipsByType: Record<string, number> = {};
  const violationsByType: Record<string, number> = {};
  const unmappedColumnsConfigured = new Set(mapping.unmappedColumns.map((entry) => entry.columnName));
  const unmappedDataObserved = new Map<string, { nonEmptyCount: number; examples: string[] }>();

  let validNodes = 0;
  let invalidNodes = 0;
  let validRelationships = 0;
  let invalidRelationships = 0;
  let totalRows = 0;
  let nonEmptyCells = 0;
  let unmappedNonEmptyCells = 0;
  let referenceNodesCreated = 0;
  let enrichmentRelationshipsCreated = 0;

  const recordIssue = (issue: ValidationIssue): void => {
    if (issues.length < MAX_ISSUES) {
      issues.push(issue);
    }

    violationsByType[issue.type] = (violationsByType[issue.type] || 0) + 1;
  };

  const touchNodeType = (label: string): void => {
    nodesByType[label] = (nodesByType[label] || 0) + 1;
  };

  const touchRelationshipType = (relationshipType: string): void => {
    const local = getLocalName(relationshipType);
    relationshipsByType[local] = (relationshipsByType[local] || 0) + 1;
  };

  const addNode = (node: GraphNode, classUri: string): boolean => {
    const existing = nodesById.get(node.id);
    if (existing) {
      for (const [key, value] of Object.entries(node.properties)) {
        if (!(key in existing.properties) && value !== "") {
          existing.properties[key] = value;
        }
      }
      return false;
    }

    nodesById.set(node.id, node);
    nodeClassById.set(node.id, classUri);
    touchNodeType(node.labels[0]);
    validNodes += 1;
    return true;
  };

  const addRelationship = (relationship: GraphRelationship): boolean => {
    if (relationshipsById.has(relationship.id)) {
      return false;
    }

    relationshipsById.set(relationship.id, relationship);
    touchRelationshipType(relationship.type);
    validRelationships += 1;
    return true;
  };

  for (const binding of Array.from(supplementaryEntityBindings.values())) {
    const classUri = binding.entity.mapping.ontologyClass;
    const classInfo = binding.entity.classInfo;
    const attributeRuntimes = runtimeAttributes.get(classUri) || [];

    for (const supplementaryRow of Array.from(binding.dataset.rowsByKey.values())) {
      const nodeId = generateStableURI(classInfo.label, supplementaryRow.key);
      const properties: Record<string, string | number | boolean> = {};
      let invalid = false;

      for (const attributeRuntime of attributeRuntimes) {
        const rawValue = normalizeCell(supplementaryRow.raw[attributeRuntime.mapping.columnName]);
        if (!rawValue) continue;

        const validation = validateNodeProperty(
          classUri,
          attributeRuntime.mapping.ontologyProperty,
          rawValue,
          attributeRuntime.mapping.datatype,
          ontologyIndex,
        );

        if (!validation.valid) {
          invalid = true;
          invalidNodes += 1;
          recordIssue({
            type: "invalid_supplementary_node_property",
            severity: "warning",
            message: validation.message || "Supplementary node property validation failed",
            entityId: nodeId,
            example: {
              fileName: binding.dataset.fileName,
              columnName: attributeRuntime.mapping.columnName,
              value: rawValue,
            },
          });
          break;
        }

        properties[attributeRuntime.propertyLocalName] = coerceValue(rawValue, attributeRuntime.mapping.datatype);
      }

      if (invalid) continue;

      const inserted = addNode(
        {
          id: nodeId,
          labels: [classInfo.label],
          properties,
          _meta: {
            sourceRow: 0,
            confidence: binding.entity.mapping.confidence,
            compliant: complianceScore >= 80,
            enriched: true,
          },
        },
        classUri,
      );
      if (inserted) {
        referenceNodesCreated += 1;
      }
    }
  }

  const parseRowStream = async (): Promise<void> =>
    new Promise((resolve, reject) => {
      const parser = parse({
        columns: true,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      });

      parser.on("readable", () => {
        let record: CsvRow | null;
        while ((record = parser.read() as CsvRow | null) !== null) {
          totalRows += 1;
          const rowIndex = totalRows;

          for (const [columnName, rawValue] of Object.entries(record)) {
            const value = normalizeCell(rawValue);
            if (!value) continue;
            nonEmptyCells += 1;

            if (unmappedColumnsConfigured.has(columnName)) {
              unmappedNonEmptyCells += 1;
              const bucket = unmappedDataObserved.get(columnName) || { nonEmptyCount: 0, examples: [] };
              bucket.nonEmptyCount += 1;
              recordExample(bucket.examples, value, MAX_UNMAPPED_EXAMPLES);
              unmappedDataObserved.set(columnName, bucket);
            }
          }

          const rowEntityIds = new Map<string, string>();

          for (const runtimeEntity of Array.from(runtimeEntities.values())) {
            const identifierColumn = runtimeEntity.mapping.identifierColumn;
            const identifierValue = normalizeCell(record[identifierColumn]);
            if (!identifierValue) continue;

            const classUri = runtimeEntity.mapping.ontologyClass;
            const classInfo = runtimeEntity.classInfo;

            if (!ontologyIndex.classByUri.has(classUri)) {
              invalidNodes += 1;
              recordIssue({
                type: "unknown_class",
                severity: "error",
                message: `Class not found in ontology: ${classUri}`,
                rowIndex,
              });
              continue;
            }

            const nodeId = generateStableURI(classInfo.label, identifierValue);
            rowEntityIds.set(classUri, nodeId);

            const properties: Record<string, string | number | boolean> = {};
            const attributeRuntimes = runtimeAttributes.get(classUri) || [];

            let nodeInvalid = false;
            for (const attributeRuntime of attributeRuntimes) {
              const rawValue = normalizeCell(record[attributeRuntime.mapping.columnName]);
              if (!rawValue) continue;

              let resolvedValue = rawValue;
              const enrichedLabel = resolveSupplementaryLabel(rawValue, supplementaryDatasets);
              if (enrichedLabel) {
                resolvedValue = enrichedLabel;
              }

              const validation = validateNodeProperty(
                classUri,
                attributeRuntime.mapping.ontologyProperty,
                resolvedValue,
                attributeRuntime.mapping.datatype,
                ontologyIndex,
              );

              if (!validation.valid) {
                nodeInvalid = true;
                invalidNodes += 1;
                recordIssue({
                  type: "invalid_node_property",
                  severity: "error",
                  message: validation.message || "Node property validation failed",
                  rowIndex,
                  entityId: nodeId,
                  example: {
                    columnName: attributeRuntime.mapping.columnName,
                    value: resolvedValue,
                  },
                });
                break;
              }

              properties[attributeRuntime.propertyLocalName] = coerceValue(resolvedValue, attributeRuntime.mapping.datatype);
            }

            if (nodeInvalid) {
              continue;
            }

            addNode(
              {
                id: nodeId,
                labels: [classInfo.label],
                properties,
                _meta: {
                  sourceRow: rowIndex,
                  confidence: runtimeEntity.mapping.confidence,
                  compliant: complianceScore >= 80,
                },
              },
              classUri,
            );
          }

          for (const runtimeRelationship of runtimeRelationships) {
            const rawValue = normalizeCell(record[runtimeRelationship.mapping.columnName]);
            if (!rawValue) continue;

            const sourceId = rowEntityIds.get(runtimeRelationship.mapping.sourceEntity);
            let targetId = rowEntityIds.get(runtimeRelationship.mapping.targetEntity);
            if (!targetId) {
              const binding = supplementaryEntityBindings.get(runtimeRelationship.mapping.targetEntity);
              const match = binding?.dataset.rowsByKey.get(rawValue.toLowerCase());
              if (binding && match) {
                targetId = generateStableURI(binding.entity.classInfo.label, match.key);
              }
            }
            if (!sourceId || !targetId) {
              invalidRelationships += 1;
              recordIssue({
                type: "missing_relationship_endpoint",
                severity: "warning",
                message: `Missing relationship endpoint for ${runtimeRelationship.mapping.ontologyRelationship}`,
                rowIndex,
                example: {
                  columnName: runtimeRelationship.mapping.columnName,
                  sourceEntity: runtimeRelationship.mapping.sourceEntity,
                  targetEntity: runtimeRelationship.mapping.targetEntity,
                },
              });
              continue;
            }

            const sourceClassUri = nodeClassById.get(sourceId);
            const targetClassUri = nodeClassById.get(targetId);
            if (!sourceClassUri || !targetClassUri) {
              invalidRelationships += 1;
              recordIssue({
                type: "missing_relationship_node_class",
                severity: "error",
                message: `Relationship endpoint class missing for ${runtimeRelationship.mapping.ontologyRelationship}`,
                rowIndex,
              });
              continue;
            }

            const validation = validateRelationship(
              runtimeRelationship.mapping.ontologyRelationship,
              sourceClassUri,
              targetClassUri,
              ontologyIndex,
            );

            if (!validation.valid) {
              invalidRelationships += 1;
              recordIssue({
                type: "invalid_relationship",
                severity: "error",
                message: validation.message || "Relationship validation failed",
                rowIndex,
                relationshipId: generateRelationshipURI(sourceId, runtimeRelationship.mapping.ontologyRelationship, targetId),
              });
              continue;
            }

            const inserted = addRelationship({
              id: generateRelationshipURI(sourceId, runtimeRelationship.mapping.ontologyRelationship, targetId),
              type: runtimeRelationship.mapping.ontologyRelationship,
              from: sourceId,
              to: targetId,
              properties: {},
              _meta: {
                confidence: runtimeRelationship.mapping.confidence,
                compliant: complianceScore >= 80,
                sourceRow: rowIndex,
              },
            });
            if (inserted && supplementaryEntityBindings.has(runtimeRelationship.mapping.targetEntity)) {
              enrichmentRelationshipsCreated += 1;
            }
          }
        }
      });

      parser.on("error", reject);
      parser.on("end", resolve);

      fs.createReadStream(INPUT_CSV, { encoding: "utf8" }).pipe(parser);
    });

  await parseRowStream();

  const nodes = [...nodesById.values()];
  const relationships = [...relationshipsById.values()];
  const nodeCount = nodes.length;
  const relationshipCount = relationships.length;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;

  const outputGraph: OutputGraph = {
    metadata: {
      generatedAt: new Date().toISOString(),
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      complianceScore,
      validation: {
        compliant: complianceScore >= 80 && errorCount === 0,
        errors: errorCount,
        warnings: warningCount,
      },
    },
    nodes,
    relationships,
    statistics: {
      totalNodes: nodeCount,
      nodesByType,
      totalRelationships: relationshipCount,
      relationshipsByType,
    },
  };

  const issueGroups = new Map<string, { severity: "error" | "warning" | "info"; count: number; examples: string[] }>();
  for (const issue of issues) {
    const current = issueGroups.get(issue.type) || { severity: issue.severity, count: 0, examples: [] };
    current.count += 1;
    recordExample(current.examples, issue.message, MAX_ISSUE_EXAMPLES);
    if (issue.severity === "error") current.severity = "error";
    issueGroups.set(issue.type, current);
  }

  const avgDegree = nodeCount === 0 ? 0 : Number(((relationshipCount * 2) / nodeCount).toFixed(4));
  const density = nodeCount <= 1 ? 0 : Number((relationshipCount / (nodeCount * (nodeCount - 1))).toFixed(8));

  const graphStats: GraphStats = {
    summary: {
      totalNodes: nodeCount,
      totalRelationships: relationshipCount,
      avgDegree,
      density,
    },
    nodeStatistics: {
      byType: nodesByType,
      withIssues: invalidNodes,
      compliant: validNodes,
    },
    relationshipStatistics: {
      byType: relationshipsByType,
      withIssues: invalidRelationships,
      compliant: validRelationships,
    },
    complianceMetrics: {
      overallScore: complianceScore,
      validNodesPercent: formatPercent(validNodes, validNodes + invalidNodes),
      validRelationshipsPercent: formatPercent(validRelationships, validRelationships + invalidRelationships),
      unmappedDataPercent: formatPercent(unmappedNonEmptyCells, nonEmptyCells),
    },
    issues: Array.from(issueGroups.entries()).map(([type, info]) => ({
      type,
      severity: info.severity,
      count: info.count,
      examples: info.examples,
    })),
    validationMetrics: {
      validNodes,
      invalidNodes,
      validRelationships,
      invalidRelationships,
      violationsByType,
    },
    unmappedColumns: {
      count: unmappedColumnsConfigured.size,
      configured: Array.from(unmappedColumnsConfigured).sort((left, right) => left.localeCompare(right)),
      encounteredValues: Object.fromEntries(
        Array.from(unmappedDataObserved.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([column, info]) => [column, info]),
      ),
    },
    supplementary: {
      indexFound: Boolean(supplementaryIndex),
      filesLoaded: supplementaryDatasets.map((dataset) => dataset.fileName),
      referenceNodesCreated,
      enrichmentRelationshipsCreated,
    },
    complianceResolution,
  };

  fs.writeFileSync(OUTPUT_GRAPH_PATH, JSON.stringify(outputGraph, null, 2), "utf8");
  fs.writeFileSync(OUTPUT_STATS_PATH, JSON.stringify(graphStats, null, 2), "utf8");

  if (issues.length > 0) {
    fs.writeFileSync(
      OUTPUT_ERRORS_PATH,
      JSON.stringify(
        {
          metadata: {
            generatedAt: new Date().toISOString(),
            complianceScore,
            totalIssues: issues.length,
          },
          issues,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const nodeLabelSet = new Set(nodes.map((node) => node.labels[0]));
  const cypherLines: string[] = [];
  cypherLines.push("// Auto-generated Neo4j import script");
  cypherLines.push("");
  for (const label of Array.from(nodeLabelSet).sort((left, right) => left.localeCompare(right))) {
    cypherLines.push(`CREATE CONSTRAINT ${slugify(label)}_id_unique IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.id IS UNIQUE;`);
  }
  cypherLines.push("");

  for (const node of nodes) {
    const propertyEntries = Object.entries({ id: node.id, ...node.properties }).map(
      ([key, value]) =>
        `\`${key}\`: ${typeof value === "string" ? `'${escapeCypherString(value)}'` : String(value)}`,
    );
    cypherLines.push(`MERGE (n:\`${node.labels[0]}\` {id: '${escapeCypherString(node.id)}'}) SET n += {${propertyEntries.join(", ")}};`);
  }

  cypherLines.push("");
  for (const relationship of relationships) {
    const relType = getLocalName(relationship.type);
    cypherLines.push(
      `MATCH (a {id: '${escapeCypherString(relationship.from)}'}), (b {id: '${escapeCypherString(relationship.to)}'}) MERGE (a)-[r:\`${relType}\`]->(b);`,
    );
  }

  fs.writeFileSync(OUTPUT_CYPHER_PATH, `${cypherLines.join("\n")}\n`, "utf8");

  const ttlLines: string[] = [];
  for (const [prefix, namespace] of Object.entries(ontology.metadata.namespaces)) {
    ttlLines.push(`@prefix ${prefix}: <${namespace}> .`);
  }
  ttlLines.push("");

  for (const node of nodes) {
    const classUri = Array.from(runtimeEntities.values()).find((entry) => entry.classInfo.label === node.labels[0])?.classInfo.uri;
    if (!classUri) continue;

    ttlLines.push(`<${node.id}> a ${toTurtleTerm(classUri, ontology.metadata.namespaces)} .`);
    for (const [key, value] of Object.entries(node.properties)) {
      const attributeRuntime = compliantAttributeMappings.find(
        (mappingEntry) => getLocalName(mappingEntry.ontologyProperty) === key,
      );
      if (!attributeRuntime) continue;

      const objectValue = typeof value === "string" ? `"${escapeTurtleString(value)}"` : `"${String(value)}"`;
      ttlLines.push(`<${node.id}> ${toTurtleTerm(attributeRuntime.ontologyProperty, ontology.metadata.namespaces)} ${objectValue} .`);
    }
  }

  for (const relationship of relationships) {
    ttlLines.push(
      `<${relationship.from}> ${toTurtleTerm(relationship.type, ontology.metadata.namespaces)} <${relationship.to}> .`,
    );
  }

  fs.writeFileSync(OUTPUT_TTL_PATH, `${ttlLines.join("\n")}\n`, "utf8");

  console.log(`Compliance score: ${complianceScore}`);
  if (complianceResolution.inferred) {
    console.log(`Compliance score source: ${complianceResolution.source} (inferred)`);
  }
  console.log(`Node counts by type: ${JSON.stringify(nodesByType)}`);
  console.log(`Relationship counts by type: ${JSON.stringify(relationshipsByType)}`);
  console.log(
    `Validation results: nodes ${graphStats.complianceMetrics.validNodesPercent}% valid, relationships ${graphStats.complianceMetrics.validRelationshipsPercent}% valid`,
  );
  console.log(`Unmapped column count: ${unmappedColumnsConfigured.size}`);
  console.log("Output files:");
  console.log(`- ${OUTPUT_GRAPH_PATH}`);
  console.log(`- ${OUTPUT_CYPHER_PATH}`);
  console.log(`- ${OUTPUT_TTL_PATH}`);
  console.log(`- ${OUTPUT_STATS_PATH}`);
  if (issues.length > 0) {
    console.log(`- ${OUTPUT_ERRORS_PATH}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
