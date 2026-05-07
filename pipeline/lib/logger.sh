#!/bin/bash
# Logging utilities for Knowledge Graph generation
# Logs all AI provider actions with timestamps and metadata

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Initialize logging for a step
# If LOG_DIR is already set (e.g., by a parent pipeline), reuses the existing
# session directory so all steps share the same timestamp.
init_logging() {
    local step_name=$1
    local data_dir=${2:-data}

    # Create session-level log directory only if not already set
    if [ -z "$LOG_DIR" ] || [ ! -d "$LOG_DIR" ]; then
        export LOG_TIMESTAMP=$(date +%Y%m%d_%H%M%S)
        local provider="${PROVIDER:-claude}"
        export LOG_DIR="$data_dir/logs/$provider/${LOG_TIMESTAMP}"
        mkdir -p "$LOG_DIR/metadata"
    fi

    # Create step-level log directory (always, even within existing session)
    export STEP_LOG_DIR="$LOG_DIR/$step_name"
    export CURRENT_STEP_NAME="$step_name"
    mkdir -p "$STEP_LOG_DIR"

    # Initialize log files
    export STEP_LOG_FILE="$STEP_LOG_DIR/execution.log"
    export STEP_OUTPUT_FILE="$STEP_LOG_DIR/output.log"
    export STEP_ERROR_FILE="$STEP_LOG_DIR/error.log"
    export STEP_METADATA_FILE="$STEP_LOG_DIR/metadata.json"
    export PROVIDER_PROMPT_FILE="$STEP_LOG_DIR/provider-prompt.txt"
    export PROVIDER_RESPONSE_FILE="$STEP_LOG_DIR/provider-response.txt"
    # Backward-compatible aliases
    export CLAUDE_PROMPT_FILE="$PROVIDER_PROMPT_FILE"
    export CLAUDE_RESPONSE_FILE="$PROVIDER_RESPONSE_FILE"

    # Log session metadata
    cat > "$STEP_METADATA_FILE" <<EOF
{
  "step": "$step_name",
  "timestamp": "$(date -Iseconds)",
  "data_dir": "$data_dir",
  "log_dir": "$LOG_DIR",
  "user": "$USER",
  "hostname": "$(hostname)",
  "pwd": "$(pwd)"
}
EOF

    # Log to main session log
    SESSION_LOG="$LOG_DIR/session.log"
    echo "[$(date -Iseconds)] ===== Started: $step_name =====" >> "$SESSION_LOG"

    # Print to console
    echo -e "${CYAN}[LOG]${NC} Logging to: $STEP_LOG_DIR"
}

# Log a message
log_info() {
    local message="$1"
    local timestamp=$(date -Iseconds)
    echo -e "${BLUE}[INFO]${NC} $message"
    echo "[$timestamp] [INFO] $message" >> "$STEP_LOG_FILE"
    echo "[$timestamp] [INFO] $message" >> "$LOG_DIR/session.log"
}

# Log a warning
log_warn() {
    local message="$1"
    local timestamp=$(date -Iseconds)
    echo -e "${YELLOW}[WARN]${NC} $message"
    echo "[$timestamp] [WARN] $message" >> "$STEP_LOG_FILE"
    echo "[$timestamp] [WARN] $message" >> "$LOG_DIR/session.log"
}

# Log an error
log_error() {
    local message="$1"
    local timestamp=$(date -Iseconds)
    echo -e "${RED}[ERROR]${NC} $message"
    echo "[$timestamp] [ERROR] $message" >> "$STEP_LOG_FILE"
    echo "[$timestamp] [ERROR] $message" >> "$STEP_ERROR_FILE"
    echo "[$timestamp] [ERROR] $message" >> "$LOG_DIR/session.log"
}

# Log a success
log_success() {
    local message="$1"
    local timestamp=$(date -Iseconds)
    echo -e "${GREEN}[SUCCESS]${NC} $message"
    echo "[$timestamp] [SUCCESS] $message" >> "$STEP_LOG_FILE"
    echo "[$timestamp] [SUCCESS] $message" >> "$LOG_DIR/session.log"
}

