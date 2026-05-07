import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";

type PrimitiveType = "string" | "integer" | "float" | "date" | "boolean" | "url" | "mixed";

interface ColumnProfile {
  name: string;
  inferredType: PrimitiveType;
  nonMissingCount?: number;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  relatedSupplementaryFile?: string;
  supplementaryContext?: string;
}

interface DatasetProfile {
  datasetPath: string;
  totalRows: number;
  totalColumns: number;
  generatedAt: string;
  supplementaryIndexPath?: string;
  supplementaryFilesLoaded?: boolean;
  supplementaryFilesInspected?: string[];
  columns: ColumnProfile[];
}

interface OntologyClass {
  uri: string;
  label: string;
  definition?: string;
  comment?: string;
  superClasses?: string[];
  equivalentClasses?: string[];
  examples?: string[];
}

interface ObjectProperty {
  uri: string;
  label: string;
  definition?: string;
  domain?: string[];
  range?: string[];
  superProperties?: string[];
  inverseOf?: string;
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
    sourceFiles?: string[];
    namespaces: Record<string, string>;
  };
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
  annotationProperties?: Array<{ uri: string; label: string }>;
}

interface MappingGuidePattern {
  scenario: string;
  ontologyClass: string;
  requiredProperties: string[];
  optionalProperties: string[];
  relationships: string[];
}

interface MappingGuide {
  commonPatterns?: MappingGuidePattern[];
  allowedNamespaces?: string[];
  constraints?: string[];
}

interface SupplementaryFileInfo {
  path?: string;
  name?: string;
  fileName?: string;
  format?: string;
  description?: string;
  columns?: string[];
  rowCount?: number;
}

interface SupplementaryLookup {
  fileName: string;
  filePath: string;
  format: string;
  description: string;
  columns: string[];
  normalizedValues: Set<string>;
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
  propertyType: "data" | "annotation";
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
  severity: "warning" | "info";
}

interface ValidationReport {
  classesUsed: string[];
  propertiesUsed: string[];
  namespacesUsed: string[];
  customTermsDetected: string[];
  recommendations: string[];
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
    warnings: string[];
  };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
  unmappedColumns: UnmappedColumn[];
  validationReport: ValidationReport;
}

interface ComplianceReport {
  metadata: MappingStrategy["metadata"];
  validationReport: ValidationReport;
  lowConfidenceMappings: Array<{
    type: "entity" | "attribute" | "relationship";
    columnName: string;
    ontologyTerm: string;
    confidence: number;
    reason: string;
  }>;
  invalidMappings: Array<{
    type: "entity" | "attribute" | "relationship";
    columnName: string;
    ontologyTerm: string;
    reason: string;
  }>;
  unmappedColumns: UnmappedColumn[];
}

interface Context {
  ontology: OntologyStructure;
  guide: MappingGuide;
  namespaces: Record<string, string>;
  classByUri: Map<string, OntologyClass>;
  classByRef: Map<string, OntologyClass>;
  objectPropertyByUri: Map<string, ObjectProperty>;
  objectPropertyByRef: Map<string, ObjectProperty>;
  dataPropertyByUri: Map<string, DataProperty>;
  dataPropertyByRef: Map<string, DataProperty>;
  requiredPropertiesByClass: Map<string, string[]>;
  supplementaryLookups: SupplementaryLookup[];
  warnings: string[];
  coreClass: string;
}

