import * as fs from "fs";
import * as path from "path";
import neo4j, { Driver, Session, Integer } from "neo4j-driver";

// ============================================================
// Configuration
// ============================================================

const DATA_DIR = process.env.DATA_DIR || "domain-data/geospatial";
const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "123123123";
const NEO4J_DATABASE = process.env.NEO4J_DATABASE || "neo4j";

const OUTPUT_DIR = path.resolve(DATA_DIR, "output");
const ONTOLOGY_FILE = path.resolve(OUTPUT_DIR, "ontology-structure.json");
const MAPPING_FILE = path.resolve(OUTPUT_DIR, "ontology-mapping-guide.json");
const REPORT_JSON = path.resolve(OUTPUT_DIR, "validation-report.json");
const REPORT_TXT = path.resolve(OUTPUT_DIR, "validation-report.txt");
const FIXES_FILE = path.resolve(OUTPUT_DIR, "fixes.cypher");
const DETAILS_FILE = path.resolve(OUTPUT_DIR, "violations-details.json");

const MAX_EXAMPLES = 5;
const SAMPLE_LIMIT = 10;

// ============================================================
// Types
// ============================================================

interface OntologyClass {
  uri: string;
  label: string;
  definition: string;
  superClasses: string[];
  equivalentClasses: string[];
}

interface OntologyObjectProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string[];
  superProperties: string[];
  inverseOf: string;
}

interface OntologyDataProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string;
}

interface OntologyStructure {
  metadata: {
    title: string;
    version: string;
    description: string;
    sourceFiles: string[];
    namespaces: Record<string, string>;
  };
  classes: OntologyClass[];
  objectProperties: OntologyObjectProperty[];
  dataProperties: OntologyDataProperty[];
}

interface MappingPattern {
  scenario: string;
  ontologyClass: string;
  requiredProperties: string[];
  optionalProperties: string[];
  relationships: string[];
}

interface MappingGuide {
  commonPatterns: MappingPattern[];
  allowedNamespaces: string[];
  constraints: string[];
}

interface ViolationExample {
  nodeId?: string;
  labels?: string[];
  properties?: Record<string, unknown>;
  context?: string;
}

interface FixStrategy {
  strategy: string;
  cypherQuery: string;
  description: string;
  risk: "safe" | "moderate" | "destructive";
}

interface Violation {
  category: "class" | "objectProperty" | "dataProperty" | "required" | "structure";
  type: string;
  property: string;
  severity: "error" | "warning" | "info";
  count: number;
  description: string;
  examples: ViolationExample[];
  fixStrategies: FixStrategy[];
}

interface ValidationReport {
  metadata: {
    validatedAt: string;
    ontologyName: string;
    ontologyVersion: string;
    graphSource: string;
  };
  overallCompliance: {
    isCompliant: boolean;
    score: number;
    grade: "A" | "B" | "C" | "D" | "F";
  };
  statistics: {
    totalNodes: number;
    totalRelationships: number;
    nodesAnalyzed: number;
    relationshipsAnalyzed: number;
  };
  violations: Violation[];
  violationSummary: {
    byCategory: Record<string, number>;
    bySeverity: { errors: number; warnings: number; info: number };
    topViolations: { type: string; count: number; severity: string }[];
  };
  ontologyRequirements: {
    validLabels: { met: boolean; invalid: string[] };
    validNamespaces: { met: boolean; invalid: string[] };
    validDomainRanges: { met: boolean; violations: number };
    hasRequiredProperties: { met: boolean; missing: string[] };
  };
  recommendations: { priority: number; action: string; reasoning: string; impact: string }[];
}

// ============================================================
// Helpers
// ============================================================

const toInt = (v: unknown): number => {
  if (v instanceof Integer || (typeof v === "object" && v !== null && "low" in v && "high" in v)) {
    return (v as Integer).toNumber();
  }
  return Number(v) || 0;
};

const extractLocalName = (uri: string): string => {
  const hash = uri.lastIndexOf("#");
  if (hash >= 0) return uri.substring(hash + 1);
  const slash = uri.lastIndexOf("/");
  if (slash >= 0) return uri.substring(slash + 1);
  return uri;
};

const resolvePrefixed = (prefixed: string, namespaces: Record<string, string>): string => {
  const colon = prefixed.indexOf(":");
  if (colon < 0) return prefixed;
  const prefix = prefixed.substring(0, colon);
  const local = prefixed.substring(colon + 1);
  if (namespaces[prefix]) return namespaces[prefix] + local;
  return prefixed;
};

const resolveToLabel = (prefixed: string, namespaces: Record<string, string>): string => {
  const full = resolvePrefixed(prefixed, namespaces);
  return extractLocalName(full);
};

const computeGrade = (score: number): "A" | "B" | "C" | "D" | "F" => {
  if (score >= 95) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
};

// ============================================================
// Build Validation Rules from Ontology
// ============================================================

interface ValidationRules {
  validClassLabels: Set<string>;
  classLabelToUri: Map<string, string>;
  classHierarchy: Map<string, Set<string>>; // label -> set of superclass labels
  objectPropertyRules: {
    label: string;
    uri: string;
    domainLabels: string[];
    rangeLabels: string[];
  }[];
  dataPropertyRules: {
    label: string;
    uri: string;
    domainLabels: string[];
    rangeType: string;
  }[];
  requiredPropertiesByClass: Map<string, string[]>;
  validNamespacePrefixes: string[];
  validNamespaceUris: string[];
}

