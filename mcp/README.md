# MCP Neo4j Server

Stdio [MCP](https://modelcontextprotocol.io) server that exposes a Neo4j Bolt connection as a set of tools. Used by both [pipeline/](../pipeline/) (to write the generated graph) and [chatbot/](../chatbot/) (to query it from Claude).

## Build

```bash
npm install
npm run build      # produces dist/server.js
```

## Configure

```env
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```

Reads from process env. The pipeline and chatbot launch this server over stdio and pass these via their own MCP configs.

## Tools

| Tool                   | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `execute_cypher`       | Run an arbitrary Cypher query                            |
| `create_nodes`         | Batch-create nodes (labels + properties), 1000 per batch |
| `create_relationships` | Batch-create relationships between existing nodes        |
| `run_bulk_import`      | Read a graph JSON file and import nodes + relationships  |
| `get_schema`           | List labels, relationship types, constraints, indexes    |
| `get_statistics`       | Node/relationship counts, breakdown by label and type    |
| `clear_database`       | `DETACH DELETE` everything (requires `confirm: true`)    |
| `validate_graph`       | Placeholder — not implemented                            |

## Run standalone

```bash
npm start          # node dist/server.js, communicates over stdio
```

Not intended to be run directly — invoke through an MCP client.
