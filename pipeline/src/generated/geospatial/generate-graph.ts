import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse";
import { createWriteStream, WriteStream } from "fs";

// ============================================================
// Types
// ============================================================

interface OntologyClass {
  uri: string;
  label: string;
  definition: string;
  superClasses: string[];
}

interface OntologyObjectProperty {
  uri: string;
  label: string;
  definition: string;
  domain: string[];
  range: string[];
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
  severity: string;
}

interface MappingStrategy {
  metadata: {
    complianceScore: number;
    ontologyName: string;
    ontologyVersion: string;
    totalColumns: number;
    mappedColumns: number;
    unmappedColumns: number;
  };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: RelationshipMapping[];
  unmappedColumns: UnmappedColumn[];
}

interface SupplementaryFileIndex {
  path: string;
  name: string;
  format: string;
  columns: string[];
  rowCount: number;
  description: string;
}

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  _meta: {
    sourceRow?: number;
    confidence: number;
    compliant: boolean;
  };
}

interface GraphRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
  _meta: {
    confidence: number;
    compliant: boolean;
  };
}

interface ValidationIssue {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  nodeId?: string;
  relId?: string;
  details?: Record<string, unknown>;
}

// ============================================================
// Constants
// ============================================================

const DATA_DIR = "domain-data/geospatial";
const OUTPUT_DIR = path.join(DATA_DIR, "output");
const SUPP_DIR = path.join(DATA_DIR, "supplementary-files");
const BASE_URI = "http://data.example.org/";

// ============================================================
// Utility functions
// ============================================================

function slugify(value: string): string {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function generateURI(classLabel: string, identifier: string): string {
  return `${BASE_URI}${slugify(classLabel)}/${slugify(identifier)}`;
}

function extractLocalName(uri: string): string {
  const hashIdx = uri.lastIndexOf("#");
  const slashIdx = uri.lastIndexOf("/");
  const idx = Math.max(hashIdx, slashIdx);
  return idx >= 0 ? uri.substring(idx + 1) : uri;
}

function classLabelFromURI(uri: string, classMap: Map<string, OntologyClass>): string {
  const cls = classMap.get(uri);
  return cls ? cls.label : extractLocalName(uri);
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function escapeCypher(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function escapeTurtle(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

// ============================================================
// Load supplementary lookup data
// ============================================================

function loadCountryLookup(filePath: string): Map<string, { name: string; geonameid: string }> {
  const map = new Map<string, { name: string; geonameid: string }>();
  if (!fs.existsSync(filePath)) return map;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length >= 17) {
      const iso = parts[0].trim();
      const name = parts[4].trim();
      const geonameid = parts[16].trim();
      if (iso && name) {
        map.set(iso, { name, geonameid });
      }
    }
  }
  return map;
}

function loadAdmin1Lookup(filePath: string): Map<string, { name: string; geonameid: string }> {
  const map = new Map<string, { name: string; geonameid: string }>();
  if (!fs.existsSync(filePath)) return map;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length >= 4) {
      const code = parts[0].trim();
      const name = parts[1].trim();
      const geonameid = parts[3].trim();
      if (code && name) {
        map.set(code, { name, geonameid });
      }
    }
  }
  return map;
}

function loadFeatureCodeLookup(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(filePath)) return map;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const fullCode = parts[0].trim();
      const description = parts[1].trim();
      // fullCode is like "A.ADM1" — extract just the part after the dot
      const dotIdx = fullCode.indexOf(".");
      const shortCode = dotIdx >= 0 ? fullCode.substring(dotIdx + 1) : fullCode;
      map.set(shortCode, description);
      map.set(fullCode, description);
    }
  }
  return map;
}

// ============================================================
// Ontology validation helpers
// ============================================================

function buildValidationMaps(ontology: OntologyStructure) {
  const classURIs = new Set<string>();
  const classMap = new Map<string, OntologyClass>();
  for (const cls of ontology.classes) {
    classURIs.add(cls.uri);
    classMap.set(cls.uri, cls);
  }

  const objectPropertyURIs = new Set<string>();
  const objectPropertyMap = new Map<string, OntologyObjectProperty>();
  for (const prop of ontology.objectProperties) {
    objectPropertyURIs.add(prop.uri);
    objectPropertyMap.set(prop.uri, prop);
  }

  const dataPropertyURIs = new Set<string>();
  const dataPropertyMap = new Map<string, OntologyDataProperty>();
  for (const prop of ontology.dataProperties) {
    dataPropertyURIs.add(prop.uri);
    dataPropertyMap.set(prop.uri, prop);
  }

  // Build superclass hierarchy for domain checking
  // A class "matches" a domain constraint if the class itself or any of its superclasses is in the domain
  const superclassChain = new Map<string, Set<string>>();
  for (const cls of ontology.classes) {
    const chain = new Set<string>();
    chain.add(cls.uri);
    const queue = [...cls.superClasses];
    while (queue.length > 0) {
      const sup = queue.shift()!;
      // Resolve prefixed to full URI
      const resolvedSup = resolvePrefix(sup, ontology.metadata.namespaces);
      chain.add(resolvedSup);
      const supCls = classMap.get(resolvedSup);
      if (supCls) {
        for (const ss of supCls.superClasses) {
          const resolved = resolvePrefix(ss, ontology.metadata.namespaces);
          if (!chain.has(resolved)) queue.push(resolved);
        }
      }
    }
    superclassChain.set(cls.uri, chain);
  }

  return { classURIs, classMap, objectPropertyURIs, objectPropertyMap, dataPropertyURIs, dataPropertyMap, superclassChain };
}

