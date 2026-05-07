import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse/sync";

type Primitive = string | number | boolean;
type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue } | null;
type CsvRow = Record<string, string>;
type Severity = "info" | "warning" | "error" | "critical";

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

interface MappingMetadata {
  ontologyCompliant: boolean;
  complianceScore: number;
  ontologyName: string;
  ontologyVersion: string;
  allowedNamespaces?: string[];
  totalColumns?: number;
  mappedColumns?: number;
  unmappedColumns?: number;
  warnings?: string[];
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  confidence: number;
  reasoning?: string;
  identifierColumn: string;
  requiredProperties?: string[];
  compliant: boolean;
}

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  propertyType: "data" | "annotation";
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
  suggestion?: string;
  severity?: Severity;
}

interface ValidationReport {
  classesUsed?: string[];
  propertiesUsed?: string[];
  namespacesUsed?: string[];
  customTermsDetected?: string[];
  recommendations?: string[];
}

interface MappingStrategy {
  metadata: MappingMetadata;
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
  unmappedColumns?: UnmappedColumn[];
  validationReport?: ValidationReport;
}

interface MappingComplianceReport {
  metadata?: MappingMetadata;
  validationReport?: ValidationReport;
  lowConfidenceMappings?: Array<Record<string, JsonValue>>;
  invalidMappings?: Array<Record<string, JsonValue>>;
  unmappedColumns?: UnmappedColumn[];
}

interface SupplementaryFileDescriptor {
  name?: string;
  path?: string;
  filePath?: string;
  location?: string;
  format?: string;
  description?: string;
  columns?: string[];
  ontologyClass?: string;
  identifierColumn?: string;
  labelColumn?: string;
  relationshipProperty?: string;
  sourceColumn?: string;
  sourceEntity?: string;
}

interface SupplementaryLookup {
  descriptor: SupplementaryFileDescriptor;
  absolutePath: string;
  rows: CsvRow[];
  idColumn?: string;
  labelColumn?: string;
  codeToLabel: Map<string, string>;
  nodesByCode: Map<string, GraphNode>;
}

interface IndexedClass extends OntologyClass {
  ref: string;
}

interface IndexedObjectProperty extends OntologyObjectProperty {
  ref: string;
}

interface IndexedDataProperty extends OntologyDataProperty {
  ref: string;
}

interface GraphNodeMeta {
  sourceRow: number;
  confidence: number;
  compliant: boolean;
  classRef: string;
  classLabel: string;
  issues?: string[];
}

interface GraphRelationshipMeta {
  confidence: number;
  compliant: boolean;
  issues?: string[];
}

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, Primitive>;
  _meta: GraphNodeMeta;
}

interface GraphRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, Primitive>;
  _meta: GraphRelationshipMeta;
}

interface ValidationIssue {
  type: string;
  severity: Severity;
  message: string;
  rowIndex?: number;
  entityId?: string;
  relationshipId?: string;
  context?: Record<string, JsonValue>;
}

interface ValidationMetrics {
  validNodes: number;
  invalidNodes: number;
  validRelationships: number;
  invalidRelationships: number;
  violationsByType: Map<string, number>;
}

interface UnmappedValueLog {
  rowIndex: number;
  columnName: string;
  value: string;
}

interface GraphOutput {
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

interface StatsOutput {
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
    severity: Severity;
    count: number;
    examples: string[];
  }>;
}

interface GenerationContext {
  ontology: OntologyStructure;
  mapping: MappingStrategy;
  namespaces: Record<string, string>;
  validNamespaces: Set<string>;
  classByRef: Map<string, IndexedClass>;
  classHierarchy: Map<string, Set<string>>;
  objectPropertyByRef: Map<string, IndexedObjectProperty>;
  dataPropertyByRef: Map<string, IndexedDataProperty>;
  entityMappings: EntityMapping[];
  attributeMappingsByEntity: Map<string, AttributeMapping[]>;
  relationshipMappings: RelationshipMapping[];
  unmappedColumns: UnmappedColumn[];
  supplementaryLookups: SupplementaryLookup[];
  validationIssues: ValidationIssue[];
  validationMetrics: ValidationMetrics;
  nodes: Map<string, GraphNode>;
  relationships: Map<string, GraphRelationship>;
  nodeCountsByType: Map<string, number>;
  relationshipCountsByType: Map<string, number>;
  nodesWithIssues: Set<string>;
  relationshipsWithIssues: Set<string>;
  unmappedValueLogs: UnmappedValueLog[];
  mappedCellCount: number;
  unmappedCellCount: number;
  complianceViolations: string[];
  complianceScore: number;
  graphCompliant: boolean;
  mainEntityClassRef: string;
  subtypeMappings: Map<string, EntityMapping>;
  supplementarySummary: {
    indexFound: boolean;
    loadedFiles: string[];
    warnings: string[];
  };
}

interface ErrorOutput {
  metadata: {
    generatedAt: string;
    complianceScore: number;
    graphCompliant: boolean;
  };
  complianceViolations: string[];
  issues: Array<{
    type: string;
    severity: Severity;
    message: string;
    rowIndex: number | null;
    entityId: string | null;
    relationshipId: string | null;
    context: Record<string, JsonValue> | null;
  }>;
  unmappedValues: Array<{
    rowIndex: number;
    columnName: string;
    value: string;
  }>;
  validationMetrics: {
    validNodes: number;
    invalidNodes: number;
    validRelationships: number;
    invalidRelationships: number;
    violationsByType: Record<string, number>;
  };
}

const BASE_URI = "http://data.example.org";
const PROJECT_ROOT = process.cwd();
const OUTPUT_DIR = path.join(PROJECT_ROOT, "domain-data/scientific-dblp/output/codex");
const SUPPLEMENTARY_DIR = path.join(PROJECT_ROOT, "domain-data/scientific-dblp/supplementary-files");

const DATASET_CSV_PATH = path.join(OUTPUT_DIR, "dataset-cleaned.csv");
const MAPPING_STRATEGY_PATH = path.join(OUTPUT_DIR, "mapping-strategy.json");
const ONTOLOGY_STRUCTURE_PATH = path.join(OUTPUT_DIR, "ontology-structure.json");
const ONTOLOGY_MAPPING_GUIDE_PATH = path.join(OUTPUT_DIR, "ontology-mapping-guide.json");
const SUPPLEMENTARY_INDEX_PATH = path.join(OUTPUT_DIR, "supplementary-files-index.json");
const COMPLIANCE_REPORT_PATH = path.join(OUTPUT_DIR, "mapping-compliance-report.json");

const GRAPH_JSON_PATH = path.join(OUTPUT_DIR, "graph-data.json");
const GRAPH_CYPHER_PATH = path.join(OUTPUT_DIR, "graph-import.cypher");
const GRAPH_TTL_PATH = path.join(OUTPUT_DIR, "graph-data.ttl");
const GRAPH_STATS_PATH = path.join(OUTPUT_DIR, "graph-stats.json");
const GRAPH_ERRORS_PATH = path.join(OUTPUT_DIR, "graph-validation-errors.json");

