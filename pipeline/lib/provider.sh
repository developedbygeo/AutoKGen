#!/bin/bash
# Provider abstraction layer for AI code generation
# Supports multiple AI CLI tools (Claude Code, Codex) via unified interface

# ─────────────────────────────────────────────────────────────────
# Provider Configuration
# ─────────────────────────────────────────────────────────────────
# PROVIDER env var selects the active provider (default: claude)
# PROVIDER_FLAGS env var allows custom CLI flags (optional)

# Supported providers and their default invocation patterns:
#   claude  →  claude -p "prompt"
#   codex   →  codex exec --full-auto "prompt"

SUPPORTED_PROVIDERS=("claude" "codex")

resolve_provider_bin() {
    local provider="${1:-$(get_provider)}"

    if [ "$provider" = "codex" ] && [ -n "${CODEX_BIN:-}" ] && [ -x "${CODEX_BIN}" ]; then
        echo "$CODEX_BIN"
        return 0
    fi

    if command -v "$provider" >/dev/null 2>&1; then
        command -v "$provider"
        return 0
    fi

    if [ "$provider" = "codex" ]; then
        local fallback_codex="/home/user/.vscode-server/extensions/openai.chatgpt-26.325.31654-linux-x64/bin/linux-x86_64/codex"
        if [ -x "$fallback_codex" ]; then
            echo "$fallback_codex"
            return 0
        fi
    fi

    return 1
}

# ─────────────────────────────────────────────────────────────────
# Provider Functions
# ─────────────────────────────────────────────────────────────────

# Get the active provider name
get_provider() {
    echo "${PROVIDER:-claude}"
}

# Get the display name for the active provider
get_provider_display_name() {
    local provider=$(get_provider)
    case "$provider" in
        claude) echo "Claude Code" ;;
        codex)  echo "Codex" ;;
        *)      echo "$provider" ;;
    esac
}

# Validate that the selected provider is supported and available
validate_provider() {
    local provider=$(get_provider)
    local supported=false

    for p in "${SUPPORTED_PROVIDERS[@]}"; do
        if [ "$p" = "$provider" ]; then
            supported=true
            break
        fi
    done

    if [ "$supported" = false ]; then
        echo -e "\033[0;31m[ERROR]\033[0m Unknown provider: $provider"
        echo "Supported providers: ${SUPPORTED_PROVIDERS[*]}"
        return 1
    fi

    if ! resolve_provider_bin "$provider" >/dev/null; then
        echo -e "\033[0;31m[ERROR]\033[0m Provider CLI not found: $provider"
        echo "Install $provider and ensure it is available in PATH."
        if [ "$provider" = "codex" ]; then
            echo "Optional: set CODEX_BIN in .env to the full Codex executable path."
        fi
        return 1
    fi

    return 0
}

# Build the provider command with appropriate flags
# Usage: build_provider_cmd "prompt"
build_provider_cmd() {
    local prompt="$1"
    local provider=$(get_provider)
    local custom_flags="${PROVIDER_FLAGS:-}"
    local provider_bin
    provider_bin=$(resolve_provider_bin "$provider") || return 1

    case "$provider" in
        claude)
            if [ -n "$custom_flags" ]; then
                echo "$provider_bin $custom_flags"
            else
                echo "$provider_bin -p"
            fi
            ;;
        codex)
            if [ -n "$custom_flags" ]; then
                echo "$provider_bin $custom_flags"
            else
                echo "$provider_bin exec --full-auto"
            fi
            ;;
        *)
            echo "$provider_bin"
            ;;
    esac
}

# Run the configured AI provider with a prompt
# Usage: run_provider "prompt text here"
# Returns: exit code from the provider CLI
run_provider() {
    local prompt="$1"
    local provider=$(get_provider)
    local custom_flags="${PROVIDER_FLAGS:-}"
    local provider_bin
    provider_bin=$(resolve_provider_bin "$provider") || {
        echo -e "\033[0;31m[ERROR]\033[0m Provider CLI not found: $provider"
        return 1
    }

    case "$provider" in
        claude)
            if [ -n "$custom_flags" ]; then
                "$provider_bin" $custom_flags "$prompt"
            else
                "$provider_bin" -p "$prompt"
            fi
            ;;
        codex)
            if [ -n "$custom_flags" ]; then
                "$provider_bin" $custom_flags "$prompt"
            else
                "$provider_bin" exec --full-auto "$prompt"
            fi
            ;;
        *)
            echo -e "\033[0;31m[ERROR]\033[0m Unknown provider: $provider"
            return 1
            ;;
    esac
}

# ─────────────────────────────────────────────────────────────────
# Output Directory
# ─────────────────────────────────────────────────────────────────
# Outputs are organized per provider: $DATA_DIR/output/<provider>/
# This enables side-by-side comparison of results across providers.

# Initialize OUTPUT_DIR based on current DATA_DIR and PROVIDER.
# Called automatically when provider.sh is sourced (if DATA_DIR is set),
# and can be called again if DATA_DIR changes.
init_output_dir() {
    local data_dir="${1:-${DATA_DIR:-data}}"
    local provider=$(get_provider)
    export OUTPUT_DIR="$data_dir/output/$provider"
    mkdir -p "$OUTPUT_DIR"
}

# ─────────────────────────────────────────────────────────────────
# Generated Code Directory
# ─────────────────────────────────────────────────────────────────
# Generated code is organized per provider: src/generated/<provider>/<domain>/
# This enables side-by-side comparison of generated code across providers.

# Initialize GENERATED_DIR based on current DOMAIN and PROVIDER.
# Called automatically when provider.sh is sourced (if DOMAIN is set),
# and can be called again if DOMAIN changes.
init_generated_dir() {
    local domain="${1:-${DOMAIN:-}}"
    local provider=$(get_provider)
    if [ -n "$domain" ]; then
        export GENERATED_DIR="src/generated/$provider/$domain"
        mkdir -p "$GENERATED_DIR"
    fi
}

# Auto-initialize if DATA_DIR is already set
if [ -n "$DATA_DIR" ]; then
    init_output_dir "$DATA_DIR"
fi

# Auto-initialize GENERATED_DIR if DOMAIN is already set
if [ -n "${DOMAIN:-}" ]; then
    init_generated_dir "$DOMAIN"
fi

# Export functions for use in subshells
export -f get_provider
export -f get_provider_display_name
export -f resolve_provider_bin
export -f validate_provider
export -f build_provider_cmd
export -f run_provider
export -f init_output_dir
export -f init_generated_dir
