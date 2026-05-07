#!/bin/bash
# Check Neo4j connectivity via the same Bolt path used by the importer

set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(cat "$SCRIPT_DIR/.env" | grep -v '^#' | xargs)
fi

# Set defaults
NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_DATABASE="${NEO4J_DATABASE:-neo4j}"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Neo4j Connectivity Check${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${BLUE}[1/3]${NC} Validating Neo4j environment..."
if [ -z "${NEO4J_PASSWORD:-}" ]; then
    echo -e "${RED}✗ NEO4J_PASSWORD is not set${NC}"
    echo -e "${YELLOW}  Set NEO4J_PASSWORD in .env${NC}"
    exit 1
fi

if ! node -e "require('neo4j-driver')" >/dev/null 2>&1; then
    echo -e "${RED}✗ neo4j-driver is not available${NC}"
    echo -e "${YELLOW}  Install project dependencies before running the pipeline${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Environment looks valid${NC}"
echo -e "  URI: ${NEO4J_URI}"
echo -e "  User: ${NEO4J_USER}"
echo -e "  Database: ${NEO4J_DATABASE}"

echo ""
echo -e "${BLUE}[2/3]${NC} Testing Bolt connectivity..."

BOLT_OUTPUT=$(
    NEO4J_URI="$NEO4J_URI" \
    NEO4J_USER="$NEO4J_USER" \
    NEO4J_PASSWORD="$NEO4J_PASSWORD" \
    NEO4J_DATABASE="$NEO4J_DATABASE" \
    node <<'NODE'
const neo4j = require('neo4j-driver');

async function main() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || 'neo4j';

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    await driver.verifyConnectivity();
    const session = driver.session({ database });
    try {
      const result = await session.run(
        'MATCH (n) WITH count(n) AS nodeCount MATCH ()-[r]->() RETURN nodeCount, count(r) AS relCount'
      );
      const record = result.records[0];
      const nodeCount = record ? record.get('nodeCount').toNumber() : 0;
      const relCount = record ? record.get('relCount').toNumber() : 0;
      console.log(JSON.stringify({ ok: true, nodeCount, relCount }));
    } finally {
      await session.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  } finally {
    await driver.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
NODE
) || {
    echo -e "${RED}✗ Bolt connectivity failed${NC}"
    echo "$BOLT_OUTPUT"
    echo ""
    echo -e "${YELLOW}Troubleshooting:${NC}"
    echo "  1. Verify Neo4j is running and Bolt is enabled"
    echo "  2. Verify the URI in .env: NEO4J_URI=$NEO4J_URI"
    echo "  3. Confirm the active instance accepts Bolt connections on the configured port"
    exit 1
}

echo -e "${GREEN}✓ Bolt connectivity successful${NC}"

echo ""
echo -e "${BLUE}[3/3]${NC} Querying target database (${NEO4J_DATABASE})..."

NODE_COUNT=$(printf '%s' "$BOLT_OUTPUT" | node -e "const fs=require('fs'); const input=fs.readFileSync(0,'utf8'); const data=JSON.parse(input); process.stdout.write(String(data.nodeCount ?? 0));")
REL_COUNT=$(printf '%s' "$BOLT_OUTPUT" | node -e "const fs=require('fs'); const input=fs.readFileSync(0,'utf8'); const data=JSON.parse(input); process.stdout.write(String(data.relCount ?? 0));")

echo -e "${GREEN}✓ Database query successful${NC}"
echo -e "  Nodes: ${NODE_COUNT}"
echo -e "  Relationships: ${REL_COUNT}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Neo4j Bolt connection is ready for pipeline execution${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
exit 0