const buildValidationRules = (
  ontology: OntologyStructure,
  mapping: MappingGuide
): ValidationRules => {
  const ns = ontology.metadata.namespaces;

  // Valid class labels
  const validClassLabels = new Set<string>();
  const classLabelToUri = new Map<string, string>();
  const classHierarchy = new Map<string, Set<string>>();

  for (const cls of ontology.classes) {
    const label = extractLocalName(cls.uri);
    validClassLabels.add(label);
    classLabelToUri.set(label, cls.uri);

    const superLabels = new Set<string>();
    for (const sup of cls.superClasses) {
      superLabels.add(resolveToLabel(sup, ns));
    }
    classHierarchy.set(label, superLabels);
  }

  // Object property domain/range rules
  const objectPropertyRules = ontology.objectProperties.map((op) => ({
    label: extractLocalName(op.uri),
    uri: op.uri,
    domainLabels: op.domain.map((d) => resolveToLabel(d, ns)),
    rangeLabels: op.range.map((r) => resolveToLabel(r, ns)),
  }));

  // Data property domain/range rules
  const dataPropertyRules = ontology.dataProperties.map((dp) => ({
    label: extractLocalName(dp.uri),
    uri: dp.uri,
    domainLabels: dp.domain.map((d) => resolveToLabel(d, ns)),
    rangeType: dp.range,
  }));

  // Required properties from mapping guide
  const requiredPropertiesByClass = new Map<string, string[]>();
  for (const pattern of mapping.commonPatterns) {
    if (pattern.requiredProperties.length > 0) {
      const classLabel = resolveToLabel(pattern.ontologyClass, ns);
      const propLabels = pattern.requiredProperties.map((p) => resolveToLabel(p, ns));
      requiredPropertiesByClass.set(classLabel, propLabels);
    }
  }

  // Namespace prefixes
  const validNamespacePrefixes = Object.keys(ns);
  const validNamespaceUris = Object.values(ns);

  return {
    validClassLabels,
    classLabelToUri,
    classHierarchy,
    objectPropertyRules,
    dataPropertyRules,
    requiredPropertiesByClass,
    validNamespacePrefixes,
    validNamespaceUris,
  };
};

// Check if a label is compatible with the expected label (considering class hierarchy)
const isLabelCompatible = (
  actualLabel: string,
  expectedLabel: string,
  rules: ValidationRules
): boolean => {
  if (actualLabel === expectedLabel) return true;
  // Check if actualLabel is a subclass of expectedLabel
  const supers = rules.classHierarchy.get(actualLabel);
  if (supers && supers.has(expectedLabel)) return true;
  // Transitive check: walk up hierarchy
  const visited = new Set<string>();
  const queue = [actualLabel];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === expectedLabel) return true;
    const parents = rules.classHierarchy.get(current);
    if (parents) {
      for (const p of parents) queue.push(p);
    }
  }
  return false;
};

// ============================================================
// Validation Functions
// ============================================================

const validateClassLabels = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  const result = await session.run(
    "MATCH (n) RETURN DISTINCT labels(n) as nodeLabels, count(*) as count"
  );

  const invalidLabels: { label: string; count: number }[] = [];
  let totalAnalyzed = 0;

  for (const record of result.records) {
    const labels: string[] = record.get("nodeLabels");
    const count = toInt(record.get("count"));
    totalAnalyzed += count;

    for (const label of labels) {
      if (!rules.validClassLabels.has(label)) {
        invalidLabels.push({ label, count });
      }
    }
  }

  if (invalidLabels.length > 0) {
    for (const inv of invalidLabels) {
      // Get examples
      const exResult = await session.run(
        `MATCH (n) WHERE $label IN labels(n) RETURN n LIMIT ${SAMPLE_LIMIT}`,
        { label: inv.label }
      );
      const examples: ViolationExample[] = exResult.records.slice(0, MAX_EXAMPLES).map((r) => {
        const node = r.get("n");
        return {
          nodeId: node.properties.uri || node.identity.toString(),
          labels: node.labels,
          properties: { uri: node.properties.uri },
          context: `Node with invalid label "${inv.label}"`,
        };
      });

      violations.push({
        category: "class",
        type: "invalid_class_label",
        property: inv.label,
        severity: "error",
        count: inv.count,
        description: `Label "${inv.label}" is not defined in the ontology. Found ${inv.count} node(s) with this label.`,
        examples,
        fixStrategies: [
          {
            strategy: "relabel_nodes",
            cypherQuery: `// MATCH (n:\`${inv.label}\`) SET n:\`CorrectLabel\` REMOVE n:\`${inv.label}\``,
            description: `Relabel nodes from "${inv.label}" to a valid ontology class`,
            risk: "moderate",
          },
          {
            strategy: "delete_invalid_nodes",
            cypherQuery: `// MATCH (n:\`${inv.label}\`) DETACH DELETE n`,
            description: `Delete all nodes with invalid label "${inv.label}" (DESTRUCTIVE)`,
            risk: "destructive",
          },
        ],
      });
    }
  }

  return violations;
};

