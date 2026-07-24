#!/bin/bash
set -euo pipefail

# Wrapper script for Codex/Claude MCP config that launches the actual Neo4j MCP
# server living in the sibling repository.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_REPO="/home/user/project/mcp-neo4j-server"
ENV_FILE="$MCP_REPO/.env"
SERVER_ENTRY="$MCP_REPO/dist/server.js"

if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

if [ ! -f "$SERVER_ENTRY" ]; then
    echo "Neo4j MCP entrypoint not found: $SERVER_ENTRY" >&2
    echo "Build the server in $MCP_REPO before starting it." >&2
    exit 1
fi

exec node "$SERVER_ENTRY"