async function main(): Promise<void> {
  const ontology = readJsonFile<OntologyStructure>(ONTOLOGY_STRUCTURE_PATH);
  readJsonFile<Record<string, JsonValue>>(ONTOLOGY_MAPPING_GUIDE_PATH);
  const mapping = readJsonFile<MappingStrategy>(MAPPING_STRATEGY_PATH);
  const complianceReport = readJsonFileIfExists<MappingComplianceReport>(COMPLIANCE_REPORT_PATH);
  const rows = readCsvFile(DATASET_CSV_PATH);

  const classByRef = buildClassIndex(ontology);
  const classHierarchy = buildClassHierarchy(classByRef);
  const objectPropertyByRef = buildObjectPropertyIndex(ontology);
  const dataPropertyByRef = buildDataPropertyIndex(ontology);
  const namespaces = ontology.metadata.namespaces ?? {};
  const validNamespaces = new Set(Object.keys(namespaces));
  const supplementaryLookups = loadSupplementaryLookups();

  const entityMappings = mapping.entityMappings.filter((entry) => entry.compliant);
  const relationshipMappings = mapping.relationshipMappings.filter((entry) => entry.compliant);
  const attributeMappings = mapping.attributeMappings.filter(
    (entry) => entry.compliant && entry.propertyType === "data",
  );

  const mainEntityClassRef =
    entityMappings.find(
      (entry) => !entry.columnName.includes("=") && entry.identifierColumn === "key",
    )?.ontologyClass ?? entityMappings[0]?.ontologyClass ?? "";

  const subtypeMappings = new Map<string, EntityMapping>();
  for (const entry of entityMappings) {
    if (entry.columnName.startsWith("record_type=")) {
      const [, value] = entry.columnName.split("=", 2);
      subtypeMappings.set(value.trim(), entry);
    }
  }

  const attributeMappingsByEntity = new Map<string, AttributeMapping[]>();
  for (const mappingEntry of attributeMappings) {
    const items = attributeMappingsByEntity.get(mappingEntry.targetEntity) ?? [];
    items.push(mappingEntry);
    attributeMappingsByEntity.set(mappingEntry.targetEntity, items);
  }

  const complianceViolations = collectComplianceViolations(mapping, complianceReport);
  const complianceScore = mapping.metadata.complianceScore ?? complianceReport?.metadata?.complianceScore ?? 0;

  if (complianceScore < 60) {
    printComplianceSummary(complianceScore, complianceViolations, false);
    throw new Error(
      `Compliance score ${complianceScore} is below the minimum threshold of 60. Graph generation stopped.`,
    );
  }

  const graphCompliant = complianceScore >= 80;
  if (!graphCompliant) {
    printComplianceSummary(complianceScore, complianceViolations, true);
  }

  const context: GenerationContext = {
    ontology,
    mapping,
    namespaces,
    validNamespaces,
    classByRef,
    classHierarchy,
    objectPropertyByRef,
    dataPropertyByRef,
    entityMappings,
    attributeMappingsByEntity,
    relationshipMappings,
    unmappedColumns: mapping.unmappedColumns ?? [],
    supplementaryLookups,
    validationIssues: [],
    validationMetrics: {
      validNodes: 0,
      invalidNodes: 0,
      validRelationships: 0,
      invalidRelationships: 0,
      violationsByType: new Map<string, number>(),
    },
    nodes: new Map<string, GraphNode>(),
    relationships: new Map<string, GraphRelationship>(),
    nodeCountsByType: new Map<string, number>(),
    relationshipCountsByType: new Map<string, number>(),
    nodesWithIssues: new Set<string>(),
    relationshipsWithIssues: new Set<string>(),
    unmappedValueLogs: [],
    mappedCellCount: 0,
    unmappedCellCount: 0,
    complianceViolations,
    complianceScore,
    graphCompliant,
    mainEntityClassRef,
    subtypeMappings,
    supplementarySummary: {
      indexFound: fs.existsSync(SUPPLEMENTARY_INDEX_PATH),
      loadedFiles: supplementaryLookups.map((lookup) => path.relative(PROJECT_ROOT, lookup.absolutePath)),
      warnings: [],
    },
  };

  validateOntologyRefs(context);
  generateGraph(rows, context);

  const graphOutput = buildGraphOutput(context);
  const statsOutput = buildStatsOutput(context);
  const cypher = buildCypher(graphOutput);
  const ttl = buildTurtle(graphOutput, context);
  const errorPayload = buildErrorPayload(context);

  writeJsonFile(GRAPH_JSON_PATH, graphOutput);
  fs.writeFileSync(GRAPH_CYPHER_PATH, cypher, "utf-8");
  fs.writeFileSync(GRAPH_TTL_PATH, ttl, "utf-8");
  writeJsonFile(GRAPH_STATS_PATH, statsOutput);

  if (errorPayload.issues.length > 0 || errorPayload.unmappedValues.length > 0) {
    writeJsonFile(GRAPH_ERRORS_PATH, errorPayload);
  }

  printGenerationSummary(context, graphOutput);
}

function generateGraph(rows: CsvRow[], context: GenerationContext): void {
  const entityMappingsByRef = new Map<string, EntityMapping[]>();
  for (const entityMapping of context.entityMappings) {
    const items = entityMappingsByRef.get(entityMapping.ontologyClass) ?? [];
    items.push(entityMapping);
    entityMappingsByRef.set(entityMapping.ontologyClass, items);
  }

  rows.forEach((row, rowIndex) => {
    const sourceRow = rowIndex + 1;
    logUnmappedValues(row, sourceRow, context);

    const rowEntities = new Map<string, GraphNode>();
    const rowEntityClassByRef = new Map<string, GraphNode>();

    const orderedEntityMappings = getApplicableEntityMappings(row, context);
    for (const entityMapping of orderedEntityMappings) {
      const node = buildNodeFromRow(row, sourceRow, entityMapping, context);
      if (!node) {
        continue;
      }

      upsertNode(node, context);
      rowEntities.set(node.id, node);
      rowEntityClassByRef.set(entityMapping.ontologyClass, node);
    }

    enrichRowWithSupplementaryNodes(row, sourceRow, rowEntities, rowEntityClassByRef, context);

    for (const relationshipMapping of context.relationshipMappings) {
      const sourceNode = resolveRelationshipEndpoint(
        relationshipMapping.sourceEntity,
        rowEntityClassByRef,
        row,
        sourceRow,
        context,
      );

      if (!sourceNode) {
        continue;
      }

      const targetValues = parseMultiValueCell(row[relationshipMapping.columnName]);
      for (const rawTargetValue of targetValues) {
        const targetNode = resolveTargetNodeForValue(
          relationshipMapping,
          rawTargetValue,
          rowEntityClassByRef,
          sourceRow,
          context,
        );

        if (!targetNode) {
          continue;
        }

        const relationship = buildRelationship(
          relationshipMapping,
          sourceNode,
          targetNode,
          sourceRow,
          context,
        );

        if (relationship) {
          upsertRelationship(relationship, context);
        }
      }
    }
  });
}