const validateObjectPropertyDomainRange = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  // Get all relationship types in Neo4j
  const relTypesResult = await session.run(
    "MATCH ()-[r]->() RETURN DISTINCT type(r) as relType, count(*) as count"
  );

  const neo4jRelTypes = new Map<string, number>();
  for (const rec of relTypesResult.records) {
    neo4jRelTypes.set(rec.get("relType"), toInt(rec.get("count")));
  }

  for (const opRule of rules.objectPropertyRules) {
    const relType = opRule.label;

    if (!neo4jRelTypes.has(relType)) continue;

    if (opRule.domainLabels.length === 0 && opRule.rangeLabels.length === 0) continue;

    // Check domain violations
    if (opRule.domainLabels.length > 0) {
      const domainResult = await session.run(
        `MATCH (source)-[r:\`${relType}\`]->() RETURN DISTINCT labels(source) as srcLabels, count(*) as count`
      );

      for (const rec of domainResult.records) {
        const srcLabels: string[] = rec.get("srcLabels");
        const count = toInt(rec.get("count"));

        const domainOk = srcLabels.some((sl) =>
          opRule.domainLabels.some((dl) => isLabelCompatible(sl, dl, rules))
        );

        if (!domainOk) {
          const exResult = await session.run(
            `MATCH (source)-[r:\`${relType}\`]->() WHERE labels(source) = $labels RETURN source LIMIT ${SAMPLE_LIMIT}`,
            { labels: srcLabels }
          );
          const examples: ViolationExample[] = exResult.records.slice(0, MAX_EXAMPLES).map((r) => {
            const node = r.get("source");
            return {
              nodeId: node.properties.uri || node.identity.toString(),
              labels: node.labels,
              context: `Source of "${relType}" has labels [${srcLabels.join(", ")}], expected domain: [${opRule.domainLabels.join(", ")}]`,
            };
          });

          violations.push({
            category: "objectProperty",
            type: "domain_violation",
            property: relType,
            severity: "error",
            count,
            description: `Relationship "${relType}" has ${count} source node(s) with labels [${srcLabels.join(", ")}] that don't match ontology domain [${opRule.domainLabels.join(", ")}].`,
            examples,
            fixStrategies: [
              {
                strategy: "add_domain_label",
                cypherQuery: `MATCH (source)-[r:\`${relType}\`]->() WHERE NOT "${opRule.domainLabels[0]}" IN labels(source) SET source:\`${opRule.domainLabels[0]}\``,
                description: `Add expected domain label "${opRule.domainLabels[0]}" to source nodes`,
                risk: "moderate",
              },
            ],
          });
        }
      }
    }

    // Check range violations
    if (opRule.rangeLabels.length > 0) {
      const rangeResult = await session.run(
        `MATCH ()-[r:\`${relType}\`]->(target) RETURN DISTINCT labels(target) as tgtLabels, count(*) as count`
      );

      for (const rec of rangeResult.records) {
        const tgtLabels: string[] = rec.get("tgtLabels");
        const count = toInt(rec.get("count"));

        const rangeOk = tgtLabels.some((tl) =>
          opRule.rangeLabels.some((rl) => isLabelCompatible(tl, rl, rules))
        );

        if (!rangeOk) {
          const exResult = await session.run(
            `MATCH ()-[r:\`${relType}\`]->(target) WHERE labels(target) = $labels RETURN target LIMIT ${SAMPLE_LIMIT}`,
            { labels: tgtLabels }
          );
          const examples: ViolationExample[] = exResult.records.slice(0, MAX_EXAMPLES).map((r) => {
            const node = r.get("target");
            return {
              nodeId: node.properties.uri || node.identity.toString(),
              labels: node.labels,
              context: `Target of "${relType}" has labels [${tgtLabels.join(", ")}], expected range: [${opRule.rangeLabels.join(", ")}]`,
            };
          });

          violations.push({
            category: "objectProperty",
            type: "range_violation",
            property: relType,
            severity: "error",
            count,
            description: `Relationship "${relType}" has ${count} target node(s) with labels [${tgtLabels.join(", ")}] that don't match ontology range [${opRule.rangeLabels.join(", ")}].`,
            examples,
            fixStrategies: [
              {
                strategy: "add_range_label",
                cypherQuery: `MATCH ()-[r:\`${relType}\`]->(target) WHERE NOT "${opRule.rangeLabels[0]}" IN labels(target) SET target:\`${opRule.rangeLabels[0]}\``,
                description: `Add expected range label "${opRule.rangeLabels[0]}" to target nodes`,
                risk: "moderate",
              },
            ],
          });
        }
      }
    }
  }

  // Check for relationship types not in ontology
  const validRelTypes = new Set(rules.objectPropertyRules.map((op) => op.label));
  for (const [relType, count] of neo4jRelTypes) {
    if (!validRelTypes.has(relType)) {
      const exResult = await session.run(
        `MATCH (s)-[r:\`${relType}\`]->(t) RETURN s, t LIMIT ${SAMPLE_LIMIT}`
      );
      const examples: ViolationExample[] = exResult.records.slice(0, MAX_EXAMPLES).map((r) => {
        const s = r.get("s");
        const t = r.get("t");
        return {
          nodeId: s.properties.uri || s.identity.toString(),
          labels: s.labels,
          context: `Relationship "${relType}" from [${s.labels.join(", ")}] to [${t.labels.join(", ")}]`,
        };
      });

      violations.push({
        category: "objectProperty",
        type: "invalid_relationship_type",
        property: relType,
        severity: "error",
        count,
        description: `Relationship type "${relType}" is not defined in the ontology. Found ${count} instance(s).`,
        examples,
        fixStrategies: [
          {
            strategy: "retype_relationship",
            cypherQuery: `// MATCH (s)-[r:\`${relType}\`]->(t) CREATE (s)-[:ValidType]->(t) DELETE r`,
            description: `Change relationship type to a valid ontology property`,
            risk: "moderate",
          },
          {
            strategy: "delete_invalid_relationships",
            cypherQuery: `// MATCH ()-[r:\`${relType}\`]->() DELETE r`,
            description: `Delete all relationships of invalid type "${relType}" (DESTRUCTIVE)`,
            risk: "destructive",
          },
        ],
      });
    }
  }

  return violations;
};

