#!/bin/bash
#  Create mapping between dataset and domain ontology

echo "========================================"
echo " Creating Dataset-Ontology Mapping"
echo "========================================"


DATA_DIR="${DATA_DIR:-data}"
DOMAIN="${DOMAIN:-$(basename "$DATA_DIR")}"
# Source logging utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/logger.sh"
source "$SCRIPT_DIR/../lib/provider.sh"
init_generated_dir "$DOMAIN"
_SELF_INIT_LOGGING=false
if [ -z "$LOG_DIR" ]; then
    init_logging "create-mapping" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Create Ontology Mapping"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

run_provider "Create a STRICT mapping between the dataset and the domain ontology. Write TypeScript code that:

1. Load required files:
   - '$OUTPUT_DIR/dataset-profile.json' (dataset structure)
   - '$OUTPUT_DIR/ontology-structure.json' (parsed ontology)
   - '$OUTPUT_DIR/ontology-mapping-guide.json' (ontology patterns)

   Also check for optional supplementary data:
   - '$OUTPUT_DIR/supplementary-files-index.json' (if it exists)
   - If supplementary files exist, load the actual supplementary files listed in the index
     from '$DATA_DIR/supplementary-files/'. These are reference/lookup tables that provide
     domain context — e.g., feature code definitions, administrative division names,
     country metadata, category taxonomies. Use them to:
     a) Better understand what dataset columns contain (e.g., a column with values like
        'P.PPL', 'H.STM' can be understood via a feature codes lookup file)
     b) Inform entity detection (supplementary taxonomies suggest ontology class mappings)
     c) Identify columns that are foreign keys into supplementary reference tables
     d) Improve confidence scores for mappings where supplementary data confirms the match

2. **STRICT ONTOLOGY COMPLIANCE RULES** (MUST FOLLOW):

   Read the namespaces from ontology-structure.json metadata.namespaces.
   Read the classes from ontology-structure.json classes[].
   Read the properties from ontology-structure.json objectProperties[] and dataProperties[].

   ONLY use classes and properties that exist in ontology-structure.json or its declared namespaces.

   FORBIDDEN: Do NOT create custom classes or properties not in the ontology.
   FORBIDDEN: Do NOT use classes/properties not found in ontology-structure.json.

   If a column cannot be mapped to a valid ontology term, FLAG IT for review rather than inventing new terms.

3. **Entity Detection** (from ontology classes):

   Load all classes from ontology-structure.json. For each dataset column:

   a) Analyze column name patterns and sample values against ontology class definitions:
      - Match column names/values to class labels, definitions, and comments
      - Use the ontology class hierarchy to find the best match
      - Consider domain/range constraints from object properties

   b) Check cardinality:
      - High cardinality (>80% unique) + identifier pattern -> Entity (needs ID)
      - Medium cardinality (10-80%) -> Could be entity or controlled vocabulary
      - Low cardinality (<10%) -> Likely concept/category or attribute

   c) Relationship detection:
      - Foreign key patterns (*_id, *Id) -> Relationship property
      - Use object properties from ontology-structure.json to identify valid relationships
      - Match relationship patterns to ontology objectProperties with correct domain/range

4. **Attribute Mapping** (from ontology data properties):

   Load all data properties from ontology-structure.json.
   For each unmapped column, find the best matching data property by:
   - Comparing column name to property labels
   - Checking the domain constraint matches the target entity
   - Verifying the range/datatype is compatible with column values

5. **Generate Mapping with Compliance Scoring**:

   {
     'metadata': {
       'ontologyCompliant': boolean,
       'complianceScore': number (0-100),
       'ontologyName': string,       // From ontology-structure.json metadata.title
       'ontologyVersion': string,    // From ontology-structure.json metadata.version
       'allowedNamespaces': string[],// From ontology-structure.json metadata.namespaces
       'totalColumns': number,
       'mappedColumns': number,
       'unmappedColumns': number,
       'warnings': string[]
     },

     'entityMappings': [
       {
         'columnName': string,
         'ontologyClass': string,  // MUST be from ontology-structure.json
         'confidence': number,
         'reasoning': string,
         'identifierColumn': string,
         'requiredProperties': string[],
         'compliant': boolean
       }
     ],

     'attributeMappings': [
       {
         'columnName': string,
         'ontologyProperty': string,  // MUST be from ontology-structure.json
         'propertyType': 'data' | 'annotation',
         'targetEntity': string,
         'datatype': string,
         'confidence': number,
         'reasoning': string,
         'compliant': boolean
       }
     ],

     'relationshipMappings': [
       {
         'columnName': string,
         'ontologyRelationship': string,  // MUST be from ontology-structure.json
         'sourceEntity': string,
         'targetEntity': string,
         'confidence': number,
         'reasoning': string,
         'compliant': boolean
       }
     ],

     'unmappedColumns': [
       {
         'columnName': string,
         'reason': string,
         'suggestion': string,
         'severity': 'warning' | 'info'
       }
     ],

     'validationReport': {
       'classesUsed': string[],
       'propertiesUsed': string[],
       'namespacesUsed': string[],
       'customTermsDetected': string[],
       'recommendations': string[]
     }
   }

6. **Validation Checks**:

   a) Verify ALL mapped terms exist in ontology-structure.json
   b) Check domain/range compatibility against ontology objectProperties
   c) Verify at least one core entity class is mapped (the most connected class in the ontology)
   d) Flag any mapping with confidence < 0.6 for review
   e) Calculate compliance score:
      - 100% = All columns mapped to valid ontology terms
      - Deduct 10 points per unmapped column
      - Deduct 20 points per custom/invalid term

7. **Output Format**:

   Console output should show:
   - Mapped: X/Y columns (Z% coverage)
   - Ontology Compliance: score/100
   - Unmapped columns count (flagged for review)
   - Custom terms count
   - Entities detected with class URI and confidence

8. Save outputs:
   - '$OUTPUT_DIR/mapping-strategy.json' (main mapping)
   - '$OUTPUT_DIR/mapping-compliance-report.json' (validation report)

9. Save code to '$GENERATED_DIR/create-mapping.ts'

**CRITICAL**: This is the gatekeeper for ontology compliance. Be STRICT. Better to flag columns as unmapped than to create invalid mappings. All class and property references MUST come from ontology-structure.json.

Execute after writing."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_file_operation "write" "$OUTPUT_DIR/mapping-strategy.json" "mapping strategy"
    log_file_operation "write" "$OUTPUT_DIR/mapping-compliance-report.json" "compliance report"
    log_file_operation "write" "$GENERATED_DIR/create-mapping.ts" "generated code"
    log_success "Create Ontology Mapping completed"
    echo ""
    echo "Mapping created!"
    echo "Review:"
    echo "  - $OUTPUT_DIR/mapping-strategy.json (mappings)"
    echo "  - $OUTPUT_DIR/mapping-compliance-report.json (compliance report)"
    echo ""
else
    log_error "Create Ontology Mapping failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE