#!/bin/bash
# Knowledge Graph Generation CLI
# Interactive command-line tool for ontology-compliant KG generation

set -e

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPTS_DIR="$SCRIPT_DIR/prompts"

# Load environment variables
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(cat "$SCRIPT_DIR/.env" | grep -v '^#' | xargs)
else
    echo -e "${YELLOW}⚠️  Warning: .env file not found. Using defaults.${NC}"
    echo -e "${YELLOW}   Create .env from .env.example for custom configuration.${NC}"
    echo ""
fi

# Set defaults if not in .env
export DATA_DIR="${DATA_DIR:-data}"
export DOMAIN="${DOMAIN:-$(basename "$DATA_DIR")}"
export NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
export NEO4J_USER="${NEO4J_USER:-neo4j}"
export NEO4J_DATABASE="${NEO4J_DATABASE:-neo4j}"

# Source logging and provider utilities
source "$SCRIPT_DIR/lib/logger.sh"
source "$SCRIPT_DIR/lib/provider.sh"

# Initialize generated code dir (provider-aware: src/generated/<provider>/<domain>/)
init_generated_dir "$DOMAIN"

# Validate provider availability
export PROVIDER="${PROVIDER:-claude}"
if ! validate_provider; then
    echo -e "${RED}Provider validation failed. Check your .env configuration.${NC}"
    exit 1
fi

# Check if NEO4J_PASSWORD is set for validation step
NEO4J_PASSWORD_SET=false
if [ ! -z "$NEO4J_PASSWORD" ]; then
    NEO4J_PASSWORD_SET=true
fi

# Banner
show_banner() {
    clear
    echo -e "${CYAN}"
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║                                                        ║"
    echo "║        Knowledge Graph Generator                       ║"
    echo "║                                                        ║"
    echo "╚════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo -e "AI Provider: ${GREEN}$(get_provider_display_name)${NC}"
    echo -e "Data Directory: ${GREEN}$DATA_DIR${NC}"
    echo -e "Domain: ${GREEN}$DOMAIN${NC}"
    echo -e "Generated Code: ${GREEN}$GENERATED_DIR${NC}"
    echo -e "Output Directory: ${GREEN}$OUTPUT_DIR${NC}"
    echo -e "Neo4j URI: ${GREEN}$NEO4J_URI${NC}"
    echo -e "Neo4j Database: ${GREEN}$NEO4J_DATABASE${NC}"
    if [ "$NEO4J_PASSWORD_SET" = true ]; then
        echo -e "Neo4j Auth: ${GREEN}✓ Configured${NC}"
    else
        echo -e "Neo4j Auth: ${YELLOW}⚠ Not configured${NC}"
    fi
    echo ""
}

# Menu options
show_menu() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${MAGENTA}Main Menu${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Pipeline Options:"
    echo "    1) Run Full Pipeline (All Steps)"
    echo "    2) Run Pipeline from Specific Step"
    echo ""
    echo "  Individual Steps:"
    echo "    3) Merge Datasets"
    echo "    4) Profile Dataset"
    echo "    5) Parse Ontology"
    echo "    6) Create Mapping"
    echo "    7) Clean Data"
    echo "    8) Generate Knowledge Graph"
    echo "    9) Import to Neo4j"
    echo "   10) Validate Compliance"
    echo ""
    echo "  Utilities:"
    echo "   11) View Pipeline Status"
    echo "   12) View Compliance Report"
    echo "   13) Apply Validation Fixes"
    echo "   14) Test Neo4j Connection"
    echo "   15) Configure Settings"
    echo ""
    echo "  Optional:"
    echo "   16) Validate SHACL Shapes (n10s)"
    echo ""
    echo "    0) Exit"
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
}

# Execute step
execute_step() {
    local step_name=$1
    local step_file=$2

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}▶ $step_name${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    if [ ! -f "$PROMPTS_DIR/$step_file" ]; then
        echo -e "${RED}✗ Error: Step file not found: $step_file${NC}"
        return 1
    fi

    # Initialize logging for this step
    local log_step_name="${step_file%.sh}"
    init_logging "$log_step_name" "$DATA_DIR"
    log_info "Starting: $step_name"

    bash "$PROMPTS_DIR/$step_file" 2>&1 | tee -a "$STEP_OUTPUT_FILE"
    local exit_code=${PIPESTATUS[0]}

    echo ""
    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ $step_name completed successfully${NC}"
        log_success "$step_name completed successfully"
    else
        echo -e "${RED}✗ $step_name failed (exit code: $exit_code)${NC}"
        log_error "$step_name failed (exit code: $exit_code)"
    fi

    finalize_logging $exit_code

    echo ""
    powershell.exe -c "[console]::beep(800, 300)" 2>/dev/null &  # Audible beep on step completion
    read -p "Press Enter to continue..."
    return $exit_code
}