function resolvePrefix(prefixed: string, namespaces: Record<string, string>): string {
  const colonIdx = prefixed.indexOf(":");
  if (colonIdx < 0) return prefixed;
  if (prefixed.startsWith("http://") || prefixed.startsWith("https://")) return prefixed;
  const prefix = prefixed.substring(0, colonIdx);
  const local = prefixed.substring(colonIdx + 1);
  const ns = namespaces[prefix];
  return ns ? ns + local : prefixed;
}

function classSatisfiesDomain(classURI: string, domainConstraints: string[], namespaces: Record<string, string>, superclassChain: Map<string, Set<string>>): boolean {
  if (domainConstraints.length === 0) return true; // No domain constraint = unrestricted
  const chain = superclassChain.get(classURI);
  if (!chain) return false;
  for (const d of domainConstraints) {
    const resolved = resolvePrefix(d, namespaces);
    if (chain.has(resolved)) return true;
  }
  return false;
}

// ============================================================
// Main generation
// ============================================================

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("=== Geospatial Knowledge Graph Generation ===\n");

  // 1. Load required files
  console.log("[1/10] Loading input files...");
  const ontology: OntologyStructure = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_DIR, "ontology-structure.json"), "utf-8")
  );
  const mapping: MappingStrategy = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_DIR, "mapping-strategy.json"), "utf-8")
  );

  // Load supplementary data
  const suppIndexPath = path.join(OUTPUT_DIR, "supplementary-files-index.json");
  let suppIndex: SupplementaryFileIndex[] = [];
  if (fs.existsSync(suppIndexPath)) {
    suppIndex = JSON.parse(fs.readFileSync(suppIndexPath, "utf-8"));
    console.log(`  Loaded supplementary index: ${suppIndex.length} files`);
  }

  const countryLookup = loadCountryLookup(path.join(SUPP_DIR, "countryInfo.txt"));
  const admin1Lookup = loadAdmin1Lookup(path.join(SUPP_DIR, "admin1CodesASCII.txt"));
  const featureCodeLookup = loadFeatureCodeLookup(path.join(SUPP_DIR, "featureCodes_en.txt"));

  console.log(`  Countries: ${countryLookup.size}, Admin1: ${admin1Lookup.size}, Feature codes: ${featureCodeLookup.size}`);

  // 2. Compliance validation
  console.log("\n[2/10] Validating mapping compliance...");
  const complianceScore = mapping.metadata.complianceScore;
  console.log(`  Compliance score: ${complianceScore}/100`);

  if (complianceScore < 60) {
    console.error("  FATAL: Compliance score below 60 — aborting generation.");
    const errorReport = {
      error: "Compliance score too low",
      score: complianceScore,
      threshold: 60,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, "graph-validation-errors.json"), JSON.stringify(errorReport, null, 2));
    process.exit(1);
  }

  let graphCompliant = true;
  if (complianceScore < 80) {
    console.warn(`  WARNING: Compliance score ${complianceScore} < 80 — graph will be marked non-compliant`);
    graphCompliant = false;
  } else {
    console.log(`  Compliance: PASS (score >= 80)`);
  }

  // 3. Build ontology validation structures
  console.log("\n[3/10] Building ontology validation index...");
  const {
    classURIs, classMap, objectPropertyURIs, objectPropertyMap,
    dataPropertyURIs, dataPropertyMap, superclassChain
  } = buildValidationMaps(ontology);
  const ns = ontology.metadata.namespaces;

  // Filter to compliant mappings only
  const compliantEntities = mapping.entityMappings.filter(e => e.compliant);
  const compliantAttributes = mapping.attributeMappings.filter(a => a.compliant);
  const compliantRelationships = mapping.relationshipMappings.filter(r => r.compliant);

  console.log(`  Valid classes: ${classURIs.size}`);
  console.log(`  Object properties: ${objectPropertyURIs.size}, Data properties: ${dataPropertyURIs.size}`);
  console.log(`  Compliant entities: ${compliantEntities.length}, attributes: ${compliantAttributes.length}, relationships: ${compliantRelationships.length}`);

  // Build attribute lookup: targetEntity -> list of attribute mappings
  const attrsByEntity = new Map<string, AttributeMapping[]>();
  for (const attr of compliantAttributes) {
    const existing = attrsByEntity.get(attr.targetEntity) || [];
    existing.push(attr);
    attrsByEntity.set(attr.targetEntity, existing);
  }

  // 4. Prepare streaming
  console.log("\n[4/10] Setting up streaming pipeline...");
  const csvPath = path.join(OUTPUT_DIR, "dataset-cleaned.csv");
  const tempRelFile = path.join(OUTPUT_DIR, "_temp_relationships.ndjson");

  // Tracking
  const nodeIdSet = new Set<string>();
  const nodesByType: Record<string, number> = {};
  const relsByType: Record<string, number> = {};
  const issues: ValidationIssue[] = [];
  let validNodes = 0;
  let invalidNodes = 0;
  let validRelationships = 0;
  let invalidRelationships = 0;
  let rowCount = 0;
  let skippedRows = 0;

  // Country and admin1 nodes to create (enrichment from supplementary data)
  // Track which enrichment nodes we've already decided to create
  const enrichmentCountryIds = new Map<string, { id: string; name: string; geonameid: string }>();
  const enrichmentAdmin1Ids = new Map<string, { id: string; name: string; geonameid: string }>();

  // ============================================================
  // PASS 1: Stream CSV, write nodes to JSON, relationships to temp file
  // ============================================================
  console.log("\n[5/10] Pass 1: Streaming CSV → nodes + temp relationships...");

  const jsonOutPath = path.join(OUTPUT_DIR, "graph-data.json");
  const cypherOutPath = path.join(OUTPUT_DIR, "graph-import.cypher");
  const ttlOutPath = path.join(OUTPUT_DIR, "graph-data.ttl");

  // We'll collect nodes in a streaming JSON file
  // Write JSON header
  const jsonStream = createWriteStream(jsonOutPath, { encoding: "utf-8" });
  const tempRelStream = createWriteStream(tempRelFile, { encoding: "utf-8" });
  const cypherStream = createWriteStream(cypherOutPath, { encoding: "utf-8" });
  const ttlStream = createWriteStream(ttlOutPath, { encoding: "utf-8" });

  // Write Cypher header — uniqueness constraints
  cypherStream.write("// Auto-generated Neo4j import script\n");
  cypherStream.write(`// Generated: ${new Date().toISOString()}\n`);
  cypherStream.write(`// Ontology: ${ontology.metadata.title} v${ontology.metadata.version}\n\n`);

  // Constraints for entity classes
  for (const entity of compliantEntities) {
    const label = classLabelFromURI(entity.ontologyClass, classMap);
    const safeLabel = label.replace(/\s+/g, "");
    cypherStream.write(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:${safeLabel}) REQUIRE n.uri IS UNIQUE;\n`);
  }
  cypherStream.write("\n");

  // Write TTL header — prefix declarations
  ttlStream.write("# Auto-generated RDF/Turtle\n");
  ttlStream.write(`# Generated: ${new Date().toISOString()}\n`);
  ttlStream.write(`# Ontology: ${ontology.metadata.title} v${ontology.metadata.version}\n\n`);
  for (const [prefix, uri] of Object.entries(ns)) {
    ttlStream.write(`@prefix ${prefix}: <${uri}> .\n`);
  }
  ttlStream.write(`@prefix data: <${BASE_URI}> .\n`);
  ttlStream.write(`@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n`);
  ttlStream.write("\n");

  // JSON: We write a streaming structure. First, write metadata + start of nodes array.
  // We'll assemble the final JSON at the end after both passes.
  // For now, write nodes to a temp NDJSON file too for assembling later.
  const tempNodesFile = path.join(OUTPUT_DIR, "_temp_nodes.ndjson");
  let tempNodesStream: WriteStream = createWriteStream(tempNodesFile, { encoding: "utf-8" });

  // Cypher batch size
  const CYPHER_BATCH = 500;
  let cypherBatch: string[] = [];
  let ttlBatch: string[] = [];

  function flushCypherBatch(): void {
    if (cypherBatch.length === 0) return;
    cypherStream.write(cypherBatch.join("\n") + "\n");
    cypherBatch = [];
  }

  function flushTtlBatch(): void {
    if (ttlBatch.length === 0) return;
    ttlStream.write(ttlBatch.join("\n") + "\n");
    ttlBatch = [];
  }

  // Process a single CSV row
  function processRow(row: Record<string, string>, rowIndex: number): void {
    const geonameid = row["geonameid"];
    if (!geonameid || geonameid.trim() === "") {
      skippedRows++;
      return;
    }

    // --- Feature node ---
    const featureEntityMapping = compliantEntities.find(
      e => e.ontologyClass === "http://www.opengis.net/ont/geosparql#Feature"
    );
    if (!featureEntityMapping) return;

    const featureClassURI = featureEntityMapping.ontologyClass;
    const featureLabel = classLabelFromURI(featureClassURI, classMap);
    const featureId = generateURI(featureLabel, geonameid);

    // Check for dedup
    if (nodeIdSet.has(featureId)) return;

    // Validate class
    if (!classURIs.has(featureClassURI)) {
      issues.push({
        type: "invalid_class",
        severity: "error",
        message: `Class ${featureClassURI} not in ontology`,
        nodeId: featureId,
      });
      invalidNodes++;
      return;
    }

    // Build Feature properties from attribute mappings
    const featureAttrs = attrsByEntity.get(featureClassURI) || [];
    const featureProps: Record<string, unknown> = { uri: featureId };

    for (const attr of featureAttrs) {
      const colName = attr.columnName;
      let rawValue = row[colName];
      if (rawValue === undefined || rawValue === null || rawValue.trim() === "") continue;
      rawValue = rawValue.trim();

      const propLocal = extractLocalName(attr.ontologyProperty);

      // Type coercion based on datatype
      if (attr.datatype === "http://www.w3.org/2001/XMLSchema#integer") {
        const num = parseInt(rawValue, 10);
        if (!isNaN(num)) {
          featureProps[propLocal] = num;
        }
      } else if (attr.datatype === "http://www.w3.org/2001/XMLSchema#date") {
        featureProps[propLocal] = rawValue;
      } else {
        featureProps[propLocal] = rawValue;
      }
    }

    // Enrichment: resolve feature_code to human-readable label
    const featureCode = row["feature_code"]?.trim();
    const featureClass = row["feature_class"]?.trim();
    if (featureCode && featureCodeLookup.has(featureCode)) {
      featureProps["typeLabel"] = featureCodeLookup.get(featureCode);
    } else if (featureCode && featureClass) {
      const fullCode = `${featureClass}.${featureCode}`;
      if (featureCodeLookup.has(fullCode)) {
        featureProps["typeLabel"] = featureCodeLookup.get(fullCode);
      }
    }

    // Enrichment: resolve country_code to country name
    const countryCode = row["country_code"]?.trim();
    if (countryCode && countryLookup.has(countryCode)) {
      featureProps["spatialLabel"] = countryLookup.get(countryCode)!.name;
    }

    // Enrichment: resolve admin1_code to name
    const admin1Code = row["admin1_code"]?.trim();
    if (admin1Code && countryCode) {
      const admin1Key = `${countryCode}.${admin1Code}`;
      if (admin1Lookup.has(admin1Key)) {
        featureProps["isPartOfLabel"] = admin1Lookup.get(admin1Key)!.name;
      }
    }

    const featureNode: GraphNode = {
      id: featureId,
      labels: [featureLabel],
      properties: featureProps,
      _meta: {
        sourceRow: rowIndex,
        confidence: featureEntityMapping.confidence,
        compliant: true,
      },
    };

    nodeIdSet.add(featureId);
    validNodes++;
    nodesByType[featureLabel] = (nodesByType[featureLabel] || 0) + 1;

    // Write Feature node
    tempNodesStream.write(JSON.stringify(featureNode) + "\n");
    writeCypherNode(featureNode);
    writeTtlFeature(featureNode, featureClassURI, featureAttrs, row);

    // --- Geometry node ---
    const lat = row["latitude"]?.trim();
    const lon = row["longitude"]?.trim();
    if (!lat || !lon || lat === "" || lon === "") {
      // No geometry possible
    } else {
      const geomEntityMapping = compliantEntities.find(
        e => e.ontologyClass === "http://www.opengis.net/ont/geosparql#Geometry"
      );
      if (geomEntityMapping) {
        const geomClassURI = geomEntityMapping.ontologyClass;
        const geomLabel = classLabelFromURI(geomClassURI, classMap);
        const geomId = generateURI(geomLabel, `${geonameid}-point`);

        if (!nodeIdSet.has(geomId)) {
          const wkt = `POINT(${lon} ${lat})`;
          const geomProps: Record<string, unknown> = {
            uri: geomId,
            asWKT: wkt,
            coordinateDimension: 2,
          };

          // DEM elevation on Geometry
          const demVal = row["dem"]?.trim();
          if (demVal && demVal !== "" && demVal !== "-9999") {
            const demNum = parseInt(demVal, 10);
            if (!isNaN(demNum) && demNum !== -9999) {
              geomProps["elevation"] = demNum;
            }
          }

          const geomNode: GraphNode = {
            id: geomId,
            labels: [geomLabel],
            properties: geomProps,
            _meta: {
              sourceRow: rowIndex,
              confidence: geomEntityMapping.confidence,
              compliant: true,
            },
          };

          nodeIdSet.add(geomId);
          validNodes++;
          nodesByType[geomLabel] = (nodesByType[geomLabel] || 0) + 1;

          tempNodesStream.write(JSON.stringify(geomNode) + "\n");
          writeCypherNode(geomNode);
          writeTtlGeometry(geomNode, geomClassURI);
        }

        // Relationship: Feature --hasGeometry--> Geometry
        const hasGeomRel = compliantRelationships.find(
          r => r.ontologyRelationship === "http://www.opengis.net/ont/geosparql#hasGeometry"
        );
        if (hasGeomRel) {
          const relType = extractLocalName(hasGeomRel.ontologyRelationship);
          const rel: GraphRelationship = {
            id: generateURI("rel", `${geonameid}-hasGeometry`),
            type: relType,
            from: featureId,
            to: geomId,
            properties: {},
            _meta: { confidence: hasGeomRel.confidence, compliant: true },
          };
          tempRelStream.write(JSON.stringify(rel) + "\n");
          validRelationships++;
          relsByType[relType] = (relsByType[relType] || 0) + 1;
        }
      }
    }

    // --- sfWithin relationships (country) ---
    if (countryCode && countryLookup.has(countryCode)) {
      const countryInfo = countryLookup.get(countryCode)!;
      const countryNodeId = generateURI("Feature", `country-${countryCode.toLowerCase()}`);

      // Register enrichment node
      if (!enrichmentCountryIds.has(countryCode)) {
        enrichmentCountryIds.set(countryCode, {
          id: countryNodeId,
          name: countryInfo.name,
          geonameid: countryInfo.geonameid,
        });
      }

      // sfWithin relationship
      const sfWithinRel = compliantRelationships.find(
        r =>
          r.ontologyRelationship === "http://www.opengis.net/ont/geosparql#sfWithin" &&
          r.columnName === "country_code"
      );
      if (sfWithinRel) {
        const relType = extractLocalName(sfWithinRel.ontologyRelationship);
        const rel: GraphRelationship = {
          id: generateURI("rel", `${geonameid}-sfWithin-country-${countryCode}`),
          type: relType,
          from: featureId,
          to: countryNodeId,
          properties: {},
          _meta: { confidence: sfWithinRel.confidence, compliant: true },
        };
        tempRelStream.write(JSON.stringify(rel) + "\n");
        validRelationships++;
        relsByType[relType] = (relsByType[relType] || 0) + 1;
      }
    }

    // --- sfWithin relationships (admin1) ---
    if (admin1Code && countryCode) {
      const admin1Key = `${countryCode}.${admin1Code}`;
      if (admin1Lookup.has(admin1Key)) {
        const admin1Info = admin1Lookup.get(admin1Key)!;
        const admin1NodeId = generateURI("Feature", `admin1-${slugify(admin1Key)}`);

        if (!enrichmentAdmin1Ids.has(admin1Key)) {
          enrichmentAdmin1Ids.set(admin1Key, {
            id: admin1NodeId,
            name: admin1Info.name,
            geonameid: admin1Info.geonameid,
          });
        }

        const sfWithinRel = compliantRelationships.find(
          r =>
            r.ontologyRelationship === "http://www.opengis.net/ont/geosparql#sfWithin" &&
            r.columnName === "admin1_code"
        );
        if (sfWithinRel) {
          const relType = extractLocalName(sfWithinRel.ontologyRelationship);
          const rel: GraphRelationship = {
            id: generateURI("rel", `${geonameid}-sfWithin-admin1-${slugify(admin1Key)}`),
            type: relType,
            from: featureId,
            to: admin1NodeId,
            properties: {},
            _meta: { confidence: sfWithinRel.confidence, compliant: true },
          };
          tempRelStream.write(JSON.stringify(rel) + "\n");
          validRelationships++;
          relsByType[relType] = (relsByType[relType] || 0) + 1;
        }
      }
    }

    rowCount++;
  }

  function writeCypherNode(node: GraphNode): void {
    const label = node.labels[0].replace(/\s+/g, "");
    const propsEntries: string[] = [];
    for (const [key, value] of Object.entries(node.properties)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "number") {
        propsEntries.push(`${key}: ${value}`);
      } else {
        propsEntries.push(`${key}: '${escapeCypher(String(value))}'`);
      }
    }
    const propsStr = propsEntries.join(", ");
    cypherBatch.push(`CREATE (n:${label} {${propsStr}});`);
    if (cypherBatch.length >= CYPHER_BATCH) flushCypherBatch();
  }

  function writeTtlFeature(node: GraphNode, classURI: string, attrs: AttributeMapping[], row: Record<string, string>): void {
    const nodeUri = `<${node.id}>`;
    const lines: string[] = [];
    lines.push(`${nodeUri} a <${classURI}> ;`);

    const propLines: string[] = [];
    for (const attr of attrs) {
      const colName = attr.columnName;
      let rawValue = row[colName];
      if (rawValue === undefined || rawValue === null || rawValue.trim() === "") continue;
      rawValue = rawValue.trim();

      if (attr.datatype === "http://www.w3.org/2001/XMLSchema#integer") {
        const num = parseInt(rawValue, 10);
        if (!isNaN(num)) {
          propLines.push(`    <${attr.ontologyProperty}> "${num}"^^xsd:integer`);
        }
      } else if (attr.datatype === "http://www.w3.org/2001/XMLSchema#date") {
        propLines.push(`    <${attr.ontologyProperty}> "${escapeTurtle(rawValue)}"^^xsd:date`);
      } else {
        propLines.push(`    <${attr.ontologyProperty}> "${escapeTurtle(rawValue)}"`);
      }
    }

    if (propLines.length > 0) {
      lines.push(propLines.join(" ;\n") + " .");
    } else {
      // Fix trailing semicolon
      lines[0] = `${nodeUri} a <${classURI}> .`;
    }

    ttlBatch.push(lines.join("\n"));
    if (ttlBatch.length >= CYPHER_BATCH) flushTtlBatch();
  }

  function writeTtlGeometry(node: GraphNode, classURI: string): void {
    const nodeUri = `<${node.id}>`;
    const wkt = node.properties["asWKT"] as string;
    const lines: string[] = [];
    lines.push(`${nodeUri} a <${classURI}> ;`);
    lines.push(`    geo:asWKT "${escapeTurtle(wkt)}"^^geo:wktLiteral ;`);
    lines.push(`    geo:coordinateDimension "2"^^xsd:integer .`);
    ttlBatch.push(lines.join("\n"));
    if (ttlBatch.length >= CYPHER_BATCH) flushTtlBatch();
  }

  // Stream the CSV
  await new Promise<void>((resolve, reject) => {
    const fileStream = fs.createReadStream(csvPath, { encoding: "utf-8" });
    const parser = fileStream.pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      })
    );

    let idx = 0;
    const PROGRESS_INTERVAL = 100_000;

    parser.on("data", (row: Record<string, string>) => {
      idx++;
      processRow(row, idx);
      if (idx % PROGRESS_INTERVAL === 0) {
        const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
        console.log(`  Processed ${(idx / 1000).toFixed(0)}K rows | Nodes: ${validNodes} | Heap: ${heapMB}MB`);
      }
    });

    parser.on("end", () => {
      console.log(`  Pass 1 complete: ${idx} rows processed`);
      resolve();
    });

    parser.on("error", (err: Error) => reject(err));
  });

  // Flush remaining batches
  flushCypherBatch();
  flushTtlBatch();

  // Close node streams
  await closeStream(tempNodesStream);
  await closeStream(tempRelStream);

  // ============================================================
  // PASS 1.5: Write enrichment nodes (countries, admin1 divisions)
  // ============================================================
  console.log("\n[6/10] Writing enrichment nodes from supplementary data...");

  const featureLabel = classLabelFromURI("http://www.opengis.net/ont/geosparql#Feature", classMap);

  // Country nodes
  for (const [code, info] of enrichmentCountryIds) {
    if (nodeIdSet.has(info.id)) continue;

    const countryNode: GraphNode = {
      id: info.id,
      labels: [featureLabel],
      properties: {
        uri: info.id,
        label: info.name,
        notation: code,
        type: "country",
        spatial: code,
      },
      _meta: { confidence: 0.85, compliant: true },
    };

    nodeIdSet.add(info.id);
    validNodes++;
    nodesByType[featureLabel] = (nodesByType[featureLabel] || 0) + 1;

    tempNodesStream = createWriteStream(tempNodesFile, { flags: "a", encoding: "utf-8" });
    tempNodesStream.write(JSON.stringify(countryNode) + "\n");
    await closeStream(tempNodesStream);

    writeCypherNodeDirect(cypherStream, countryNode);
    writeTtlEnrichmentNode(ttlStream, countryNode, "http://www.opengis.net/ont/geosparql#Feature");
  }
  console.log(`  Country enrichment nodes: ${enrichmentCountryIds.size}`);

  // Admin1 nodes
  for (const [key, info] of enrichmentAdmin1Ids) {
    if (nodeIdSet.has(info.id)) continue;

    const admin1Node: GraphNode = {
      id: info.id,
      labels: [featureLabel],
      properties: {
        uri: info.id,
        label: info.name,
        notation: key,
        type: "administrative division",
      },
      _meta: { confidence: 0.8, compliant: true },
    };

    nodeIdSet.add(info.id);
    validNodes++;
    nodesByType[featureLabel] = (nodesByType[featureLabel] || 0) + 1;

    const tmpAppend = createWriteStream(tempNodesFile, { flags: "a", encoding: "utf-8" });
    tmpAppend.write(JSON.stringify(admin1Node) + "\n");
    await closeStream(tmpAppend);

    writeCypherNodeDirect(cypherStream, admin1Node);
    writeTtlEnrichmentNode(ttlStream, admin1Node, "http://www.opengis.net/ont/geosparql#Feature");
  }
  console.log(`  Admin1 enrichment nodes: ${enrichmentAdmin1Ids.size}`);

  // Admin1 --sfWithin--> Country relationships
  let admin1CountryRels = 0;
  const admin1RelAppend = createWriteStream(tempRelFile, { flags: "a", encoding: "utf-8" });
  for (const [key, info] of enrichmentAdmin1Ids) {
    const cc = key.split(".")[0];
    if (enrichmentCountryIds.has(cc)) {
      const countryInfo = enrichmentCountryIds.get(cc)!;
      const rel: GraphRelationship = {
        id: generateURI("rel", `admin1-${slugify(key)}-sfWithin-country-${cc.toLowerCase()}`),
        type: "sfWithin",
        from: info.id,
        to: countryInfo.id,
        properties: {},
        _meta: { confidence: 0.8, compliant: true },
      };
      admin1RelAppend.write(JSON.stringify(rel) + "\n");
      validRelationships++;
      relsByType["sfWithin"] = (relsByType["sfWithin"] || 0) + 1;
      admin1CountryRels++;
    }
  }
  await closeStream(admin1RelAppend);
  console.log(`  Admin1→Country relationships: ${admin1CountryRels}`);

  // ============================================================
  // PASS 2: Stream temp relationships → write to Cypher and JSON
  // ============================================================
  console.log("\n[7/10] Pass 2: Writing relationships to output formats...");

  cypherStream.write("\n// --- Relationships ---\n\n");
  ttlStream.write("\n# --- Relationships ---\n\n");

  let relCount = 0;
  const relCypherBatch: string[] = [];
  const relTtlBatch: string[] = [];
  const tempRelReadStream = fs.createReadStream(tempRelFile, { encoding: "utf-8" });
  const tempRelNodesFile = path.join(OUTPUT_DIR, "_temp_rels_validated.ndjson");
  const validatedRelStream = createWriteStream(tempRelNodesFile, { encoding: "utf-8" });

  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    tempRelReadStream.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // Keep incomplete last line

      for (const line of lines) {
        if (line.trim() === "") continue;
        const rel: GraphRelationship = JSON.parse(line);

        // Validate: both source and target must exist
        if (!nodeIdSet.has(rel.from) || !nodeIdSet.has(rel.to)) {
          invalidRelationships++;
          issues.push({
            type: "dangling_reference",
            severity: "warning",
            message: `Relationship ${rel.type} references missing node`,
            relId: rel.id,
            details: { from: rel.from, to: rel.to },
          });
          // Adjust counts — we already counted this as valid
          validRelationships--;
          relsByType[rel.type] = (relsByType[rel.type] || 0) - 1;
          continue;
        }

        validatedRelStream.write(line + "\n");
        relCount++;

        // Cypher
        const fromLabel = "Feature"; // Most nodes are Feature
        const toLabel = rel.to.includes("/geometry/") ? "Geometry" : "Feature";
        relCypherBatch.push(
          `MATCH (a:${fromLabel} {uri: '${escapeCypher(rel.from)}'}), (b:${toLabel} {uri: '${escapeCypher(rel.to)}'}) CREATE (a)-[:${rel.type}]->(b);`
        );
        if (relCypherBatch.length >= CYPHER_BATCH) {
          cypherStream.write(relCypherBatch.join("\n") + "\n");
          relCypherBatch.length = 0;
        }

        // TTL
        relTtlBatch.push(`<${rel.from}> geo:${rel.type} <${rel.to}> .`);
        if (relTtlBatch.length >= CYPHER_BATCH) {
          ttlStream.write(relTtlBatch.join("\n") + "\n");
          relTtlBatch.length = 0;
        }
      }
    });

    tempRelReadStream.on("end", () => {
      // Process remaining buffer
      if (buffer.trim()) {
        const rel: GraphRelationship = JSON.parse(buffer);
        if (nodeIdSet.has(rel.from) && nodeIdSet.has(rel.to)) {
          validatedRelStream.write(buffer + "\n");
          relCount++;
          relCypherBatch.push(
            `MATCH (a {uri: '${escapeCypher(rel.from)}'}), (b {uri: '${escapeCypher(rel.to)}'}) CREATE (a)-[:${rel.type}]->(b);`
          );
          relTtlBatch.push(`<${rel.from}> geo:${rel.type} <${rel.to}> .`);
        }
      }
      resolve();
    });

    tempRelReadStream.on("error", reject);
  });

  // Flush remaining
  if (relCypherBatch.length > 0) cypherStream.write(relCypherBatch.join("\n") + "\n");
  if (relTtlBatch.length > 0) ttlStream.write(relTtlBatch.join("\n") + "\n");

  await closeStream(validatedRelStream);
  await closeStream(cypherStream);
  await closeStream(ttlStream);

  console.log(`  Validated relationships written: ${relCount}`);

  // ============================================================
  // Assemble final JSON
  // ============================================================
  console.log("\n[8/10] Assembling final JSON output...");

  const totalNodes = validNodes;
  const totalRelationships = validRelationships;
  const avgDegree = totalNodes > 0 ? (2 * totalRelationships) / totalNodes : 0;
  const maxPossibleEdges = totalNodes * (totalNodes - 1);
  const density = maxPossibleEdges > 0 ? totalRelationships / maxPossibleEdges : 0;

  const validNodesPercent = (validNodes + invalidNodes) > 0 ? (validNodes / (validNodes + invalidNodes)) * 100 : 100;
  const validRelsPercent = (validRelationships + invalidRelationships) > 0 ? (validRelationships / (validRelationships + invalidRelationships)) * 100 : 100;
  const unmappedDataPercent = mapping.metadata.totalColumns > 0
    ? (mapping.metadata.unmappedColumns / mapping.metadata.totalColumns) * 100
    : 0;

  // Write final JSON by streaming nodes and relationships from temp files
  const finalJsonStream = createWriteStream(jsonOutPath, { encoding: "utf-8" });
  finalJsonStream.write("{\n");
  finalJsonStream.write(`  "metadata": {\n`);
  finalJsonStream.write(`    "generatedAt": "${new Date().toISOString()}",\n`);
  finalJsonStream.write(`    "ontologyName": "${ontology.metadata.title}",\n`);
  finalJsonStream.write(`    "ontologyVersion": "${ontology.metadata.version}",\n`);
  finalJsonStream.write(`    "complianceScore": ${complianceScore},\n`);
  finalJsonStream.write(`    "validation": {\n`);
  finalJsonStream.write(`      "compliant": ${graphCompliant},\n`);
  finalJsonStream.write(`      "errors": ${invalidNodes + invalidRelationships},\n`);
  finalJsonStream.write(`      "warnings": ${issues.filter(i => i.severity === "warning").length}\n`);
  finalJsonStream.write(`    }\n`);
  finalJsonStream.write(`  },\n`);

  // Stream nodes
  finalJsonStream.write(`  "nodes": [\n`);
  await streamNdjsonToJsonArray(tempNodesFile, finalJsonStream);
  finalJsonStream.write(`  ],\n`);

  // Stream relationships
  finalJsonStream.write(`  "relationships": [\n`);
  await streamNdjsonToJsonArray(tempRelNodesFile, finalJsonStream);
  finalJsonStream.write(`  ],\n`);

  // Statistics
  finalJsonStream.write(`  "statistics": {\n`);
  finalJsonStream.write(`    "totalNodes": ${totalNodes},\n`);
  finalJsonStream.write(`    "nodesByType": ${JSON.stringify(nodesByType)},\n`);
  finalJsonStream.write(`    "totalRelationships": ${totalRelationships},\n`);
  finalJsonStream.write(`    "relationshipsByType": ${JSON.stringify(relsByType)}\n`);
  finalJsonStream.write(`  }\n`);
  finalJsonStream.write(`}\n`);
  await closeStream(finalJsonStream);

  console.log(`  JSON assembled: ${jsonOutPath}`);

  // ============================================================
  // Statistics file
  // ============================================================
  console.log("\n[9/10] Writing statistics and validation reports...");

  const issuesSummary: Array<{ type: string; severity: string; count: number; examples: string[] }> = [];
  const issueMap = new Map<string, { severity: string; count: number; examples: string[] }>();
  for (const issue of issues) {
    const key = `${issue.type}:${issue.severity}`;
    const entry = issueMap.get(key) || { severity: issue.severity, count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(issue.message);
    issueMap.set(key, entry);
  }
  for (const [key, value] of issueMap) {
    const type = key.split(":")[0];
    issuesSummary.push({ type, ...value });
  }

  const stats = {
    summary: {
      totalNodes,
      totalRelationships,
      avgDegree: parseFloat(avgDegree.toFixed(4)),
      density: parseFloat(density.toFixed(10)),
    },
    nodeStatistics: {
      byType: nodesByType,
      withIssues: invalidNodes,
      compliant: validNodes,
    },
    relationshipStatistics: {
      byType: relsByType,
      withIssues: invalidRelationships,
      compliant: validRelationships,
    },
    complianceMetrics: {
      overallScore: complianceScore,
      validNodesPercent: parseFloat(validNodesPercent.toFixed(2)),
      validRelationshipsPercent: parseFloat(validRelsPercent.toFixed(2)),
      unmappedDataPercent: parseFloat(unmappedDataPercent.toFixed(2)),
    },
    issues: issuesSummary,
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, "graph-stats.json"), JSON.stringify(stats, null, 2));

  // Validation errors
  if (issues.length > 0) {
    // Write first 1000 issues
    const errorReport = {
      generatedAt: new Date().toISOString(),
      totalIssues: issues.length,
      issues: issues.slice(0, 1000),
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, "graph-validation-errors.json"), JSON.stringify(errorReport, null, 2));
  }

  // Clean up temp files
  try { fs.unlinkSync(tempNodesFile); } catch {}
  try { fs.unlinkSync(tempRelFile); } catch {}
  try { fs.unlinkSync(tempRelNodesFile); } catch {}

  // ============================================================
  // Console summary
  // ============================================================
  console.log("\n[10/10] Generation complete!\n");
  console.log("=== Knowledge Graph Summary ===\n");
  console.log(`  Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  Compliance Score: ${complianceScore}/100 (${complianceScore >= 80 ? "COMPLIANT" : "NON-COMPLIANT"})`);
  console.log(`  Rows processed: ${rowCount} (skipped: ${skippedRows})`);
  console.log("");
  console.log("  Nodes:");
  console.log(`    Total: ${totalNodes}`);
  for (const [type, count] of Object.entries(nodesByType)) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`    Enrichment (countries): ${enrichmentCountryIds.size}`);
  console.log(`    Enrichment (admin1): ${enrichmentAdmin1Ids.size}`);
  console.log("");
  console.log("  Relationships:");
  console.log(`    Total: ${totalRelationships}`);
  for (const [type, count] of Object.entries(relsByType)) {
    console.log(`    ${type}: ${count}`);
  }
  console.log("");
  console.log("  Validation:");
  console.log(`    Valid nodes: ${validNodes} (${validNodesPercent.toFixed(1)}%)`);
  console.log(`    Invalid nodes: ${invalidNodes}`);
  console.log(`    Valid relationships: ${validRelationships} (${validRelsPercent.toFixed(1)}%)`);
  console.log(`    Invalid relationships: ${invalidRelationships}`);
  console.log(`    Issues: ${issues.length}`);
  console.log("");
  console.log(`  Unmapped columns: ${mapping.metadata.unmappedColumns}/${mapping.metadata.totalColumns} (${unmappedDataPercent.toFixed(1)}%)`);
  for (const um of mapping.unmappedColumns) {
    console.log(`    - ${um.columnName}: ${um.reason.substring(0, 80)}...`);
  }
  console.log("");
  console.log("  Output files:");
  console.log(`    ${jsonOutPath}`);
  console.log(`    ${cypherOutPath}`);
  console.log(`    ${ttlOutPath}`);
  console.log(`    ${path.join(OUTPUT_DIR, "graph-stats.json")}`);
  if (issues.length > 0) {
    console.log(`    ${path.join(OUTPUT_DIR, "graph-validation-errors.json")}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
  console.log(`\n  Duration: ${elapsed}s | Peak heap: ${heapMB}MB`);
}

// ============================================================
// Helper: write Cypher node directly to stream
// ============================================================
function writeCypherNodeDirect(stream: WriteStream, node: GraphNode): void {
  const label = node.labels[0].replace(/\s+/g, "");
  const propsEntries: string[] = [];
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number") {
      propsEntries.push(`${key}: ${value}`);
    } else {
      propsEntries.push(`${key}: '${escapeCypher(String(value))}'`);
    }
  }
  stream.write(`CREATE (n:${label} {${propsEntries.join(", ")}});\n`);
}

// ============================================================
// Helper: write TTL enrichment node directly
// ============================================================
function writeTtlEnrichmentNode(stream: WriteStream, node: GraphNode, classURI: string): void {
  const nodeUri = `<${node.id}>`;
  stream.write(`${nodeUri} a <${classURI}> ;\n`);
  const propLines: string[] = [];
  if (node.properties["label"]) {
    propLines.push(`    rdfs:label "${escapeTurtle(String(node.properties["label"]))}"`)
  }
  if (node.properties["notation"]) {
    propLines.push(`    skos:notation "${escapeTurtle(String(node.properties["notation"]))}"`)
  }
  if (propLines.length > 0) {
    stream.write(propLines.join(" ;\n") + " .\n");
  } else {
    // Rewrite last line to end with .
    stream.write(".\n");
  }
}

// ============================================================
// Helper: stream NDJSON file into JSON array in output stream
// ============================================================
async function streamNdjsonToJsonArray(filePath: string, outStream: WriteStream): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  return new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    let buffer = "";
    let first = true;

    readStream.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.trim() === "") continue;
        if (!first) outStream.write(",\n");
        outStream.write("    " + line.trim());
        first = false;
      }
    });

    readStream.on("end", () => {
      if (buffer.trim()) {
        if (!first) outStream.write(",\n");
        outStream.write("    " + buffer.trim());
      }
      outStream.write("\n");
      resolve();
    });

    readStream.on("error", reject);
  });
}

// ============================================================
// Helper: close a write stream with a promise
// ============================================================
function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.on("error", reject);
  });
}

// ============================================================
// Run
// ============================================================
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
