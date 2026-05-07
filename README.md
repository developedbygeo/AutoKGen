# Agentic KG Artifact

A three-part system for autonomously building and querying knowledge graphs from heterogeneous structured data. An LLM-driven pipeline ingests raw data and produces an ontology-compliant graph in Neo4j; a chat interface lets you ask questions of that graph in natural language. Both halves talk to Neo4j through the same MCP server.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   ┌──────────────┐                              ┌──────────────┐    │
│   │   pipeline   │                              │   chatbot    │    │
│   │              │                              │              │    │
│   │  raw data →  │                              │  user Q →    │    │
│   │  cleaned →   │                              │  Claude →    │    │
│   │  mapped →    │                              │  Cypher →    │    │
│   │  graph data  │                              │  answer      │    │
│   └──────┬───────┘                              └──────┬───────┘    │
│          │ writes nodes + relationships                │ reads via  │
│          │ via MCP tools                               │ MCP tools  │
│          ▼                                             ▼            │
│   ┌──────────────────────────────────────────────────────────┐      │
│   │                          mcp                             │      │
│   │   stdio MCP server exposing Neo4j as tools:              │      │
│   │   execute_cypher · create_nodes · create_relationships   │      │
│   │   get_schema · get_statistics · run_bulk_import · …      │      │
│   └──────────────────────────┬───────────────────────────────┘      │
│                              │ Bolt                                 │
│                              ▼                                      │
│                       ┌─────────────┐                               │
│                       │    Neo4j    │                               │
│                       └─────────────┘                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

| Directory                 | Role                                                                                                              | README                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [pipeline/](pipeline/)    | Autonomous KG generation. Reads CSV/XML/JSON/TSV/TXT, parses an OWL/RDF ontology, and emits an ontology-compliant graph (JSON, Cypher, Turtle). 8 steps with 3 compliance gatekeepers. Each step delegates TypeScript generation to either [Claude Code or Codex](pipeline/README.md#prerequisites) (selected via `PROVIDER` in `.env`). | [pipeline/README.md](pipeline/README.md) |
| [mcp/](mcp/)              | Stdio MCP server that wraps a Neo4j Bolt driver. The single seam between Claude/Codex agents and the database — used by both other components. | [mcp/README.md](mcp/README.md)          |
| [chatbot/](chatbot/)      | React + Express chat UI. Forwards user questions to Claude, which uses the MCP server's Cypher tools to query the graph and stream answers back. | [chatbot/README.md](chatbot/README.md)   |

## How they fit together

1. **Pipeline builds the graph.** `pipeline` runs eight steps that turn raw data into nodes and relationships. Steps 1-6 produce graph artifacts (`graph-data.json`, `graph-import.cypher`, `graph-data.ttl`) on disk. Step 7 imports them into Neo4j by calling MCP tools (`run_bulk_import`, `create_nodes`, `create_relationships`). Step 8 validates the live graph against the ontology, again over MCP.

2. **MCP is the database boundary.** Neither the pipeline nor the chatbot opens a Neo4j connection directly in their agentic code paths. Both spawn the `mcp` server over stdio and call its tools. This means: same auth path, same query surface, same audit log shape.

3. **Chatbot reads the graph.** When a user asks a question, the Express server hands it to Claude with the MCP tools attached. Claude decides which Cypher to run, calls `execute_cypher` (or `get_schema` / `get_statistics`) via MCP, and streams the formatted answer back to the React UI.

The pipeline and chatbot are otherwise independent — you can rebuild the graph without touching the chatbot, and the chatbot can be pointed at any Neo4j instance the MCP server can reach.

## Quick start

### Prerequisites

- Node.js ≥ 20
- Neo4j 5+ running locally (default `bolt://localhost:7687`)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on `PATH` (used by the pipeline)
- Anthropic API key (used by the chatbot)

### 1. Build the MCP server

```bash
cd mcp
npm install
npm run build
```

This produces `mcp/dist/server.js`, which both other components launch over stdio.

### 2. Configure the pipeline

```bash
cd pipeline
cp .env.example .env
# edit .env: set DATA_DIR, NEO4J_PASSWORD, etc.
npm install
```

Place your input data and ontology under `pipeline/domain-data/<your-domain>/{input,ontology}/`. Three example domains are pre-wired (cultural-moma, scientific-dblp, geospatial) — see [pipeline/README.md](pipeline/README.md) for source links.

Run the full pipeline:

```bash
./main.sh                    # interactive menu
# or
npm run merge && npm run profile && npm run parse-ontology && \
npm run map && npm run clean-data && npm run generate && \
npm run import && npm run validate
```

Step 7 (`import`) and Step 8 (`validate`) require the MCP server to be reachable — point the pipeline's MCP config at `mcp/dist/server.js`.

### 3. Run the chatbot

```bash
cd chatbot
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and NEO4J_PASSWORD
npm install
```

Edit [chatbot/server/mcp-config.json](chatbot/server/mcp-config.json) so `args` points at the `mcp/dist/server.js` you built in step 1.

```bash
npm run dev
```

Open <http://localhost:5173> and start asking questions of the graph.

## Repository layout

```
.
├── pipeline/          KG generation (TypeScript, prompt-driven)
│   ├── prompts/         Bash scripts — source of truth for each pipeline step
│   ├── src/generated/   Ephemeral TS produced per run by Claude/Codex
│   ├── domain-data/     Per-domain input, ontology, and output directories
│   ├── lib/             Shared shell utilities (logger, provider abstraction)
│   └── main.sh          Interactive CLI
├── mcp/               Stdio MCP server (TypeScript)
│   └── src/server.ts    Tools: execute_cypher, create_*, get_*, run_bulk_import
├── chatbot/           React 19 + Express + AI SDK v6
│   ├── src/             Frontend (chat UI, streaming, tool-call cards)
│   └── server/          Express API + persistent MCP client
└── README.md          (this file)
```

## Configuration surface

Each component reads its own `.env` (none of which are tracked in git):

| Variable          | Used by                  | Notes                                             |
| ----------------- | ------------------------ | ------------------------------------------------- |
| `NEO4J_URI`       | mcp, pipeline, chatbot   | Default `bolt://localhost:7687`                   |
| `NEO4J_USER`      | mcp, pipeline, chatbot   | Default `neo4j`                                   |
| `NEO4J_PASSWORD`  | mcp, pipeline, chatbot   | Local-instance password                           |
| `NEO4J_DATABASE`  | pipeline                 | Default `neo4j`                                   |
| `ANTHROPIC_API_KEY` | chatbot                | Required for Claude streaming                     |
| `PROVIDER`        | pipeline                 | `claude` or `codex` — selects the code generator  |
| `DATA_DIR`        | pipeline                 | e.g. `domain-data/cultural-moma`                  |
| `MCP_NEO4J_ENABLED` | pipeline               | Toggles MCP-backed import/validate                |

See each component's README for the full list and defaults.