# Run full pipeline
run_full_pipeline() {
    show_banner
    echo -e "${MAGENTA}Running Full Pipeline${NC}"
    echo ""

    execute_step "Step 1: Merge Datasets" "merge-datasets.sh" || return 1
    execute_step "Step 2: Profile Dataset" "profile-data.sh" || return 1
    execute_step "Step 3: Parse Ontology" "parse-ontology.sh" || return 1
    execute_step "Step 4: Create Mapping" "create-mapping.sh" || return 1

    # Check compliance score
    check_compliance_before_continuing || return 1

    execute_step "Step 5: Clean Data" "clean-data.sh" || return 1
    execute_step "Step 6: Generate Knowledge Graph" "generate-graph.sh" || return 1

    # Optional Neo4j import
    echo ""
    read -p "Import to Neo4j? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Test Neo4j connection first
        echo ""
        echo -e "${BLUE}Testing Neo4j connection before import...${NC}"
        if bash "$SCRIPT_DIR/lib/check-neo4j-connection.sh"; then
            echo -e "${GREEN}✓ Connection successful, proceeding with import${NC}"
            echo ""
            execute_step "Step 7: Import to Neo4j" "import-to-neo4j.sh" || echo "Import failed, continuing..."
        else
            echo -e "${RED}✗ Neo4j connection failed${NC}"
            echo -e "${YELLOW}Skipping import step. Fix connection and run import separately.${NC}"
            read -p "Press Enter to continue..."
        fi

        # Optional validation
        echo ""
        read -p "Validate ontology compliance? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            execute_step "Step 8: Validate Compliance" "validate-ontology.sh"
        fi
    fi

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║         Pipeline Completed Successfully! 🎉            ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    read -p "Press Enter to return to menu..."
}

# Run pipeline from specific step
run_from_step() {
    show_banner
    echo -e "${MAGENTA}Run Pipeline from Step${NC}"
    echo ""
    echo "Select starting step:"
    echo "  1) Merge Datasets"
    echo "  2) Profile Dataset"
    echo "  3) Parse Ontology"
    echo "  4) Create Mapping"
    echo "  5) Clean Data"
    echo "  6) Generate Knowledge Graph"
    echo "  7) Import to Neo4j"
    echo "  8) Validate Compliance"
    echo ""
    read -p "Start from step (1-8): " step_num

    case $step_num in
        1) run_full_pipeline ;;
        2)
            execute_step "Step 2: Profile Dataset" "profile-data.sh" || return 1
            execute_step "Step 3: Parse Ontology" "parse-ontology.sh" || return 1
            execute_step "Step 4: Create Mapping" "create-mapping.sh" || return 1
            check_compliance_before_continuing || return 1
            execute_step "Step 5: Clean Data" "clean-data.sh" || return 1
            execute_step "Step 6: Generate Knowledge Graph" "generate-graph.sh" || return 1
            ;;
        3)
            execute_step "Step 3: Parse Ontology" "parse-ontology.sh" || return 1
            execute_step "Step 4: Create Mapping" "create-mapping.sh" || return 1
            check_compliance_before_continuing || return 1
            execute_step "Step 5: Clean Data" "clean-data.sh" || return 1
            execute_step "Step 6: Generate Knowledge Graph" "generate-graph.sh" || return 1
            ;;
        4)
            execute_step "Step 4: Create Mapping" "create-mapping.sh" || return 1
            check_compliance_before_continuing || return 1
            execute_step "Step 5: Clean Data" "clean-data.sh" || return 1
            execute_step "Step 6: Generate Knowledge Graph" "generate-graph.sh" || return 1
            ;;
        5)
            execute_step "Step 5: Clean Data" "clean-data.sh" || return 1
            execute_step "Step 6: Generate Knowledge Graph" "generate-graph.sh" || return 1
            ;;
        6)
            execute_step "Step 6: Generate Knowledge Graph" "generate-graph.sh" || return 1
            ;;
        7)
            execute_step "Step 7: Import to Neo4j" "import-to-neo4j.sh"
            ;;
        8)
            execute_step "Step 8: Validate Compliance" "validate-ontology.sh"
            ;;
        *)
            echo -e "${RED}Invalid step number${NC}"
            read -p "Press Enter to continue..."
            ;;
    esac
}