function getApplicableEntityMappings(row: CsvRow, context: GenerationContext): EntityMapping[] {
  const mappings: EntityMapping[] = [];

  const mainSubtype = context.subtypeMappings.get((row.record_type ?? "").trim());
  if (mainSubtype) {
    mappings.push(mainSubtype);
  } else {
    const mainBase = context.entityMappings.find((entry) => entry.ontologyClass === context.mainEntityClassRef);
    if (mainBase) {
      mappings.push(mainBase);
    }
  }

  for (const entityMapping of context.entityMappings) {
    if (entityMapping.columnName.startsWith("record_type=")) {
      continue;
    }

    if (entityMapping.ontologyClass === context.mainEntityClassRef) {
      continue;
    }

    const identifierValue = row[entityMapping.identifierColumn] ?? row[entityMapping.columnName];
    if (hasValue(identifierValue)) {
      mappings.push(entityMapping);
    }
  }

  return mappings;
}

function buildNodeFromRow(
  row: CsvRow,
  sourceRow: number,
  entityMapping: EntityMapping,
  context: GenerationContext,
): GraphNode | null {
  const classRef = entityMapping.ontologyClass;
  const classInfo = context.classByRef.get(classRef);

  if (!classInfo) {
    registerIssue(context, {
      type: "unknown-class",
      severity: "error",
      message: `Mapped class ${classRef} does not exist in ontology.`,
      rowIndex: sourceRow,
      context: { classRef },
    });
    return null;
  }

  const identifierValue = normalizeCellValue(row[entityMapping.identifierColumn] ?? row[entityMapping.columnName]);
  if (!identifierValue) {
    registerIssue(context, {
      type: "missing-identifier",
      severity: "warning",
      message: `Missing identifier value for entity ${classRef}.`,
      rowIndex: sourceRow,
      context: {
        classRef,
        identifierColumn: entityMapping.identifierColumn,
      },
    });
    return null;
  }

  const properties = buildNodeProperties(row, classRef, sourceRow, context);
  const node: GraphNode = {
    id: generateStableURI(classInfo.label, identifierValue),
    labels: [classInfo.label],
    properties,
    _meta: {
      sourceRow,
      confidence: entityMapping.confidence,
      compliant: true,
      classRef,
      classLabel: classInfo.label,
      issues: [],
    },
  };

  const validationErrors = validateNode(node, context);
  if (validationErrors.length > 0) {
    node._meta.compliant = false;
    node._meta.issues = validationErrors;
    context.validationMetrics.invalidNodes += 1;
    context.nodesWithIssues.add(node.id);
    return null;
  }

  node._meta.issues = undefined;
  context.validationMetrics.validNodes += 1;
  return node;
}

function buildNodeProperties(
  row: CsvRow,
  classRef: string,
  sourceRow: number,
  context: GenerationContext,
): Record<string, Primitive> {
  const properties: Record<string, Primitive> = {};
  const applicableMappings = collectAttributeMappingsForClass(classRef, context);

  for (const attributeMapping of applicableMappings) {
    const rawValue = normalizeCellValue(row[attributeMapping.columnName]);
    if (!rawValue) {
      continue;
    }

    const enrichedValue = resolveEnrichedValue(attributeMapping.columnName, rawValue, context);
    const normalizedValue = normalizeLiteralValue(enrichedValue, attributeMapping.datatype);
    if (normalizedValue === null) {
      registerIssue(context, {
        type: "invalid-datatype",
        severity: "warning",
        message: `Value "${rawValue}" could not be normalized to ${attributeMapping.datatype}.`,
        rowIndex: sourceRow,
        context: {
          classRef,
          propertyRef: attributeMapping.ontologyProperty,
          columnName: attributeMapping.columnName,
        },
      });
      continue;
    }

    properties[attributeMapping.ontologyProperty] = normalizedValue;
    context.mappedCellCount += 1;
  }

  return properties;
}

function collectAttributeMappingsForClass(
  classRef: string,
  context: GenerationContext,
): AttributeMapping[] {
  const direct = context.attributeMappingsByEntity.get(classRef) ?? [];
  if (direct.length > 0) {
    return direct;
  }

  const inherited: AttributeMapping[] = [];
  for (const [targetClassRef, mappings] of context.attributeMappingsByEntity.entries()) {
    if (isClassCompatible(classRef, targetClassRef, context.classHierarchy)) {
      inherited.push(...mappings);
    }
  }

  return inherited;
}

function buildRelationship(
  relationshipMapping: RelationshipMapping,
  sourceNode: GraphNode,
  targetNode: GraphNode,
  sourceRow: number,
  context: GenerationContext,
): GraphRelationship | null {
  const relationship: GraphRelationship = {
    id: generateRelationshipURI(sourceNode.id, relationshipMapping.ontologyRelationship, targetNode.id),
    type: relationshipMapping.ontologyRelationship,
    from: sourceNode.id,
    to: targetNode.id,
    properties: {},
    _meta: {
      confidence: relationshipMapping.confidence,
      compliant: true,
      issues: [],
    },
  };

  const validationErrors = validateRelationship(relationship, sourceNode, targetNode, sourceRow, context);
  if (validationErrors.length > 0) {
    relationship._meta.compliant = false;
    relationship._meta.issues = validationErrors;
    context.validationMetrics.invalidRelationships += 1;
    context.relationshipsWithIssues.add(relationship.id);
    return null;
  }

  relationship._meta.issues = undefined;
  context.validationMetrics.validRelationships += 1;
  return relationship;
}

function resolveRelationshipEndpoint(
  classRef: string,
  rowEntityClassByRef: Map<string, GraphNode>,
  row: CsvRow,
  sourceRow: number,
  context: GenerationContext,
): GraphNode | null {
  const directMatch = rowEntityClassByRef.get(classRef);
  if (directMatch) {
    return directMatch;
  }

  for (const node of Array.from(rowEntityClassByRef.values())) {
    if (isClassCompatible(node._meta.classRef, classRef, context.classHierarchy)) {
      return node;
    }
  }

  if (classRef === context.mainEntityClassRef && hasValue(row.key)) {
    const mainClassRef = context.subtypeMappings.get((row.record_type ?? "").trim())?.ontologyClass ?? classRef;
    const classInfo = context.classByRef.get(mainClassRef);
    if (!classInfo) {
      return null;
    }

    const mainNodeId = generateStableURI(classInfo.label, row.key);
    const existing = context.nodes.get(mainNodeId);
    if (existing) {
      return existing;
    }
  }

  registerIssue(context, {
    type: "missing-relationship-endpoint",
    severity: "warning",
    message: `Could not resolve entity ${classRef} for relationship endpoint.`,
    rowIndex: sourceRow,
    context: { classRef },
  });
  return null;
}