# Save provider prompt
save_provider_prompt() {
    local prompt="$1"
    echo "$prompt" > "$PROVIDER_PROMPT_FILE"
    local provider_name="${PROVIDER:-claude}"
    log_info "Provider prompt saved to: $PROVIDER_PROMPT_FILE"

    # Log prompt metadata
    local word_count=$(echo "$prompt" | wc -w)
    local char_count=$(echo "$prompt" | wc -c)

    cat > "$STEP_LOG_DIR/prompt-metadata.json" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "provider": "$provider_name",
  "word_count": $word_count,
  "char_count": $char_count,
  "estimated_tokens": $((word_count * 4 / 3))
}
EOF
}
# Backward-compatible alias
save_claude_prompt() { save_provider_prompt "$@"; }

# Log provider invocation
log_provider_start() {
    local prompt="$1"
    local provider_name="${PROVIDER:-claude}"
    log_info "Invoking provider: $provider_name..."
    save_provider_prompt "$prompt"
    echo "$(date -Iseconds)" > "$STEP_LOG_DIR/provider-start-time.txt"
}
# Backward-compatible alias
log_claude_start() { log_provider_start "$@"; }

# Log provider completion
log_provider_end() {
    local exit_code=${1:-0}
    local end_time=$(date -Iseconds)
    local start_time=$(cat "$STEP_LOG_DIR/provider-start-time.txt" 2>/dev/null || echo "$end_time")
    local provider_name="${PROVIDER:-claude}"

    # Calculate duration (if date supports it)
    local duration="N/A"
    if command -v date >/dev/null 2>&1; then
        local start_epoch=$(date -d "$start_time" +%s 2>/dev/null || echo 0)
        local end_epoch=$(date -d "$end_time" +%s 2>/dev/null || echo 0)
        if [ $start_epoch -gt 0 ] && [ $end_epoch -gt 0 ]; then
            duration=$((end_epoch - start_epoch))
            duration="${duration}s"
        fi
    fi

    if [ $exit_code -eq 0 ]; then
        log_success "Provider ($provider_name) completed successfully (duration: $duration)"
    else
        log_error "Provider ($provider_name) failed with exit code: $exit_code (duration: $duration)"
    fi

    # Save execution summary
    cat > "$STEP_LOG_DIR/execution-summary.json" <<EOF
{
  "step": "$CURRENT_STEP_NAME",
  "provider": "$provider_name",
  "start_time": "$start_time",
  "end_time": "$end_time",
  "duration": "$duration",
  "exit_code": $exit_code,
  "status": "$([ $exit_code -eq 0 ] && echo 'success' || echo 'failed')"
}
EOF
}
# Backward-compatible alias
log_claude_end() { log_provider_end "$@"; }

# Log file operation
log_file_operation() {
    local operation="$1"  # read, write, create, delete
    local file_path="$2"
    local details="${3:-}"

    log_info "File $operation: $file_path $([ -n "$details" ] && echo "($details)")"

    # Track file operations
    echo "$(date -Iseconds)|$operation|$file_path|$details" >> "$STEP_LOG_DIR/file-operations.log"
}

# Log data statistics
log_data_stats() {
    local description="$1"
    local stats_json="$2"

    log_info "Data stats: $description"
    echo "$stats_json" >> "$STEP_LOG_DIR/data-stats.jsonl"
}

# Log compliance score
log_compliance_score() {
    local score="$1"
    local max_score="${2:-100}"
    local category="${3:-overall}"

    log_info "Compliance score ($category): $score/$max_score"

    # Track compliance scores
    cat >> "$STEP_LOG_DIR/compliance-scores.jsonl" <<EOF
{"timestamp":"$(date -Iseconds)","category":"$category","score":$score,"max_score":$max_score}
EOF
}

