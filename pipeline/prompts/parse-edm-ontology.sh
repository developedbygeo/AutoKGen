#!/bin/bash
#  Parse the existing EDM ontology

echo "========================================"
echo " Parsing EDM Ontology"
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
    init_logging "parse-edm-ontology" "$DATA_DIR"
    _SELF_INIT_LOGGING=true
fi

log_info "Starting: Parse EDM Ontology"
log_info "Data directory: $DATA_DIR | Domain: $DOMAIN"
log_info "Generated code: $GENERATED_DIR"

run_provider "Parse the EDM (Europeana Data Model) ontology at '$DATA_DIR/ontology/ontology.owl'. Write TypeScript code that:

1. Use the 'rdflib' or 'n3' npm package to parse the OWL/RDF file

2. Extract ALL ontology elements:

   a) **Classes** (owl:Class, rdfs:Class):
      - URI, label, definition (skos:definition)
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

   d) **External vocabularies** referenced (dc:, dcterms:, foaf:, skos:, etc.)
      - Track which namespaces are imported/used
      - These are ALSO valid for use in the knowledge graph

3. Create a comprehensive structured JSON:
   {
     'metadata': {
       'title': 'Europeana Data Model',
       'version': string,
       'description': string,
       'namespaces': { prefix: uri }
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

4. Extract common patterns to help with mapping:
   - Which classes are most commonly used? (Agent, Place, TimeSpan, ProvidedCHO)
   - Which properties connect which classes?
   - What are typical property chains?

5. Generate a mapping guide:
   {
     'commonPatterns': [
       {
         'scenario': 'Artist/Creator information',
         'edmClass': 'edm:Agent',
         'requiredProperties': ['dc:identifier', 'skos:prefLabel'],
         'optionalProperties': ['edm:begin', 'edm:end', 'edm:hasMet'],
         'relationships': ['dc:creator (ProvidedCHO → Agent)']
       },
       {
         'scenario': 'Cultural Heritage Object',
         'edmClass': 'edm:ProvidedCHO',
         'requiredProperties': ['dc:identifier', 'dc:title'],
         'optionalProperties': ['dc:description', 'dc:type', 'dcterms:created'],
         'relationships': ['dc:creator', 'dc:subject']
       }
       // ... more patterns
     ],
     'strictConstraints': [
       'ONLY use classes from edm:, dc:, dcterms:, foaf:, skos: namespaces',
       'edm:Agent for people/organizations',
       'edm:Place for locations',
       'edm:TimeSpan for temporal information',
       'edm:ProvidedCHO for cultural heritage objects',
       'ore:Aggregation for metadata aggregation'
     ]
   }

6. Save outputs:
   - Main structure: '$OUTPUT_DIR/ontology-structure.json'
   - Mapping guide: '$OUTPUT_DIR/edm-mapping-guide.json'
   - Quick reference: '$OUTPUT_DIR/edm-quick-reference.json' (simplified view)

7. Print summary:
   - EDM version
   - Number of classes found
   - Number of object properties found
   - Number of data properties found
   - List of core EDM classes with descriptions
   - List of external vocabularies that can be used

8. Save code to '$GENERATED_DIR/parse-edm-ontology.ts'

IMPORTANT NOTES:
- Parse the ACTUAL EDM ontology at '$DATA_DIR/ontology/ontology.owl'
- Include all external vocabularies (DC, DCTERMS, FOAF, SKOS) as they are part of EDM
- Make the mapping guide practical and actionable for the next steps
- Focus on clarity - this will be used to ENFORCE ontology compliance

Use functional programming patterns. Execute after writing."
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    log_file_operation "write" "$OUTPUT_DIR/ontology-structure.json" "ontology structure"
    log_file_operation "write" "$OUTPUT_DIR/edm-mapping-guide.json" "mapping guide"
    log_file_operation "write" "$OUTPUT_DIR/edm-quick-reference.json" "quick reference"
    log_file_operation "write" "$GENERATED_DIR/parse-edm-ontology.ts" "generated code"
    log_success "Parse EDM Ontology completed"
    echo ""
    echo "EDM ontology parsed!"
    echo "Check:"
    echo "  - $OUTPUT_DIR/ontology-structure.json (complete structure)"
    echo "  - $OUTPUT_DIR/edm-mapping-guide.json (mapping patterns)"
    echo "  - $OUTPUT_DIR/edm-quick-reference.json (quick lookup)"
    echo ""
else
    log_error "Parse EDM Ontology failed (exit code: $EXIT_CODE)"
fi

if [ "$_SELF_INIT_LOGGING" = true ]; then
    finalize_logging $EXIT_CODE
fi
exit $EXIT_CODE
