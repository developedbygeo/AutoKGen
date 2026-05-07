import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';

// ─── Configuration ──────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || 'domain-data/scientific-dblp';
const INPUT_CSV = path.join(DATA_DIR, 'input', 'dataset-merged.csv');
const ONTOLOGY_FILE = path.join(DATA_DIR, 'output', 'ontology-structure.json');
const MAPPING_FILE = path.join(DATA_DIR, 'output', 'mapping-strategy.json');
const SUPPLEMENTARY_INDEX = path.join(DATA_DIR, 'output', 'supplementary-files-index.json');
const SUPPLEMENTARY_DIR = path.join(DATA_DIR, 'supplementary-files');
const OUTPUT_CSV = path.join(DATA_DIR, 'output', 'dataset-cleaned.csv');
const REPORT_FILE = path.join(DATA_DIR, 'output', 'cleaning-report.json');

const CHUNK_SIZE = 5000;
const NULL_MARKERS = new Set(['', 'null', 'NULL', 'Null', 'N/A', 'n/a', 'NA', 'na', 'None', 'none', 'NONE', 'undefined', '\\N', '-']);

// ─── Types ──────────────────────────────────────────────────────────────────

interface AttributeMapping {
  columnName: string;
  ontologyProperty: string;
  propertyType: string;
  targetEntity: string;
  datatype: string;
  confidence: number;
  compliant: boolean;
}

interface EntityMapping {
  columnName: string;
  ontologyClass: string;
  confidence: number;
  identifierColumn: string;
  requiredProperties: string[];
  compliant: boolean;
}

interface MappingStrategy {
  metadata: { complianceScore: number; mappedColumns: number; unmappedColumns: number };
  entityMappings: EntityMapping[];
  attributeMappings: AttributeMapping[];
  relationshipMappings: Array<{
    columnName: string;
    ontologyRelationship: string;
    sourceEntity: string;
    targetEntity: string;
    confidence: number;
    compliant: boolean;
  }>;
  unmappedColumns: Array<{ columnName: string; reason: string; suggestion: string; severity: string }>;
}

interface CleaningIssue {
  type: string;
  count: number;
  severity: 'info' | 'warning' | 'error';
}

interface TypeCoercion {
  column: string;
  targetType: string;
  successCount: number;
  failCount: number;
}

interface CleaningReport {
  originalRows: number;
  cleanedRows: number;
  rowsRemoved: number;
  duplicatesRemoved: number;
  issues: CleaningIssue[];
  typeCoercions: TypeCoercion[];
  columnSummary: Record<string, { nullsBefore: number; nullsAfter: number; trimmed: number; coerced: number }>;
}

type Row = Record<string, string>;

// ─── Pure cleaning functions ────────────────────────────────────────────────

const trimValue = (v: string): string => v.trim();

const isNullMarker = (v: string): boolean => NULL_MARKERS.has(v.trim());

const normalizeNull = (v: string): string | null => {
  const trimmed = v.trim();
  return isNullMarker(trimmed) ? null : trimmed;
};

const normalizeMultiValue = (v: string): string | null => {
  if (!v) return null;
  const parts = v.split('|').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length === 0) return null;
  // Deduplicate within field
  const unique = [...new Set(parts)];
  return unique.join('|');
};

const coerceYear = (v: string): string | null => {
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 1500 || n > 2030) return null;
  return String(n);
};

const coerceInteger = (v: string): string | null => {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : String(n);
};

const coerceDate = (v: string): string | null => {
  // Accept YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // Try parsing other formats
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
};

const coerceURI = (v: string): string | null => {
  // Basic URI validation — must start with a scheme or be a relative path
  const trimmed = v.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ftp://')) {
    return trimmed;
  }
  // DBLP internal paths (db/..., cdrom paths)
  if (trimmed.startsWith('db/') || trimmed.includes('/')) {
    return trimmed;
  }
  return null;
};