function resolveTargetNodeForValue(
  relationshipMapping: RelationshipMapping,
  rawTargetValue: string,
  rowEntityClassByRef: Map<string, GraphNode>,
  sourceRow: number,
  context: GenerationContext,
): GraphNode | null {
  const targetClassRef = relationshipMapping.targetEntity;
  const inRowTarget = rowEntityClassByRef.get(targetClassRef);

  if (inRowTarget && isLikelySameEntityReference(rawTargetValue, inRowTarget, context)) {
    return inRowTarget;
  }

  if (targetClassRef === context.mainEntityClassRef || isMainEntitySubclass(targetClassRef, context)) {
    return findMainEntityByIdentifier(rawTargetValue, context);
  }

  const bySupplementary = findSupplementaryNode(targetClassRef, rawTargetValue, context);
  if (bySupplementary) {
    return bySupplementary;
  }

  const classInfo = context.classByRef.get(targetClassRef);
  if (!classInfo) {
    registerIssue(context, {
      type: "unknown-target-class",
      severity: "error",
      message: `Target class ${targetClassRef} does not exist in ontology.`,
      rowIndex: sourceRow,
      context: { targetClassRef },
    });
    return null;
  }

  const syntheticNode: GraphNode = {
    id: generateStableURI(classInfo.label, rawTargetValue),
    labels: [classInfo.label],
    properties: {},
    _meta: {
      sourceRow,
      confidence: relationshipMapping.confidence,
      compliant: true,
      classRef: targetClassRef,
      classLabel: classInfo.label,
      issues: [],
    },
  };

  const validationErrors = validateNode(syntheticNode, context);
  if (validationErrors.length > 0) {
    registerIssue(context, {
      type: "invalid-target-node",
      severity: "warning",
      message: `Referenced target node for ${targetClassRef} could not be validated.`,
      rowIndex: sourceRow,
      entityId: syntheticNode.id,
      context: { rawTargetValue, targetClassRef },
    });
    return null;
  }

  upsertNode(syntheticNode, context);
  return syntheticNode;
}

function findMainEntityByIdentifier(identifierValue: string, context: GenerationContext): GraphNode | null {
  for (const entityMapping of Array.from(context.subtypeMappings.values())) {
    const classInfo = context.classByRef.get(entityMapping.ontologyClass);
    if (!classInfo) {
      continue;
    }
    const nodeId = generateStableURI(classInfo.label, identifierValue);
    const node = context.nodes.get(nodeId);
    if (node) {
      return node;
    }
  }

  const baseClass = context.classByRef.get(context.mainEntityClassRef);
  if (!baseClass) {
    return null;
  }

  return context.nodes.get(generateStableURI(baseClass.label, identifierValue)) ?? null;
}

function findSupplementaryNode(
  targetClassRef: string,
  rawTargetValue: string,
  context: GenerationContext,
): GraphNode | null {
  for (const lookup of context.supplementaryLookups) {
    if (lookup.descriptor.ontologyClass !== targetClassRef) {
      continue;
    }

    const node = lookup.nodesByCode.get(rawTargetValue);
    if (node) {
      return node;
    }
  }

  return null;
}

function enrichRowWithSupplementaryNodes(
  row: CsvRow,
  sourceRow: number,
  rowEntities: Map<string, GraphNode>,
  rowEntityClassByRef: Map<string, GraphNode>,
  context: GenerationContext,
): void {
  for (const lookup of context.supplementaryLookups) {
    const descriptor = lookup.descriptor;
    if (!descriptor.ontologyClass || !descriptor.relationshipProperty || !descriptor.sourceColumn) {
      continue;
    }

    const sourceNode = resolveRelationshipEndpoint(
      descriptor.sourceEntity ?? context.mainEntityClassRef,
      rowEntityClassByRef,
      row,
      sourceRow,
      context,
    );

    if (!sourceNode) {
      continue;
    }

    const code = normalizeCellValue(row[descriptor.sourceColumn]);
    if (!code) {
      continue;
    }

    const targetNode = lookup.nodesByCode.get(code);
    if (!targetNode) {
      continue;
    }

    if (!rowEntities.has(targetNode.id) && !context.nodes.has(targetNode.id)) {
      upsertNode(targetNode, context);
    }

    const relationship: GraphRelationship = {
      id: generateRelationshipURI(sourceNode.id, descriptor.relationshipProperty, targetNode.id),
      type: descriptor.relationshipProperty,
      from: sourceNode.id,
      to: targetNode.id,
      properties: {},
      _meta: {
        confidence: 1,
        compliant: true,
        issues: [],
      },
    };

    const validationErrors = validateRelationship(relationship, sourceNode, targetNode, sourceRow, context);
    if (validationErrors.length > 0) {
      relationship._meta.compliant = false;
      relationship._meta.issues = validationErrors;
      context.validationMetrics.invalidRelationships += 1;
      context.relationshipsWithIssues.add(relationship.id);
      continue;
    }

    relationship._meta.issues = undefined;
    context.validationMetrics.validRelationships += 1;
    upsertRelationship(relationship, context);
  }
}

function validateNode(node: GraphNode, context: GenerationContext): string[] {
  const issues: string[] = [];
  const classRef = node._meta.classRef;
  const classInfo = context.classByRef.get(classRef);

  if (!classInfo) {
    issues.push(`Class ${classRef} is not defined in the ontology.`);
  }

  for (const [propertyRef, value] of Object.entries(node.properties)) {
    const property = context.dataPropertyByRef.get(propertyRef);
    if (!property) {
      issues.push(`Property ${propertyRef} is not a valid ontology data property.`);
      registerIssue(context, {
        type: "unknown-data-property",
        severity: "error",
        message: `Property ${propertyRef} is not defined as a data property.`,
        entityId: node.id,
        rowIndex: node._meta.sourceRow,
      });
      continue;
    }

    if (!isPropertyDomainValid(classRef, property.domain, context.classHierarchy)) {
      issues.push(`Property ${propertyRef} is not valid for class ${classRef}.`);
      registerIssue(context, {
        type: "invalid-property-domain",
        severity: "error",
        message: `Property ${propertyRef} domain does not match ${classRef}.`,
        entityId: node.id,
        rowIndex: node._meta.sourceRow,
      });
    }

    const declaredDatatype = inferPropertyDatatype(propertyRef, classRef, context);
    if (declaredDatatype && !isValueCompatibleWithDatatype(value, declaredDatatype)) {
      issues.push(`Property ${propertyRef} has invalid datatype for value "${String(value)}".`);
      registerIssue(context, {
        type: "invalid-property-datatype",
        severity: "error",
        message: `Property ${propertyRef} value is incompatible with ${declaredDatatype}.`,
        entityId: node.id,
        rowIndex: node._meta.sourceRow,
      });
    }
  }

  return issues;
}

function validateRelationship(
  relationship: GraphRelationship,
  sourceNode: GraphNode,
  targetNode: GraphNode,
  sourceRow: number,
  context: GenerationContext,
): string[] {
  const issues: string[] = [];
  const property = context.objectPropertyByRef.get(relationship.type);

  if (!property) {
    issues.push(`Relationship type ${relationship.type} is not a valid ontology object property.`);
    registerIssue(context, {
      type: "unknown-object-property",
      severity: "error",
      message: `Relationship type ${relationship.type} is not defined in ontology.`,
      relationshipId: relationship.id,
      rowIndex: sourceRow,
    });
    return issues;
  }

  if (!isPropertyDomainValid(sourceNode._meta.classRef, property.domain, context.classHierarchy)) {
    issues.push(`Source class ${sourceNode._meta.classRef} violates domain of ${relationship.type}.`);
    registerIssue(context, {
      type: "invalid-relationship-domain",
      severity: "error",
      message: `Relationship ${relationship.type} domain mismatch.`,
      relationshipId: relationship.id,
      rowIndex: sourceRow,
    });
  }

  if (!isPropertyRangeValid(targetNode._meta.classRef, property.range, context.classHierarchy)) {
    issues.push(`Target class ${targetNode._meta.classRef} violates range of ${relationship.type}.`);
    registerIssue(context, {
      type: "invalid-relationship-range",
      severity: "error",
      message: `Relationship ${relationship.type} range mismatch.`,
      relationshipId: relationship.id,
      rowIndex: sourceRow,
    });
  }

  return issues;
}

function buildGraphOutput(context: GenerationContext): GraphOutput {
  const nodes = Array.from(context.nodes.values()).sort((left, right) => left.id.localeCompare(right.id));
  const relationships = Array.from(context.relationships.values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      ontologyName: context.ontology.metadata.title,
      ontologyVersion: context.ontology.metadata.version,
      complianceScore: context.complianceScore,
      validation: {
        compliant:
          context.graphCompliant &&
          context.validationMetrics.invalidNodes === 0 &&
          context.validationMetrics.invalidRelationships === 0,
        errors: context.validationIssues.filter((issue) => issue.severity === "error" || issue.severity === "critical")
          .length,
        warnings: context.validationIssues.filter((issue) => issue.severity === "warning").length,
      },
    },
    nodes,
    relationships,
    statistics: {
      totalNodes: nodes.length,
      nodesByType: mapToRecord(context.nodeCountsByType),
      totalRelationships: relationships.length,
      relationshipsByType: mapToRecord(context.relationshipCountsByType),
    },
  };
}

function buildStatsOutput(context: GenerationContext): StatsOutput {
  const totalNodes = context.nodes.size;
  const totalRelationships = context.relationships.size;
  const avgDegree = totalNodes === 0 ? 0 : (2 * totalRelationships) / totalNodes;
  const density =
    totalNodes <= 1 ? 0 : totalRelationships / (totalNodes * (totalNodes - 1));

  const groupedIssues = new Map<string, { severity: Severity; count: number; examples: string[] }>();
  for (const issue of context.validationIssues) {
    const existing = groupedIssues.get(issue.type) ?? {
      severity: issue.severity,
      count: 0,
      examples: [],
    };
    existing.count += 1;
    if (existing.examples.length < 3) {
      existing.examples.push(issue.message);
    }
    groupedIssues.set(issue.type, existing);
  }

  return {
    summary: {
      totalNodes,
      totalRelationships,
      avgDegree,
      density,
    },
    nodeStatistics: {
      byType: mapToRecord(context.nodeCountsByType),
      withIssues: context.nodesWithIssues.size,
      compliant: Math.max(0, totalNodes - context.nodesWithIssues.size),
    },
    relationshipStatistics: {
      byType: mapToRecord(context.relationshipCountsByType),
      withIssues: context.relationshipsWithIssues.size,
      compliant: Math.max(0, totalRelationships - context.relationshipsWithIssues.size),
    },
    complianceMetrics: {
      overallScore: context.complianceScore,
      validNodesPercent: percentage(context.validationMetrics.validNodes, context.validationMetrics.validNodes + context.validationMetrics.invalidNodes),
      validRelationshipsPercent: percentage(
        context.validationMetrics.validRelationships,
        context.validationMetrics.validRelationships + context.validationMetrics.invalidRelationships,
      ),
      unmappedDataPercent: percentage(context.unmappedCellCount, context.mappedCellCount + context.unmappedCellCount),
    },
    issues: Array.from(groupedIssues.entries())
      .map(([type, details]) => ({
        type,
        severity: details.severity,
        count: details.count,
        examples: details.examples,
      }))
      .sort((left, right) => right.count - left.count),
  };
}