interface CandidateReason {
  confidence: number;
  reasoning: string;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/scientific-dblp";
const OUTPUT_DIR = path.resolve(DATA_DIR, "output", "codex");
const SUPPLEMENTARY_DIR = path.resolve(DATA_DIR, "supplementary-files");
const PROFILE_PATH = path.resolve(OUTPUT_DIR, "dataset-profile.json");
const ONTOLOGY_PATH = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const GUIDE_PATH = path.resolve(OUTPUT_DIR, "ontology-mapping-guide.json");
const SUPPLEMENTARY_INDEX_PATH = path.resolve(OUTPUT_DIR, "supplementary-files-index.json");
const STRATEGY_PATH = path.resolve(OUTPUT_DIR, "mapping-strategy.json");
const COMPLIANCE_PATH = path.resolve(OUTPUT_DIR, "mapping-compliance-report.json");

function loadJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function loadOptionalJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function ensureOutputDir(): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function overlaps(tokensA: string[], tokensB: string[]): number {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  let count = 0;
  for (const token of a) {
    if (b.has(token)) {
      count += 1;
    }
  }
  return count;
}

function isIdentifierLike(columnName: string): boolean {
  return /(^|[_\s])(id|identifier|key|ref|reference)([_\s]|$)/i.test(columnName);
}

function isForeignKeyLike(columnName: string): boolean {
  return /(^|[_\s])(crossref|rel|cite|.*_id|.*id)([_\s]|$)/i.test(columnName);
}

function getNonMissingCount(column: ColumnProfile, totalRows: number): number {
  if (typeof column.nonMissingCount === "number") {
    return column.nonMissingCount;
  }

  return Math.max(totalRows - column.missingCount, 0);
}

function getUniqueRatio(column: ColumnProfile, totalRows: number): number {
  const denominator = Math.max(getNonMissingCount(column, totalRows), 1);
  return clamp(column.uniqueCount / denominator, 0, 1);
}

function computeCardinality(column: ColumnProfile, totalRows: number): "high" | "medium" | "low" {
  const ratio = getUniqueRatio(column, totalRows);
  if (ratio > 0.8) return "high";
  if (ratio >= 0.1) return "medium";
  return "low";
}

function toPrefixed(uri: string, namespaces: Record<string, string>): string {
  for (const [prefix, namespace] of Object.entries(namespaces)) {
    if (uri.startsWith(namespace)) {
      return `${prefix}:${uri.slice(namespace.length)}`;
    }
  }

  return uri;
}

function getNamespaceUri(value: string, namespaces: Record<string, string>): string | null {
  if (value.includes(":") && !value.startsWith("http://") && !value.startsWith("https://")) {
    const prefix = value.split(":")[0];
    return namespaces[prefix] || null;
  }

  for (const namespace of Object.values(namespaces)) {
    if (value.startsWith(namespace)) {
      return namespace;
    }
  }

  return null;
}

function buildClassMaps(ontology: OntologyStructure): {
  classByUri: Map<string, OntologyClass>;
  classByRef: Map<string, OntologyClass>;
} {
  const classByUri = new Map<string, OntologyClass>();
  const classByRef = new Map<string, OntologyClass>();

  for (const cls of ontology.classes) {
    const prefixed = toPrefixed(cls.uri, ontology.metadata.namespaces);
    classByUri.set(cls.uri, cls);
    classByRef.set(cls.uri, cls);
    classByRef.set(prefixed, cls);
  }

  return { classByUri, classByRef };
}

function buildPropertyMaps<T extends { uri: string }>(
  properties: T[],
  namespaces: Record<string, string>,
): {
  byUri: Map<string, T>;
  byRef: Map<string, T>;
} {
  const byUri = new Map<string, T>();
  const byRef = new Map<string, T>();

  for (const property of properties) {
    const prefixed = toPrefixed(property.uri, namespaces);
    byUri.set(property.uri, property);
    byRef.set(property.uri, property);
    byRef.set(prefixed, property);
  }

  return { byUri, byRef };
}

function buildRequiredPropertiesByClass(guide: MappingGuide, context: Context): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const pattern of guide.commonPatterns || []) {
    if (!pattern.ontologyClass) {
      continue;
    }
    const validProperties = (pattern.requiredProperties || []).filter(
      (property) => context.dataPropertyByRef.has(property) || context.objectPropertyByRef.has(property),
    );
    result.set(pattern.ontologyClass, validProperties);
  }
  return result;
}

function computeMostConnectedClass(ontology: OntologyStructure, guide: MappingGuide): string {
  const guidePatterns = guide.commonPatterns || [];
  const scoredGuideClasses = guidePatterns
    .map((pattern) => {
      const match = pattern.scenario.match(/\((\d+)\s+ontology links?\)/i);
      return {
        classRef: pattern.ontologyClass,
        score: match ? Number(match[1]) : 0,
        scenario: pattern.scenario,
      };
    })
    .filter((item) => item.classRef && item.score > 0)
    .sort((a, b) => b.score - a.score);

  const bestGuideClass = scoredGuideClasses.find((item) => {
    const lowerScenario = item.scenario.toLowerCase();
    return lowerScenario.includes("core entity") && ontology.classes.some((cls) => toPrefixed(cls.uri, ontology.metadata.namespaces) === item.classRef);
  });

  if (bestGuideClass) {
    return bestGuideClass.classRef;
  }

  const degreeByRef = new Map<string, number>();

  for (const cls of ontology.classes) {
    degreeByRef.set(toPrefixed(cls.uri, ontology.metadata.namespaces), 0);
  }

  for (const property of ontology.objectProperties) {
    for (const domain of property.domain || []) {
      degreeByRef.set(domain, (degreeByRef.get(domain) || 0) + 1);
    }
    for (const range of property.range || []) {
      degreeByRef.set(range, (degreeByRef.get(range) || 0) + 1);
    }
  }

  const sorted = [...degreeByRef.entries()].sort((a, b) => b[1] - a[1]);
  const winner = sorted[0]?.[0];
  if (winner) {
    return winner;
  }

  return ontology.classes[0] ? toPrefixed(ontology.classes[0].uri, ontology.metadata.namespaces) : "";
}

function parseDelimitedRows(text: string, delimiter: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0) {
    return [];
  }

  return result.data
    .filter((row) => row && typeof row === "object")
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [String(key).trim(), String(value ?? "").trim()]),
      ),
    );
}

function parseSupplementaryFile(filePath: string, format: string): Record<string, string>[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const effectiveFormat = (format || ext.replace(/^\./, "")).toLowerCase();

  if (effectiveFormat === "csv") {
    return parseDelimitedRows(text, ",");
  }
  if (effectiveFormat === "tsv" || effectiveFormat === "tab") {
    return parseDelimitedRows(text, "\t");
  }
  if (effectiveFormat === "json") {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) =>
          Object.fromEntries(Object.entries(item).map(([key, value]) => [String(key).trim(), String(value ?? "").trim()])),
        );
    }
  }

  return [];
}

function normalizeSupplementaryIndex(index: unknown): SupplementaryFileInfo[] {
  if (Array.isArray(index)) {
    return index as SupplementaryFileInfo[];
  }

  if (typeof index === "object" && index !== null) {
    const record = index as Record<string, unknown>;
    if (Array.isArray(record.files)) {
      return record.files as SupplementaryFileInfo[];
    }
    if (Array.isArray(record.supplementaryFiles)) {
      return record.supplementaryFiles as SupplementaryFileInfo[];
    }
  }

  return [];
}