const validateDataPropertyDomains = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  for (const dpRule of rules.dataPropertyRules) {
    const propName = dpRule.label;
    if (dpRule.domainLabels.length === 0) continue;

    // Check if any nodes have this property
    const result = await session.run(
      `MATCH (n) WHERE n.\`${propName}\` IS NOT NULL RETURN DISTINCT labels(n) as nodeLabels, count(*) as count`
    );

    for (const rec of result.records) {
      const nodeLabels: string[] = rec.get("nodeLabels");
      const count = toInt(rec.get("count"));

      const domainOk = nodeLabels.some((nl) =>
        dpRule.domainLabels.some((dl) => isLabelCompatible(nl, dl, rules))
      );

      if (!domainOk) {
        violations.push({
          category: "dataProperty",
          type: "data_property_domain_violation",
          property: propName,
          severity: "warning",
          count,
          description: `Data property "${propName}" appears on ${count} node(s) with labels [${nodeLabels.join(", ")}], but ontology domain is [${dpRule.domainLabels.join(", ")}].`,
          examples: [],
          fixStrategies: [
            {
              strategy: "remove_property",
              cypherQuery: `MATCH (n) WHERE n.\`${propName}\` IS NOT NULL AND NOT "${dpRule.domainLabels[0]}" IN labels(n) REMOVE n.\`${propName}\``,
              description: `Remove property "${propName}" from nodes outside its domain`,
              risk: "moderate",
            },
          ],
        });
      }
    }
  }

  return violations;
};

const XSD_TYPE_VALIDATORS: Record<string, (val: unknown) => boolean> = {
  "xsd:integer": (v) => Number.isInteger(Number(v)),
  "xsd:double": (v) => !isNaN(Number(v)),
  "xsd:boolean": (v) => typeof v === "boolean" || v === "true" || v === "false",
  "xsd:date": (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
  "xsd:dateTime": (v) => typeof v === "string" && !isNaN(Date.parse(v)),
  "xsd:string": () => true,
};

const validateDataPropertyDatatypes = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  for (const dpRule of rules.dataPropertyRules) {
    const propName = dpRule.label;
    const rangeType = dpRule.rangeType;

    if (!rangeType) continue;

    // Normalize range type to xsd: prefix form
    let normalizedRange = rangeType;
    if (rangeType.startsWith("http://www.w3.org/2001/XMLSchema#")) {
      normalizedRange = "xsd:" + rangeType.replace("http://www.w3.org/2001/XMLSchema#", "");
    }

    const validator = XSD_TYPE_VALIDATORS[normalizedRange];
    if (!validator) continue;

    // Sample values to check
    const result = await session.run(
      `MATCH (n) WHERE n.\`${propName}\` IS NOT NULL RETURN n.\`${propName}\` as value, n.uri as uri LIMIT ${SAMPLE_LIMIT * 5}`
    );

    let invalidCount = 0;
    const invalidExamples: ViolationExample[] = [];

    for (const rec of result.records) {
      const value = rec.get("value");
      const neoVal = value instanceof Integer ? value.toNumber() : value;
      if (!validator(neoVal)) {
        invalidCount++;
        if (invalidExamples.length < MAX_EXAMPLES) {
          invalidExamples.push({
            nodeId: rec.get("uri"),
            context: `Property "${propName}" has value "${neoVal}" (type: ${typeof neoVal}), expected ${normalizedRange}`,
          });
        }
      }
    }

    if (invalidCount > 0) {
      violations.push({
        category: "dataProperty",
        type: "datatype_mismatch",
        property: propName,
        severity: "warning",
        count: invalidCount,
        description: `${invalidCount} sampled value(s) of "${propName}" don't match expected type "${normalizedRange}".`,
        examples: invalidExamples,
        fixStrategies: [
          {
            strategy: "cast_values",
            cypherQuery: `// MATCH (n) WHERE n.\`${propName}\` IS NOT NULL SET n.\`${propName}\` = toInteger(n.\`${propName}\`)`,
            description: `Cast values of "${propName}" to the correct type`,
            risk: "safe",
          },
        ],
      });
    }
  }

  return violations;
};

const validateRequiredProperties = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  for (const [classLabel, requiredProps] of rules.requiredPropertiesByClass) {
    if (requiredProps.length === 0) continue;

    for (const prop of requiredProps) {
      const result = await session.run(
        `MATCH (n:\`${classLabel}\`) WHERE n.\`${prop}\` IS NULL RETURN count(n) as missingCount`
      );
      const missingCount = toInt(result.records[0]?.get("missingCount"));

      if (missingCount > 0) {
        const exResult = await session.run(
          `MATCH (n:\`${classLabel}\`) WHERE n.\`${prop}\` IS NULL RETURN n LIMIT ${SAMPLE_LIMIT}`
        );
        const examples: ViolationExample[] = exResult.records.slice(0, MAX_EXAMPLES).map((r) => {
          const node = r.get("n");
          return {
            nodeId: node.properties.uri || node.identity.toString(),
            labels: node.labels,
            context: `Missing required property "${prop}" on ${classLabel} node`,
          };
        });

        violations.push({
          category: "required",
          type: "missing_required_property",
          property: `${classLabel}.${prop}`,
          severity: "error",
          count: missingCount,
          description: `${missingCount} "${classLabel}" node(s) are missing required property "${prop}".`,
          examples,
          fixStrategies: [
            {
              strategy: "add_default_value",
              cypherQuery: `MATCH (n:\`${classLabel}\`) WHERE n.\`${prop}\` IS NULL SET n.\`${prop}\` = "UNKNOWN"`,
              description: `Set default value for missing "${prop}" on "${classLabel}" nodes`,
              risk: "safe",
            },
          ],
        });
      }
    }
  }

  return violations;
};