# Check compliance score before continuing
check_compliance_before_continuing() {
    if [ -f "$OUTPUT_DIR/mapping-strategy.json" ] && command -v jq &> /dev/null; then
        local score=$(jq -r '.metadata.complianceScore // "unknown"' "$OUTPUT_DIR/mapping-strategy.json")
        echo ""
        echo -e "${CYAN}Compliance Score: $score/100${NC}"

        if [ "$score" != "unknown" ] && [ "$score" -lt 70 ]; then
            echo -e "${YELLOW}⚠️  WARNING: Compliance score is below 70!${NC}"
            echo -e "${YELLOW}   Review $OUTPUT_DIR/mapping-strategy.json${NC}"
            echo ""
            read -p "Continue anyway? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                return 1
            fi
        fi
    fi
    return 0
}

# View pipeline status
view_status() {
    show_banner
    echo -e "${MAGENTA}Pipeline Status${NC}"
    echo ""

    local files=(
        "merge-report.json:Merge Report"
        "dataset-profile.json:Dataset Profile"
        "ontology-structure.json:Ontology Structure"
        "mapping-strategy.json:Mapping Strategy"
        "dataset-cleaned.csv:Cleaned Data"
        "graph-data.json:Knowledge Graph"
        "validation-report.json:Validation Report"
    )

    for file_info in "${files[@]}"; do
        IFS=':' read -r file desc <<< "$file_info"
        if [ -f "$OUTPUT_DIR/$file" ]; then
            echo -e "${GREEN}✓${NC} $desc"
        else
            echo -e "${RED}✗${NC} $desc"
        fi
    done

    echo ""
    read -p "Press Enter to continue..."
}

# View compliance report
view_compliance_report() {
    show_banner
    echo -e "${MAGENTA}Compliance Report${NC}"
    echo ""

    if [ -f "$OUTPUT_DIR/validation-report.txt" ]; then
        cat "$OUTPUT_DIR/validation-report.txt"
    elif [ -f "$OUTPUT_DIR/mapping-compliance-report.json" ] && command -v jq &> /dev/null; then
        echo "Mapping Compliance Report:"
        echo ""
        jq '.' "$OUTPUT_DIR/mapping-compliance-report.json"
    else
        echo -e "${YELLOW}No compliance report found.${NC}"
        echo "Run the pipeline or validation step first."
    fi

    echo ""
    read -p "Press Enter to continue..."
}

# Apply validation fixes
apply_fixes() {
    show_banner
    echo -e "${MAGENTA}Apply Validation Fixes${NC}"
    echo ""

    if [ ! -f "$OUTPUT_DIR/fixes.cypher" ]; then
        echo -e "${YELLOW}No fixes file found.${NC}"
        echo "Run validation step first."
        echo ""
        read -p "Press Enter to continue..."
        return
    fi

    echo "Available fixes in $OUTPUT_DIR/fixes.cypher"
    echo ""
    echo "Options:"
    echo "  1) View fixes"
    echo "  2) Apply safe fixes only"
    echo "  3) Apply all fixes (dangerous!)"
    echo "  4) Manual selection"
    echo "  0) Cancel"
    echo ""
    read -p "Choose option: " fix_option

    case $fix_option in
        1)
            less "$OUTPUT_DIR/fixes.cypher"
            ;;
        2)
            echo "Applying safe fixes..."
            # Extract safe fixes section and apply
            sed -n '/SAFE FIXES/,/MODERATE FIXES/p' "$OUTPUT_DIR/fixes.cypher" | \
                cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" -a "$NEO4J_URI" -d "$NEO4J_DATABASE"
            ;;
        3)
            echo -e "${RED}⚠️  WARNING: This will apply ALL fixes, including destructive ones!${NC}"
            read -p "Are you ABSOLUTELY sure? (type YES): " confirm
            if [ "$confirm" = "YES" ]; then
                cat "$OUTPUT_DIR/fixes.cypher" | \
                    cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" -a "$NEO4J_URI" -d "$NEO4J_DATABASE"
            fi
            ;;
        4)
            echo "Opening fixes file in editor..."
            ${EDITOR:-nano} "$OUTPUT_DIR/fixes.cypher"
            echo ""
            read -p "Apply edited fixes? (y/n) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                cat "$OUTPUT_DIR/fixes.cypher" | \
                    cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" -a "$NEO4J_URI" -d "$NEO4J_DATABASE"
            fi
            ;;
        *)
            echo "Cancelled."
            ;;
    esac

    echo ""
    read -p "Press Enter to continue..."
}