function buildCypher(graph: GraphOutput): string {
  const lines: string[] = [];
  const uniqueLabels = new Set<string>();

  for (const node of graph.nodes) {
    for (const label of node.labels) {
      uniqueLabels.add(label);
    }
  }

  for (const label of Array.from(uniqueLabels).sort()) {
    lines.push(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:${quoteLabel(label)}) REQUIRE n.id IS UNIQUE;`);
  }

  if (uniqueLabels.size > 0) {
    lines.push("");
  }

  for (const node of graph.nodes) {
    const payload = {
      id: node.id,
      ...node.properties,
      _meta_sourceRow: node._meta.sourceRow,
      _meta_confidence: node._meta.confidence,
      _meta_compliant: node._meta.compliant,
      _meta_classRef: node._meta.classRef,
      _meta_classLabel: node._meta.classLabel,
    };

    lines.push(
      `MERGE (n:${node.labels.map((label) => quoteLabel(label)).join(":")} {id: ${quoteString(node.id)}})`,
    );
    lines.push(`SET n += ${toCypherMap(payload)};`);
  }

  if (graph.relationships.length > 0) {
    lines.push("");
  }

  for (const relationship of graph.relationships) {
    const payload = {
      ...relationship.properties,
      _meta_confidence: relationship._meta.confidence,
      _meta_compliant: relationship._meta.compliant,
    };

    lines.push(
      `MATCH (source {id: ${quoteString(relationship.from)}}), (target {id: ${quoteString(relationship.to)}})`,
    );
    lines.push(
      `MERGE (source)-[r:${quoteLabel(relationship.type)} {id: ${quoteString(relationship.id)}}]->(target)`,
    );
    lines.push(`SET r += ${toCypherMap(payload)};`);
  }

  return `${lines.join("\n")}\n`;
}

function buildTurtle(graph: GraphOutput, context: GenerationContext): string {
  const lines: string[] = [];

  for (const [prefix, uri] of Object.entries(context.namespaces)) {
    lines.push(`@prefix ${prefix}: <${uri}> .`);
  }
  lines.push("");

  const outgoingBySource = new Map<string, GraphRelationship[]>();
  for (const relationship of graph.relationships) {
    const items = outgoingBySource.get(relationship.from) ?? [];
    items.push(relationship);
    outgoingBySource.set(relationship.from, items);
  }

  for (const node of graph.nodes) {
    const subject = `<${node.id}>`;
    const statements: string[] = [];
    statements.push(`a ${node._meta.classRef}`);

    for (const [propertyRef, value] of Object.entries(node.properties)) {
      statements.push(`${propertyRef} ${toTurtleLiteral(value)}`);
    }

    for (const relationship of outgoingBySource.get(node.id) ?? []) {
      statements.push(`${relationship.type} <${relationship.to}>`);
    }

    lines.push(`${subject} ${statements.join(" ;\n  ")} .`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function buildErrorPayload(context: GenerationContext): ErrorOutput {
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      complianceScore: context.complianceScore,
      graphCompliant: context.graphCompliant,
    },
    complianceViolations: context.complianceViolations,
    issues: context.validationIssues.map((issue) => ({
      type: issue.type,
      severity: issue.severity,
      message: issue.message,
      rowIndex: issue.rowIndex ?? null,
      entityId: issue.entityId ?? null,
      relationshipId: issue.relationshipId ?? null,
      context: issue.context ?? null,
    })),
    unmappedValues: context.unmappedValueLogs.map((entry) => ({
      rowIndex: entry.rowIndex,
      columnName: entry.columnName,
      value: entry.value,
    })),
    validationMetrics: {
      validNodes: context.validationMetrics.validNodes,
      invalidNodes: context.validationMetrics.invalidNodes,
      validRelationships: context.validationMetrics.validRelationships,
      invalidRelationships: context.validationMetrics.invalidRelationships,
      violationsByType: mapToRecord(context.validationMetrics.violationsByType),
    },
  };
}

function loadSupplementaryLookups(): SupplementaryLookup[] {
  if (!fs.existsSync(SUPPLEMENTARY_INDEX_PATH)) {
    return [];
  }

  const rawIndex = readJsonFile<JsonValue>(SUPPLEMENTARY_INDEX_PATH);
  const descriptors = normalizeSupplementaryIndex(rawIndex);
  const lookups: SupplementaryLookup[] = [];

  for (const descriptor of descriptors) {
    const relativePath = descriptor.filePath ?? descriptor.path ?? descriptor.location ?? descriptor.name;
    if (!relativePath) {
      continue;
    }

    const absolutePath = path.join(SUPPLEMENTARY_DIR, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const rows = readTabularFile(absolutePath, descriptor.format);
    if (rows.length === 0) {
      continue;
    }

    const idColumn = descriptor.identifierColumn ?? guessIdentifierColumn(rows[0]);
    const labelColumn = descriptor.labelColumn ?? guessLabelColumn(rows[0]);

    const codeToLabel = new Map<string, string>();
    const nodesByCode = new Map<string, GraphNode>();

    if (idColumn && labelColumn) {
      for (const row of rows) {
        const code = normalizeCellValue(row[idColumn]);
        const label = normalizeCellValue(row[labelColumn]);
        if (!code || !label) {
          continue;
        }
        codeToLabel.set(code, label);

        if (descriptor.ontologyClass) {
          const classLabelSlug = slugify(descriptor.ontologyClass);
          const nodeId = `${BASE_URI}/${classLabelSlug}/${slugify(code)}`;
          nodesByCode.set(code, {
            id: nodeId,
            labels: [descriptor.ontologyClass],
            properties: {},
            _meta: {
              sourceRow: 0,
              confidence: 1,
              compliant: true,
              classRef: descriptor.ontologyClass,
              classLabel: descriptor.ontologyClass,
            },
          });
        }
      }
    }

    lookups.push({
      descriptor,
      absolutePath,
      rows,
      idColumn,
      labelColumn,
      codeToLabel,
      nodesByCode,
    });
  }

  return lookups;
}

function normalizeSupplementaryIndex(rawIndex: JsonValue): SupplementaryFileDescriptor[] {
  if (Array.isArray(rawIndex)) {
    return rawIndex.filter(isObjectLike) as SupplementaryFileDescriptor[];
  }

  if (isObjectLike(rawIndex)) {
    const files = rawIndex.files;
    if (Array.isArray(files)) {
      return files.filter(isObjectLike) as SupplementaryFileDescriptor[];
    }
  }

  return [];
}

function validateOntologyRefs(context: GenerationContext): void {
  const classRefs = new Set<string>();
  const propertyRefs = new Set<string>();

  for (const mappingEntry of context.entityMappings) {
    classRefs.add(mappingEntry.ontologyClass);
  }

  for (const mappingEntry of Array.from(context.attributeMappingsByEntity.values())) {
    for (const item of mappingEntry) {
      propertyRefs.add(item.ontologyProperty);
      classRefs.add(item.targetEntity);
    }
  }

  for (const mappingEntry of context.relationshipMappings) {
    propertyRefs.add(mappingEntry.ontologyRelationship);
    classRefs.add(mappingEntry.sourceEntity);
    classRefs.add(mappingEntry.targetEntity);
  }

  for (const classRef of Array.from(classRefs)) {
    validateNamespaceRef(classRef, context);
    if (!context.classByRef.has(classRef)) {
      registerIssue(context, {
        type: "unknown-class",
        severity: "error",
        message: `Class ${classRef} is not present in ontology-structure.json.`,
        context: { classRef },
      });
    }
  }

  for (const propertyRef of Array.from(propertyRefs)) {
    validateNamespaceRef(propertyRef, context);
    if (!context.dataPropertyByRef.has(propertyRef) && !context.objectPropertyByRef.has(propertyRef)) {
      registerIssue(context, {
        type: "unknown-property",
        severity: "error",
        message: `Property ${propertyRef} is not present in ontology-structure.json.`,
        context: { propertyRef },
      });
    }
  }
}

function validateNamespaceRef(ref: string, context: GenerationContext): void {
  const prefix = ref.includes(":") ? ref.split(":", 1)[0] : "";
  if (!prefix || context.validNamespaces.has(prefix)) {
    return;
  }

  registerIssue(context, {
    type: "invalid-namespace",
    severity: "error",
    message: `Reference ${ref} uses unknown namespace prefix ${prefix}.`,
    context: { ref, prefix },
  });
}

function buildClassIndex(ontology: OntologyStructure): Map<string, IndexedClass> {
  const index = new Map<string, IndexedClass>();
  for (const ontologyClass of ontology.classes) {
    const ref = toCompactRef(ontologyClass.uri, ontology.metadata.namespaces);
    if (ref) {
      index.set(ref, { ...ontologyClass, ref });
    }
  }
  return index;
}

function buildClassHierarchy(classByRef: Map<string, IndexedClass>): Map<string, Set<string>> {
  const hierarchy = new Map<string, Set<string>>();

  const visit = (classRef: string, seen: Set<string>): Set<string> => {
    const cached = hierarchy.get(classRef);
    if (cached) {
      return cached;
    }

    const result = new Set<string>([classRef]);
    const classInfo = classByRef.get(classRef);
    if (!classInfo) {
      hierarchy.set(classRef, result);
      return result;
    }

    for (const superClass of classInfo.superClasses ?? []) {
      if (seen.has(superClass)) {
        continue;
      }
      seen.add(superClass);
      result.add(superClass);
      for (const inherited of Array.from(visit(superClass, seen))) {
        result.add(inherited);
      }
    }

    hierarchy.set(classRef, result);
    return result;
  };

  for (const classRef of Array.from(classByRef.keys())) {
    visit(classRef, new Set<string>());
  }

  return hierarchy;
}

function buildObjectPropertyIndex(ontology: OntologyStructure): Map<string, IndexedObjectProperty> {
  const index = new Map<string, IndexedObjectProperty>();
  for (const property of ontology.objectProperties) {
    const ref = toCompactRef(property.uri, ontology.metadata.namespaces);
    if (ref) {
      index.set(ref, { ...property, ref });
    }
  }
  return index;
}

function buildDataPropertyIndex(ontology: OntologyStructure): Map<string, IndexedDataProperty> {
  const index = new Map<string, IndexedDataProperty>();
  for (const property of ontology.dataProperties) {
    const ref = toCompactRef(property.uri, ontology.metadata.namespaces);
    if (ref) {
      index.set(ref, { ...property, ref });
    }
  }
  return index;
}

function collectComplianceViolations(
  mapping: MappingStrategy,
  complianceReport: MappingComplianceReport | null,
): string[] {
  const violations: string[] = [];

  for (const warning of mapping.metadata.warnings ?? []) {
    violations.push(warning);
  }

  for (const invalidMapping of complianceReport?.invalidMappings ?? []) {
    violations.push(`Invalid mapping: ${JSON.stringify(invalidMapping)}`);
  }

  for (const recommendation of complianceReport?.validationReport?.recommendations ?? []) {
    violations.push(recommendation);
  }

  for (const unmapped of complianceReport?.unmappedColumns ?? []) {
    violations.push(`Unmapped column ${unmapped.columnName}: ${unmapped.reason}`);
  }

  return violations;
}

function readCsvFile(filePath: string): CsvRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    trim: false,
  }) as CsvRow[];
}

function readTabularFile(filePath: string, format?: string): CsvRow[] {
  const extension = path.extname(filePath).toLowerCase();
  const resolvedFormat = (format ?? extension.replace(/^\./, "")).toLowerCase();

  if (resolvedFormat === "json") {
    const value = readJsonFile<JsonValue>(filePath);
    if (Array.isArray(value)) {
      return value.filter(isObjectLike).map((row) => toStringRecord(row as Record<string, JsonValue>));
    }
    return [];
  }

  const delimiter = resolvedFormat === "tsv" ? "\t" : ",";
  const content = fs.readFileSync(filePath, "utf-8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    delimiter,
  }) as CsvRow[];
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readJsonFileIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFile<T>(filePath);
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function normalizeCellValue(value: string | undefined): string {
  return (value ?? "").trim();
}

function hasValue(value: string | undefined): boolean {
  return normalizeCellValue(value).length > 0;
}

function parseMultiValueCell(value: string | undefined): string[] {
  const normalized = normalizeCellValue(value);
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0);
      }
    } catch {
      // Fall through to delimiter-based parsing.
    }
  }

  const delimiters = ["|", ";", ","];
  for (const delimiter of delimiters) {
    if (normalized.includes(delimiter)) {
      return normalized
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
  }

  return [normalized];
}

function resolveEnrichedValue(columnName: string, rawValue: string, context: GenerationContext): string {
  for (const lookup of context.supplementaryLookups) {
    const descriptor = lookup.descriptor;
    const relevantColumns = new Set<string>(
      [descriptor.sourceColumn, descriptor.identifierColumn, ...(descriptor.columns ?? [])]
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0),
    );

    if (!relevantColumns.has(columnName)) {
      continue;
    }

    const label = lookup.codeToLabel.get(rawValue);
    if (label) {
      return label;
    }
  }

  return rawValue;
}

function normalizeLiteralValue(value: string, datatype: string): Primitive | null {
  const normalizedDatatype = datatype.trim().toLowerCase();

  if (normalizedDatatype.endsWith("boolean")) {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
    return null;
  }

  if (normalizedDatatype.endsWith("integer") || normalizedDatatype.endsWith("positiveinteger")) {
    if (!/^-?\d+$/.test(value)) {
      return null;
    }
    const numeric = Number.parseInt(value, 10);
    if (normalizedDatatype.endsWith("positiveinteger") && numeric <= 0) {
      return null;
    }
    return numeric;
  }

  if (normalizedDatatype.endsWith("decimal") || normalizedDatatype.endsWith("float") || normalizedDatatype.endsWith("double")) {
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      return null;
    }
    return Number.parseFloat(value);
  }

  if (normalizedDatatype.endsWith("gyear")) {
    return /^\d{4}$/.test(value) ? value : null;
  }

  if (normalizedDatatype.endsWith("datetime")) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
  }

  if (normalizedDatatype.endsWith("date")) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }

  if (normalizedDatatype.endsWith("anyuri")) {
    try {
      return new URL(value).toString();
    } catch {
      return null;
    }
  }

  return value;
}

function inferPropertyDatatype(propertyRef: string, classRef: string, context: GenerationContext): string | null {
  const mapping = collectAttributeMappingsForClass(classRef, context).find(
    (entry) => entry.ontologyProperty === propertyRef,
  );
  if (mapping?.datatype) {
    return mapping.datatype;
  }

  return context.dataPropertyByRef.get(propertyRef)?.range ?? null;
}

function isValueCompatibleWithDatatype(value: Primitive, datatype: string): boolean {
  return normalizeLiteralValue(String(value), datatype) !== null;
}

function isPropertyDomainValid(
  classRef: string,
  domains: string[] | undefined,
  hierarchy: Map<string, Set<string>>,
): boolean {
  if (!domains || domains.length === 0) {
    return true;
  }
  return domains.some((domain) => isClassCompatible(classRef, domain, hierarchy));
}

function isPropertyRangeValid(
  classRef: string,
  ranges: string[] | undefined,
  hierarchy: Map<string, Set<string>>,
): boolean {
  if (!ranges || ranges.length === 0) {
    return true;
  }
  return ranges.some((range) => isClassCompatible(classRef, range, hierarchy));
}

function isClassCompatible(
  classRef: string,
  expectedClassRef: string,
  hierarchy: Map<string, Set<string>>,
): boolean {
  if (classRef === expectedClassRef) {
    return true;
  }
  return hierarchy.get(classRef)?.has(expectedClassRef) ?? false;
}

function isMainEntitySubclass(targetClassRef: string, context: GenerationContext): boolean {
  return isClassCompatible(targetClassRef, context.mainEntityClassRef, context.classHierarchy);
}

function upsertNode(node: GraphNode, context: GenerationContext): void {
  const existing = context.nodes.get(node.id);
  if (existing) {
    existing.properties = {
      ...existing.properties,
      ...node.properties,
    };
    existing.labels = Array.from(new Set([...existing.labels, ...node.labels]));
    existing._meta.confidence = Math.max(existing._meta.confidence, node._meta.confidence);
    existing._meta.compliant = existing._meta.compliant && node._meta.compliant;
    return;
  }

  context.nodes.set(node.id, node);
  incrementCounter(context.nodeCountsByType, node._meta.classRef);
}

function upsertRelationship(relationship: GraphRelationship, context: GenerationContext): void {
  if (context.relationships.has(relationship.id)) {
    return;
  }

  context.relationships.set(relationship.id, relationship);
  incrementCounter(context.relationshipCountsByType, relationship.type);
}

function logUnmappedValues(row: CsvRow, sourceRow: number, context: GenerationContext): void {
  for (const unmappedColumn of context.unmappedColumns) {
    const value = normalizeCellValue(row[unmappedColumn.columnName]);
    if (!value) {
      continue;
    }

    context.unmappedCellCount += 1;
    context.unmappedValueLogs.push({
      rowIndex: sourceRow,
      columnName: unmappedColumn.columnName,
      value,
    });
  }
}

function registerIssue(context: GenerationContext, issue: ValidationIssue): void {
  context.validationIssues.push(issue);
  incrementCounter(context.validationMetrics.violationsByType, issue.type);
}

function incrementCounter(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function mapToRecord(counter: Map<string, number>): Record<string, number> {
  return Object.fromEntries(Array.from(counter.entries()).sort(([left], [right]) => left.localeCompare(right)));
}

function percentage(part: number, total: number): number {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(2));
}

function generateStableURI(classLabel: string, identifierValue: string): string {
  return `${BASE_URI}/${slugify(classLabel)}/${slugify(identifierValue)}`;
}

function generateRelationshipURI(sourceId: string, relationshipType: string, targetId: string): string {
  return `${BASE_URI}/rel/${slugify(`${sourceId}|${relationshipType}|${targetId}`)}`;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function toCompactRef(uri: string, namespaces: Record<string, string>): string | null {
  for (const [prefix, namespaceUri] of Object.entries(namespaces)) {
    if (uri.startsWith(namespaceUri)) {
      return `${prefix}:${uri.slice(namespaceUri.length)}`;
    }
  }
  return null;
}

function guessIdentifierColumn(row: CsvRow): string | undefined {
  const candidates = ["id", "code", "identifier", "key", "uri"];
  return candidates.find((candidate) => candidate in row);
}

function guessLabelColumn(row: CsvRow): string | undefined {
  const candidates = ["label", "name", "title", "description"];
  return candidates.find((candidate) => candidate in row);
}

function isLikelySameEntityReference(
  rawTargetValue: string,
  node: GraphNode,
  context: GenerationContext,
): boolean {
  const classInfo = context.classByRef.get(node._meta.classRef);
  if (!classInfo) {
    return false;
  }
  return node.id === generateStableURI(classInfo.label, rawTargetValue);
}

function quoteLabel(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function quoteString(value: string): string {
  return JSON.stringify(value);
}

function toCypherValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => toCypherValue(item)).join(", ")}]`;
  }

  if (typeof value === "object") {
    return toCypherMap(value as Record<string, JsonValue>);
  }

  if (typeof value === "string") {
    return quoteString(value);
  }

  return String(value);
}

