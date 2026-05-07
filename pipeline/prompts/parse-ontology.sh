#!/bin/bash
#  Parse the domain ontology

echo "========================================"
echo " Parsing Ontology"
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
    init_logging "parse-ontology" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Parse Ontology"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

run_provider "Parse the domain ontology. Write TypeScript code that:

1. **Discover ontology files** in '$DATA_DIR/ontology/':
   - Scan for all supported formats: .owl, .xml, .ttl, .rdf, .n3, .jsonld
   - Log which files were found and their formats
   - If no ontology files found, exit with an error

2. Use the 'rdflib' or 'n3' npm package to parse the OWL/RDF/XML files

3. Extract ALL ontology elements from every discovered file:

   a) **Classes** (owl:Class, rdfs:Class):
      - URI, label, definition (skos:definition or rdfs:comment)
      - Comments (rdfs:comment, skos:scopeNote)
      - Super classes (rdfs:subClassOf)
      - Equivalent classes (owl:equivalentClass)

   b) **Object Properties** (owl:ObjectProperty):
      - URI, label, definition
      - Domain (rdfs:domain) and Range (rdfs:range)
      - Super properties (rdfs:subPropertyOf)
      - Inverse properties (owl:inverseOf)
      - Cardinality constraints if any

   c) **Data Properties** (owl:DatatypeProperty, rdf:Property with literal ranges):
      - URI, label, definition
      - Domain (rdfs:domain) and Range (rdfs:range)
      - Datatype (xsd:string, xsd:date, xsd:integer, etc.)

   d) **External vocabularies** referenced (any imported/used namespaces)
      - Track which namespaces are imported/used
      - These are ALSO valid for use in the knowledge graph

4. Create a comprehensive structured JSON:
   {
     'metadata': {
       'title': string,        // Derive from ontology metadata (dc:title, rdfs:label, etc.)
       'version': string,      // Derive from owl:versionInfo if available
       'description': string,  // Derive from rdfs:comment, dc:description
       'sourceFiles': string[],// List of parsed ontology files
       'namespaces': { prefix: uri }  // All discovered namespaces
     },
     'classes': [
       {
         'uri': string,
         'label': string,
         'definition': string,
         'comment': string,
         'superClasses': string[],
         'equivalentClasses': string[],
         'examples': string[]
       }
     ],
     'objectProperties': [
       {
         'uri': string,
         'label': string,
         'definition': string,
         'domain': string[],
         'range': string[],
         'superProperties': string[],
         'inverseOf': string
       }
     ],
     'dataProperties': [
       {
         'uri': string,
         'label': string,
         'definition': string,
         'domain': string[],
         'range': string  // XSD datatype
       }
     ],
     'externalVocabularies': [
       {
         'prefix': string,
         'namespace': string,
         'classes': string[],
         'properties': string[]
       }
     ]
   }

5. Extract common patterns to help with mapping:
   - Which classes are the most connected (most properties reference them)?
   - Which properties connect which classes?
   - What are typical property chains?
   - Identify the core entity classes vs. auxiliary/metadata classes

6. Generate a mapping guide derived from the ontology:
   {
     'commonPatterns': [
       {
         'scenario': string,          // Describe the pattern
         'ontologyClass': string,     // The class URI
         'requiredProperties': string[],
         'optionalProperties': string[],
         'relationships': string[]    // Typical relationships involving this class
       }
     ],
     'allowedNamespaces': string[],   // All namespaces from the ontology
     'constraints': string[]          // Derived from ontology restrictions
   }

7. Save outputs:
   - Main structure: '$OUTPUT_DIR/ontology-structure.json'
   - Mapping guide: '$OUTPUT_DIR/ontology-mapping-guide.json'
   - Quick reference: '$OUTPUT_DIR/ontology-quick-reference.json' (simplified view)

8. Print summary:
   - Ontology name and version (derived from files)
   - Source files parsed
   - Number of classes found
   - Number of object properties found
   - Number of data properties found
   - List of core classes with descriptions
   - List of namespaces that can be used

9. Save code to '$GENERATED_DIR/parse-ontology.ts'

IMPORTANT NOTES:
- Parse ALL ontology files found in '$DATA_DIR/ontology/' — do not hardcode filenames
- Detect the file format from extension and content (OWL/XML, Turtle, N3, JSON-LD, etc.)
- Include all external vocabularies as they are valid for use in the knowledge graph
- Make the mapping guide practical and actionable for the next steps
- Focus on clarity - this will be used to ENFORCE ontology compliance in later steps
- Do NOT assume any specific ontology (EDM, FABIO, Schema.org, etc.) — be fully generic

Use functional programming patterns. Execute after writing."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_file_operation "write" "$OUTPUT_DIR/ontology-structure.json" "ontology structure"
    log_file_operation "write" "$OUTPUT_DIR/ontology-mapping-guide.json" "mapping guide"
    log_file_operation "write" "$OUTPUT_DIR/ontology-quick-reference.json" "quick reference"
    log_file_operation "write" "$GENERATED_DIR/parse-ontology.ts" "generated code"
    log_success "Parse Ontology completed"
    echo ""
    echo "Ontology parsed!"
    echo "Check:"
    echo "  - $OUTPUT_DIR/ontology-structure.json (complete structure)"
    echo "  - $OUTPUT_DIR/ontology-mapping-guide.json (mapping patterns)"
    echo "  - $OUTPUT_DIR/ontology-quick-reference.json (quick lookup)"
    echo ""
else
    log_error "Parse Ontology failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE
