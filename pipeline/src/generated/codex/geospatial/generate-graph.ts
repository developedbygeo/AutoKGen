import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse";

type Primitive = string | number | boolean;
type CsvRow = Record<string, string>;

interface OntologyClass {
  uri: string;
  label: string;
  superClasses?: string[];
}

interface OntologyObjectProperty {
  uri: string;
  label: string;
  domain?: string[];
  range?: string[];
}

interface OntologyDataProperty {
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
  objectProperties: OntologyObjectProperty[];
  dataProperties: OntologyDataProperty[];
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  confidence: number;
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
  reasoning?: string;
  compliant: boolean;
}

interface RelationshipMapping {
  columnName: string;
  ontologyRelationship: string;
  sourceEntity: string;
  targetEntity: string;
  confidence: number;
  reasoning?: string;
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
    ontologyCompliant?: boolean;
    complianceScore: number;
    ontologyName: string;
    ontologyVersion: string;
    warnings?: string[];
  };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
  unmappedColumns: UnmappedColumn[];
}

interface MappingGuide {
  allowedNamespaces?: string[];
}

interface SupplementaryIndexEntry {
  path: string;
  name: string;
  format?: string;
  columns?: string[];
}

interface SupplementaryRecord {
  key: string;
  label: string;
  geonameid?: string;
  raw: Record<string, string>;
}

interface SupplementaryLookups {
  filesLoaded: string[];
  countryByCode: Map<string, SupplementaryRecord>;
  admin1ByCode: Map<string, SupplementaryRecord>;
  featureCodeByCode: Map<string, SupplementaryRecord>;
}

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, Primitive>;
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
  properties: Record<string, Primitive>;
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
  example?: Record<string, unknown>;
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
}

interface OntologyIndex {
  classByUri: Map<string, OntologyClass>;
  classByLabel: Map<string, OntologyClass>;
  objectPropertyByUri: Map<string, OntologyObjectProperty>;
  dataPropertyByUri: Map<string, OntologyDataProperty>;
  namespaces: Record<string, string>;
  validNamespaceUris: Set<string>;
  classAncestors: Map<string, Set<string>>;
}

interface EntityRuntime {
  mapping: EntityMapping;
  classInfo: OntologyClass;
  label: string;
}

interface AttributeRuntime {
  mapping: AttributeMapping;
  propertyInfo: OntologyDataProperty;
  propertyKey: string;
}

interface RelationshipRuntime {
  mapping: RelationshipMapping;
  propertyInfo: OntologyObjectProperty;
  typeKey: string;
}

const DATA_DIR = path.resolve("domain-data/geospatial");
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");

const INPUT_CSV = path.resolve(OUTPUT_DIR, "dataset-cleaned.csv");
const MAPPING_PATH = path.resolve(OUTPUT_DIR, "mapping-strategy.json");
const ONTOLOGY_PATH = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const GUIDE_PATH = path.resolve(OUTPUT_DIR, "ontology-mapping-guide.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");

const OUTPUT_GRAPH_PATH = path.resolve(OUTPUT_DIR, "graph-data.json");
const OUTPUT_CYPHER_PATH = path.resolve(OUTPUT_DIR, "graph-import.cypher");
const OUTPUT_TTL_PATH = path.resolve(OUTPUT_DIR, "graph-data.ttl");
const OUTPUT_STATS_PATH = path.resolve(OUTPUT_DIR, "graph-stats.json");
const OUTPUT_ERRORS_PATH = path.resolve(OUTPUT_DIR, "graph-validation-errors.json");

const TEMP_NODES_PATH = path.resolve(OUTPUT_DIR, ".graph-nodes.ndjson");
const TEMP_RELATIONSHIPS_PATH = path.resolve(OUTPUT_DIR, ".graph-relationships.ndjson");

const BASE_URI = "http://data.example.org/";
const MAX_EXAMPLES = 5;
const MAX_ISSUES = 10000;

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

function generateStableURI(classLabel: string, identifierValue: string): string {
  return `${BASE_URI}${slugify(classLabel)}/${slugify(identifierValue)}`;
}

function generateRelationshipURI(sourceId: string, relationshipType: string, targetId: string): string {
  return generateStableURI("rel", `${sourceId}|${relationshipType}|${targetId}`);
}

function getLocalName(uri: string): string {
  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0) return uri.slice(hashIndex + 1);
  const slashIndex = uri.lastIndexOf("/");
  return slashIndex >= 0 ? uri.slice(slashIndex + 1) : uri;
}

function escapeCypherString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n");
}

function escapeTurtleString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n");
}

function resolvePrefixedValue(value: string, namespaces: Record<string, string>): string {
  if (!value || /^https?:\/\//i.test(value)) {
    return value;
  }

  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return value;
  }

  const prefix = value.slice(0, separatorIndex);
  const local = value.slice(separatorIndex + 1);
  const namespace = namespaces[prefix];
  return namespace ? `${namespace}${local}` : value;
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

function isNamespaceAllowed(uri: string, ontologyIndex: OntologyIndex, guide: MappingGuide): boolean {
  const ontologyAllowed = Array.from(ontologyIndex.validNamespaceUris).some((namespace) => uri.startsWith(namespace));
  if (ontologyAllowed) {
    return true;
  }

  return (guide.allowedNamespaces || []).some((namespace) => uri.startsWith(namespace));
}

function valueMatchesDatatype(value: string, datatype: string): boolean {
  const normalized = datatype.toLowerCase();
  if (normalized.endsWith("string") || normalized.endsWith("literal")) return true;
  if (normalized.endsWith("integer") || normalized.endsWith("int")) return /^-?\d+$/.test(value);
  if (normalized.endsWith("decimal") || normalized.endsWith("double") || normalized.endsWith("float")) {
    return /^-?\d+(?:\.\d+)?$/.test(value);
  }
  if (normalized.endsWith("boolean")) return /^(true|false|0|1)$/i.test(value);
  if (normalized.endsWith("date")) return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (normalized.endsWith("anyuri") || normalized.endsWith("uri")) return /^https?:\/\/\S+$/i.test(value);
  return true;
}

function coerceValue(value: string, datatype: string): Primitive {
  const normalized = datatype.toLowerCase();
  if (normalized.endsWith("integer") || normalized.endsWith("int")) {
    return Number.parseInt(value, 10);
  }
  if (normalized.endsWith("decimal") || normalized.endsWith("double") || normalized.endsWith("float")) {
    return Number.parseFloat(value);
  }
  if (normalized.endsWith("boolean")) {
    return /^(true|1)$/i.test(value);
  }
  return value;
}

function formatPercent(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function addExample(values: string[], candidate: string): void {
  if (!candidate || values.includes(candidate) || values.length >= MAX_EXAMPLES) {
    return;
  }

  values.push(candidate);
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });
}

function buildOntologyIndex(ontology: OntologyStructure): OntologyIndex {
  const classByUri = new Map<string, OntologyClass>();
  const classByLabel = new Map<string, OntologyClass>();
  const objectPropertyByUri = new Map<string, OntologyObjectProperty>();
  const dataPropertyByUri = new Map<string, OntologyDataProperty>();

  for (const ontologyClass of ontology.classes) {
    classByUri.set(ontologyClass.uri, ontologyClass);
    classByLabel.set(ontologyClass.label, ontologyClass);
  }

  for (const property of ontology.objectProperties) {
    objectPropertyByUri.set(property.uri, property);
  }

  for (const property of ontology.dataProperties) {
    dataPropertyByUri.set(property.uri, property);
  }

  const classAncestors = new Map<string, Set<string>>();

  const visit = (classUri: string, trail: Set<string>): Set<string> => {
    const existing = classAncestors.get(classUri);
    if (existing) {
      return existing;
    }

    const ontologyClass = classByUri.get(classUri);
    const ancestors = new Set<string>([classUri]);
    if (!ontologyClass) {
      classAncestors.set(classUri, ancestors);
      return ancestors;
    }

    for (const superClass of ontologyClass.superClasses || []) {
      const resolved = resolvePrefixedValue(superClass, ontology.metadata.namespaces);
      if (trail.has(resolved)) {
        continue;
      }
      ancestors.add(resolved);
      const nextTrail = new Set(trail);
      nextTrail.add(resolved);
      for (const ancestor of Array.from(visit(resolved, nextTrail))) {
        ancestors.add(ancestor);
      }
    }

    classAncestors.set(classUri, ancestors);
    return ancestors;
  };

  for (const ontologyClass of ontology.classes) {
    visit(ontologyClass.uri, new Set<string>([ontologyClass.uri]));
  }

  return {
    classByUri,
    classByLabel,
    objectPropertyByUri,
    dataPropertyByUri,
    namespaces: ontology.metadata.namespaces,
    validNamespaceUris: new Set(Object.values(ontology.metadata.namespaces)),
    classAncestors,
  };
}

function classSatisfiesConstraint(classUri: string, constraints: string[] | undefined, ontologyIndex: OntologyIndex): boolean {
  if (!constraints || constraints.length === 0) {
    return true;
  }

  const ancestors = ontologyIndex.classAncestors.get(classUri);
  if (!ancestors) {
    return false;
  }

  return constraints.some((constraint) => {
    const resolved = resolvePrefixedValue(constraint, ontologyIndex.namespaces);
    return ancestors.has(resolved);
  });
}

function validateNodeProperty(
  nodeClassUri: string,
  propertyUri: string,
  value: string,
  declaredDatatype: string,
  ontologyIndex: OntologyIndex,
): { valid: boolean; message?: string } {
  const dataProperty = ontologyIndex.dataPropertyByUri.get(propertyUri);
  if (!dataProperty) {
    if (ontologyIndex.objectPropertyByUri.has(propertyUri)) {
      return {
        valid: false,
        message: `Property ${propertyUri} is an object property and cannot be materialized as a node literal property`,
      };
    }

    return {
      valid: false,
      message: `Property ${propertyUri} was not found in ontology-structure.json`,
    };
  }

  if (!classSatisfiesConstraint(nodeClassUri, dataProperty.domain, ontologyIndex)) {
    return {
      valid: false,
      message: `Property domain mismatch for ${propertyUri} on class ${nodeClassUri}`,
    };
  }

  const ontologyDatatype = resolvePrefixedValue(dataProperty.range || declaredDatatype, ontologyIndex.namespaces);
  const effectiveDatatype = ontologyDatatype || declaredDatatype;
  if (effectiveDatatype && !valueMatchesDatatype(value, effectiveDatatype)) {
    return {
      valid: false,
      message: `Datatype mismatch for ${propertyUri}: value "${value}" does not satisfy ${effectiveDatatype}`,
    };
  }

  return { valid: true };
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
      message: `Relationship ${relationshipType} was not found in ontology-structure.json`,
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

function splitDelimitedLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((value) => value.trim());
}

function parseSupplementaryTable(
  filePath: string,
  columns: string[] | undefined,
  delimiter: string,
  skipComments: boolean,
): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf8");
  const rows: Record<string, string>[] = [];
  const lines = content.split(/\r?\n/);
  const headers = columns && columns.length > 0 ? columns : null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (skipComments && trimmed.startsWith("#")) continue;

    const values = splitDelimitedLine(line, delimiter);
    const effectiveHeaders = headers || values.map((_, index) => `column_${index + 1}`);
    const row: Record<string, string> = {};

    for (let index = 0; index < effectiveHeaders.length; index += 1) {
      row[effectiveHeaders[index]] = values[index] ?? "";
    }

    rows.push(row);
  }

  return rows;
}

function buildSupplementaryLookups(entries: SupplementaryIndexEntry[] | null, issues: ValidationIssue[]): SupplementaryLookups {
  const lookups: SupplementaryLookups = {
    filesLoaded: [],
    countryByCode: new Map<string, SupplementaryRecord>(),
    admin1ByCode: new Map<string, SupplementaryRecord>(),
    featureCodeByCode: new Map<string, SupplementaryRecord>(),
  };

  if (!entries || entries.length === 0 || !fs.existsSync(SUPPLEMENTARY_DIR)) {
    return lookups;
  }

  for (const entry of entries) {
    const fileName = path.basename(entry.path || entry.name);
    const filePath = path.resolve(SUPPLEMENTARY_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      issues.push({
        type: "supplementary_file_missing",
        severity: "warning",
        message: `Supplementary file listed in index but not found: ${fileName}`,
      });
      continue;
    }

    try {
      if (fileName === "countryInfo.txt") {
        const rows = parseSupplementaryTable(filePath, entry.columns, "\t", true);
        for (const row of rows) {
          const code = normalizeCell(row.iso_alpha2);
          const label = normalizeCell(row.country);
          if (!code || !label) continue;
          lookups.countryByCode.set(code.toLowerCase(), {
            key: code,
            label,
            geonameid: normalizeCell(row.geonameid) || undefined,
            raw: row,
          });
        }
      } else if (fileName === "admin1CodesASCII.txt") {
        const rows = parseSupplementaryTable(filePath, entry.columns, "\t", false);
        for (const row of rows) {
          const key = normalizeCell(row.code);
          const label = normalizeCell(row.name);
          if (!key || !label) continue;
          lookups.admin1ByCode.set(key.toLowerCase(), {
            key,
            label,
            geonameid: normalizeCell(row.geonameid) || undefined,
            raw: row,
          });
        }
      } else if (fileName === "featureCodes_en.txt") {
        const rows = parseSupplementaryTable(filePath, entry.columns, "\t", false);
        for (const row of rows) {
          const key = normalizeCell(row.code);
          const label = normalizeCell(row.name || row.description);
          if (!key || !label) continue;
          const record: SupplementaryRecord = {
            key,
            label,
            raw: row,
          };
          lookups.featureCodeByCode.set(key.toLowerCase(), record);
          const shortCode = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
          if (!lookups.featureCodeByCode.has(shortCode.toLowerCase())) {
            lookups.featureCodeByCode.set(shortCode.toLowerCase(), record);
          }
        }
      } else {
        continue;
      }

      lookups.filesLoaded.push(fileName);
    } catch (error) {
      issues.push({
        type: "supplementary_file_parse_error",
        severity: "warning",
        message: `Failed to parse supplementary file ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return lookups;
}

function escapeCypherLabel(label: string): string {
  return `\`${label.replace(/`/g, "``")}\``;
}

function propertyMapToCypher(properties: Record<string, Primitive>): string {
  const entries = Object.entries(properties).map(([key, value]) => {
    if (typeof value === "number") return `${key}: ${Number.isFinite(value) ? value : 0}`;
    if (typeof value === "boolean") return `${key}: ${value ? "true" : "false"}`;
    return `${key}: '${escapeCypherString(String(value))}'`;
  });
  return `{${entries.join(", ")}}`;
}

function nodeToCypher(node: GraphNode): string {
  const label = escapeCypherLabel(node.labels[0]);
  const properties = { id: node.id, ...node.properties };
  return `MERGE (n:${label} {id: '${escapeCypherString(node.id)}'}) SET n += ${propertyMapToCypher(properties)};`;
}

function relationshipToCypher(relationship: GraphRelationship, sourceLabel: string, targetLabel: string): string {
  const relType = escapeCypherLabel(getLocalName(relationship.type));
  const source = escapeCypherLabel(sourceLabel);
  const target = escapeCypherLabel(targetLabel);
  const propertySet = Object.keys(relationship.properties).length > 0
    ? ` SET r += ${propertyMapToCypher(relationship.properties)}`
    : "";

  return `MATCH (a:${source} {id: '${escapeCypherString(relationship.from)}'}) MATCH (b:${target} {id: '${escapeCypherString(relationship.to)}'}) MERGE (a)-[r:${relType}]->(b)${propertySet};`;
}

function propertyToTurtleLiteral(value: Primitive, datatype: string, namespaces: Record<string, string>): string {
  if (typeof value === "number") {
    const resolved = datatype ? resolvePrefixedValue(datatype, namespaces) : "http://www.w3.org/2001/XMLSchema#decimal";
    return `"${value}"^^${toTurtleTerm(resolved, namespaces)}`;
  }

  if (typeof value === "boolean") {
    return `"${value ? "true" : "false"}"^^xsd:boolean`;
  }

  const resolved = datatype ? resolvePrefixedValue(datatype, namespaces) : "";
  if (resolved) {
    return `"${escapeTurtleString(value)}"^^${toTurtleTerm(resolved, namespaces)}`;
  }

  return `"${escapeTurtleString(value)}"`;
}

function writeNodeTurtle(
  stream: fs.WriteStream,
  node: GraphNode,
  classUri: string,
  namespaces: Record<string, string>,
  propertyUriByKey: Map<string, string>,
  datatypeByPropertyUri: Map<string, string>,
): void {
  const subject = `<${node.id}>`;
  const lines: string[] = [`${subject} a ${toTurtleTerm(classUri, namespaces)}`];

  for (const [propertyKey, value] of Object.entries(node.properties)) {
    const propertyUri = propertyUriByKey.get(propertyKey) || propertyKey;
    const datatype = datatypeByPropertyUri.get(propertyUri) || "";
    lines.push(`  ; ${toTurtleTerm(propertyUri, namespaces)} ${propertyToTurtleLiteral(value, datatype, namespaces)}`);
  }

  stream.write(`${lines.join("\n")} .\n`);
}

async function streamNdjsonArray<T>(
  output: fs.WriteStream,
  filePath: string,
  transform: (line: string) => T,
): Promise<void> {
  if (!fs.existsSync(filePath)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";
    let first = true;

    input.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const item = transform(line);
        output.write(`${first ? "" : ",\n"}${JSON.stringify(item)}`);
        first = false;
      }
    });

    input.on("end", () => {
      if (buffer.trim()) {
        const item = transform(buffer);
        output.write(`${first ? "" : ",\n"}${JSON.stringify(item)}`);
      }
      resolve();
    });

    input.on("error", reject);
  });
}