function toCypherMap(value: Record<string, JsonValue>): string {
  const entries = Object.entries(value).map(([key, entry]) => `${quoteLabel(key)}: ${toCypherValue(entry)}`);
  return `{${entries.join(", ")}}`;
}

function toTurtleLiteral(value: Primitive): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? `"${value}"^^xsd:integer` : `"${value}"^^xsd:decimal`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (/^https?:\/\//.test(value)) {
    return `<${value}>`;
  }
  return JSON.stringify(value);
}

function toStringRecord(record: Record<string, JsonValue>): CsvRow {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, value === null ? "" : String(value)]),
  );
}

function isObjectLike(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printComplianceSummary(score: number, violations: string[], withWarning: boolean): void {
  if (withWarning) {
    console.warn(`Compliance score: ${score} (warning mode, graph marked non-compliant)`);
  } else {
    console.error(`Compliance score: ${score} (below minimum threshold, stopping)`);
  }

  for (const violation of violations) {
    console.warn(`- ${violation}`);
  }
}

function printGenerationSummary(context: GenerationContext, graph: GraphOutput): void {
  console.log(`Compliance score: ${context.complianceScore}`);
  console.log(`Graph compliant: ${graph.metadata.validation.compliant ? "yes" : "no"}`);
  console.log("Node counts by type:");
  for (const [type, count] of Object.entries(graph.statistics.nodesByType)) {
    console.log(`- ${type}: ${count}`);
  }
  console.log("Relationship counts by type:");
  for (const [type, count] of Object.entries(graph.statistics.relationshipsByType)) {
    console.log(`- ${type}: ${count}`);
  }

  const totalNodeValidations =
    context.validationMetrics.validNodes + context.validationMetrics.invalidNodes;
  const totalRelationshipValidations =
    context.validationMetrics.validRelationships + context.validationMetrics.invalidRelationships;

  console.log(
    `Validation results: nodes ${percentage(context.validationMetrics.validNodes, totalNodeValidations)}% valid, relationships ${percentage(context.validationMetrics.validRelationships, totalRelationshipValidations)}% valid`,
  );
  console.log(`Unmapped column count: ${context.unmappedColumns.length}`);
  console.log("Output files:");
  console.log(`- ${path.relative(PROJECT_ROOT, GRAPH_JSON_PATH)}`);
  console.log(`- ${path.relative(PROJECT_ROOT, GRAPH_CYPHER_PATH)}`);
  console.log(`- ${path.relative(PROJECT_ROOT, GRAPH_TTL_PATH)}`);
  console.log(`- ${path.relative(PROJECT_ROOT, GRAPH_STATS_PATH)}`);
  if (fs.existsSync(GRAPH_ERRORS_PATH)) {
    console.log(`- ${path.relative(PROJECT_ROOT, GRAPH_ERRORS_PATH)}`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