# Test Neo4j connection
test_neo4j_connection() {
    show_banner
    echo -e "${MAGENTA}Testing Neo4j Connection${NC}"
    echo ""

    if [ -f "$SCRIPT_DIR/lib/check-neo4j-connection.sh" ]; then
        bash "$SCRIPT_DIR/lib/check-neo4j-connection.sh"
    else
        echo -e "${RED}✗ Connection checker not found${NC}"
        echo "Expected: $SCRIPT_DIR/lib/check-neo4j-connection.sh"
    fi

    echo ""
    read -p "Press Enter to continue..."
}

# Configure settings
configure_settings() {
    show_banner
    echo -e "${MAGENTA}Configure Settings${NC}"
    echo ""

    echo "Current Configuration:"
    echo "  PROVIDER=$PROVIDER ($(get_provider_display_name))"
    echo "  DATA_DIR=$DATA_DIR"
    echo "  OUTPUT_DIR=$OUTPUT_DIR"
    echo "  NEO4J_URI=$NEO4J_URI"
    echo "  NEO4J_USER=$NEO4J_USER"
    echo "  NEO4J_DATABASE=$NEO4J_DATABASE"
    echo "  NEO4J_PASSWORD=${NEO4J_PASSWORD:+***set***}"
    echo ""
    echo "Edit .env file to change configuration."
    echo ""

    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        read -p "Create .env from .env.example? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            if [ -f "$SCRIPT_DIR/.env.example" ]; then
                cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
                echo -e "${GREEN}✓ Created .env file${NC}"
                echo "Please edit .env and restart the CLI."
            else
                echo -e "${RED}✗ .env.example not found${NC}"
            fi
        fi
    else
        read -p "Open .env in editor? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            ${EDITOR:-nano} "$SCRIPT_DIR/.env"
            echo ""
            echo -e "${YELLOW}Please restart CLI for changes to take effect.${NC}"
        fi
    fi

    echo ""
    read -p "Press Enter to continue..."
}

# Run SHACL validation with n10s
run_shacl_validation() {
    show_banner
    echo -e "${MAGENTA}SHACL Validation (n10s)${NC}"
    echo ""

    # Check Neo4j connection first
    echo -e "${BLUE}Testing Neo4j connection...${NC}"
    if ! bash "$SCRIPT_DIR/lib/check-neo4j-connection.sh"; then
        echo -e "${RED}✗ Neo4j connection failed${NC}"
        echo -e "${YELLOW}Neo4j must be running with n10s installed for SHACL validation.${NC}"
        echo ""
        read -p "Press Enter to continue..."
        return 1
    fi
    echo -e "${GREEN}✓ Connection OK${NC}"
    echo ""

    # Let the prompt script handle file discovery/selection
    execute_step "SHACL Validation (n10s)" "validate-shacl.sh"
}

# Main loop
main() {
    while true; do
        show_banner
        show_menu
        read -p "Enter choice [0-16]: " choice
        echo ""

        case $choice in
            1) run_full_pipeline ;;
            2) run_from_step ;;
            3) execute_step "Merge Datasets" "merge-datasets.sh" ;;
            4) execute_step "Profile Dataset" "profile-data.sh" ;;
            5) execute_step "Parse Ontology" "parse-ontology.sh" ;;
            6) execute_step "Create Mapping" "create-mapping.sh" ;;
            7) execute_step "Clean Data" "clean-data.sh" ;;
            8) execute_step "Generate Knowledge Graph" "generate-graph.sh" ;;
            9) execute_step "Import to Neo4j" "import-to-neo4j.sh" ;;
            10) execute_step "Validate Compliance" "validate-ontology.sh" ;;
            11) view_status ;;
            12) view_compliance_report ;;
            13) apply_fixes ;;
            14) test_neo4j_connection ;;
            15) configure_settings ;;
            16) run_shacl_validation ;;
            0)
                echo -e "${CYAN}Goodbye!${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}Invalid option${NC}"
                sleep 1
                ;;
        esac
    done
}

# Run main
main
