#!/bin/bash
# Master pipeline orchestrator - Ontology-Compliant KG Generation

echo "========================================"
echo "Knowledge Graph Generation Pipeline"
echo "========================================"
echo ""
echo "This pipeline will generate an ontology-compliant Knowledge Graph:"
echo ""
echo "Step 1: Merge datasets (CSV, XML, JSON, TSV, TXT)"
echo "Step 2: Profile dataset structure"
echo "Step 3: Parse domain ontology"
echo "Step 4: Create ontology-compliant mapping"
echo "Step 5: Clean data"
echo "Step 6: Generate knowledge graph"
echo "Step 7: Import to Neo4j (optional)"
echo "Step 8: Validate ontology compliance"
echo ""
echo "Prerequisites:"
echo "✓ Data file(s) in: \$DATA_DIR/input/ (CSV, XML, JSON, TSV, TXT)"
echo "✓ Ontology file(s) in: \$DATA_DIR/ontology/ (.owl, .xml, .ttl, .rdf)"
echo "✓ Optional: supplementary files in: \$DATA_DIR/supplementary-files/"
echo "✓ Neo4j running (for import and validation steps)"
echo ""
echo "The pipeline enforces STRICT ontology compliance:"
echo "- Only classes and properties from the domain ontology"
echo "- Validates domain/range constraints"
echo "- Flags unmapped columns for review"
echo "- Provides automated fix suggestions"
echo ""

# Set default DATA_DIR if not provided
export DATA_DIR="${DATA_DIR:-data}"
export DOMAIN="${DOMAIN:-$(basename "$DATA_DIR")}"
# Source provider abstraction (sets OUTPUT_DIR and GENERATED_DIR)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/provider.sh"
init_generated_dir "$DOMAIN"

echo "Using DATA_DIR: $DATA_DIR"
echo "Domain: $DOMAIN"
echo "Generated code: $GENERATED_DIR"
echo ""
read -p "Press Enter to continue..."

# Step 1: Merge datasets
echo ""
echo "========================================"
echo "Step 1: Merging Datasets"
echo "========================================"
./prompts/merge-datasets.sh
if [ $? -ne 0 ]; then
    echo "❌ ERROR in Step 1: Merging failed"
    exit 1
fi
echo "✅ Step 1 completed"

# Step 2: Profile
echo ""
echo "========================================"
echo "Step 2: Profiling Dataset"
echo "========================================"
./prompts/profile-data.sh
if [ $? -ne 0 ]; then
    echo "❌ ERROR in Step 2: Profiling failed"
    exit 1
fi
echo "✅ Step 2 completed"

# Step 3: Parse Ontology
echo ""
echo "========================================"
echo "Step 3: Parsing Ontology"
echo "========================================"
./prompts/parse-ontology.sh
if [ $? -ne 0 ]; then
    echo "❌ ERROR in Step 3: Ontology parsing failed"
    exit 1
fi
echo "✅ Step 3 completed"

# Step 4: Create Mapping
echo ""
echo "========================================"
echo "Step 4: Creating Ontology Mapping"
echo "========================================"
./prompts/create-mapping.sh
if [ $? -ne 0 ]; then
    echo "❌ ERROR in Step 4: Mapping creation failed"
    exit 1
fi
echo "✅ Step 4 completed"

# Check mapping compliance score
if [ -f "$OUTPUT_DIR/mapping-strategy.json" ]; then
    echo ""
    echo "Checking mapping compliance score..."
    # Extract compliance score if possible (requires jq)
    if command -v jq &> /dev/null; then
        SCORE=$(jq -r '.metadata.complianceScore // "unknown"' "$OUTPUT_DIR/mapping-strategy.json")
        echo "Compliance Score: $SCORE/100"

        if [ "$SCORE" != "unknown" ] && [ "$SCORE" -lt 70 ]; then
            echo "⚠️  WARNING: Compliance score is below 70!"
            echo "Review $OUTPUT_DIR/mapping-strategy.json before continuing."
            read -p "Continue anyway? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi
fi