const validateStructure = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  // Check for orphaned nodes
  const orphanResult = await session.run(
    "MATCH (n) WHERE NOT (n)--() RETURN labels(n) as nodeLabels, count(*) as count"
  );

  let totalOrphans = 0;
  const orphanExamples: ViolationExample[] = [];

  for (const rec of orphanResult.records) {
    const labels: string[] = rec.get("nodeLabels");
    const count = toInt(rec.get("count"));
    totalOrphans += count;

    if (orphanExamples.length < MAX_EXAMPLES) {
      orphanExamples.push({
        labels,
        context: `${count} orphaned node(s) with labels [${labels.join(", ")}]`,
      });
    }
  }

  if (totalOrphans > 0) {
    // Get sample orphan nodes
    const sampleResult = await session.run(
      `MATCH (n) WHERE NOT (n)--() RETURN n LIMIT ${SAMPLE_LIMIT}`
    );
    const detailedExamples: ViolationExample[] = sampleResult.records
      .slice(0, MAX_EXAMPLES)
      .map((r) => {
        const node = r.get("n");
        return {
          nodeId: node.properties.uri || node.identity.toString(),
          labels: node.labels,
          context: "Orphaned node with no relationships",
        };
      });

    violations.push({
      category: "structure",
      type: "orphaned_nodes",
      property: "graph_connectivity",
      severity: "warning",
      count: totalOrphans,
      description: `Found ${totalOrphans} orphaned node(s) with no relationships. These may indicate incomplete graph construction.`,
      examples: detailedExamples,
      fixStrategies: [
        {
          strategy: "investigate_orphans",
          cypherQuery: `MATCH (n) WHERE NOT (n)--() RETURN labels(n), count(*) as cnt ORDER BY cnt DESC`,
          description: "Investigate orphaned nodes by label distribution",
          risk: "safe",
        },
        {
          strategy: "delete_orphans",
          cypherQuery: `// MATCH (n) WHERE NOT (n)--() DELETE n`,
          description: "Delete all orphaned nodes (DESTRUCTIVE)",
          risk: "destructive",
        },
      ],
    });
  }

  // Verify at least one instance of each core class exists
  for (const classLabel of rules.validClassLabels) {
    const countResult = await session.run(
      `MATCH (n:\`${classLabel}\`) RETURN count(n) as cnt`
    );
    const cnt = toInt(countResult.records[0]?.get("cnt"));

    if (cnt === 0) {
      violations.push({
        category: "structure",
        type: "missing_class_instances",
        property: classLabel,
        severity: "info",
        count: 0,
        description: `No instances of ontology class "${classLabel}" found in the graph. This class may not be applicable to this dataset.`,
        examples: [],
        fixStrategies: [],
      });
    }
  }

  return violations;
};

const validatePropertyNamespaces = async (
  session: Session,
  rules: ValidationRules
): Promise<Violation[]> => {
  const violations: Violation[] = [];

  // Build set of all valid property names from the ontology
  const validPropertyNames = new Set<string>();

  // Add all data property local names
  for (const dp of rules.dataPropertyRules) {
    validPropertyNames.add(dp.label);
  }

  // Add all object property local names (they may appear as node properties in some encodings)
  for (const op of rules.objectPropertyRules) {
    validPropertyNames.add(op.label);
  }

  // Common Neo4j/graph infrastructure properties that are always valid
  const infraProperties = new Set([
    "uri", "id", "label", "altLabel", "hiddenLabel",
    "notation", "type", "spatial", "population", "modified",
    "temporal", "isPartOf", "typeLabel", "spatialLabel",
    "isPartOfLabel", "elevation",
  ]);

  // Get all unique property keys from the graph
  const propsResult = await session.run(
    "MATCH (n) UNWIND keys(n) AS key RETURN DISTINCT key, count(*) as cnt ORDER BY cnt DESC"
  );

  const invalidNamespaceProps: { key: string; count: number }[] = [];

  for (const rec of propsResult.records) {
    const key: string = rec.get("key");
    const count = toInt(rec.get("cnt"));

    // Skip infrastructure and valid ontology properties
    if (infraProperties.has(key) || validPropertyNames.has(key)) continue;

    // Check if the property matches any namespace prefix pattern
    const hasValidPrefix = rules.validNamespacePrefixes.some(
      (prefix) => key.startsWith(prefix + ":") || key.startsWith(prefix + "_")
    );

    // Check if it's a full URI matching a valid namespace
    const hasValidNamespace = rules.validNamespaceUris.some((nsUri) => key.startsWith(nsUri));

    if (!hasValidPrefix && !hasValidNamespace) {
      invalidNamespaceProps.push({ key, count });
    }
  }

  if (invalidNamespaceProps.length > 0) {
    for (const inv of invalidNamespaceProps) {
      violations.push({
        category: "dataProperty",
        type: "unrecognized_property",
        property: inv.key,
        severity: "info",
        count: inv.count,
        description: `Property "${inv.key}" appears on ${inv.count} node(s) but is not an ontology-defined property. It may be domain-specific metadata.`,
        examples: [],
        fixStrategies: [
          {
            strategy: "review_property",
            cypherQuery: `MATCH (n) WHERE n.\`${inv.key}\` IS NOT NULL RETURN DISTINCT labels(n), n.\`${inv.key}\` LIMIT 10`,
            description: `Review usage of property "${inv.key}"`,
            risk: "safe",
          },
        ],
      });
    }
  }

  return violations;
};

// ============================================================
// Scoring
// ============================================================

const computeComplianceScore = (violations: Violation[], stats: { totalNodes: number; totalRelationships: number }): number => {
  let penalty = 0;
  const total = stats.totalNodes + stats.totalRelationships;
  if (total === 0) return 100;

  for (const v of violations) {
    const proportion = v.count / total;

    switch (v.severity) {
      case "error":
        // Errors are weighted heavily
        if (v.category === "class" && v.type === "invalid_class_label") {
          penalty += Math.min(proportion * 200, 20);
        } else if (v.type === "invalid_relationship_type") {
          penalty += Math.min(proportion * 200, 20);
        } else if (v.type === "domain_violation" || v.type === "range_violation") {
          penalty += Math.min(proportion * 150, 15);
        } else if (v.type === "missing_required_property") {
          penalty += Math.min(proportion * 100, 10);
        } else {
          penalty += Math.min(proportion * 100, 10);
        }
        break;
      case "warning":
        if (v.type === "orphaned_nodes") {
          penalty += Math.min(proportion * 50, 10);
        } else {
          penalty += Math.min(proportion * 30, 5);
        }
        break;
      case "info":
        penalty += Math.min(0.5, 1);
        break;
    }
  }

  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
};

// ============================================================
// Report Generation
// ============================================================

const generateTextReport = (report: ValidationReport): string => {
  const lines: string[] = [];
  const hr = "=".repeat(72);
  const hr2 = "-".repeat(72);

  lines.push(hr);
  lines.push("  ONTOLOGY VALIDATION REPORT");
  lines.push(hr);
  lines.push("");
  lines.push(`  Ontology:    ${report.metadata.ontologyName} v${report.metadata.ontologyVersion}`);
  lines.push(`  Validated:   ${report.metadata.validatedAt}`);
  lines.push(`  Source:      ${report.metadata.graphSource}`);
  lines.push("");
  lines.push(hr2);
  lines.push("  COMPLIANCE SUMMARY");
  lines.push(hr2);
  lines.push("");
  lines.push(`  Score:       ${report.overallCompliance.score}/100`);
  lines.push(`  Grade:       ${report.overallCompliance.grade}`);
  lines.push(`  Status:      ${report.overallCompliance.isCompliant ? "COMPLIANT" : "NON-COMPLIANT"}`);
  lines.push("");
  lines.push(hr2);
  lines.push("  GRAPH STATISTICS");
  lines.push(hr2);
  lines.push("");
  lines.push(`  Total Nodes:           ${report.statistics.totalNodes.toLocaleString()}`);
  lines.push(`  Total Relationships:   ${report.statistics.totalRelationships.toLocaleString()}`);
  lines.push(`  Nodes Analyzed:        ${report.statistics.nodesAnalyzed.toLocaleString()}`);
  lines.push(`  Rels Analyzed:         ${report.statistics.relationshipsAnalyzed.toLocaleString()}`);
  lines.push("");
  lines.push(hr2);
  lines.push("  ISSUE BREAKDOWN");
  lines.push(hr2);
  lines.push("");
  lines.push(`  Errors:     ${report.violationSummary.bySeverity.errors}`);
  lines.push(`  Warnings:   ${report.violationSummary.bySeverity.warnings}`);
  lines.push(`  Info:       ${report.violationSummary.bySeverity.info}`);
  lines.push("");

  if (report.violationSummary.topViolations.length > 0) {
    lines.push("  Top Violations:");
    for (const tv of report.violationSummary.topViolations.slice(0, 10)) {
      lines.push(`    [${tv.severity.toUpperCase()}] ${tv.type}: ${tv.count.toLocaleString()} instance(s)`);
    }
    lines.push("");
  }

  lines.push(hr2);
  lines.push("  ONTOLOGY REQUIREMENTS");
  lines.push(hr2);
  lines.push("");
  const req = report.ontologyRequirements;
  lines.push(`  Valid Labels:          ${req.validLabels.met ? "PASS" : "FAIL"}`);
  if (req.validLabels.invalid.length > 0) {
    lines.push(`    Invalid: ${req.validLabels.invalid.join(", ")}`);
  }
  lines.push(`  Valid Namespaces:      ${req.validNamespaces.met ? "PASS" : "FAIL"}`);
  if (req.validNamespaces.invalid.length > 0) {
    lines.push(`    Unrecognized: ${req.validNamespaces.invalid.join(", ")}`);
  }
  lines.push(`  Domain/Range:          ${req.validDomainRanges.met ? "PASS" : `FAIL (${req.validDomainRanges.violations} violation(s))`}`);
  lines.push(`  Required Properties:   ${req.hasRequiredProperties.met ? "PASS" : "FAIL"}`);
  if (req.hasRequiredProperties.missing.length > 0) {
    lines.push(`    Missing: ${req.hasRequiredProperties.missing.join(", ")}`);
  }
  lines.push("");

  if (report.violations.length > 0) {
    lines.push(hr2);
    lines.push("  DETAILED VIOLATIONS");
    lines.push(hr2);
    lines.push("");

    for (let i = 0; i < report.violations.length; i++) {
      const v = report.violations[i];
      lines.push(`  ${i + 1}. [${v.severity.toUpperCase()}] ${v.type}`);
      lines.push(`     Category: ${v.category}`);
      lines.push(`     Property: ${v.property}`);
      lines.push(`     Count:    ${v.count.toLocaleString()}`);
      lines.push(`     ${v.description}`);
      if (v.examples.length > 0) {
        lines.push("     Examples:");
        for (const ex of v.examples.slice(0, 3)) {
          lines.push(`       - ${ex.context || ex.nodeId || "N/A"}`);
        }
      }
      lines.push("");
    }
  }

  if (report.recommendations.length > 0) {
    lines.push(hr2);
    lines.push("  RECOMMENDATIONS");
    lines.push(hr2);
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`  [P${rec.priority}] ${rec.action}`);
      lines.push(`       Reasoning: ${rec.reasoning}`);
      lines.push(`       Impact: ${rec.impact}`);
      lines.push("");
    }
  }

  lines.push(hr);
  lines.push(`  End of Report — Score: ${report.overallCompliance.score}/100 (Grade ${report.overallCompliance.grade})`);
  lines.push(hr);

  return lines.join("\n");
};

const generateFixesCypher = (violations: Violation[]): string => {
  const lines: string[] = [];
  lines.push("// ============================================================");
  lines.push("// AUTO-GENERATED FIX QUERIES");
  lines.push(`// Generated: ${new Date().toISOString()}`);
  lines.push("// ============================================================");
  lines.push("");

  const groups: Record<string, FixStrategy[]> = { safe: [], moderate: [], destructive: [] };

  for (const v of violations) {
    for (const fix of v.fixStrategies) {
      groups[fix.risk].push(fix);
    }
  }

  if (groups.safe.length > 0) {
    lines.push("// ---- SAFE FIXES (low risk, formatting/defaults) ----");
    lines.push("");
    for (const fix of groups.safe) {
      lines.push(`// ${fix.description}`);
      lines.push(fix.cypherQuery);
      lines.push("");
    }
  }

  if (groups.moderate.length > 0) {
    lines.push("// ---- MODERATE FIXES (review before running) ----");
    lines.push("");
    for (const fix of groups.moderate) {
      lines.push(`// ${fix.description}`);
      lines.push(fix.cypherQuery);
      lines.push("");
    }
  }

  if (groups.destructive.length > 0) {
    lines.push("// ---- DESTRUCTIVE FIXES (commented out — enable only if certain) ----");
    lines.push("");
    for (const fix of groups.destructive) {
      lines.push(`// ${fix.description}`);
      lines.push(`// ${fix.cypherQuery}`);
      lines.push("");
    }
  }

  return lines.join("\n");
};

// ============================================================
// Main
// ============================================================

