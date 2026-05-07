# Agentic KG Chat

A chat interface for querying a Neo4j knowledge graph using natural language. The app uses Claude as the AI backbone with MCP (Model Context Protocol) to connect directly to Neo4j, so Claude can execute Cypher queries on your behalf and present the results.

## Architecture

```
React (Vite)  <-->  Express API  <-->  Anthropic SDK  <-->  Neo4j MCP Server  <-->  Neo4j
```

- **Frontend**: React 19 + AI SDK v6 (`useChat`) with streaming UI
- **Backend**: Express server calling the Anthropic API with a streaming agentic loop
- **MCP Server**: Stdio-based MCP server that exposes Neo4j tools (`execute_cypher`, `get_schema`, `get_statistics`)
- **Database**: Neo4j graph database

## Prerequisites

- **Node.js** >= 18
- **pnpm** (or npm/yarn)
- **Neo4j** running locally (default: `bolt://localhost:7687`)
- **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com))
- **MCP Neo4j Server** built and ready at a known path

## Setup

### 1. Build the MCP server

The app expects a compiled MCP Neo4j server. If you haven't built it yet:

```bash
cd /path/to/mcp-neo4j-server
pnpm install
pnpm build
```

### 2. Install dependencies

```bash
cd agentic-kg-artifact-chatbot
pnpm install
```

### 3. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

```env
ANTHROPIC_API_KEY=sk-ant-...

NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```

### 4. Update MCP config

Edit `server/mcp-config.json` to point to your MCP server build:

```json
{
  "mcpServers": {
    "neo4j": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-neo4j-server/dist/server.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "your-password"
      }
    }
  }
}
```

### 5. Run

```bash
pnpm dev
```

This starts both the Vite dev server (frontend) and the Express API server concurrently. Open [http://localhost:5173](http://localhost:5173).

## Available Scripts

| Command           | Description                                   |
| ----------------- | --------------------------------------------- |
| `pnpm dev`        | Start both frontend and backend in watch mode |
| `pnpm dev:client` | Start only the Vite frontend                  |
| `pnpm dev:server` | Start only the Express backend                |
| `pnpm build`      | Type-check and build for production           |
| `pnpm lint`       | Run ESLint                                    |

## Project Structure

```
├── server/
│   ├── index.ts          # Express API with streaming chat endpoint
│   ├── mcp.ts            # Persistent MCP client (connects to Neo4j MCP server)
│   ├── db.ts             # Neo4j health check
│   ├── mcp-config.json   # MCP server configuration
│   └── tsconfig.json     # Server TypeScript config
├── src/
│   ├── pages/
│   │   └── chat.tsx      # Main chat page
│   ├── components/
│   │   └── chat/
│   │       ├── message-bubble.tsx   # Message rendering with markdown
│   │       └── tool-call-card.tsx   # Collapsible tool call display
│   ├── hooks/
│   │   └── use-db-status.ts        # Neo4j connection status hook
│   └── index.css         # Global styles
├── .env.example          # Environment template
└── package.json
```

## How It Works

1. You type a question in the chat (e.g., "Who is the artist with the most artworks?")
2. The frontend sends the message to `/api/chat` via the AI SDK's streaming transport
3. The Express server calls the Anthropic API with your conversation + Neo4j MCP tools
4. Claude decides which tools to call, executes Cypher queries via MCP, and streams back results
5. Tool calls appear as collapsible cards in the chat; the final answer renders as Markdown
