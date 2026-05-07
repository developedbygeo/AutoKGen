import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import neo4j, { Driver, Integer, QueryResult, Record as Neo4jRecord } from 'neo4j-driver';
import { BlankNode, Literal, NamedNode, Parser, Store, Term } from 'n3';

type ValidationMode = 'live-neo4j-n10s' | 'snapshot-fallback';
type ShaclSeverity = 'sh:Violation' | 'sh:Warning' | 'sh:Info';

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface GraphRelationship {
  id?: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface GraphData {
  metadata?: Record<string, unknown>;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  statistics?: Record<string, unknown>;
}

interface RuntimeConfig {
  uri: string;
  user: string;
  password: string;
  database: string;
}

interface ShaclPropertyConstraint {
  id: string;
  path: string;
  minCount?: number;
  maxCount?: number;
  datatype?: string;
  className?: string;
  nodeKind?: string;
  severity: ShaclSeverity;
  message?: string;
}

interface ShaclNodeShape {
  id: string;
  targetClass: string;
  properties: ShaclPropertyConstraint[];
}

interface ValidationViolation {
  shape: string;
  focusNode: string;
  path: string | null;
  message: string;
  severity: ShaclSeverity;
}

interface NodesValidatedPerShape {
  shape: string;
  targetClass: string;
  nodesValidated: number;
}

interface SummaryCounts {
  'sh:Violation': number;
  'sh:Warning': number;
  'sh:Info': number;
  totalViolations: number;
}

interface ViolationGroup {
  severity: ShaclSeverity;
  shape: string;
  path: string | null;
  message: string;
  count: number;
  examples: string[];
}

interface ValidationResultBundle {
  validationMode: ValidationMode;
  totalShapesValidated: number;
  nodesValidatedPerShape: NodesValidatedPerShape[];
  violations: ValidationViolation[];
  liveAttemptError?: {
    message: string;
    setupInstructions: string[];
  };
  snapshotNotice?: string;
}

interface ValidationReport {
  validationMode: ValidationMode;
  executedAt: string;
  overallPass: boolean;
  totalShapesValidated: number;
  shapesFile: {
    path: string;
    sha256: string;
    lineCount: number;
  };
  snapshotFile: {
    path: string;
    validatedActiveDatabaseContents: boolean;
  };
  nodesValidatedPerShape: NodesValidatedPerShape[];
  violationsBySeverity: Record<ShaclSeverity, ValidationViolation[]>;
  violations: ValidationViolation[];
  summaryCounts: SummaryCounts;
  topViolations: ViolationGroup[];
  liveAttemptError?: {
    message: string;
    setupInstructions: string[];
  };
  snapshotNotice?: string;
}

interface SnapshotState {
  nodeById: Map<string, GraphNode>;
  outgoingByNodeId: Map<string, Map<string, GraphRelationship[]>>;
}

interface ResolvedValue {
  value: unknown;
  source: 'property' | 'relationship';
  relationship?: GraphRelationship;
  targetNode?: GraphNode;
}

const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const SHAPES_FILE = path.resolve(PROJECT_ROOT, 'domain-data/cultural-moma/validation/edm-shacl-shapes-v2.ttl');
const SNAPSHOT_FILE = path.resolve(PROJECT_ROOT, 'domain-data/cultural-moma/output/codex/graph-data.json');
const REPORT_FILE = path.resolve(PROJECT_ROOT, 'domain-data/cultural-moma/output/codex/shacl-validation-report.json');
const DEFAULT_DATABASE = 'neo4j';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SH = 'http://www.w3.org/ns/shacl#';
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function localName(value: string): string {
  const hashIndex = value.lastIndexOf('#');
  const slashIndex = value.lastIndexOf('/');
  return value.slice(Math.max(hashIndex, slashIndex) + 1);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (neo4j.isInt(value)) {
    return (value as Integer).toNumber();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return 0;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function severityFromIri(value?: string | null): ShaclSeverity {
  const local = value ? localName(value) : '';
  if (local === 'Info') {
    return 'sh:Info';
  }
  if (local === 'Warning') {
    return 'sh:Warning';
  }
  return 'sh:Violation';
}

function getRequiredEnv(name: 'NEO4J_URI' | 'NEO4J_USER' | 'NEO4J_PASSWORD'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function getRuntimeConfig(): RuntimeConfig {
  return {
    uri: getRequiredEnv('NEO4J_URI'),
    user: getRequiredEnv('NEO4J_USER'),
    password: getRequiredEnv('NEO4J_PASSWORD'),
    database: process.env.NEO4J_DATABASE?.trim() || DEFAULT_DATABASE,
  };
}

function createDriver(config: RuntimeConfig): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
}

function escapeForCypherSingleQuotedLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function isNamedNode(term?: Term | null): term is NamedNode {
  return Boolean(term && term.termType === 'NamedNode');
}

function isBlankNode(term?: Term | null): term is BlankNode {
  return Boolean(term && term.termType === 'BlankNode');
}

function isLiteral(term?: Term | null): term is Literal {
  return Boolean(term && term.termType === 'Literal');
}

function getFirstObject(store: Store, subject: Term, predicate: string): Term | undefined {
  return store.getObjects(subject, predicate, null)[0];
}

function getLiteralValue(store: Store, subject: Term, predicate: string): string | undefined {
  const term = getFirstObject(store, subject, predicate);
  return isLiteral(term) ? term.value : undefined;
}

function getNamedNodeLocal(store: Store, subject: Term, predicate: string): string | undefined {
  const term = getFirstObject(store, subject, predicate);
  return isNamedNode(term) ? localName(term.value) : undefined;
}

function getNumericLiteral(store: Store, subject: Term, predicate: string): number | undefined {
  const value = getLiteralValue(store, subject, predicate);
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function readJsonFile<T>(filePath: string): Promise<T> {
  return fs.readFile(filePath, 'utf8').then((content) => JSON.parse(content) as T);
}

async function ensureInputFilesExist(): Promise<void> {
  for (const filePath of [SHAPES_FILE, SNAPSHOT_FILE]) {
    await fs.access(filePath);
  }
}

function parseShaclShapes(ttlContent: string): ShaclNodeShape[] {
  const parser = new Parser();
  const store = new Store(parser.parse(ttlContent));
  const nodeShapeTerms = store.getSubjects(RDF_TYPE, `${SH}NodeShape`, null);

  const shapes = nodeShapeTerms
    .filter(isNamedNode)
    .map((shapeTerm) => {
      const targetClass = getNamedNodeLocal(store, shapeTerm, `${SH}targetClass`);
      if (!targetClass) {
        return null;
      }

      const propertyConstraints = store.getObjects(shapeTerm, `${SH}property`, null)
        .filter((term) => isBlankNode(term) || isNamedNode(term))
        .map((constraintTerm) => {
          const pathName = getNamedNodeLocal(store, constraintTerm, `${SH}path`);
          if (!pathName) {
            return null;
          }

          const severity = severityFromIri(
            isNamedNode(getFirstObject(store, constraintTerm, `${SH}severity`))
              ? (getFirstObject(store, constraintTerm, `${SH}severity`) as NamedNode).value
              : undefined,
          );

          return {
            id: constraintTerm.value,
            path: pathName,
            minCount: getNumericLiteral(store, constraintTerm, `${SH}minCount`),
            maxCount: getNumericLiteral(store, constraintTerm, `${SH}maxCount`),
            datatype: getNamedNodeLocal(store, constraintTerm, `${SH}datatype`),
            className: getNamedNodeLocal(store, constraintTerm, `${SH}class`),
            nodeKind: getNamedNodeLocal(store, constraintTerm, `${SH}nodeKind`),
            severity,
            message: getLiteralValue(store, constraintTerm, `${SH}message`),
          } as ShaclPropertyConstraint;
        })
        .filter((constraint): constraint is ShaclPropertyConstraint => constraint !== null);

      return {
        id: localName(shapeTerm.value),
        targetClass,
        properties: propertyConstraints,
      } as ShaclNodeShape;
    })
    .filter((shape): shape is ShaclNodeShape => shape !== null);

  return shapes.sort((left, right) => left.id.localeCompare(right.id));
}

function buildSnapshotState(graph: GraphData): SnapshotState {
  const nodeById = new Map<string, GraphNode>();
  const outgoingByNodeId = new Map<string, Map<string, GraphRelationship[]>>();

  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  for (const relationship of graph.relationships) {
    const fromMap = outgoingByNodeId.get(relationship.from) ?? new Map<string, GraphRelationship[]>();
    const key = normalizeToken(relationship.type);
    const existing = fromMap.get(key) ?? [];
    existing.push(relationship);
    fromMap.set(key, existing);
    outgoingByNodeId.set(relationship.from, fromMap);
  }

  return { nodeById, outgoingByNodeId };
}

function flattenPropertyValues(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenPropertyValues(entry));
  }
  return [value];
}

function resolveConstraintValues(node: GraphNode, constraint: ShaclPropertyConstraint, snapshot: SnapshotState): ResolvedValue[] {
  const normalizedPath = normalizeToken(constraint.path);
  const propertyValues: ResolvedValue[] = [];

  for (const [key, rawValue] of Object.entries(node.properties ?? {})) {
    if (normalizeToken(key) !== normalizedPath) {
      continue;
    }
    for (const value of flattenPropertyValues(rawValue)) {
      propertyValues.push({ value, source: 'property' });
    }
  }

  const outgoing = snapshot.outgoingByNodeId.get(node.id)?.get(normalizedPath) ?? [];
  const relationshipValues = outgoing.map((relationship) => ({
    value: relationship.to,
    source: 'relationship' as const,
    relationship,
    targetNode: snapshot.nodeById.get(relationship.to),
  }));

  return [...propertyValues, ...relationshipValues];
}

function nodeMatchesTargetClass(node: GraphNode, targetClass: string): boolean {
  const target = normalizeToken(targetClass);
  return node.labels.some((label) => normalizeToken(label) === target);
}

function validateDatatype(value: unknown, datatype?: string): boolean {
  if (!datatype) {
    return true;
  }
  if (value === null || value === undefined) {
    return true;
  }

  switch (datatype) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' ? Number.isInteger(value) : /^-?\d+$/.test(String(value));
    case 'decimal':
    case 'double':
    case 'float':
      return !Number.isNaN(Number(value));
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false';
    default:
      return true;
  }
}

function validateNodeKind(value: ResolvedValue, nodeKind?: string): boolean {
  if (!nodeKind || nodeKind !== 'IRI') {
    return true;
  }
  if (value.source === 'relationship') {
    return Boolean(value.targetNode?.id) && /^[a-z][a-z0-9+.-]*:/i.test(String(value.targetNode?.id));
  }
  return typeof value.value === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value.value);
}

function validateClass(value: ResolvedValue, className?: string): boolean {
  if (!className) {
    return true;
  }
  if (value.source !== 'relationship' || !value.targetNode) {
    return false;
  }
  const target = normalizeToken(className);
  return value.targetNode.labels.some((label) => normalizeToken(label) === target);
}

function buildConstraintMessage(
  node: GraphNode,
  shape: ShaclNodeShape,
  constraint: ShaclPropertyConstraint,
): ValidationViolation {
  return {
    shape: shape.id,
    focusNode: node.id,
    path: constraint.path,
    message: constraint.message ?? `${shape.id}.${constraint.path}: constraint violation`,
    severity: constraint.severity,
  };
}

function validateSnapshotAgainstShapes(graph: GraphData, shapes: ShaclNodeShape[]): ValidationResultBundle {
  const snapshot = buildSnapshotState(graph);
  const nodesValidatedPerShape: NodesValidatedPerShape[] = [];
  const violations: ValidationViolation[] = [];

  for (const shape of shapes) {
    const matchingNodes = graph.nodes.filter((node) => nodeMatchesTargetClass(node, shape.targetClass));
    nodesValidatedPerShape.push({
      shape: shape.id,
      targetClass: shape.targetClass,
      nodesValidated: matchingNodes.length,
    });

    for (const node of matchingNodes) {
      for (const constraint of shape.properties) {
        const values = resolveConstraintValues(node, constraint, snapshot);

        if (constraint.minCount !== undefined && values.length < constraint.minCount) {
          violations.push(buildConstraintMessage(node, shape, constraint));
          continue;
        }

        if (constraint.maxCount !== undefined && values.length > constraint.maxCount) {
          violations.push(buildConstraintMessage(node, shape, constraint));
          continue;
        }

        if (values.length === 0) {
          continue;
        }

        const invalidDatatype = values.find((value) => !validateDatatype(value.value, constraint.datatype));
        if (invalidDatatype) {
          violations.push(buildConstraintMessage(node, shape, constraint));
          continue;
        }

        const invalidNodeKind = values.find((value) => !validateNodeKind(value, constraint.nodeKind));
        if (invalidNodeKind) {
          violations.push(buildConstraintMessage(node, shape, constraint));
          continue;
        }

        const invalidClass = values.find((value) => !validateClass(value, constraint.className));
        if (invalidClass) {
          violations.push(buildConstraintMessage(node, shape, constraint));
        }
      }
    }
  }

  return {
    validationMode: 'snapshot-fallback',
    totalShapesValidated: shapes.length,
    nodesValidatedPerShape,
    violations,
    snapshotNotice: 'Snapshot validation checked domain-data/cultural-moma/output/codex/graph-data.json and did not validate the active database contents.',
  };
}

