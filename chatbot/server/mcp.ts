import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_CONFIG_PATH = path.resolve(__dirname, 'mcp-config.json');

// Allowed tools — only these are passed to Claude
const ALLOWED_TOOLS = new Set([
  'execute_cypher',
  'get_schema',
  'get_statistics',
]);

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let toolsCache: Anthropic.Tool[] | null = null;

async function ensureConnected(): Promise<void> {
  if (client) return;

  const config = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8'));
  const neo4j = config.mcpServers.neo4j;

  transport = new StdioClientTransport({
    command: neo4j.command,
    args: neo4j.args,
    env: { ...process.env, ...neo4j.env },
  });

  client = new Client({ name: 'kg-chatbot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('[mcp] Connected to Neo4j MCP server');

  // Fetch and cache tool definitions
  const { tools } = await client.listTools();
  toolsCache = tools
    .filter((t) => ALLOWED_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

  console.log('[mcp] Available tools:', toolsCache.map((t) => t.name).join(', '));
}

export async function getMcpTools(): Promise<Anthropic.Tool[]> {
  await ensureConnected();
  return toolsCache!;
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  await ensureConnected();
  const result = await client!.callTool({ name, arguments: args });

  // Extract text from MCP tool result content
  if (Array.isArray(result.content)) {
    return (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('');
  }
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

export async function closeMcp(): Promise<void> {
  if (transport) {
    await transport.close();
    transport = null;
    client = null;
    toolsCache = null;
    console.log('[mcp] Disconnected');
  }
}