function loadSupplementaryLookups(index: unknown, warnings: string[]): SupplementaryLookup[] {
  const files = normalizeSupplementaryIndex(index);
  if (files.length === 0) {
    return [];
  }

  const lookups: SupplementaryLookup[] = [];

  for (const file of files) {
    const name = file.path || file.fileName || file.name;
    if (!name) {
      continue;
    }

    const fileName = path.basename(name);
    const filePath = path.resolve(SUPPLEMENTARY_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      warnings.push(`Supplementary file listed in index but missing on disk: ${fileName}`);
      continue;
    }

    const rows = parseSupplementaryFile(filePath, file.format || "");
    const values = new Set<string>();
    for (const row of rows.slice(0, 3000)) {
      for (const value of Object.values(row)) {
        const normalized = normalizeText(value);
        if (normalized) {
          values.add(normalized);
        }
      }
    }

    lookups.push({
      fileName,
      filePath,
      format: (file.format || path.extname(filePath).replace(/^\./, "") || "unknown").toLowerCase(),
      description: file.description || "",
      columns: file.columns || (rows[0] ? Object.keys(rows[0]) : []),
      normalizedValues: values,
    });
  }

  return lookups;
}

function getSupplementaryHint(column: ColumnProfile, lookups: SupplementaryLookup[]): { score: number; reason: string | null } {
  if (lookups.length === 0) {
    return { score: 0, reason: null };
  }

  const columnTokens = tokenize(column.name);
  const normalizedSamples = column.sampleValues.map(normalizeText).filter(Boolean);
  let bestScore = 0;
  let bestReason: string | null = null;

  for (const lookup of lookups) {
    const lookupTokens = tokenize(`${lookup.fileName} ${lookup.description} ${lookup.columns.join(" ")}`);
    const tokenOverlap = overlaps(columnTokens, lookupTokens);
    const valueOverlap = normalizedSamples.filter((sample) => lookup.normalizedValues.has(sample)).length;
    const valueRatio = normalizedSamples.length === 0 ? 0 : valueOverlap / normalizedSamples.length;
    const score = clamp(tokenOverlap * 0.05 + valueRatio * 0.25, 0, 0.3);

    if (score > bestScore) {
      bestScore = score;
      bestReason = `supplementary lookup ${lookup.fileName} overlaps on column/value semantics`;
    }
  }

  return { score: bestScore, reason: bestReason };
}

function getAncestors(classRef: string, context: Context, visited = new Set<string>()): Set<string> {
  const ancestors = new Set<string>();
  if (visited.has(classRef)) {
    return ancestors;
  }
  visited.add(classRef);

  const cls = context.classByRef.get(classRef);
  if (!cls) {
    return ancestors;
  }

  const prefixed = toPrefixed(cls.uri, context.namespaces);
  ancestors.add(prefixed);

  for (const superClass of cls.superClasses || []) {
    ancestors.add(superClass);
    const nested = getAncestors(superClass, context, visited);
    for (const value of nested) {
      ancestors.add(value);
    }
  }

  return ancestors;
}

function isClassCompatible(classRef: string, allowedRefs: string[] | undefined, context: Context): boolean {
  if (!allowedRefs || allowedRefs.length === 0) {
    return true;
  }
  if (!context.classByRef.has(classRef)) {
    return false;
  }
  const ancestors = getAncestors(classRef, context);
  return allowedRefs.some((allowed) => allowed === classRef || ancestors.has(allowed));
}

function inferDatatype(column: ColumnProfile): string {
  switch (column.inferredType) {
    case "integer":
      return "xsd:integer";
    case "float":
      return "xsd:decimal";
    case "date":
      return "xsd:date";
    case "boolean":
      return "xsd:boolean";
    case "url":
      return "xsd:anyURI";
    default:
      return "xsd:string";
  }
}

