#!/bin/bash
# Script to add logging to all prompt files

PROMPTS_DIR="prompts"

# Create logging header template
create_logging_header() {
    local step_name=$1
    cat <<'EOF'
# Load logging utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/logger.sh"

# Use DATA_DIR from environment or default
DATA_DIR="${DATA_DIR:-data}"

# Initialize logging
init_logging "STEP_NAME" "$DATA_DIR"

EOF
}

# Update each prompt file
update_prompt_file() {
    local file=$1
    local step_name=$(basename "$file" .sh)

    echo "Updating $file..."

    # Create temp file with logging
    {
        echo '#!/bin/bash'
        echo "# $(head -2 "$file" | tail -1 | sed 's/^#[ ]*//')"
        echo ""
        create_logging_header "$step_name" | sed "s/STEP_NAME/$step_name/g"

        # Add initial log statements
        echo 'log_info "Starting '"$step_name"'"'
        echo 'log_info "Data directory: $DATA_DIR"'
        echo ""

        # Skip shebang and initial comments, add rest of file
        tail -n +3 "$file" | sed 's/^DATA_DIR=.*/# DATA_DIR set above/' | sed 's/^CLAUDE_CMD=.*/# CLAUDE_CMD not needed with logging/'

        # Add finalization at end
        echo ""
        echo '# Finalize logging'
        echo 'EXIT_CODE=$?'
        echo 'finalize_logging $EXIT_CODE'
        echo 'exit $EXIT_CODE'

    } > "$file.tmp"

    mv "$file.tmp" "$file"
    chmod +x "$file"
}

# Process all prompt files
for file in $PROMPTS_DIR/*.sh; do
    if [ -f "$file" ]; then
        update_prompt_file "$file"
    fi
done

echo "✓ All prompt files updated with logging"