// Multi-value URI: each pipe-delimited segment must be a valid URI
const coerceMultiURI = (v: string): string | null => {
  const parts = v.split('|').map(s => s.trim()).filter(s => s.length > 0);
  const valid = parts.map(coerceURI).filter((u): u is string => u !== null);
  return valid.length > 0 ? valid.join('|') : null;
};

const coerceBoolean = (v: string): string | null => {
  const lower = v.toLowerCase().trim();
  if (['true', '1', 'yes'].includes(lower)) return 'true';
  if (['false', '0', 'no'].includes(lower)) return 'false';
  return null;
};

// ─── Build column type map from mapping strategy ────────────────────────────

interface ColumnTypeInfo {
  datatype: string;
  ontologyProperty: string;
  isMultiValue: boolean;
  isURI: boolean;
}

const MULTI_VALUE_COLUMNS = new Set(['authors', 'editors', 'ee', 'isbn', 'cite', 'url', 'note', 'crossref', 'rel', 'stream']);

const buildColumnTypeMap = (mapping: MappingStrategy): Map<string, ColumnTypeInfo> => {
  const map = new Map<string, ColumnTypeInfo>();

  for (const attr of mapping.attributeMappings) {
    map.set(attr.columnName, {
      datatype: attr.datatype,
      ontologyProperty: attr.ontologyProperty,
      isMultiValue: MULTI_VALUE_COLUMNS.has(attr.columnName),
      isURI: attr.datatype === 'xsd:anyURI',
    });
  }

  // Relationship columns are multi-value strings
  for (const rel of mapping.relationshipMappings) {
    if (!map.has(rel.columnName)) {
      map.set(rel.columnName, {
        datatype: 'xsd:string',
        ontologyProperty: rel.ontologyRelationship,
        isMultiValue: MULTI_VALUE_COLUMNS.has(rel.columnName),
        isURI: false,
      });
    }
  }

  return map;
};

// ─── Required properties per record type ────────────────────────────────────

const VALID_RECORD_TYPES = new Set([
  'article', 'inproceedings', 'proceedings', 'book',
  'incollection', 'phdthesis', 'mastersthesis', 'www', 'data'
]);

// Critical: key + record_type must always exist, title strongly preferred
const isCriticallyInvalid = (row: Row): boolean => {
  const key = row['key'];
  const recordType = row['record_type'];
  if (!key || isNullMarker(key)) return true;
  if (!recordType || isNullMarker(recordType)) return true;
  if (!VALID_RECORD_TYPES.has(recordType.trim().toLowerCase())) return true;
  return false;
};

// ─── Load supplementary files ───────────────────────────────────────────────

const loadSupplementaryFiles = (): Map<string, Map<string, string>> | null => {
  if (!fs.existsSync(SUPPLEMENTARY_INDEX) || !fs.existsSync(SUPPLEMENTARY_DIR)) {
    return null;
  }
  try {
    const index = JSON.parse(fs.readFileSync(SUPPLEMENTARY_INDEX, 'utf-8'));
    const lookups = new Map<string, Map<string, string>>();

    for (const entry of index.files || []) {
      const filePath = path.join(SUPPLEMENTARY_DIR, entry.filename);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lookup = new Map<string, string>();
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          lookup.set(parts[0].trim(), parts[1].trim());
        }
      }

      if (lookup.size > 0) {
        lookups.set(entry.filename, lookup);
      }
    }

    return lookups.size > 0 ? lookups : null;
  } catch {
    return null;
  }
};

// ─── Row cleaning pipeline ──────────────────────────────────────────────────

interface RowCleanResult {
  row: Row | null; // null = row removed
  issues: string[];
  trimCount: number;
  nullNormalized: number;
  coercionResults: Map<string, { success: boolean }>;
}