async function main(): Promise<void> {
  ensureDir(OUTPUT_DIR);

  for (const requiredFile of [INPUT_CSV, MAPPING_PATH, ONTOLOGY_PATH, GUIDE_PATH]) {
    if (!fs.existsSync(requiredFile)) {
      throw new Error(`Required file not found: ${requiredFile}`);
    }
  }

  const ontology = readJsonFile<OntologyStructure>(ONTOLOGY_PATH);
  const mapping = readJsonFile<MappingStrategy>(MAPPING_PATH);
  const guide = readJsonFile<MappingGuide>(GUIDE_PATH);
  const supplementaryIndex = readOptionalJsonFile<SupplementaryIndexEntry[]>(SUPPLEMENTARY_INDEX_PATH);

  const ontologyIndex = buildOntologyIndex(ontology);
  const issues: ValidationIssue[] = [];
  const complianceScore = Number(mapping.metadata.complianceScore || 0);
  const graphMarkedCompliant = complianceScore >= 80;

  if (Number.isNaN(complianceScore)) {
    throw new Error("mapping-strategy.json contains a non-numeric complianceScore");
  }

  if (complianceScore < 80) {
    const severity: ValidationIssue["severity"] = complianceScore < 60 ? "error" : "warning";
    issues.push({
      type: "mapping_compliance_score",
      severity,
      message: `mapping-strategy.json complianceScore is ${complianceScore}; expected at least 80 to proceed normally`,
    });
  }

  for (const warning of mapping.metadata.warnings || []) {
    issues.push({
      type: "mapping_warning",
      severity: "warning",
      message: warning,
    });
  }

  for (const unmapped of mapping.unmappedColumns) {
    issues.push({
      type: "mapping_unmapped_column",
      severity: unmapped.severity,
      message: `${unmapped.columnName}: ${unmapped.reason}`,
      example: { suggestion: unmapped.suggestion },
    });
  }

  if (complianceScore < 60) {
    fs.writeFileSync(
      OUTPUT_ERRORS_PATH,
      JSON.stringify(
        {
          metadata: {
            generatedAt: new Date().toISOString(),
            status: "stopped",
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
    return;
  }

  const compliantEntities = mapping.entityMappings.filter((entry) => entry.compliant);
  const compliantAttributes = mapping.attributeMappings.filter((entry) => entry.compliant);
  const compliantRelationships = mapping.relationshipMappings.filter((entry) => entry.compliant);

  const runtimeEntities = new Map<string, EntityRuntime>();
  const runtimeAttributesByEntity = new Map<string, AttributeRuntime[]>();
  const runtimeRelationships: RelationshipRuntime[] = [];
  const propertyUriByKey = new Map<string, string>();
  const datatypeByPropertyKey = new Map<string, string>();

  for (const entry of compliantEntities) {
    if (!isNamespaceAllowed(entry.ontologyClass, ontologyIndex, guide)) {
      issues.push({
        type: "invalid_class_namespace",
        severity: "error",
        message: `Entity mapping class namespace is not allowed: ${entry.ontologyClass}`,
      });
      continue;
    }

    const classInfo = ontologyIndex.classByUri.get(entry.ontologyClass);
    if (!classInfo) {
      issues.push({
        type: "invalid_entity_class",
        severity: "error",
        message: `Entity mapping references unknown class ${entry.ontologyClass}`,
      });
      continue;
    }

    runtimeEntities.set(entry.ontologyClass, {
      mapping: entry,
      classInfo,
      label: classInfo.label,
    });
  }

  for (const entry of compliantAttributes) {
    if (!isNamespaceAllowed(entry.ontologyProperty, ontologyIndex, guide)) {
      issues.push({
        type: "invalid_property_namespace",
        severity: "error",
        message: `Attribute mapping property namespace is not allowed: ${entry.ontologyProperty}`,
      });
      continue;
    }

    const propertyInfo = ontologyIndex.dataPropertyByUri.get(entry.ontologyProperty);
    if (!propertyInfo) {
      issues.push({
        type: "invalid_attribute_property",
        severity: "error",
        message: `Attribute mapping references property absent from ontology-structure.json: ${entry.ontologyProperty}`,
        example: {
          columnName: entry.columnName,
          targetEntity: entry.targetEntity,
        },
      });
      continue;
    }

    if (!runtimeEntities.has(entry.targetEntity)) {
      issues.push({
        type: "invalid_attribute_target",
        severity: "error",
        message: `Attribute mapping targets entity class not admitted for generation: ${entry.targetEntity}`,
        example: { columnName: entry.columnName },
      });
      continue;
    }

    const propertyKey = getLocalName(entry.ontologyProperty);
    const list = runtimeAttributesByEntity.get(entry.targetEntity) || [];
    list.push({
      mapping: entry,
      propertyInfo,
      propertyKey,
    });
    runtimeAttributesByEntity.set(entry.targetEntity, list);
    propertyUriByKey.set(propertyKey, entry.ontologyProperty);
    datatypeByPropertyKey.set(entry.ontologyProperty, entry.datatype);
  }

  for (const entry of compliantRelationships) {
    if (!isNamespaceAllowed(entry.ontologyRelationship, ontologyIndex, guide)) {
      issues.push({
        type: "invalid_relationship_namespace",
        severity: "error",
        message: `Relationship mapping property namespace is not allowed: ${entry.ontologyRelationship}`,
      });
      continue;
    }

    const propertyInfo = ontologyIndex.objectPropertyByUri.get(entry.ontologyRelationship);
    if (!propertyInfo) {
      issues.push({
        type: "invalid_relationship_property",
        severity: "error",
        message: `Relationship mapping references property absent from ontology-structure.json: ${entry.ontologyRelationship}`,
        example: {
          columnName: entry.columnName,
          sourceEntity: entry.sourceEntity,
          targetEntity: entry.targetEntity,
        },
      });
      continue;
    }

    if (!runtimeEntities.has(entry.sourceEntity) || !runtimeEntities.has(entry.targetEntity)) {
      issues.push({
        type: "invalid_relationship_endpoints",
        severity: "error",
        message: `Relationship mapping endpoints are not both available for generation: ${entry.ontologyRelationship}`,
      });
      continue;
    }

    runtimeRelationships.push({
      mapping: entry,
      propertyInfo,
      typeKey: getLocalName(entry.ontologyRelationship),
    });
  }

  const supplementaryLookups = buildSupplementaryLookups(supplementaryIndex, issues);
  const featureRuntime = runtimeEntities.get("http://www.opengis.net/ont/geosparql#Feature");
  const geometryRuntime = runtimeEntities.get("http://www.opengis.net/ont/geosparql#Geometry");

  const unmappedConfigured = new Set(mapping.unmappedColumns.map((entry) => entry.columnName));
  const unmappedObserved = new Map<string, { nonEmptyCount: number; examples: string[] }>();
  const nodeIdSet = new Set<string>();
  const relationshipIdSet = new Set<string>();
  const nodeClassById = new Map<string, string>();
  const nodeLabelById = new Map<string, string>();
  const nodesByType: Record<string, number> = {};
  const relationshipsByType: Record<string, number> = {};
  const violationsByType: Record<string, number> = {};
  const nodeIssueIds = new Set<string>();
  const relationshipIssueIds = new Set<string>();
  const usedLabels = new Set<string>();

  let validNodes = 0;
  let invalidNodes = 0;
  let validRelationships = 0;
  let invalidRelationships = 0;
  let totalRows = 0;
  let nonEmptyCellCount = 0;
  let unmappedNonEmptyCellCount = 0;
  let referenceNodesCreated = 0;
  let enrichmentRelationshipsCreated = 0;

  const recordIssue = (issue: ValidationIssue): void => {
    violationsByType[issue.type] = (violationsByType[issue.type] || 0) + 1;

    if (issue.entityId) {
      nodeIssueIds.add(issue.entityId);
    }
    if (issue.relationshipId) {
      relationshipIssueIds.add(issue.relationshipId);
    }

    if (issues.length < MAX_ISSUES) {
      issues.push(issue);
    }
  };

  const nodeStream = fs.createWriteStream(TEMP_NODES_PATH, { encoding: "utf8" });
  const relationshipStream = fs.createWriteStream(TEMP_RELATIONSHIPS_PATH, { encoding: "utf8" });
  const cypherStream = fs.createWriteStream(OUTPUT_CYPHER_PATH, { encoding: "utf8" });
  const ttlStream = fs.createWriteStream(OUTPUT_TTL_PATH, { encoding: "utf8" });

  const writeNode = (node: GraphNode, classUri: string): boolean => {
    if (nodeIdSet.has(node.id)) {
      return false;
    }

    nodeIdSet.add(node.id);
    nodeClassById.set(node.id, classUri);
    nodeLabelById.set(node.id, node.labels[0]);
    nodesByType[node.labels[0]] = (nodesByType[node.labels[0]] || 0) + 1;
    usedLabels.add(node.labels[0]);
    validNodes += 1;

    nodeStream.write(`${JSON.stringify(node)}\n`);
    cypherStream.write(`${nodeToCypher(node)}\n`);
    writeNodeTurtle(ttlStream, node, classUri, ontologyIndex.namespaces, propertyUriByKey, datatypeByPropertyKey);
    return true;
  };

  const writeRelationship = (relationship: GraphRelationship, sourceClassUri: string, targetClassUri: string): boolean => {
    const validation = validateRelationship(relationship.type, sourceClassUri, targetClassUri, ontologyIndex);
    if (!validation.valid) {
      invalidRelationships += 1;
      recordIssue({
        type: "invalid_relationship",
        severity: "error",
        message: validation.message || "Relationship validation failed",
        relationshipId: relationship.id,
        example: {
          from: relationship.from,
          to: relationship.to,
        },
      });
      return false;
    }

    if (relationshipIdSet.has(relationship.id)) {
      return false;
    }

    const sourceLabel = nodeLabelById.get(relationship.from);
    const targetLabel = nodeLabelById.get(relationship.to);
    if (!sourceLabel || !targetLabel) {
      invalidRelationships += 1;
      recordIssue({
        type: "dangling_relationship",
        severity: "warning",
        message: `Relationship ${relationship.id} references a node that was not admitted to the graph`,
        relationshipId: relationship.id,
      });
      return false;
    }

    relationshipIdSet.add(relationship.id);
    relationshipsByType[relationship.type] = (relationshipsByType[relationship.type] || 0) + 1;
    validRelationships += 1;

    relationshipStream.write(`${JSON.stringify(relationship)}\n`);
    cypherStream.write(`${relationshipToCypher(relationship, sourceLabel, targetLabel)}\n`);
    ttlStream.write(
      `<${relationship.from}> ${toTurtleTerm(relationship.type, ontologyIndex.namespaces)} <${relationship.to}> .\n`,
    );
    return true;
  };

  cypherStream.write(`// Auto-generated on ${new Date().toISOString()}\n`);
  cypherStream.write(`// Ontology: ${ontology.metadata.title} v${ontology.metadata.version}\n\n`);
  ttlStream.write(`# Auto-generated on ${new Date().toISOString()}\n`);
  for (const [prefix, namespace] of Object.entries(ontologyIndex.namespaces)) {
    ttlStream.write(`@prefix ${prefix}: <${namespace}> .\n`);
  }
  ttlStream.write(`@prefix data: <${BASE_URI}> .\n\n`);

  const ensureReferenceFeatureNode = (
    identifier: string,
    sourceRow: number,
    confidence: number,
    enriched: boolean,
  ): string | null => {
    if (!featureRuntime) {
      return null;
    }

    const nodeId = generateStableURI(featureRuntime.label, identifier);
    if (!nodeIdSet.has(nodeId)) {
      const node: GraphNode = {
        id: nodeId,
        labels: [featureRuntime.label],
        properties: {},
        _meta: {
          sourceRow,
          confidence,
          compliant: graphMarkedCompliant,
          enriched,
        },
      };

      const inserted = writeNode(node, featureRuntime.mapping.ontologyClass);
      if (inserted && enriched) {
        referenceNodesCreated += 1;
      }
    }

    return nodeId;
  };

  const hasGeometryRelationship = runtimeRelationships.find(
    (entry) => entry.mapping.ontologyRelationship === "http://www.opengis.net/ont/geosparql#hasGeometry",
  );
  const withinRelationships = runtimeRelationships.filter(
    (entry) => entry.mapping.ontologyRelationship === "http://www.opengis.net/ont/geosparql#sfWithin",
  );

  await new Promise<void>((resolve, reject) => {
    const parser = parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    parser.on("readable", () => {
      let row: CsvRow | null;
      while ((row = parser.read() as CsvRow | null) !== null) {
        totalRows += 1;
        const rowIndex = totalRows;

        for (const [columnName, rawValue] of Object.entries(row)) {
          const value = normalizeCell(rawValue);
          if (!value) continue;

          nonEmptyCellCount += 1;
          if (unmappedConfigured.has(columnName)) {
            unmappedNonEmptyCellCount += 1;
            const bucket = unmappedObserved.get(columnName) || { nonEmptyCount: 0, examples: [] };
            bucket.nonEmptyCount += 1;
            addExample(bucket.examples, value);
            unmappedObserved.set(columnName, bucket);
          }
        }

        const entityIdByClass = new Map<string, string>();

        for (const entityRuntime of Array.from(runtimeEntities.values())) {
          const identifierValue = normalizeCell(row[entityRuntime.mapping.identifierColumn]);
          if (!identifierValue) {
            continue;
          }

          const nodeId = generateStableURI(entityRuntime.label, identifierValue);
          entityIdByClass.set(entityRuntime.mapping.ontologyClass, nodeId);

          if (nodeIdSet.has(nodeId)) {
            continue;
          }

          const properties: Record<string, Primitive> = {};
          let isInvalid = false;

          for (const attributeRuntime of runtimeAttributesByEntity.get(entityRuntime.mapping.ontologyClass) || []) {
            let rawValue = "";

            if (attributeRuntime.mapping.columnName === "latitude+longitude") {
              const latitude = normalizeCell(row.latitude);
              const longitude = normalizeCell(row.longitude);
              if (!latitude || !longitude) {
                continue;
              }

              if (attributeRuntime.mapping.ontologyProperty === "http://www.opengis.net/ont/geosparql#asWKT") {
                rawValue = `POINT(${longitude} ${latitude})`;
              } else if (attributeRuntime.mapping.ontologyProperty === "http://www.opengis.net/ont/geosparql#coordinateDimension") {
                rawValue = "2";
              }
            } else {
              rawValue = normalizeCell(row[attributeRuntime.mapping.columnName]);
            }

            if (!rawValue) {
              continue;
            }

            if (attributeRuntime.mapping.columnName === "dem" && rawValue === "-9999") {
              continue;
            }

            if (attributeRuntime.mapping.columnName === "country_code") {
              const enriched = supplementaryLookups.countryByCode.get(rawValue.toLowerCase());
              if (enriched) {
                rawValue = enriched.label;
              }
            } else if (attributeRuntime.mapping.columnName === "admin1_code") {
              const countryCode = normalizeCell(row.country_code);
              const adminKey = countryCode ? `${countryCode}.${rawValue}` : rawValue;
              const enriched = supplementaryLookups.admin1ByCode.get(adminKey.toLowerCase());
              if (enriched) {
                rawValue = enriched.label;
              }
            } else if (attributeRuntime.mapping.columnName === "feature_code") {
              const enriched = supplementaryLookups.featureCodeByCode.get(rawValue.toLowerCase());
              if (enriched) {
                rawValue = enriched.label;
              }
            }

            const validation = validateNodeProperty(
              entityRuntime.mapping.ontologyClass,
              attributeRuntime.mapping.ontologyProperty,
              rawValue,
              attributeRuntime.mapping.datatype,
              ontologyIndex,
            );

            if (!validation.valid) {
              isInvalid = true;
              invalidNodes += 1;
              recordIssue({
                type: "invalid_node_property",
                severity: "error",
                message: validation.message || "Node property validation failed",
                rowIndex,
                entityId: nodeId,
                example: {
                  columnName: attributeRuntime.mapping.columnName,
                  value: rawValue,
                },
              });
              break;
            }

            properties[attributeRuntime.propertyKey] = coerceValue(rawValue, attributeRuntime.mapping.datatype);
          }

          if (isInvalid) {
            continue;
          }

          const node: GraphNode = {
            id: nodeId,
            labels: [entityRuntime.label],
            properties,
            _meta: {
              sourceRow: rowIndex,
              confidence: entityRuntime.mapping.confidence,
              compliant: graphMarkedCompliant,
            },
          };

          writeNode(node, entityRuntime.mapping.ontologyClass);
        }

        if (featureRuntime && geometryRuntime && hasGeometryRelationship) {
          const featureId = entityIdByClass.get(featureRuntime.mapping.ontologyClass);
          const geometryId = entityIdByClass.get(geometryRuntime.mapping.ontologyClass);
          const latitude = normalizeCell(row.latitude);
          const longitude = normalizeCell(row.longitude);

          if (featureId && geometryId && latitude && longitude && nodeIdSet.has(featureId) && nodeIdSet.has(geometryId)) {
            const relationship: GraphRelationship = {
              id: generateRelationshipURI(featureId, hasGeometryRelationship.mapping.ontologyRelationship, geometryId),
              type: hasGeometryRelationship.mapping.ontologyRelationship,
              from: featureId,
              to: geometryId,
              properties: {},
              _meta: {
                confidence: hasGeometryRelationship.mapping.confidence,
                compliant: graphMarkedCompliant,
                sourceRow: rowIndex,
              },
            };

            writeRelationship(
              relationship,
              featureRuntime.mapping.ontologyClass,
              geometryRuntime.mapping.ontologyClass,
            );
          }
        }

        if (featureRuntime) {
          const featureId = entityIdByClass.get(featureRuntime.mapping.ontologyClass);
          if (!featureId || !nodeIdSet.has(featureId)) {
            continue;
          }

          for (const relationshipRuntime of withinRelationships) {
            if (relationshipRuntime.mapping.columnName === "country_code") {
              const code = normalizeCell(row.country_code);
              if (!code) continue;

              const countryNodeId = ensureReferenceFeatureNode(`country-${code}`, rowIndex, relationshipRuntime.mapping.confidence, true);
              if (!countryNodeId) continue;

              const relationship: GraphRelationship = {
                id: generateRelationshipURI(featureId, relationshipRuntime.mapping.ontologyRelationship, countryNodeId),
                type: relationshipRuntime.mapping.ontologyRelationship,
                from: featureId,
                to: countryNodeId,
                properties: {},
                _meta: {
                  confidence: relationshipRuntime.mapping.confidence,
                  compliant: graphMarkedCompliant,
                  sourceRow: rowIndex,
                  enriched: true,
                },
              };

              const inserted = writeRelationship(
                relationship,
                featureRuntime.mapping.ontologyClass,
                featureRuntime.mapping.ontologyClass,
              );
              if (inserted) {
                enrichmentRelationshipsCreated += 1;
              }
            }

            if (relationshipRuntime.mapping.columnName === "admin1_code") {
              const countryCode = normalizeCell(row.country_code);
              const adminCode = normalizeCell(row.admin1_code);
              if (!countryCode || !adminCode) continue;

              const adminNodeId = ensureReferenceFeatureNode(
                `admin1-${countryCode}.${adminCode}`,
                rowIndex,
                relationshipRuntime.mapping.confidence,
                true,
              );
              if (!adminNodeId) continue;

              const relationship: GraphRelationship = {
                id: generateRelationshipURI(featureId, relationshipRuntime.mapping.ontologyRelationship, adminNodeId),
                type: relationshipRuntime.mapping.ontologyRelationship,
                from: featureId,
                to: adminNodeId,
                properties: {},
                _meta: {
                  confidence: relationshipRuntime.mapping.confidence,
                  compliant: graphMarkedCompliant,
                  sourceRow: rowIndex,
                  enriched: true,
                },
              };

              const inserted = writeRelationship(
                relationship,
                featureRuntime.mapping.ontologyClass,
                featureRuntime.mapping.ontologyClass,
              );
              if (inserted) {
                enrichmentRelationshipsCreated += 1;
              }

              const countryNodeId = ensureReferenceFeatureNode(
                `country-${countryCode}`,
                rowIndex,
                relationshipRuntime.mapping.confidence,
                true,
              );
              if (!countryNodeId) continue;

              const hierarchyRelationship: GraphRelationship = {
                id: generateRelationshipURI(adminNodeId, relationshipRuntime.mapping.ontologyRelationship, countryNodeId),
                type: relationshipRuntime.mapping.ontologyRelationship,
                from: adminNodeId,
                to: countryNodeId,
                properties: {},
                _meta: {
                  confidence: relationshipRuntime.mapping.confidence,
                  compliant: graphMarkedCompliant,
                  sourceRow: rowIndex,
                  enriched: true,
                },
              };

              const insertedHierarchy = writeRelationship(
                hierarchyRelationship,
                featureRuntime.mapping.ontologyClass,
                featureRuntime.mapping.ontologyClass,
              );
              if (insertedHierarchy) {
                enrichmentRelationshipsCreated += 1;
              }
            }
          }
        }
      }
    });

    parser.on("error", reject);
    parser.on("end", () => resolve());

    fs.createReadStream(INPUT_CSV, { encoding: "utf8" }).on("error", reject).pipe(parser);
  });

  await closeStream(nodeStream);
  await closeStream(relationshipStream);
  await closeStream(cypherStream);
  await closeStream(ttlStream);

  const constraintLines = Array.from(usedLabels)
    .sort()
    .map((label) => `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${escapeCypherLabel(label)}) REQUIRE n.id IS UNIQUE;`)
    .join("\n");

  const existingCypher = fs.readFileSync(OUTPUT_CYPHER_PATH, "utf8");
  fs.writeFileSync(OUTPUT_CYPHER_PATH, `${existingCypher.split("\n\n")[0]}\n\n${constraintLines}\n\n${existingCypher.slice(existingCypher.indexOf("\n\n") + 2)}`, "utf8");

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const graphValidationCompliant = graphMarkedCompliant && errorCount === 0;

  const outputGraph: Omit<OutputGraph, "nodes" | "relationships"> = {
    metadata: {
      generatedAt: new Date().toISOString(),
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      complianceScore,
      validation: {
        compliant: graphValidationCompliant,
        errors: errorCount,
        warnings: warningCount,
      },
    },
    statistics: {
      totalNodes: validNodes,
      nodesByType,
      totalRelationships: validRelationships,
      relationshipsByType,
    },
  };

  const graphWriteStream = fs.createWriteStream(OUTPUT_GRAPH_PATH, { encoding: "utf8" });
  graphWriteStream.write("{\n");
  graphWriteStream.write(`  "metadata": ${JSON.stringify(outputGraph.metadata, null, 2).replace(/\n/g, "\n  ")},\n`);
  graphWriteStream.write('  "nodes": [\n');
  await streamNdjsonArray(graphWriteStream, TEMP_NODES_PATH, (line) => JSON.parse(line) as GraphNode);
  graphWriteStream.write("\n  ],\n");
  graphWriteStream.write('  "relationships": [\n');
  await streamNdjsonArray(graphWriteStream, TEMP_RELATIONSHIPS_PATH, (line) => JSON.parse(line) as GraphRelationship);
  graphWriteStream.write(`\n  ],\n  "statistics": ${JSON.stringify(outputGraph.statistics, null, 2).replace(/\n/g, "\n  ")}\n`);
  graphWriteStream.write("}\n");
  await closeStream(graphWriteStream);

  const totalPossibleRelationships = validNodes <= 1 ? 0 : validNodes * (validNodes - 1);
  const issueSummaryMap = new Map<string, { severity: "error" | "warning" | "info"; count: number; examples: string[] }>();

  for (const issue of issues) {
    const existing = issueSummaryMap.get(issue.type) || { severity: issue.severity, count: 0, examples: [] };
    existing.count += 1;
    addExample(existing.examples, issue.message);
    issueSummaryMap.set(issue.type, existing);
  }

  const stats: GraphStats & {
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
  } = {
    summary: {
      totalNodes: validNodes,
      totalRelationships: validRelationships,
      avgDegree: validNodes === 0 ? 0 : Number(((validRelationships * 2) / validNodes).toFixed(4)),
      density: totalPossibleRelationships === 0 ? 0 : Number((validRelationships / totalPossibleRelationships).toFixed(8)),
    },
    nodeStatistics: {
      byType: nodesByType,
      withIssues: nodeIssueIds.size,
      compliant: Math.max(validNodes - nodeIssueIds.size, 0),
    },
    relationshipStatistics: {
      byType: relationshipsByType,
      withIssues: relationshipIssueIds.size,
      compliant: Math.max(validRelationships - relationshipIssueIds.size, 0),
    },
    complianceMetrics: {
      overallScore: complianceScore,
      validNodesPercent: formatPercent(validNodes, validNodes + invalidNodes),
      validRelationshipsPercent: formatPercent(validRelationships, validRelationships + invalidRelationships),
      unmappedDataPercent: formatPercent(unmappedNonEmptyCellCount, nonEmptyCellCount),
    },
    issues: Array.from(issueSummaryMap.entries()).map(([type, detail]) => ({
      type,
      severity: detail.severity,
      count: detail.count,
      examples: detail.examples,
    })),
    validationMetrics: {
      validNodes,
      invalidNodes,
      validRelationships,
      invalidRelationships,
      violationsByType,
    },
    unmappedColumns: {
      count: mapping.unmappedColumns.length,
      configured: mapping.unmappedColumns.map((entry) => entry.columnName),
      encounteredValues: Object.fromEntries(Array.from(unmappedObserved.entries())),
    },
    supplementary: {
      indexFound: fs.existsSync(SUPPLEMENTARY_INDEX_PATH),
      filesLoaded: supplementaryLookups.filesLoaded,
      referenceNodesCreated,
      enrichmentRelationshipsCreated,
    },
  };

  fs.writeFileSync(OUTPUT_STATS_PATH, JSON.stringify(stats, null, 2), "utf8");

  if (issues.length > 0) {
    fs.writeFileSync(
      OUTPUT_ERRORS_PATH,
      JSON.stringify(
        {
          metadata: {
            generatedAt: new Date().toISOString(),
            ontologyName: ontology.metadata.title,
            ontologyVersion: ontology.metadata.version,
            complianceScore,
            graphCompliant: graphValidationCompliant,
          },
          issues,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (fs.existsSync(TEMP_NODES_PATH)) fs.unlinkSync(TEMP_NODES_PATH);
  if (fs.existsSync(TEMP_RELATIONSHIPS_PATH)) fs.unlinkSync(TEMP_RELATIONSHIPS_PATH);

  console.log(`Compliance score: ${complianceScore}`);
  if (complianceScore < 80) {
    console.warn("Compliance warnings:");
    for (const issue of issues.filter((entry) => entry.type.startsWith("mapping_") || entry.type.startsWith("invalid_"))) {
      console.warn(`- [${issue.severity}] ${issue.message}`);
    }
  }
  console.log("Node counts by type:");
  for (const [type, count] of Object.entries(nodesByType)) {
    console.log(`- ${type}: ${count}`);
  }
  console.log("Relationship counts by type:");
  for (const [type, count] of Object.entries(relationshipsByType)) {
    console.log(`- ${getLocalName(type)}: ${count}`);
  }
  console.log(
    `Validation: nodes ${formatPercent(validNodes, validNodes + invalidNodes)}% valid (${validNodes}/${validNodes + invalidNodes}), ` +
      `relationships ${formatPercent(validRelationships, validRelationships + invalidRelationships)}% valid (${validRelationships}/${validRelationships + invalidRelationships})`,
  );
  console.log(`Unmapped columns configured: ${mapping.unmappedColumns.length}`);
  console.log("Output files:");
  console.log(`- ${OUTPUT_GRAPH_PATH}`);
  console.log(`- ${OUTPUT_CYPHER_PATH}`);
  console.log(`- ${OUTPUT_TTL_PATH}`);
  console.log(`- ${OUTPUT_STATS_PATH}`);
  if (issues.length > 0) {
    console.log(`- ${OUTPUT_ERRORS_PATH}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