# Finalize logging for step
finalize_logging() {
    local exit_code=${1:-0}
    local end_time=$(date -Iseconds)

    # Update session log
    if [ $exit_code -eq 0 ]; then
        echo "[$end_time] ===== Completed: $CURRENT_STEP_NAME =====" >> "$LOG_DIR/session.log"
    else
        echo "[$end_time] ===== Failed: $CURRENT_STEP_NAME (exit: $exit_code) =====" >> "$LOG_DIR/session.log"
    fi

    # Generate step summary
    generate_step_summary "$exit_code"

    # Create symlink to latest logs
    local logs_root="$(dirname "$LOG_DIR")"
    ln -sf "$LOG_TIMESTAMP" "$logs_root/latest" 2>/dev/null || true

    log_info "Logs saved to: $STEP_LOG_DIR"
}

# Generate step summary
generate_step_summary() {
    local exit_code=${1:-0}

    local info_count
    local warn_count
    local error_count
    local success_count

    info_count=$(grep -c "\[INFO\]" "$STEP_LOG_FILE" 2>/dev/null || true)
    warn_count=$(grep -c "\[WARN\]" "$STEP_LOG_FILE" 2>/dev/null || true)
    error_count=$(grep -c "\[ERROR\]" "$STEP_LOG_FILE" 2>/dev/null || true)
    success_count=$(grep -c "\[SUCCESS\]" "$STEP_LOG_FILE" 2>/dev/null || true)

    info_count="${info_count:-0}"
    warn_count="${warn_count:-0}"
    error_count="${error_count:-0}"
    success_count="${success_count:-0}"

    cat > "$STEP_LOG_DIR/summary.json" <<EOF
{
  "step": "$CURRENT_STEP_NAME",
  "exit_code": $exit_code,
  "status": "$([ $exit_code -eq 0 ] && echo 'success' || echo 'failed')",
  "logs": {
    "info": $info_count,
    "warnings": $warn_count,
    "errors": $error_count,
    "successes": $success_count
  },
  "files": {
    "execution_log": "$STEP_LOG_FILE",
    "output_log": "$STEP_OUTPUT_FILE",
    "error_log": "$STEP_ERROR_FILE",
    "metadata": "$STEP_METADATA_FILE",
    "provider_prompt": "$PROVIDER_PROMPT_FILE",
    "provider_response": "$PROVIDER_RESPONSE_FILE"
  }
}
EOF

    # Print summary
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}Step Summary: $CURRENT_STEP_NAME${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "Status: $([ $exit_code -eq 0 ] && echo -e "${GREEN}SUCCESS${NC}" || echo -e "${RED}FAILED${NC}")"
    echo -e "Info messages: $info_count"
    echo -e "Warnings: $([ $warn_count -gt 0 ] && echo -e "${YELLOW}$warn_count${NC}" || echo "$warn_count")"
    echo -e "Errors: $([ $error_count -gt 0 ] && echo -e "${RED}$error_count${NC}" || echo "$error_count")"
    echo -e "Logs: $STEP_LOG_DIR"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Wrapper for running the AI provider with logging
run_provider_with_logging() {
    local prompt="$1"
    local step_name="$2"

    log_provider_start "$prompt"

    # Run provider and capture output
    local provider_output
    local provider_exit_code

    if provider_output=$(run_provider "$prompt" 2>&1); then
        provider_exit_code=0
        echo "$provider_output" > "$PROVIDER_RESPONSE_FILE"
        echo "$provider_output" >> "$STEP_OUTPUT_FILE"
        log_success "Generated code saved to src/generated/$step_name.ts"
    else
        provider_exit_code=$?
        echo "$provider_output" > "$PROVIDER_RESPONSE_FILE"
        echo "$provider_output" >> "$STEP_ERROR_FILE"
        log_error "Provider execution failed"
    fi

    log_provider_end $provider_exit_code

    return $provider_exit_code
}
# Backward-compatible alias
run_claude_with_logging() { run_provider_with_logging "$@"; }

# Export functions
export -f init_logging
export -f log_info
export -f log_warn
export -f log_error
export -f log_success
export -f save_provider_prompt
export -f save_claude_prompt
export -f log_provider_start
export -f log_claude_start
export -f log_provider_end
export -f log_claude_end
export -f log_file_operation
export -f log_data_stats
export -f log_compliance_score
export -f finalize_logging
export -f generate_step_summary
export -f run_provider_with_logging
export -f run_claude_with_logging