const cleanRow = (
  raw: Row,
  columns: string[],
  columnTypes: Map<string, ColumnTypeInfo>,
): RowCleanResult => {
  const issues: string[] = [];
  let trimCount = 0;
  let nullNormalized = 0;
  const coercionResults = new Map<string, { success: boolean }>();

  // Step: Check critical constraints — remove row if invalid
  if (isCriticallyInvalid(raw)) {
    issues.push('missing_critical_field');
    return { row: null, issues, trimCount, nullNormalized, coercionResults };
  }

  const cleaned: Row = {};

  for (const col of columns) {
    let value: string | null = raw[col] ?? '';

    // (a) Trim whitespace
    const beforeTrim = value;
    value = trimValue(value);
    if (value !== beforeTrim) trimCount++;

    // (b) Normalize null markers
    const normalized = normalizeNull(value);
    if (normalized === null && value.length > 0) nullNormalized++;
    value = normalized;

    if (value === null) {
      cleaned[col] = '';
      continue;
    }

    // (c) Multi-value normalization
    if (MULTI_VALUE_COLUMNS.has(col)) {
      value = normalizeMultiValue(value);
      if (value === null) {
        cleaned[col] = '';
        continue;
      }
    }

    // (d) Type coercion based on ontology mappings
    const typeInfo = columnTypes.get(col);
    if (typeInfo) {
      const originalValue = value;

      if (typeInfo.isURI && MULTI_VALUE_COLUMNS.has(col)) {
        value = coerceMultiURI(value);
      } else if (typeInfo.isURI) {
        value = coerceURI(value);
      } else {
        switch (typeInfo.datatype) {
          case 'xsd:gYear':
            value = coerceYear(value);
            break;
          case 'xsd:integer':
            value = coerceInteger(value);
            break;
          case 'xsd:dateTime':
          case 'xsd:date':
            value = coerceDate(value);
            break;
          case 'xsd:boolean':
            value = coerceBoolean(value);
            break;
          // xsd:string — no coercion needed
        }
      }

      if (value !== originalValue) {
        coercionResults.set(col, { success: value !== null });
        if (value === null) {
          issues.push(`coercion_failed:${col}`);
        }
      }
    }

    cleaned[col] = value ?? '';
  }

  // (e) Record-type specific validation
  const recordType = cleaned['record_type']?.toLowerCase();
  const title = cleaned['title'];

  // Title is strongly recommended but not always fatal
  if (!title || title.length === 0) {
    issues.push('missing_title');
  }

  // Article should have journal or booktitle
  if (recordType === 'article' && !cleaned['journal']) {
    issues.push('article_missing_journal');
  }

  // Conference paper should have booktitle
  if (recordType === 'inproceedings' && !cleaned['booktitle']) {
    issues.push('inproceedings_missing_booktitle');
  }

  return { row: cleaned, issues, trimCount, nullNormalized, coercionResults };
};

// ─── Deduplication via streaming hash ───────────────────────────────────────

// Use a compact hash for dedup — concatenate key fields rather than full row
// DBLP key is unique identifier, so dedup on key
const getDeduplicationKey = (row: Row): string => row['key'] || '';

