import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";

type PrimitiveType = "string" | "integer" | "float" | "date" | "boolean" | "url" | "mixed";

interface NumericStats {
  min: number;
  max: number;
  mean: number;
}

interface ColumnProfile {
  name: string;
  inferredType: PrimitiveType;
  missingCount: number;
  missingPercent: number;
  uniqueCount: number;
  sampleValues: string[];
  relatedSupplementaryFile?: string;
  supplementaryContext?: string;
  numericStats?: NumericStats;
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
    sourceFiles?: string[];
    namespaces: Record<string, string>;
  };
  classes: OntologyClass[];
  objectProperties: ObjectProperty[];
  dataProperties: DataProperty[];
  externalVocabularies?: Array<{
    prefix: string;
    namespace: string;
    classes: string[];
    properties: string[];
  }>;
}

interface MappingGuidePattern {
  scenario: string;
  ontologyClass: string;
  requiredProperties: string[];
  optionalProperties: string[];
  relationships: string[];
}

interface MappingGuide {
  commonPatterns: MappingGuidePattern[];
  allowedNamespaces: string[];
  constraints: string[];
}

interface SupplementaryFileInfo {
  path?: string;
  name: string;
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
  sampleValues: string[];
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
}

interface MappingContext {
  ontology: OntologyStructure;
  guide: MappingGuide;
  classByUri: Map<string, OntologyClass>;
  objectPropertyByUri: Map<string, ObjectProperty>;
  dataPropertyByUri: Map<string, DataProperty>;
  requiredPropertiesByClass: Map<string, string[]>;
  supplementaryLookups: SupplementaryLookup[];
  warnings: string[];
  coreClassUri: string;
}

const DATA_DIR = process.env.DATA_DIR || "domain-data/cultural-moma";
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

function getNonMissingCount(column: ColumnProfile, totalRows: number): number {
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

function isIdentifierLike(columnName: string): boolean {
  return /(^|[\s_])(?:id|qid|ulan|identifier)([\s_]|$)/i.test(columnName) || /(objectid|constituentid|wiki qid)$/i.test(normalizeText(columnName));
}

function hasLookupLikeValues(column: ColumnProfile): boolean {
  return column.sampleValues.some((value) => /^[A-Z]\d+$/i.test(value) || /^Q\d+$/i.test(value) || /^\d{5,}$/.test(value));
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

function toPrefixed(uri: string, namespaces: Record<string, string>): string {
  for (const [prefix, namespace] of Object.entries(namespaces)) {
    if (uri.startsWith(namespace)) {
      return `${prefix}:${uri.slice(namespace.length)}`;
    }
  }

  return uri;
}

function getNamespaceUri(uri: string, namespaces: Record<string, string>): string | null {
  for (const namespace of Object.values(namespaces)) {
    if (uri.startsWith(namespace)) {
      return namespace;
    }
  }

  return null;
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
          Object.fromEntries(
            Object.entries(item).map(([key, value]) => [String(key).trim(), String(value ?? "").trim()]),
          ),
        );
    }
  }

  return [];
}

function loadSupplementaryLookups(index: SupplementaryFileInfo[] | null, warnings: string[]): SupplementaryLookup[] {
  if (!index || index.length === 0) {
    return [];
  }

  const lookups: SupplementaryLookup[] = [];

  for (const file of index) {
    const fileName = path.basename(file.path || file.name);
    const filePath = path.resolve(SUPPLEMENTARY_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      warnings.push(`Supplementary file listed in index but missing on disk: ${fileName}`);
      continue;
    }

    const rows = parseSupplementaryFile(filePath, file.format || "");
    const values: string[] = [];
    const rowLimit = Math.min(rows.length, 5000);

    for (let i = 0; i < rowLimit; i += 1) {
      for (const value of Object.values(rows[i])) {
        const trimmed = value.trim();
        if (trimmed.length > 0 && trimmed.length <= 100) {
          values.push(trimmed);
        }
        if (values.length >= 1000) {
          break;
        }
      }
      if (values.length >= 1000) {
        break;
      }
    }

    lookups.push({
      fileName,
      filePath,
      format: (file.format || path.extname(filePath).replace(/^\./, "") || "unknown").toLowerCase(),
      description: file.description || "",
      columns: file.columns || (rows[0] ? Object.keys(rows[0]) : []),
      sampleValues: values.slice(0, 20),
      normalizedValues: new Set(values.map((value) => normalizeText(value)).filter(Boolean)),
    });
  }

  return lookups;
}