# Step 4: Clean Data
echo ""
echo "========================================"
echo "Step 5: Cleaning Data"
echo "========================================"
./prompts/clean-data.sh
if [ $? -ne 0 ]; then
    echo "❌ ERROR in Step 5: Data cleaning failed"
    exit 1
fi
echo "✅ Step 5 completed"

# Step 5: Generate Graph
echo ""
echo "========================================"
echo "Step 6: Generating Knowledge Graph"
echo "========================================"
./prompts/generate-graph.sh
if [ $? -ne 0 ]; then
    echo "❌ ERROR in Step 6: Graph generation failed"
    exit 1
fi
echo "✅ Step 6 completed"

# Optional: Import to Neo4j
echo ""
read -p "Import graph to Neo4j? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "========================================"
    echo "Step 7: Importing to Neo4j"
    echo "========================================"
    ./prompts/import-to-neo4j.sh
    if [ $? -ne 0 ]; then
        echo "⚠️  WARNING: Neo4j import failed (continuing...)"
    else
        echo "✅ Step 7 completed"

        # Optional: Validate graph in Neo4j
        echo ""
        read -p "Validate ontology compliance in Neo4j? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo ""
            echo "========================================"
            echo "Step 8: Validating Ontology Compliance"
            echo "========================================"
            ./prompts/validate-ontology.sh
            VALIDATION_EXIT=$?

            if [ $VALIDATION_EXIT -eq 0 ]; then
                echo "✅ Fully compliant!"
            elif [ $VALIDATION_EXIT -eq 1 ]; then
                echo "⚠️  Partially compliant - review fixes in $OUTPUT_DIR/fixes.cypher"
            else
                echo "❌ Non-compliant - major issues found"
                echo "Review $OUTPUT_DIR/validation-report.txt for details"
            fi
        fi
    fi
fi

echo ""
echo "========================================"
echo "Pipeline Complete!"
echo "========================================"
echo ""
echo "📁 Generated Files:"
echo ""
echo "Data Processing:"
echo "  - $OUTPUT_DIR/merge-report.json"
echo "  - $OUTPUT_DIR/dataset-profile.json"
echo "  - $OUTPUT_DIR/dataset-cleaned.csv"
echo "  - $OUTPUT_DIR/cleaning-report.json"
echo ""
echo "Ontology:"
echo "  - $OUTPUT_DIR/ontology-structure.json"
echo "  - $OUTPUT_DIR/ontology-mapping-guide.json"
echo "  - $OUTPUT_DIR/ontology-quick-reference.json"
echo ""
echo "Mapping & Compliance:"
echo "  - $OUTPUT_DIR/mapping-strategy.json"
echo "  - $OUTPUT_DIR/mapping-compliance-report.json"
echo ""
echo "Knowledge Graph:"
echo "  - $OUTPUT_DIR/graph-data.json"
echo "  - $OUTPUT_DIR/graph-import.cypher"
echo "  - $OUTPUT_DIR/graph-data.ttl (RDF/Turtle)"
echo "  - $OUTPUT_DIR/graph-stats.json"
echo ""
echo "Validation (if run):"
echo "  - $OUTPUT_DIR/validation-report.json"
echo "  - $OUTPUT_DIR/validation-report.txt"
echo "  - $OUTPUT_DIR/fixes.cypher"
echo ""
echo "💻 Generated Code (in $GENERATED_DIR/):"
echo "  - $GENERATED_DIR/merge-datasets.ts"
echo "  - $GENERATED_DIR/profile-data.ts"
echo "  - $GENERATED_DIR/parse-ontology.ts"
echo "  - $GENERATED_DIR/create-mapping.ts"
echo "  - $GENERATED_DIR/clean-data.ts"
echo "  - $GENERATED_DIR/generate-graph.ts"
echo "  - $GENERATED_DIR/validate-ontology.ts (if run)"
echo ""
echo "📊 Next Steps:"
echo "  1. Review mapping compliance in mapping-strategy.json"
echo "  2. Check graph statistics in graph-stats.json"
echo "  3. If validation was run, apply fixes from fixes.cypher"
echo "  4. Import to Neo4j and run validation iteratively until compliant"
echo ""
echo "🎉 Your Knowledge Graph is ready!"
echo ""