function toPlainObject(record: Neo4jRecord): Record<string, unknown> {
  const object = record.toObject();
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, neo4j.isInt(value) ? (value as Integer).toNumber() : value]));
}

function firstDefinedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function normalizeLiveSeverity(value: unknown): ShaclSeverity {
  if (typeof value === 'string' && value.trim() !== '') {
    if (value.startsWith('sh:')) {
      return value as ShaclSeverity;
    }
    return severityFromIri(value);
  }
  return 'sh:Violation';
}

function normalizeLiveViolations(result: QueryResult): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  for (const record of result.records) {
    const raw = toPlainObject(record);
    const shape = firstDefinedString(raw.shape, raw.shapeId, raw.sourceShape, raw.propertyShape, raw.constraintComponent);
    const focusNode = firstDefinedString(raw.focusNode, raw.nodeId, raw.node, raw.subject);
    const path = firstDefinedString(raw.path, raw.resultPath, raw.property, raw.propertyName);
    const message = firstDefinedString(raw.message, raw.resultMessage, raw.details, raw.description);
    const severity = normalizeLiveSeverity(raw.severity ?? raw.resultSeverity);

    if (!shape && !focusNode && !message) {
      continue;
    }

    violations.push({
      shape: shape ?? 'UnknownShape',
      focusNode: focusNode ?? 'UnknownFocusNode',
      path: path ?? null,
      message: message ?? 'SHACL validation issue reported by n10s',
      severity,
    });
  }

  return violations;
}

function deriveNodesValidatedPerShapeFromCounts(
  shapes: ShaclNodeShape[],
  labelCounts: Array<{ label: string; count: number }>,
): NodesValidatedPerShape[] {
  return shapes.map((shape) => {
    const target = normalizeToken(shape.targetClass);
    const nodesValidated = labelCounts
      .filter((entry) => normalizeToken(entry.label) === target)
      .reduce((sum, entry) => sum + entry.count, 0);

    return {
      shape: shape.id,
      targetClass: shape.targetClass,
      nodesValidated,
    };
  });
}

async function fetchLiveLabelCounts(driver: Driver, config: RuntimeConfig): Promise<Array<{ label: string; count: number }>> {
  const session = driver.session({ database: config.database });
  try {
    const result = await session.run(
      'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label',
    );
    return result.records.map((record) => ({
      label: String(record.get('label')),
      count: asNumber(record.get('count')),
    }));
  } finally {
    await session.close();
  }
}

function buildSetupInstructions(): string[] {
  return [
    'Verify NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, and optional NEO4J_DATABASE are set correctly.',
    "Verify neosemantics is installed and registered: CALL dbms.procedures() YIELD name WHERE name STARTS WITH 'n10s.validation.shacl' RETURN name ORDER BY name",
    'If n10s is missing, install the neosemantics plugin version that matches your Neo4j version and restart the database.',
    'Ensure the Neo4j user has permission to execute n10s procedures.',
    'Retry after confirming the database is reachable from the runtime environment.',
  ];
}

async function validateViaLiveNeo4j(ttlContent: string, shapes: ShaclNodeShape[]): Promise<ValidationResultBundle> {
  const config = getRuntimeConfig();
  const driver = createDriver(config);
  const labelCounts = await fetchLiveLabelCounts(driver, config);
  const session = driver.session({ database: config.database });
  const escapedTtl = escapeForCypherSingleQuotedLiteral(ttlContent);

  try {
    await driver.verifyConnectivity();
    const transaction = session.beginTransaction();

    try {
      await transaction.run(`CALL n10s.validation.shacl.import.inline('${escapedTtl}', 'Turtle')`);

      let violations: ValidationViolation[] = [];
      const liveQueries = [
        `CALL n10s.validation.shacl.validate() YIELD focusNode, nodeType, shapeId, propertyShape, offendingValue, resultPath, severity, resultMessage
         RETURN focusNode, nodeType, shapeId, propertyShape, offendingValue, resultPath, severity, resultMessage`,
        `CALL n10s.validation.shacl.validate()`,
      ];

      let lastValidationError: unknown = null;
      for (const query of liveQueries) {
        try {
          const result = await transaction.run(query);
          violations = normalizeLiveViolations(result);
          lastValidationError = null;
          break;
        } catch (error) {
          lastValidationError = error;
        }
      }

      await transaction.rollback();

      if (lastValidationError) {
        throw lastValidationError;
      }

      return {
        validationMode: 'live-neo4j-n10s',
        totalShapesValidated: shapes.length,
        nodesValidatedPerShape: deriveNodesValidatedPerShapeFromCounts(shapes, labelCounts),
        violations,
      };
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Ignore rollback errors on a failed live attempt.
      }
      throw error;
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

function summarizeViolations(violations: ValidationViolation[]): {
  violationsBySeverity: Record<ShaclSeverity, ValidationViolation[]>;
  summaryCounts: SummaryCounts;
  topViolations: ViolationGroup[];
} {
  const violationsBySeverity: Record<ShaclSeverity, ValidationViolation[]> = {
    'sh:Violation': [],
    'sh:Warning': [],
    'sh:Info': [],
  };

  for (const violation of violations) {
    violationsBySeverity[violation.severity].push(violation);
  }

  const grouped = new Map<string, ViolationGroup>();
  for (const violation of violations) {
    const key = [violation.severity, violation.shape, violation.path ?? '', violation.message].join('||');
    const current = grouped.get(key) ?? {
      severity: violation.severity,
      shape: violation.shape,
      path: violation.path,
      message: violation.message,
      count: 0,
      examples: [],
    };
    current.count += 1;
    if (current.examples.length < 3 && !current.examples.includes(violation.focusNode)) {
      current.examples.push(violation.focusNode);
    }
    grouped.set(key, current);
  }

  const topViolations = Array.from(grouped.values())
    .sort((left, right) => right.count - left.count || left.severity.localeCompare(right.severity) || left.shape.localeCompare(right.shape))
    .slice(0, 10);

  const summaryCounts: SummaryCounts = {
    'sh:Violation': violationsBySeverity['sh:Violation'].length,
    'sh:Warning': violationsBySeverity['sh:Warning'].length,
    'sh:Info': violationsBySeverity['sh:Info'].length,
    totalViolations: violations.length,
  };

  return { violationsBySeverity, summaryCounts, topViolations };
}

function formatLiveAttemptError(error: unknown): { message: string; setupInstructions: string[] } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    setupInstructions: buildSetupInstructions(),
  };
}