function scoreEntityColumn(column: ColumnProfile, context: Context, totalRows: number): CandidateReason | null {
  const supplementaryHint = getSupplementaryHint(column, context.supplementaryLookups);
  const uniqueRatio = getUniqueRatio(column, totalRows);
  const cardinality = computeCardinality(column, totalRows);
  const reasons: string[] = [];

  const columnName = column.name.toLowerCase();
  if (columnName === "record_type") {
    let confidence = 0.96;
    reasons.push("record_type is the dataset-wide type discriminator for DBLP records");
    if (uniqueRatio < 0.1) {
      confidence += 0.02;
      reasons.push("low-cardinality controlled values fit an ontology class discriminator");
    }
    if (supplementaryHint.reason) {
      reasons.push(supplementaryHint.reason);
    }
    return { confidence: round(clamp(confidence + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  if (columnName === "journal") {
    const confidence = 0.89 + supplementaryHint.score;
    reasons.push("column name and sample values clearly denote journal venue entities");
    reasons.push(`cardinality=${cardinality} (${round(uniqueRatio * 100)}% unique) fits reusable venue identifiers`);
    return { confidence: round(clamp(confidence, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  if (columnName === "booktitle") {
    const confidence = 0.76 + supplementaryHint.score;
    reasons.push("booktitle values denote containing bibliographic works such as proceedings, handbooks, and reference books");
    reasons.push("core:Work is the safest superclass because the column mixes multiple containing work types");
    return { confidence: round(clamp(confidence, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  if (columnName === "series") {
    const confidence = 0.84 + supplementaryHint.score;
    reasons.push("series values behave like named publication series reused across many records");
    return { confidence: round(clamp(confidence, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  if (columnName === "stream") {
    const confidence = 0.71 + supplementaryHint.score;
    reasons.push("stream values identify named repository channels such as Zenodo and IEEE DataPort");
    reasons.push("fabio:DataRepository is the closest ontology class available for repository-like sources");
    return { confidence: round(clamp(confidence, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  return null;
}

function scoreAttributeColumn(column: ColumnProfile, propertyRef: string, context: Context): CandidateReason | null {
  const reasons: string[] = [];
  const supplementaryHint = getSupplementaryHint(column, context.supplementaryLookups);
  const name = column.name.toLowerCase();

  if (name === "key" && propertyRef === "dcterms:identifier") {
    reasons.push("DBLP key is the stable primary record identifier");
    return { confidence: round(clamp(0.98 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "title" && propertyRef === "dcterms:title") {
    reasons.push("title column matches the ontology title property directly");
    return { confidence: round(clamp(0.99 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "mdate" && propertyRef === "dcterms:modified") {
    reasons.push("mdate is the DBLP metadata modification date");
    reasons.push("values are date-only strings but can be normalized to a dateTime during downstream export");
    return { confidence: round(clamp(0.82 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "year" && propertyRef === "fabio:hasPublicationYear") {
    reasons.push("four-digit year values align with FaBiO publication year semantics");
    return { confidence: round(clamp(0.96 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "pages" && propertyRef === "ns1:pageRange") {
    reasons.push("pages values are page ranges or single page numbers");
    return { confidence: round(clamp(0.94 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "volume" && propertyRef === "ns1:volume") {
    reasons.push("volume column matches PRISM volume identifier semantics");
    return { confidence: round(clamp(0.95 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "number" && propertyRef === "ns1:issueIdentifier") {
    reasons.push("number commonly carries journal issue identifiers in DBLP");
    reasons.push("column is mixed across record types, so this mapping is valid but not universal");
    return { confidence: round(clamp(0.74 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "chapter" && propertyRef === "fabio:hasSequenceIdentifier") {
    reasons.push("chapter values behave as sequence numbers within a containing work");
    return { confidence: round(clamp(0.81 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "isbn" && propertyRef === "ns1:isbn") {
    reasons.push("ISBN values match the ontology ISBN property directly");
    return { confidence: round(clamp(0.99 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "ee" && propertyRef === "fabio:hasURL") {
    reasons.push("ee contains external electronic edition URLs, mostly DOI landing URLs");
    return { confidence: round(clamp(0.93 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "url" && propertyRef === "fabio:hasURL") {
    reasons.push("url contains DBLP-internal resource URLs");
    return { confidence: round(clamp(0.88 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "publnr" && propertyRef === "fabio:hasSequenceIdentifier") {
    reasons.push("publication number values behave as internal sequence identifiers");
    return { confidence: round(clamp(0.68 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "journal" && propertyRef === "dcterms:title") {
    reasons.push("journal values are the human-readable titles of detected journal entities");
    return { confidence: round(clamp(0.9 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "booktitle" && propertyRef === "dcterms:title") {
    reasons.push("booktitle values are the human-readable titles of containing work entities");
    return { confidence: round(clamp(0.88 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "series" && propertyRef === "dcterms:title") {
    reasons.push("series values act as the canonical names of publication series entities");
    return { confidence: round(clamp(0.9 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "stream" && propertyRef === "dcterms:identifier") {
    reasons.push("stream values are repository-like identifiers rather than display labels");
    return { confidence: round(clamp(0.72 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  return null;
}

function scoreRelationshipColumn(column: ColumnProfile, propertyRef: string, context: Context): CandidateReason | null {
  const reasons: string[] = [];
  const supplementaryHint = getSupplementaryHint(column, context.supplementaryLookups);
  const name = column.name.toLowerCase();

  if (name === "crossref" && propertyRef === "core:partOf") {
    reasons.push("crossref is a foreign-key style reference to a containing DBLP record");
    reasons.push("part-whole containment is the strictest valid FRBR relation available");
    return { confidence: round(clamp(0.9 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "cite" && propertyRef === "core:relatedEndeavour") {
    reasons.push("cite contains lists of cited DBLP record keys");
    reasons.push("relatedEndeavour is the safest valid generic relation because citation-specific properties are absent");
    return { confidence: round(clamp(0.84 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "rel" && propertyRef === "core:relatedEndeavour") {
    reasons.push("rel values look like DBLP record keys pointing to related dataset records");
    return { confidence: round(clamp(0.74 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "journal" && propertyRef === "core:partOf") {
    reasons.push("journal names denote the parent venue that contains a journal article");
    return { confidence: round(clamp(0.82 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "booktitle" && propertyRef === "core:partOf") {
    reasons.push("booktitle identifies the containing work for chapters and proceedings papers");
    return { confidence: round(clamp(0.8 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "series" && propertyRef === "core:partOf") {
    reasons.push("series links a publication to the broader named series it belongs to");
    return { confidence: round(clamp(0.7 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }
  if (name === "stream" && propertyRef === "core:relatedEndeavour") {
    reasons.push("stream ties the record to a repository/release channel rather than a bibliographic container");
    return { confidence: round(clamp(0.66 + supplementaryHint.score, 0, 0.99)), reasoning: reasons.join("; ") };
  }

  if (isForeignKeyLike(column.name)) {
    reasons.push("column name has foreign-key style structure");
  }

  return null;
}

function mapEntities(profile: DatasetProfile, context: Context): EntityMapping[] {
  const mappings: EntityMapping[] = [];
  const requiredForCore = context.requiredPropertiesByClass.get(context.coreClass) || [];

  for (const column of profile.columns) {
    const candidate = scoreEntityColumn(column, context, profile.totalRows);
    if (!candidate) {
      continue;
    }

    let ontologyClass = context.coreClass;
    if (column.name === "journal") {
      ontologyClass = "fabio:Journal";
    } else if (column.name === "booktitle") {
      ontologyClass = "core:Work";
    } else if (column.name === "series") {
      ontologyClass = "fabio:Series";
    } else if (column.name === "stream") {
      ontologyClass = "fabio:DataRepository";
    }

    const requiredProperties = context.requiredPropertiesByClass.get(ontologyClass) || requiredForCore;
    mappings.push({
      columnName: column.name,
      ontologyClass,
      confidence: candidate.confidence,
      reasoning: candidate.reasoning,
      identifierColumn: column.name === "record_type" ? "key" : column.name,
      requiredProperties,
      compliant: context.classByRef.has(ontologyClass),
    });
  }

  const recordTypeClassMap = new Map<string, string>([
    ["article", "fabio:JournalArticle"],
    ["inproceedings", "fabio:ConferencePaper"],
    ["proceedings", "fabio:ConferenceProceedings"],
    ["book", "fabio:Book"],
    ["incollection", "fabio:BookChapter"],
    ["phdthesis", "fabio:DoctoralThesis"],
    ["mastersthesis", "fabio:MastersThesis"],
    ["www", "fabio:WebContent"],
    ["data", "fabio:DataFile"],
  ]);

  for (const [recordType, ontologyClass] of recordTypeClassMap.entries()) {
    mappings.push({
      columnName: `record_type=${recordType}`,
      ontologyClass,
      confidence: round(clamp(recordType === "www" ? 0.74 : recordType === "data" ? 0.81 : 0.95, 0, 0.99)),
      reasoning: `record_type value '${recordType}' matches the closest available FaBiO subclass for that DBLP record family`,
      identifierColumn: "key",
      requiredProperties: context.requiredPropertiesByClass.get(ontologyClass) || [],
      compliant: context.classByRef.has(ontologyClass),
    });
  }

  return mappings;
}

function mapAttributes(profile: DatasetProfile, context: Context): AttributeMapping[] {
  const plan: Array<{ columnName: string; property: string; targetEntity: string }> = [
    { columnName: "key", property: "dcterms:identifier", targetEntity: context.coreClass },
    { columnName: "title", property: "dcterms:title", targetEntity: context.coreClass },
    { columnName: "mdate", property: "dcterms:modified", targetEntity: context.coreClass },
    { columnName: "year", property: "fabio:hasPublicationYear", targetEntity: context.coreClass },
    { columnName: "pages", property: "ns1:pageRange", targetEntity: context.coreClass },
    { columnName: "volume", property: "ns1:volume", targetEntity: context.coreClass },
    { columnName: "number", property: "ns1:issueIdentifier", targetEntity: context.coreClass },
    { columnName: "chapter", property: "fabio:hasSequenceIdentifier", targetEntity: context.coreClass },
    { columnName: "isbn", property: "ns1:isbn", targetEntity: context.coreClass },
    { columnName: "ee", property: "fabio:hasURL", targetEntity: context.coreClass },
    { columnName: "url", property: "fabio:hasURL", targetEntity: context.coreClass },
    { columnName: "publnr", property: "fabio:hasSequenceIdentifier", targetEntity: context.coreClass },
    { columnName: "journal", property: "dcterms:title", targetEntity: "fabio:Journal" },
    { columnName: "booktitle", property: "dcterms:title", targetEntity: "core:Work" },
    { columnName: "series", property: "dcterms:title", targetEntity: "fabio:Series" },
    { columnName: "stream", property: "dcterms:identifier", targetEntity: "fabio:DataRepository" },
  ];

  const mappings: AttributeMapping[] = [];

  for (const item of plan) {
    const column = profile.columns.find((entry) => entry.name === item.columnName);
    if (!column) {
      continue;
    }
    const property = context.dataPropertyByRef.get(item.property);
    if (!property) {
      continue;
    }
    const candidate = scoreAttributeColumn(column, item.property, context);
    if (!candidate) {
      continue;
    }
    const compatible = isClassCompatible(item.targetEntity, property.domain, context);
    mappings.push({
      columnName: item.columnName,
      ontologyProperty: item.property,
      propertyType: "data",
      targetEntity: item.targetEntity,
      datatype: property.range || inferDatatype(column),
      confidence: candidate.confidence,
      reasoning: candidate.reasoning,
      compliant: context.classByRef.has(item.targetEntity) && compatible,
    });
  }

  return mappings;
}

function mapRelationships(profile: DatasetProfile, context: Context): RelationshipMapping[] {
  const plan: Array<{ columnName: string; property: string; sourceEntity: string; targetEntity: string }> = [
    { columnName: "crossref", property: "core:partOf", sourceEntity: context.coreClass, targetEntity: context.coreClass },
    { columnName: "cite", property: "core:relatedEndeavour", sourceEntity: context.coreClass, targetEntity: context.coreClass },
    { columnName: "rel", property: "core:relatedEndeavour", sourceEntity: context.coreClass, targetEntity: context.coreClass },
    { columnName: "journal", property: "core:partOf", sourceEntity: context.coreClass, targetEntity: "fabio:Journal" },
    { columnName: "booktitle", property: "core:partOf", sourceEntity: context.coreClass, targetEntity: "core:Work" },
    { columnName: "series", property: "core:partOf", sourceEntity: context.coreClass, targetEntity: "fabio:Series" },
    { columnName: "stream", property: "core:relatedEndeavour", sourceEntity: context.coreClass, targetEntity: "fabio:DataRepository" },
  ];

  const mappings: RelationshipMapping[] = [];

  for (const item of plan) {
    const column = profile.columns.find((entry) => entry.name === item.columnName);
    if (!column) {
      continue;
    }
    const property = context.objectPropertyByRef.get(item.property);
    if (!property) {
      continue;
    }
    const candidate = scoreRelationshipColumn(column, item.property, context);
    if (!candidate) {
      continue;
    }
    const sourceCompatible = isClassCompatible(item.sourceEntity, property.domain, context);
    const targetCompatible = isClassCompatible(item.targetEntity, property.range, context);
    mappings.push({
      columnName: item.columnName,
      ontologyRelationship: item.property,
      sourceEntity: item.sourceEntity,
      targetEntity: item.targetEntity,
      confidence: candidate.confidence,
      reasoning: candidate.reasoning,
      compliant: context.classByRef.has(item.sourceEntity) && context.classByRef.has(item.targetEntity) && sourceCompatible && targetCompatible,
    });
  }

  return mappings;
}

function buildUnmappedColumns(
  profile: DatasetProfile,
  mappedColumns: Set<string>,
  context: Context,
): UnmappedColumn[] {
  const unmapped: UnmappedColumn[] = [];

  for (const column of profile.columns) {
    if (mappedColumns.has(column.name)) {
      continue;
    }

    let reason = "No strict ontology term satisfied the column semantics with enough confidence.";
    let suggestion = "Review the ontology or enrich the dataset with a linked reference table.";

    if (["authors", "editors", "publisher", "school"].includes(column.name)) {
      reason = "The column denotes people or organizations, but the parsed ontology does not expose a matching agent/organization class for strict mapping.";
      suggestion = "Extend the ontology set with an explicit agent/person/organization ontology before mapping this column.";
    } else if (column.name === "publtype") {
      reason = "Values such as 'encyclopedia', 'version', and 'withdrawn' mix publication form and status, and no precise valid property exists in the parsed ontology.";
      suggestion = "Map after a controlled vocabulary or status ontology is added.";
    } else if (column.name === "month") {
      reason = "Month alone is an incomplete temporal fragment and should not be forced into a full publication-date property.";
      suggestion = "Combine with year during data cleaning if a complete publication date is needed.";
    } else if (column.name === "note") {
      reason = "Free-text notes are heterogeneous and do not safely align with a single existing ontology property.";
      suggestion = "Split notes into typed subfields before mapping.";
    } else if (column.name === "cdrom") {
      reason = "CD-ROM file paths look like local distribution artifacts, but no precise compliant property is available.";
      suggestion = "Keep as provenance metadata or add a storage/location ontology.";
    } else if (column.name === "address") {
      reason = "The ontology references publication places in object property ranges, but the corresponding place class is not available in the parsed classes list.";
      suggestion = "Re-parse the ontology with supporting FRBR classes or leave this field out of KG generation.";
    }

    if (context.supplementaryLookups.length > 0) {
      const hint = getSupplementaryHint(column, context.supplementaryLookups);
      if (hint.reason) {
        reason = `${reason} ${hint.reason}.`;
      }
    }

    unmapped.push({
      columnName: column.name,
      reason,
      suggestion,
      severity: "warning",
    });
  }

  return unmapped;
}

function validateMappings(
  profile: DatasetProfile,
  strategy: MappingStrategy,
  context: Context,
): ComplianceReport {
  const classesUsed = new Set<string>();
  const propertiesUsed = new Set<string>();
  const namespacesUsed = new Set<string>();
  const customTermsDetected: string[] = [];
  const invalidMappings: ComplianceReport["invalidMappings"] = [];
  const lowConfidenceMappings: ComplianceReport["lowConfidenceMappings"] = [];

  const addNamespace = (value: string): void => {
    const namespace = getNamespaceUri(value, context.namespaces);
    if (namespace) {
      namespacesUsed.add(namespace);
    }
  };

  for (const mapping of strategy.entityMappings) {
    const exists = context.classByRef.has(mapping.ontologyClass);
    if (!exists) {
      customTermsDetected.push(mapping.ontologyClass);
      invalidMappings.push({
        type: "entity",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyClass,
        reason: "Class not found in ontology-structure.json",
      });
      mapping.compliant = false;
    } else {
      classesUsed.add(mapping.ontologyClass);
      addNamespace(mapping.ontologyClass);
    }
    if (mapping.confidence < 0.6) {
      lowConfidenceMappings.push({
        type: "entity",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyClass,
        confidence: mapping.confidence,
        reason: mapping.reasoning,
      });
    }
  }

  for (const mapping of strategy.attributeMappings) {
    const property = context.dataPropertyByRef.get(mapping.ontologyProperty);
    const propertyExists = Boolean(property);
    const entityExists = context.classByRef.has(mapping.targetEntity);
    const domainCompatible = property ? isClassCompatible(mapping.targetEntity, property.domain, context) : false;

    if (!propertyExists) {
      customTermsDetected.push(mapping.ontologyProperty);
      invalidMappings.push({
        type: "attribute",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyProperty,
        reason: "Data property not found in ontology-structure.json",
      });
      mapping.compliant = false;
    } else if (!entityExists) {
      invalidMappings.push({
        type: "attribute",
        columnName: mapping.columnName,
        ontologyTerm: mapping.targetEntity,
        reason: "Target entity class not found in ontology-structure.json",
      });
      mapping.compliant = false;
    } else if (!domainCompatible) {
      invalidMappings.push({
        type: "attribute",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyProperty,
        reason: "Data property domain is incompatible with the target entity",
      });
      mapping.compliant = false;
    } else {
      propertiesUsed.add(mapping.ontologyProperty);
      classesUsed.add(mapping.targetEntity);
      addNamespace(mapping.ontologyProperty);
      addNamespace(mapping.targetEntity);
    }

    if (mapping.confidence < 0.6) {
      lowConfidenceMappings.push({
        type: "attribute",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyProperty,
        confidence: mapping.confidence,
        reason: mapping.reasoning,
      });
    }
  }

  for (const mapping of strategy.relationshipMappings) {
    const property = context.objectPropertyByRef.get(mapping.ontologyRelationship);
    const propertyExists = Boolean(property);
    const sourceExists = context.classByRef.has(mapping.sourceEntity);
    const targetExists = context.classByRef.has(mapping.targetEntity);
    const domainCompatible = property ? isClassCompatible(mapping.sourceEntity, property.domain, context) : false;
    const rangeCompatible = property ? isClassCompatible(mapping.targetEntity, property.range, context) : false;

    if (!propertyExists) {
      customTermsDetected.push(mapping.ontologyRelationship);
      invalidMappings.push({
        type: "relationship",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyRelationship,
        reason: "Object property not found in ontology-structure.json",
      });
      mapping.compliant = false;
    } else if (!sourceExists || !targetExists) {
      invalidMappings.push({
        type: "relationship",
        columnName: mapping.columnName,
        ontologyTerm: !sourceExists ? mapping.sourceEntity : mapping.targetEntity,
        reason: "Relationship endpoint class not found in ontology-structure.json",
      });
      mapping.compliant = false;
    } else if (!domainCompatible || !rangeCompatible) {
      invalidMappings.push({
        type: "relationship",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyRelationship,
        reason: "Object property domain/range is incompatible with the mapped source/target classes",
      });
      mapping.compliant = false;
    } else {
      propertiesUsed.add(mapping.ontologyRelationship);
      classesUsed.add(mapping.sourceEntity);
      classesUsed.add(mapping.targetEntity);
      addNamespace(mapping.ontologyRelationship);
      addNamespace(mapping.sourceEntity);
      addNamespace(mapping.targetEntity);
    }

    if (mapping.confidence < 0.6) {
      lowConfidenceMappings.push({
        type: "relationship",
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyRelationship,
        confidence: mapping.confidence,
        reason: mapping.reasoning,
      });
    }
  }

  const coreEntityMapped = strategy.entityMappings.some((mapping) => isClassCompatible(mapping.ontologyClass, [context.coreClass], context));
  if (!coreEntityMapped) {
    strategy.metadata.warnings.push(`No mapped entity satisfies the core ontology class requirement (${context.coreClass}).`);
  }

  const actualColumns = new Set(profile.columns.map((column) => column.name));
  const mappedColumnNames = new Set<string>();
  for (const mapping of strategy.entityMappings) {
    if (actualColumns.has(mapping.columnName)) {
      mappedColumnNames.add(mapping.columnName);
    }
  }
  for (const mapping of strategy.attributeMappings) {
    if (actualColumns.has(mapping.columnName)) {
      mappedColumnNames.add(mapping.columnName);
    }
  }
  for (const mapping of strategy.relationshipMappings) {
    if (actualColumns.has(mapping.columnName)) {
      mappedColumnNames.add(mapping.columnName);
    }
  }

  const uniqueCustomTerms = unique(customTermsDetected);
  const complianceScore = clamp(100 - strategy.unmappedColumns.length * 10 - uniqueCustomTerms.length * 20, 0, 100);
  strategy.metadata.complianceScore = complianceScore;
  strategy.metadata.mappedColumns = mappedColumnNames.size;
  strategy.metadata.unmappedColumns = strategy.unmappedColumns.length;
  strategy.metadata.ontologyCompliant =
    uniqueCustomTerms.length === 0 &&
    invalidMappings.length === 0 &&
    coreEntityMapped;

  const recommendations: string[] = [];
  if (lowConfidenceMappings.length > 0) {
    recommendations.push("Review mappings below 0.6 confidence before graph generation.");
  }
  if (strategy.unmappedColumns.length > 0) {
    recommendations.push("Unmapped columns should remain excluded unless a stricter ontology extension is added.");
  }
  if (!coreEntityMapped) {
    recommendations.push(`Add a mapping to the core ontology class ${context.coreClass}.`);
  }
  if (context.supplementaryLookups.length === 0) {
    recommendations.push("No supplementary lookup files were available for confidence boosting or foreign-key confirmation.");
  }

  if (lowConfidenceMappings.length > 0) {
    strategy.metadata.warnings.push(`${lowConfidenceMappings.length} mapping(s) are below the 0.6 confidence review threshold.`);
  }
  if (strategy.unmappedColumns.length > 0) {
    strategy.metadata.warnings.push(`${strategy.unmappedColumns.length} column(s) were flagged as unmapped to preserve strict ontology compliance.`);
  }

  strategy.validationReport = {
    classesUsed: unique([...classesUsed]).sort(),
    propertiesUsed: unique([...propertiesUsed]).sort(),
    namespacesUsed: unique([...namespacesUsed]).sort(),
    customTermsDetected: uniqueCustomTerms.sort(),
    recommendations: unique(recommendations),
  };

  return {
    metadata: strategy.metadata,
    validationReport: strategy.validationReport,
    lowConfidenceMappings,
    invalidMappings,
    unmappedColumns: strategy.unmappedColumns,
  };
}

function buildContext(ontology: OntologyStructure, guide: MappingGuide, supplementaryIndex: unknown): Context {
  const warnings: string[] = [];
  const { classByUri, classByRef } = buildClassMaps(ontology);
  const objectMaps = buildPropertyMaps(ontology.objectProperties, ontology.metadata.namespaces);
  const dataMaps = buildPropertyMaps(ontology.dataProperties, ontology.metadata.namespaces);

  const context: Context = {
    ontology,
    guide,
    namespaces: ontology.metadata.namespaces,
    classByUri,
    classByRef,
    objectPropertyByUri: objectMaps.byUri,
    objectPropertyByRef: objectMaps.byRef,
    dataPropertyByUri: dataMaps.byUri,
    dataPropertyByRef: dataMaps.byRef,
    requiredPropertiesByClass: new Map<string, string[]>(),
    supplementaryLookups: loadSupplementaryLookups(supplementaryIndex, warnings),
    warnings,
    coreClass: computeMostConnectedClass(ontology, guide),
  };

  context.requiredPropertiesByClass = buildRequiredPropertiesByClass(guide, context);
  return context;
}

function main(): void {
  ensureOutputDir();

  const profile = loadJson<DatasetProfile>(PROFILE_PATH);
  const ontology = loadJson<OntologyStructure>(ONTOLOGY_PATH);
  const guide = loadJson<MappingGuide>(GUIDE_PATH);
  const supplementaryIndex = loadOptionalJson<unknown>(SUPPLEMENTARY_INDEX_PATH);
  const context = buildContext(ontology, guide, supplementaryIndex);

  const entityMappings = mapEntities(profile, context);
  const attributeMappings = mapAttributes(profile, context);
  const relationshipMappings = mapRelationships(profile, context);

  const actualColumns = new Set(profile.columns.map((column) => column.name));
  const prelimMappedColumns = new Set<string>();
  for (const mapping of entityMappings) {
    if (actualColumns.has(mapping.columnName)) prelimMappedColumns.add(mapping.columnName);
  }
  for (const mapping of attributeMappings) {
    if (actualColumns.has(mapping.columnName)) prelimMappedColumns.add(mapping.columnName);
  }
  for (const mapping of relationshipMappings) {
    if (actualColumns.has(mapping.columnName)) prelimMappedColumns.add(mapping.columnName);
  }

  const strategy: MappingStrategy = {
    metadata: {
      ontologyCompliant: false,
      complianceScore: 0,
      ontologyName: ontology.metadata.title,
      ontologyVersion: ontology.metadata.version,
      allowedNamespaces: Object.entries(ontology.metadata.namespaces).map(([prefix, namespace]) => `${prefix}: ${namespace}`),
      totalColumns: profile.totalColumns,
      mappedColumns: prelimMappedColumns.size,
      unmappedColumns: 0,
      warnings: [...context.warnings],
    },
    entityMappings,
    attributeMappings,
    relationshipMappings,
    unmappedColumns: [],
    validationReport: {
      classesUsed: [],
      propertiesUsed: [],
      namespacesUsed: [],
      customTermsDetected: [],
      recommendations: [],
    },
  };

  strategy.unmappedColumns = buildUnmappedColumns(profile, prelimMappedColumns, context);
  const complianceReport = validateMappings(profile, strategy, context);

  fs.writeFileSync(STRATEGY_PATH, JSON.stringify(strategy, null, 2));
  fs.writeFileSync(COMPLIANCE_PATH, JSON.stringify(complianceReport, null, 2));

  const coverage = profile.totalColumns === 0 ? 0 : round((strategy.metadata.mappedColumns / profile.totalColumns) * 100);
  console.log(`Mapped: ${strategy.metadata.mappedColumns}/${profile.totalColumns} columns (${coverage}% coverage)`);
  console.log(`Ontology Compliance: ${strategy.metadata.complianceScore}/100`);
  console.log(`Unmapped columns count: ${strategy.metadata.unmappedColumns}`);
  console.log(`Custom terms count: ${strategy.validationReport.customTermsDetected.length}`);
  console.log("Entities detected with class URI and confidence:");
  for (const mapping of strategy.entityMappings) {
    const cls = context.classByRef.get(mapping.ontologyClass);
    const uri = cls ? cls.uri : mapping.ontologyClass;
    console.log(`- ${mapping.columnName}: ${uri} (${mapping.confidence})`);
  }
}

main();