const main = async (): Promise<void> => {
  console.log("\n========================================");
  console.log("  Ontology Validation — Gatekeeper #3");
  console.log("========================================\n");

  // Load files
  console.log("[1/7] Loading ontology and mapping files...");
  const ontology: OntologyStructure = JSON.parse(fs.readFileSync(ONTOLOGY_FILE, "utf-8"));
  const mapping: MappingGuide = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8"));

  console.log(`  Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  Classes: ${ontology.classes.length}`);
  console.log(`  Object Properties: ${ontology.objectProperties.length}`);
  console.log(`  Data Properties: ${ontology.dataProperties.length}`);

  // Build rules
  console.log("\n[2/7] Building validation rules from ontology...");
  const rules = buildValidationRules(ontology, mapping);
  console.log(`  Valid class labels: [${[...rules.validClassLabels].join(", ")}]`);
  console.log(`  Object property rules: ${rules.objectPropertyRules.length}`);
  console.log(`  Data property rules: ${rules.dataPropertyRules.length}`);
  console.log(`  Required properties: ${rules.requiredPropertiesByClass.size} class(es)`);

  // Connect to Neo4j
  console.log("\n[3/7] Connecting to Neo4j...");
  const driver: Driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session: Session = driver.session({ database: NEO4J_DATABASE });

  try {
    // Get graph statistics
    const statsResult = await session.run(
      "MATCH (n) RETURN count(n) as nodeCount"
    );
    const totalNodes = toInt(statsResult.records[0]?.get("nodeCount"));

    const relStatsResult = await session.run(
      "MATCH ()-[r]->() RETURN count(r) as relCount"
    );
    const totalRelationships = toInt(relStatsResult.records[0]?.get("relCount"));

    console.log(`  Connected! Nodes: ${totalNodes.toLocaleString()}, Relationships: ${totalRelationships.toLocaleString()}`);

    // Run validations
    console.log("\n[4/7] Running validation checks...");
    const allViolations: Violation[] = [];

    console.log("  [a] Validating class labels...");
    const classViolations = await validateClassLabels(session, rules);
    allViolations.push(...classViolations);
    console.log(`      ${classViolations.length} issue(s) found`);

    console.log("  [b] Validating object property domain/range...");
    const opViolations = await validateObjectPropertyDomainRange(session, rules);
    allViolations.push(...opViolations);
    console.log(`      ${opViolations.length} issue(s) found`);

    console.log("  [c] Validating data property domains...");
    const dpDomainViolations = await validateDataPropertyDomains(session, rules);
    allViolations.push(...dpDomainViolations);
    console.log(`      ${dpDomainViolations.length} issue(s) found`);

    console.log("  [d] Validating data property datatypes...");
    const dpTypeViolations = await validateDataPropertyDatatypes(session, rules);
    allViolations.push(...dpTypeViolations);
    console.log(`      ${dpTypeViolations.length} issue(s) found`);

    console.log("  [e] Checking required properties...");
    const reqViolations = await validateRequiredProperties(session, rules);
    allViolations.push(...reqViolations);
    console.log(`      ${reqViolations.length} issue(s) found`);

    console.log("  [f] Structural validation...");
    const structViolations = await validateStructure(session, rules);
    allViolations.push(...structViolations);
    console.log(`      ${structViolations.length} issue(s) found`);

    console.log("  [g] Property namespace validation...");
    const nsViolations = await validatePropertyNamespaces(session, rules);
    allViolations.push(...nsViolations);
    console.log(`      ${nsViolations.length} issue(s) found`);

    // Compute score
    console.log("\n[5/7] Computing compliance score...");
    const score = computeComplianceScore(allViolations, { totalNodes, totalRelationships });
    const grade = computeGrade(score);
    const isCompliant = score >= 70;

    // Build violation summary
    const byCategory: Record<string, number> = {};
    const bySeverity = { errors: 0, warnings: 0, info: 0 };
    for (const v of allViolations) {
      byCategory[v.category] = (byCategory[v.category] || 0) + 1;
      if (v.severity === "error") bySeverity.errors++;
      else if (v.severity === "warning") bySeverity.warnings++;
      else bySeverity.info++;
    }

    const topViolations = [...allViolations]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((v) => ({ type: v.type, count: v.count, severity: v.severity }));

    // Build ontology requirements summary
    const invalidLabels = allViolations
      .filter((v) => v.type === "invalid_class_label")
      .map((v) => v.property);
    const invalidNamespaces = allViolations
      .filter((v) => v.type === "unrecognized_property")
      .map((v) => v.property);
    const domainRangeViolations = allViolations.filter(
      (v) => v.type === "domain_violation" || v.type === "range_violation"
    ).length;
    const missingRequired = allViolations
      .filter((v) => v.type === "missing_required_property")
      .map((v) => v.property);

    // Recommendations
    const recommendations: { priority: number; action: string; reasoning: string; impact: string }[] = [];

    if (invalidLabels.length > 0) {
      recommendations.push({
        priority: 1,
        action: `Review and fix ${invalidLabels.length} invalid class label(s): ${invalidLabels.join(", ")}`,
        reasoning: "Invalid labels indicate nodes that don't conform to the ontology class hierarchy",
        impact: "High — directly affects ontology compliance score",
      });
    }

    const invalidRelTypes = allViolations.filter((v) => v.type === "invalid_relationship_type");
    if (invalidRelTypes.length > 0) {
      recommendations.push({
        priority: 1,
        action: `Review ${invalidRelTypes.length} invalid relationship type(s)`,
        reasoning: "Relationship types not in the ontology violate the schema",
        impact: "High — may indicate mapping errors",
      });
    }

    if (domainRangeViolations > 0) {
      recommendations.push({
        priority: 2,
        action: `Fix ${domainRangeViolations} domain/range constraint violation(s)`,
        reasoning: "Domain/range violations mean properties or relationships are attached to incorrect node types",
        impact: "Medium — affects query correctness and reasoning",
      });
    }

    if (missingRequired.length > 0) {
      recommendations.push({
        priority: 2,
        action: `Add missing required properties: ${missingRequired.join(", ")}`,
        reasoning: "Required properties ensure data completeness for downstream consumers",
        impact: "Medium — may affect data usability",
      });
    }

    const orphanViolation = allViolations.find((v) => v.type === "orphaned_nodes");
    if (orphanViolation && orphanViolation.count > 0) {
      recommendations.push({
        priority: 3,
        action: `Investigate ${orphanViolation.count.toLocaleString()} orphaned node(s)`,
        reasoning: "Orphaned nodes may indicate incomplete graph construction or failed relationship creation",
        impact: "Low — may affect graph traversal completeness",
      });
    }

    if (allViolations.length === 0) {
      recommendations.push({
        priority: 0,
        action: "No issues found — graph is fully compliant",
        reasoning: "All ontology constraints are satisfied",
        impact: "None — ready for production use",
      });
    }

    // Build report
    const report: ValidationReport = {
      metadata: {
        validatedAt: new Date().toISOString(),
        ontologyName: ontology.metadata.title,
        ontologyVersion: ontology.metadata.version,
        graphSource: "Neo4j",
      },
      overallCompliance: { isCompliant, score, grade },
      statistics: {
        totalNodes,
        totalRelationships,
        nodesAnalyzed: totalNodes,
        relationshipsAnalyzed: totalRelationships,
      },
      violations: allViolations,
      violationSummary: { byCategory, bySeverity, topViolations },
      ontologyRequirements: {
        validLabels: { met: invalidLabels.length === 0, invalid: invalidLabels },
        validNamespaces: { met: invalidNamespaces.length === 0, invalid: invalidNamespaces },
        validDomainRanges: { met: domainRangeViolations === 0, violations: domainRangeViolations },
        hasRequiredProperties: { met: missingRequired.length === 0, missing: missingRequired },
      },
      recommendations,
    };

    // Write outputs
    console.log("\n[6/7] Writing output files...");

    fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
    console.log(`  -> ${REPORT_JSON}`);

    const textReport = generateTextReport(report);
    fs.writeFileSync(REPORT_TXT, textReport);
    console.log(`  -> ${REPORT_TXT}`);

    const fixesCypher = generateFixesCypher(allViolations);
    fs.writeFileSync(FIXES_FILE, fixesCypher);
    console.log(`  -> ${FIXES_FILE}`);

    // Violations details (separate for large example payloads)
    const details = allViolations.map((v) => ({
      type: v.type,
      category: v.category,
      severity: v.severity,
      property: v.property,
      count: v.count,
      description: v.description,
      examples: v.examples,
    }));
    fs.writeFileSync(DETAILS_FILE, JSON.stringify(details, null, 2));
    console.log(`  -> ${DETAILS_FILE}`);

    // Console summary
    console.log("\n[7/7] Validation Complete");
    console.log("========================================");
    console.log(`  Compliance Score: ${score}/100 (Grade ${grade})`);
    console.log(`  Status: ${isCompliant ? "COMPLIANT" : "NON-COMPLIANT"}`);
    console.log(`  Nodes: ${totalNodes.toLocaleString()}`);
    console.log(`  Relationships: ${totalRelationships.toLocaleString()}`);
    console.log(`  Errors: ${bySeverity.errors} | Warnings: ${bySeverity.warnings} | Info: ${bySeverity.info}`);
    console.log("========================================\n");

    if (!isCompliant) {
      console.error(`  BLOCKED: Compliance score ${score} is below threshold (70). Pipeline halted.`);
      process.exit(2);
    } else if (score < 95) {
      console.log(`  PARTIAL: Score ${score} is above threshold but below full compliance (95).`);
      process.exit(1);
    } else {
      console.log("  PASSED: Graph is fully compliant with the ontology.");
      process.exit(0);
    }
  } finally {
    await session.close();
    await driver.close();
  }
};

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(2);
});