function buildReport(
  shapesFileContent: string,
  result: ValidationResultBundle,
): ValidationReport {
  const summary = summarizeViolations(result.violations);
  return {
    validationMode: result.validationMode,
    executedAt: new Date().toISOString(),
    overallPass: summary.summaryCounts['sh:Violation'] === 0,
    totalShapesValidated: result.totalShapesValidated,
    shapesFile: {
      path: path.relative(PROJECT_ROOT, SHAPES_FILE),
      sha256: sha256(shapesFileContent),
      lineCount: shapesFileContent.split(/\r?\n/).length,
    },
    snapshotFile: {
      path: path.relative(PROJECT_ROOT, SNAPSHOT_FILE),
      validatedActiveDatabaseContents: result.validationMode === 'live-neo4j-n10s',
    },
    nodesValidatedPerShape: result.nodesValidatedPerShape,
    violationsBySeverity: summary.violationsBySeverity,
    violations: result.violations,
    summaryCounts: summary.summaryCounts,
    topViolations: summary.topViolations,
    liveAttemptError: result.liveAttemptError,
    snapshotNotice: result.snapshotNotice,
  };
}

function printConsoleSummary(report: ValidationReport): void {
  console.log('SHACL Validation Summary');
  console.log(`Mode: ${report.validationMode}`);

  if (report.snapshotNotice) {
    console.log(`Note: ${report.snapshotNotice}`);
  }

  console.log(`Total shapes validated: ${formatNumber(report.totalShapesValidated)}`);
  console.log('');
  console.log('Nodes validated per shape:');
  for (const entry of report.nodesValidatedPerShape) {
    console.log(`- ${entry.shape} (${entry.targetClass}): ${formatNumber(entry.nodesValidated)}`);
  }

  console.log('');
  console.log('Violations by severity:');
  console.log(`- sh:Violation: ${formatNumber(report.summaryCounts['sh:Violation'])}`);
  console.log(`- sh:Warning: ${formatNumber(report.summaryCounts['sh:Warning'])}`);
  console.log(`- sh:Info: ${formatNumber(report.summaryCounts['sh:Info'])}`);

  console.log('');
  console.log('Top violations with examples:');
  if (report.topViolations.length === 0) {
    console.log('- None');
  } else {
    for (const entry of report.topViolations) {
      const examples = entry.examples.length > 0 ? ` | examples: ${entry.examples.join(', ')}` : '';
      console.log(
        `- ${entry.severity} | ${entry.shape} | ${entry.path ?? '(no path)'} | count ${formatNumber(entry.count)}${examples}`,
      );
    }
  }

  console.log('');
  console.log(`Overall status: ${report.overallPass ? 'PASS' : 'FAIL'}`);

  if (report.liveAttemptError) {
    console.log('');
    console.log('Live Neo4j n10s path failed:');
    console.log(`- ${report.liveAttemptError.message}`);
    console.log('Setup instructions:');
    for (const instruction of report.liveAttemptError.setupInstructions) {
      console.log(`- ${instruction}`);
    }
  }
}

async function main(): Promise<void> {
  await ensureInputFilesExist();

  const [ttlContent, graph] = await Promise.all([
    fs.readFile(SHAPES_FILE, 'utf8'),
    readJsonFile<GraphData>(SNAPSHOT_FILE),
  ]);
  const shapes = parseShaclShapes(ttlContent);

  let result: ValidationResultBundle;
  try {
    result = await validateViaLiveNeo4j(ttlContent, shapes);
  } catch (error) {
    result = validateSnapshotAgainstShapes(graph, shapes);
    result.liveAttemptError = formatLiveAttemptError(error);
  }

  const report = buildReport(ttlContent, result);
  await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  printConsoleSummary(report);
}

main().catch((error) => {
  console.error('Fatal SHACL validation error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