function buildRequiredPropertiesByClass(guide: MappingGuide): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const pattern of guide.commonPatterns) {
    if (pattern.ontologyClass) {
      result.set(pattern.ontologyClass, pattern.requiredProperties || []);
    }
  }
  return result;
}

function computeMostConnectedClass(ontology: OntologyStructure): string {
  const degrees = new Map<string, number>();
  for (const cls of ontology.classes) {
    degrees.set(cls.uri, 0);
  }

  for (const property of ontology.objectProperties) {
    for (const domain of property.domain || []) {
      degrees.set(domain, (degrees.get(domain) || 0) + 1);
    }
    for (const range of property.range || []) {
      degrees.set(range, (degrees.get(range) || 0) + 1);
    }
  }

  const sorted = [...degrees.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || ontology.classes[0]?.uri || "";
}

function getSupplementaryHint(column: ColumnProfile, lookups: SupplementaryLookup[]): { score: number; reason: string | null } {
  if (lookups.length === 0) {
    return { score: 0, reason: null };
  }

  const columnTokens = tokenize(column.name);
  const columnValues = column.sampleValues.map((value) => normalizeText(value)).filter(Boolean);

  let bestScore = 0;
  let bestReason: string | null = null;

  for (const lookup of lookups) {
    const columnOverlap = overlaps(columnTokens, lookup.columns.flatMap((name) => tokenize(name)));
    const valueOverlapCount = columnValues.filter((value) => lookup.normalizedValues.has(value)).length;
    const valueOverlapRatio = column.sampleValues.length === 0 ? 0 : valueOverlapCount / column.sampleValues.length;
    const score = clamp(columnOverlap * 0.08 + valueOverlapRatio * 0.3, 0, 0.3);

    if (score > bestScore) {
      bestScore = score;
      bestReason = `supplementary lookup ${lookup.fileName} overlaps on columns/values`;
    }
  }

  return { score: bestScore, reason: bestReason };
}

function scoreClassCandidate(column: ColumnProfile, cls: OntologyClass, totalRows: number, context: MappingContext): { score: number; reason: string[] } {
  const reasons: string[] = [];
  const columnTokens = tokenize(column.name);
  const classTokens = tokenize([cls.label, cls.definition || "", cls.comment || "", ...(cls.examples || [])].join(" "));
  const tokenOverlap = overlaps(columnTokens, classTokens);
  let score = tokenOverlap * 0.08;

  if (tokenOverlap > 0) {
    reasons.push(`column/class token overlap=${tokenOverlap}`);
  }

  const uniqueRatio = getUniqueRatio(column, totalRows);
  const cardinality = computeCardinality(column, totalRows);
  const identifierLike = isIdentifierLike(column.name);
  const lookupLikeValues = hasLookupLikeValues(column);

  if (cls.uri === "http://www.europeana.eu/schemas/edm/ProvidedCHO") {
    if (/objectid/i.test(column.name)) {
      score += 0.84;
      reasons.push("ObjectID strongly indicates the primary heritage object identifier");
    }
    if (/accessionnumber/i.test(column.name)) {
      score += 0.38;
      reasons.push("Accession numbers commonly identify collection objects");
    }
    if (/(title|medium|dimensions|department|classification|dateacquired|onview)/i.test(column.name)) {
      score += 0.16;
      reasons.push("column looks like an object-level field");
    }
  }

  if (cls.uri === "http://www.europeana.eu/schemas/edm/Agent") {
    if (/constituentid/i.test(column.name)) {
      score += 0.84;
      reasons.push("ConstituentID is a stable person/agent identifier");
    }
    if (/(artist|displayname|ulan|wiki qid|nationality|gender)/i.test(column.name)) {
      score += 0.18;
      reasons.push("column looks artist/agent-related");
    }
  }

  if (cls.uri === "http://www.europeana.eu/schemas/edm/WebResource") {
    if (/(^|[^a-z])(url|imageurl)([^a-z]|$)/i.test(column.name)) {
      score += 0.82;
      reasons.push("URL-like column fits WebResource identifiers");
    }
  }

  if (cls.uri === "http://www.europeana.eu/schemas/edm/TimeSpan") {
    if (/(date|begin|end|acquired|duration)/i.test(column.name)) {
      score += 0.22;
      reasons.push("temporal column matches TimeSpan vocabulary");
    }
  }

  if (cls.uri === "http://www.europeana.eu/schemas/edm/Place") {
    if (/(nationality|location|onview)/i.test(column.name)) {
      score += 0.18;
      reasons.push("column may encode location-like values");
    }
  }

  if (cardinality === "high" && identifierLike) {
    score += 0.14;
    reasons.push("high-cardinality identifier-like column");
  } else if (cardinality === "medium" && (identifierLike || lookupLikeValues)) {
    score += 0.06;
    reasons.push("medium-cardinality code-like column");
  }

  if (uniqueRatio < 0.05 && cls.uri !== "http://www.w3.org/2004/02/skos/core#Concept") {
    score -= 0.12;
    reasons.push("very low cardinality weakens entity detection");
  }

  const supplementaryHint = getSupplementaryHint(column, context.supplementaryLookups);
  if (supplementaryHint.score > 0) {
    score += supplementaryHint.score;
    reasons.push(supplementaryHint.reason || "supplementary confirmation");
  }

  return { score: clamp(score, 0, 1), reason: reasons };
}

function detectEntities(profile: DatasetProfile, context: MappingContext): EntityMapping[] {
  const entities: EntityMapping[] = [];
  const usedColumns = new Set<string>();

  for (const column of profile.columns) {
    let bestClass: OntologyClass | null = null;
    let bestScore = 0;
    let bestReasons: string[] = [];

    for (const cls of context.ontology.classes) {
      const candidate = scoreClassCandidate(column, cls, profile.totalRows, context);
      if (candidate.score > bestScore) {
        bestClass = cls;
        bestScore = candidate.score;
        bestReasons = candidate.reason;
      }
    }

    const cardinality = computeCardinality(column, profile.totalRows);
    const strictThreshold =
      isIdentifierLike(column.name) || column.inferredType === "url" ? 0.74 : cardinality === "high" ? 0.82 : 0.9;

    if (!bestClass || bestScore < strictThreshold) {
      continue;
    }

    if (
      bestClass.uri === "http://www.europeana.eu/schemas/edm/TimeSpan" ||
      bestClass.uri === "http://www.europeana.eu/schemas/edm/Place" ||
      bestClass.uri === "http://www.w3.org/2004/02/skos/core#Concept"
    ) {
      continue;
    }

    usedColumns.add(column.name);
    const requiredProperties = context.requiredPropertiesByClass.get(bestClass.uri) || [];
    entities.push({
      columnName: column.name,
      ontologyClass: bestClass.uri,
      confidence: round(bestScore),
      reasoning: unique(bestReasons).join("; "),
      identifierColumn: column.name,
      requiredProperties,
      compliant: context.classByUri.has(bestClass.uri),
    });
  }

  if (!usedColumns.has("ObjectID") && context.classByUri.has("http://www.europeana.eu/schemas/edm/ProvidedCHO")) {
    const objectId = profile.columns.find((column) => column.name === "ObjectID");
    if (objectId) {
      entities.push({
        columnName: objectId.name,
        ontologyClass: "http://www.europeana.eu/schemas/edm/ProvidedCHO",
        confidence: 0.97,
        reasoning: "fallback safeguard: ObjectID is the only dataset-wide unique object identifier and best fits ProvidedCHO",
        identifierColumn: objectId.name,
        requiredProperties: context.requiredPropertiesByClass.get("http://www.europeana.eu/schemas/edm/ProvidedCHO") || [],
        compliant: true,
      });
    }
  }

  return uniqueBy(entities, (mapping) => mapping.columnName);
}

function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function getEntityByColumn(entityMappings: EntityMapping[], columnName: string): EntityMapping | undefined {
  return entityMappings.find((mapping) => mapping.columnName === columnName);
}

function getEntityByClass(entityMappings: EntityMapping[], classUri: string): EntityMapping | undefined {
  return entityMappings.find((mapping) => mapping.ontologyClass === classUri);
}

function domainCompatible(property: ObjectProperty | DataProperty, sourceClass: string): boolean {
  const domains = property.domain || [];
  return domains.length === 0 || domains.includes(sourceClass);
}

function rangeCompatible(property: ObjectProperty, targetClass: string): boolean {
  const ranges = property.range || [];
  return ranges.length === 0 || ranges.includes(targetClass);
}

function detectRelationships(entityMappings: EntityMapping[], context: MappingContext): RelationshipMapping[] {
  const relationships: RelationshipMapping[] = [];
  const providedCho = getEntityByClass(entityMappings, "http://www.europeana.eu/schemas/edm/ProvidedCHO");
  const webResourceColumns = entityMappings.filter(
    (mapping) => mapping.ontologyClass === "http://www.europeana.eu/schemas/edm/WebResource",
  );

  if (!providedCho) {
    return relationships;
  }

  for (const webResource of webResourceColumns) {
    let propertyUri: string | null = null;
    let confidence = 0;
    let reasoning = "";

    if (webResource.columnName === "URL") {
      propertyUri = "http://www.europeana.eu/schemas/edm/isShownAt";
      confidence = 0.9;
      reasoning = "public work URL behaves like the landing page / shown-at web resource";
    } else if (webResource.columnName === "ImageURL") {
      propertyUri = "http://www.europeana.eu/schemas/edm/object";
      confidence = 0.82;
      reasoning = "image URL behaves like the representative web resource for the object";
    }

    if (!propertyUri) {
      continue;
    }

    const property = context.objectPropertyByUri.get(propertyUri);
    if (!property) {
      context.warnings.push(`Relationship property ${propertyUri} not found in ontology-structure.json`);
      continue;
    }

    const compliant = domainCompatible(property, providedCho.ontologyClass) && rangeCompatible(property, webResource.ontologyClass);
    relationships.push({
      columnName: webResource.columnName,
      ontologyRelationship: propertyUri,
      sourceEntity: providedCho.ontologyClass,
      targetEntity: webResource.ontologyClass,
      confidence: round(confidence),
      reasoning,
      compliant,
    });
  }

  return relationships;
}

function datatypeCompatible(column: ColumnProfile, property: DataProperty): boolean {
  const range = property.range || "";
  if (!range.includes("Literal")) {
    return false;
  }

  if (property.uri.endsWith("/begin") || property.uri.endsWith("/end")) {
    return column.inferredType === "date" || column.inferredType === "integer" || /date|begin|end/i.test(column.name);
  }

  if (property.uri.endsWith("/ugc")) {
    return column.inferredType === "boolean";
  }

  return true;
}

function detectAttributes(profile: DatasetProfile, entityMappings: EntityMapping[], context: MappingContext): AttributeMapping[] {
  const attributes: AttributeMapping[] = [];
  const mappedEntityColumns = new Set(entityMappings.map((mapping) => mapping.columnName));

  for (const column of profile.columns) {
    if (mappedEntityColumns.has(column.name)) {
      continue;
    }

    let bestProperty: DataProperty | null = null;
    let bestScore = 0;
    let targetEntity: string | null = null;
    let reason = "";

    for (const property of context.ontology.dataProperties) {
      const propertyTokens = tokenize([property.label, property.definition || ""].join(" "));
      const columnTokens = tokenize(column.name);
      let score = overlaps(columnTokens, propertyTokens) * 0.08;

      if (property.uri === "http://www.europeana.eu/schemas/edm/begin" && /begin/i.test(column.name)) {
        score += 0.4;
      }
      if (property.uri === "http://www.europeana.eu/schemas/edm/end" && /end/i.test(column.name)) {
        score += 0.4;
      }
      if (property.uri === "http://www.europeana.eu/schemas/edm/type" && /type/i.test(column.name)) {
        score += 0.28;
      }
      if (property.uri === "http://www.europeana.eu/schemas/edm/ugc" && /catalog/i.test(column.name)) {
        score += 0.18;
      }

      if (!datatypeCompatible(column, property)) {
        score -= 0.25;
      }

      const candidateTarget =
        getEntityByClass(entityMappings, "http://www.europeana.eu/schemas/edm/ProvidedCHO")?.ontologyClass ||
        entityMappings[0]?.ontologyClass ||
        null;

      if (candidateTarget && !domainCompatible(property, candidateTarget)) {
        score -= 0.2;
      }

      score = clamp(score, 0, 1);
      if (score > bestScore && candidateTarget) {
        bestScore = score;
        bestProperty = property;
        targetEntity = candidateTarget;
        reason = "column/property lexical match with datatype check";
      }
    }

    if (!bestProperty || !targetEntity || bestScore < 0.7) {
      continue;
    }

    attributes.push({
      columnName: column.name,
      ontologyProperty: bestProperty.uri,
      propertyType: "data",
      targetEntity,
      datatype: bestProperty.range || "http://www.w3.org/2000/01/rdf-schema#Literal",
      confidence: round(bestScore),
      reasoning: reason,
      compliant: context.dataPropertyByUri.has(bestProperty.uri) && domainCompatible(bestProperty, targetEntity),
    });
  }

  return attributes;
}

function classifyUnmappedColumn(
  column: ColumnProfile,
  entityMappings: EntityMapping[],
  attributeMappings: AttributeMapping[],
  relationshipMappings: RelationshipMapping[],
): UnmappedColumn | null {
  const mappedColumns = new Set([
    ...entityMappings.map((mapping) => mapping.columnName),
    ...attributeMappings.map((mapping) => mapping.columnName),
    ...relationshipMappings.map((mapping) => mapping.columnName),
  ]);

  if (mappedColumns.has(column.name)) {
    return null;
  }

  if (/artist|displayname|creditline/i.test(column.name)) {
    return {
      columnName: column.name,
      reason: "EDM subset in ontology-structure.json does not expose a valid creator/label property for this column.",
      suggestion: "Review manually if the ontology parser should expose Dublin Core or SKOS labeling properties before mapping.",
      severity: "warning",
    };
  }

  if (/(^|[\s_])(date|begindate|enddate|begin|end|duration|dateacquired)([\s_]|$)/i.test(normalizeText(column.name))) {
    return {
      columnName: column.name,
      reason: "Temporal value detected but no safe TimeSpan-centric mapping could be proven with current ontology terms.",
      suggestion: "Flag for review rather than attaching edm:begin/end to the wrong entity.",
      severity: "warning",
    };
  }

  if (/(classification|department|nationality|gender|cataloged|ulan|wiki qid)/i.test(column.name)) {
    return {
      columnName: column.name,
      reason: "Controlled-value column detected, but no valid ontology property in ontology-structure.json connects it safely.",
      suggestion: "Review after expanding available ontology properties or supplementary taxonomies.",
      severity: "info",
    };
  }

  if (/(height|width|depth|length|weight|diameter|circumference|dimensions)/i.test(column.name)) {
    return {
      columnName: column.name,
      reason: "Physical measurement column found, but the parsed EDM subset contains no compliant measurement property.",
      suggestion: "Keep unmapped unless measurement ontology terms are added to ontology-structure.json.",
      severity: "info",
    };
  }

  return {
    columnName: column.name,
    reason: "No valid class or property from ontology-structure.json matched with sufficient confidence.",
    suggestion: "Manual review required.",
    severity: "info",
  };
}

function validateMappings(strategy: Omit<MappingStrategy, "metadata" | "validationReport">, context: MappingContext, totalColumns: number): {
  metadata: MappingStrategy["metadata"];
  validationReport: ValidationReport;
  complianceReport: ComplianceReport;
} {
  const warnings = [...context.warnings];
  const classesUsed = unique(strategy.entityMappings.map((mapping) => mapping.ontologyClass)).sort();
  const propertiesUsed = unique(
    [...strategy.attributeMappings.map((mapping) => mapping.ontologyProperty), ...strategy.relationshipMappings.map((mapping) => mapping.ontologyRelationship)],
  ).sort();
  const customTermsDetected: string[] = [];

  for (const mapping of strategy.entityMappings) {
    if (!context.classByUri.has(mapping.ontologyClass)) {
      customTermsDetected.push(mapping.ontologyClass);
      warnings.push(`Entity class ${mapping.ontologyClass} not found in ontology-structure.json`);
    }
  }

  for (const mapping of strategy.attributeMappings) {
    if (!context.dataPropertyByUri.has(mapping.ontologyProperty)) {
      customTermsDetected.push(mapping.ontologyProperty);
      warnings.push(`Data property ${mapping.ontologyProperty} not found in ontology-structure.json`);
    }
  }

  for (const mapping of strategy.relationshipMappings) {
    const property = context.objectPropertyByUri.get(mapping.ontologyRelationship);
    if (!property) {
      customTermsDetected.push(mapping.ontologyRelationship);
      warnings.push(`Object property ${mapping.ontologyRelationship} not found in ontology-structure.json`);
      continue;
    }
    if (!domainCompatible(property, mapping.sourceEntity) || !rangeCompatible(property, mapping.targetEntity)) {
      warnings.push(`Domain/range mismatch for ${mapping.ontologyRelationship}`);
    }
  }

  if (!classesUsed.includes(context.coreClassUri)) {
    warnings.push(`Core ontology class ${context.coreClassUri} was not mapped.`);
  }

  const lowConfidenceMappings = [
    ...strategy.entityMappings
      .filter((mapping) => mapping.confidence < 0.6)
      .map((mapping) => ({
        type: "entity" as const,
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyClass,
        confidence: mapping.confidence,
        reason: "confidence below 0.6",
      })),
    ...strategy.attributeMappings
      .filter((mapping) => mapping.confidence < 0.6)
      .map((mapping) => ({
        type: "attribute" as const,
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyProperty,
        confidence: mapping.confidence,
        reason: "confidence below 0.6",
      })),
    ...strategy.relationshipMappings
      .filter((mapping) => mapping.confidence < 0.6)
      .map((mapping) => ({
        type: "relationship" as const,
        columnName: mapping.columnName,
        ontologyTerm: mapping.ontologyRelationship,
        confidence: mapping.confidence,
        reason: "confidence below 0.6",
      })),
  ];

  for (const lowConfidence of lowConfidenceMappings) {
    warnings.push(`Low-confidence ${lowConfidence.type} mapping: ${lowConfidence.columnName} -> ${lowConfidence.ontologyTerm}`);
  }

  const mappedColumns = unique(
    [...strategy.entityMappings.map((mapping) => mapping.columnName), ...strategy.attributeMappings.map((mapping) => mapping.columnName), ...strategy.relationshipMappings.map((mapping) => mapping.columnName)],
  ).length;
  const unmappedColumns = totalColumns - mappedColumns;
  const complianceScore = clamp(100 - unmappedColumns * 10 - customTermsDetected.length * 20, 0, 100);

  const namespacesUsed = unique(
    [...classesUsed, ...propertiesUsed]
      .map((uri) => getNamespaceUri(uri, context.ontology.metadata.namespaces))
      .filter((uri): uri is string => Boolean(uri)),
  ).sort();

  const recommendations = [
    "Keep unmapped columns under manual review rather than inventing ontology terms.",
    "If creator/title/measurement mappings are required, extend ontology parsing so the needed properties appear in ontology-structure.json first.",
  ];

  if (context.supplementaryLookups.length === 0) {
    recommendations.push("No supplementary lookup files were available; load them in future runs if domain reference tables are added.");
  }

  const validationReport: ValidationReport = {
    classesUsed,
    propertiesUsed,
    namespacesUsed,
    customTermsDetected: unique(customTermsDetected).sort(),
    recommendations,
  };

  const metadata: MappingStrategy["metadata"] = {
    ontologyCompliant: validationReport.customTermsDetected.length === 0 && strategy.entityMappings.every((m) => m.compliant) && strategy.attributeMappings.every((m) => m.compliant) && strategy.relationshipMappings.every((m) => m.compliant),
    complianceScore,
    ontologyName: context.ontology.metadata.title,
    ontologyVersion: context.ontology.metadata.version,
    allowedNamespaces: Object.values(context.ontology.metadata.namespaces),
    totalColumns,
    mappedColumns,
    unmappedColumns,
    warnings: unique(warnings),
  };

  const complianceReport: ComplianceReport = {
    metadata,
    validationReport,
    lowConfidenceMappings,
  };

  return { metadata, validationReport, complianceReport };
}

function main(): void {
  ensureOutputDir();

  const profile = loadJson<DatasetProfile>(PROFILE_PATH);
  const ontology = loadJson<OntologyStructure>(ONTOLOGY_PATH);
  const guide = loadJson<MappingGuide>(GUIDE_PATH);
  const supplementaryIndex = loadOptionalJson<SupplementaryFileInfo[]>(SUPPLEMENTARY_INDEX_PATH);

  const warnings: string[] = [];
  const context: MappingContext = {
    ontology,
    guide,
    classByUri: new Map(ontology.classes.map((cls) => [cls.uri, cls])),
    objectPropertyByUri: new Map(ontology.objectProperties.map((prop) => [prop.uri, prop])),
    dataPropertyByUri: new Map(ontology.dataProperties.map((prop) => [prop.uri, prop])),
    requiredPropertiesByClass: buildRequiredPropertiesByClass(guide),
    supplementaryLookups: loadSupplementaryLookups(supplementaryIndex, warnings),
    warnings,
    coreClassUri: computeMostConnectedClass(ontology),
  };

  const entityMappings = detectEntities(profile, context);
  const relationshipMappings = detectRelationships(entityMappings, context);
  const attributeMappings = detectAttributes(profile, entityMappings, context);
  const unmappedColumns = profile.columns
    .map((column) => classifyUnmappedColumn(column, entityMappings, attributeMappings, relationshipMappings))
    .filter((column): column is UnmappedColumn => Boolean(column));

  const validation = validateMappings(
    {
      entityMappings,
      attributeMappings,
      relationshipMappings,
      unmappedColumns,
    },
    context,
    profile.totalColumns,
  );

  const strategy: MappingStrategy = {
    metadata: validation.metadata,
    entityMappings,
    attributeMappings,
    relationshipMappings,
    unmappedColumns,
    validationReport: validation.validationReport,
  };

  fs.writeFileSync(STRATEGY_PATH, JSON.stringify(strategy, null, 2), "utf8");
  fs.writeFileSync(COMPLIANCE_PATH, JSON.stringify(validation.complianceReport, null, 2), "utf8");

  const coverage = profile.totalColumns === 0 ? 0 : Math.round((validation.metadata.mappedColumns / profile.totalColumns) * 100);
  console.log(`Mapped: ${validation.metadata.mappedColumns}/${profile.totalColumns} columns (${coverage}% coverage)`);
  console.log(`Ontology Compliance: ${validation.metadata.complianceScore}/100`);
  console.log(`Unmapped columns count: ${validation.metadata.unmappedColumns}`);
  console.log(`Custom terms count: ${validation.validationReport.customTermsDetected.length}`);
  console.log("Entities detected:");
  for (const entity of entityMappings) {
    console.log(`  - ${entity.columnName} -> ${entity.ontologyClass} (${entity.confidence})`);
  }
  console.log(`Saved: ${STRATEGY_PATH}`);
  console.log(`Saved: ${COMPLIANCE_PATH}`);
}

main();