// ─── Main pipeline ──────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const startTime = Date.now();
  console.log('=== Data Cleaning Pipeline ===');
  console.log(`Input: ${INPUT_CSV}`);
  console.log(`Output: ${OUTPUT_CSV}`);

  // Load ontology and mapping
  console.log('\nLoading ontology structure...');
  const ontology = JSON.parse(fs.readFileSync(ONTOLOGY_FILE, 'utf-8'));
  console.log(`  Ontology: ${ontology.metadata.title} v${ontology.metadata.version}`);
  console.log(`  Classes: ${ontology.classes.length}, Properties: ${(ontology.dataProperties?.length || 0) + (ontology.objectProperties?.length || 0)}`);

  console.log('Loading mapping strategy...');
  const mapping: MappingStrategy = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
  console.log(`  Compliance score: ${mapping.metadata.complianceScore}/100`);
  console.log(`  Mapped columns: ${mapping.metadata.mappedColumns}/${mapping.metadata.mappedColumns + mapping.metadata.unmappedColumns}`);

  const columnTypes = buildColumnTypeMap(mapping);

  // Load supplementary files (optional)
  console.log('Loading supplementary files...');
  const supplementary = loadSupplementaryFiles();
  console.log(supplementary ? `  Loaded ${supplementary.size} lookup tables` : '  No supplementary files found');

  // Initialize report accumulators
  let originalRows = 0;
  let cleanedRows = 0;
  let rowsRemoved = 0;
  let duplicatesRemoved = 0;
  const issueCounter = new Map<string, number>();
  const coercionSuccess = new Map<string, number>();
  const coercionFail = new Map<string, number>();
  const columnNullsBefore = new Map<string, number>();
  const columnNullsAfter = new Map<string, number>();
  const columnTrimmed = new Map<string, number>();
  const columnCoerced = new Map<string, number>();

  // Dedup set — only track DBLP keys
  const seenKeys = new Set<string>();

  // Stream processing
  console.log('\nStreaming and cleaning data...');

  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(INPUT_CSV, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false, // We handle trimming ourselves
    });

    const outputDir = path.dirname(OUTPUT_CSV);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const writeStream = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf-8' });

    let columns: string[] | null = null;
    let headerWritten = false;
    let chunkCount = 0;
    let rowsInChunk = 0;

    parser.on('readable', () => {
      let record: Row;
      while ((record = parser.read()) !== null) {
        originalRows++;

        // Capture column names from first record
        if (columns === null) {
          columns = Object.keys(record);
          // Write CSV header
          writeStream.write(columns.join(',') + '\n');
          headerWritten = true;
        }

        // Count nulls before cleaning
        for (const col of columns) {
          const val = record[col] ?? '';
          if (!val || isNullMarker(val)) {
            columnNullsBefore.set(col, (columnNullsBefore.get(col) || 0) + 1);
          }
        }

        // (a) Exact duplicate check via key
        const dedupKey = getDeduplicationKey(record);
        if (dedupKey && seenKeys.has(dedupKey)) {
          duplicatesRemoved++;
          rowsRemoved++;
          continue;
        }
        if (dedupKey) {
          seenKeys.add(dedupKey);
        }

        // Clean the row
        const result = cleanRow(record, columns, columnTypes);

        // Track issues
        for (const issue of result.issues) {
          issueCounter.set(issue, (issueCounter.get(issue) || 0) + 1);
        }

        // Track coercion results
        for (const [col, res] of result.coercionResults) {
          if (res.success) {
            coercionSuccess.set(col, (coercionSuccess.get(col) || 0) + 1);
          } else {
            coercionFail.set(col, (coercionFail.get(col) || 0) + 1);
          }
          columnCoerced.set(col, (columnCoerced.get(col) || 0) + 1);
        }

        if (result.row === null) {
          rowsRemoved++;
          continue;
        }

        // Count nulls after cleaning
        for (const col of columns) {
          if (!result.row[col]) {
            columnNullsAfter.set(col, (columnNullsAfter.get(col) || 0) + 1);
          }
        }

        // Write cleaned row — CSV-escape values containing commas, quotes, or newlines
        const csvLine = columns.map(col => {
          const v = result.row![col] ?? '';
          if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
            return '"' + v.replace(/"/g, '""') + '"';
          }
          return v;
        }).join(',');
        writeStream.write(csvLine + '\n');
        cleanedRows++;

        rowsInChunk++;
        if (rowsInChunk >= CHUNK_SIZE) {
          chunkCount++;
          if (chunkCount % 200 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = Math.round(originalRows / ((Date.now() - startTime) / 1000));
            console.log(`  Processed ${originalRows.toLocaleString()} rows (${elapsed}s, ${rate.toLocaleString()} rows/s) | Cleaned: ${cleanedRows.toLocaleString()} | Removed: ${rowsRemoved.toLocaleString()}`);
          }
          rowsInChunk = 0;
        }
      }
    });

    parser.on('error', (err: Error) => {
      console.error('CSV parse error:', err.message);
      reject(err);
    });

    parser.on('end', () => {
      writeStream.end(() => {
        resolve();
      });
    });

    readStream.pipe(parser);
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nCleaning complete in ${elapsed}s`);

  // Free memory
  seenKeys.clear();

  // ─── Build report ───────────────────────────────────────────────────────

  const issues: CleaningIssue[] = [];
  for (const [type, count] of issueCounter) {
    let severity: 'info' | 'warning' | 'error' = 'info';
    if (type === 'missing_critical_field') severity = 'error';
    else if (type === 'missing_title') severity = 'warning';
    else if (type.startsWith('coercion_failed')) severity = 'warning';
    else if (type.includes('missing_')) severity = 'info';

    issues.push({ type, count, severity });
  }

  // Add dedup as an issue
  if (duplicatesRemoved > 0) {
    issues.push({ type: 'duplicate_keys_removed', count: duplicatesRemoved, severity: 'info' });
  }

  const typeCoercions: TypeCoercion[] = [];
  const allCoercionCols = new Set([...coercionSuccess.keys(), ...coercionFail.keys()]);
  for (const col of allCoercionCols) {
    const typeInfo = columnTypes.get(col);
    typeCoercions.push({
      column: col,
      targetType: typeInfo?.datatype || 'unknown',
      successCount: coercionSuccess.get(col) || 0,
      failCount: coercionFail.get(col) || 0,
    });
  }

  const columnSummary: Record<string, { nullsBefore: number; nullsAfter: number; trimmed: number; coerced: number }> = {};
  const allCols = new Set([...columnNullsBefore.keys(), ...columnNullsAfter.keys()]);
  for (const col of allCols) {
    columnSummary[col] = {
      nullsBefore: columnNullsBefore.get(col) || 0,
      nullsAfter: columnNullsAfter.get(col) || 0,
      trimmed: columnTrimmed.get(col) || 0,
      coerced: columnCoerced.get(col) || 0,
    };
  }

  const report: CleaningReport = {
    originalRows,
    cleanedRows,
    rowsRemoved,
    duplicatesRemoved,
    issues: issues.sort((a, b) => b.count - a.count),
    typeCoercions: typeCoercions.sort((a, b) => (b.successCount + b.failCount) - (a.successCount + a.failCount)),
    columnSummary,
  };

  // Save report
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nReport saved to: ${REPORT_FILE}`);

  // ─── Print summary ────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║              DATA CLEANING SUMMARY                         ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Original rows:    ${String(originalRows.toLocaleString()).padEnd(40)}║`);
  console.log(`║  Cleaned rows:     ${String(cleanedRows.toLocaleString()).padEnd(40)}║`);
  console.log(`║  Rows removed:     ${String(rowsRemoved.toLocaleString()).padEnd(40)}║`);
  console.log(`║  Duplicates:       ${String(duplicatesRemoved.toLocaleString()).padEnd(40)}║`);
  console.log(`║  Retention rate:   ${String((cleanedRows / originalRows * 100).toFixed(2) + '%').padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  ISSUES                                                    ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  for (const issue of report.issues.slice(0, 10)) {
    const tag = issue.severity === 'error' ? '[ERR]' : issue.severity === 'warning' ? '[WRN]' : '[INF]';
    console.log(`║  ${tag} ${issue.type.padEnd(35)} ${String(issue.count.toLocaleString()).padStart(15)} ║`);
  }
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  TYPE COERCIONS                                            ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  for (const tc of report.typeCoercions) {
    const total = tc.successCount + tc.failCount;
    const failRate = total > 0 ? ((tc.failCount / total) * 100).toFixed(1) : '0.0';
    console.log(`║  ${tc.column.padEnd(15)} → ${tc.targetType.padEnd(15)} ok:${String(tc.successCount.toLocaleString()).padStart(10)} fail:${String(tc.failCount.toLocaleString()).padStart(10)} (${failRate}%) ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');

  console.log(`\nCleaned CSV: ${OUTPUT_CSV}`);
  console.log(`Total time: ${elapsed}s`);
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
