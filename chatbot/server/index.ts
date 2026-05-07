import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { checkNeo4jHealth, closeDriver } from './db.js';
import { getMcpTools, callMcpTool, closeMcp } from './mcp.js';

const SYSTEM_PROMPT = [
  'You are a knowledge graph assistant with access to a Neo4j database via MCP tools.',
  'When the user asks questions about data (artists, artworks, relationships, counts, etc.),',
  'ALWAYS use your neo4j MCP tools to query the database — do NOT guess or suggest queries.',
  'Use execute_cypher for custom queries, get_schema to understand the data model,',
  'and get_statistics for overview counts.',
  'Format your responses using Markdown — use headings, bold, bullet lists, tables, and code blocks where appropriate.',
  'Present results in a clear, readable format.',
].join(' ');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

const anthropic = new Anthropic();
const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

interface RequestMessage {
  role: string;
  parts?: Array<{ type: string; text?: string }>;
  content?: string;
}

function extractText(msg: RequestMessage): string {
  if (msg.parts) {
    return msg.parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('');
  }
  return msg.content || '';
}

// Convert frontend messages to Anthropic API format
function toAnthropicMessages(messages: RequestMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: extractText(m),
  }));
}

// SSE helper
function writePart(res: express.Response, part: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(part)}\n\n`);
}

// POST /api/chat — Vercel AI SDK UI Message Stream protocol
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body as { messages?: RequestMessage[] };

  console.log('[chat] Received request with', messages?.length, 'messages');

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

  // SSE setup
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Vercel-AI-UI-Message-Stream', 'v1');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 2000);

  // Abort controller for cancelling in-flight API calls
  const controller = new AbortController();

  res.on('close', () => {
    clearInterval(heartbeat);
    if (!closed) {
      closed = true;
      controller.abort();
      console.log('[chat] Client disconnected');
    }
  });

  try {
    const tools = await getMcpTools();
    const apiMessages = toAnthropicMessages(messages);

    writePart(res, { type: 'start' });

    const t0 = Date.now();
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    // Agentic loop — keeps going while Claude wants to call tools
    while (iterations++ < MAX_ITERATIONS) {
      if (closed) break;

      let inStep = false;
      let activeTextId: string | null = null;

      // Track tool_use block index → our toolCallId
      const toolCallIds = new Map<number, string>();

      function ensureStep() {
        if (!inStep) {
          writePart(res, { type: 'start-step' });
          inStep = true;
        }
      }

      function endStep() {
        if (activeTextId) {
          writePart(res, { type: 'text-end', id: activeTextId });
          activeTextId = null;
        }
        if (inStep) {
          writePart(res, { type: 'finish-step' });
          inStep = false;
        }
      }

      // Stream the response
      const stream = anthropic.messages.stream(
        {
          model: MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: apiMessages,
          tools,
        },
        { signal: controller.signal },
      );

      // Handle streaming events for real-time UI updates
      stream.on('streamEvent', (event) => {
        if (closed) return;

        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            ensureStep();
            activeTextId = crypto.randomUUID();
            writePart(res, { type: 'text-start', id: activeTextId });
          } else if (event.content_block.type === 'tool_use') {
            const toolCallId = crypto.randomUUID();
            toolCallIds.set(event.index, toolCallId);
            ensureStep();
            writePart(res, {
              type: 'tool-input-start',
              toolCallId,
              toolName: event.content_block.name,
              dynamic: true,
            });
          }
        }

        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (activeTextId) {
            writePart(res, { type: 'text-delta', id: activeTextId, delta: event.delta.text });
          }
        }
      });

      const response = await stream.finalMessage();
      endStep();

      if (closed) break;

      console.log(
        `[chat] Iteration ${iterations}: stop_reason=${response.stop_reason} (+${Date.now() - t0}ms)`,
      );

      // If Claude wants to call tools, execute them and loop
      if (response.stop_reason === 'tool_use') {
        // Add assistant response to conversation
        apiMessages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          const toolCallId = toolCallIds.get(response.content.indexOf(block)) ?? crypto.randomUUID();

          // Emit tool input
          writePart(res, {
            type: 'tool-input-available',
            toolCallId,
            toolName: block.name,
            input: block.input,
            dynamic: true,
          });

          // Execute the tool via MCP
          let output: string;
          try {
            output = await callMcpTool(block.name, block.input as Record<string, unknown>);
          } catch (err) {
            output = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          // Emit tool output
          writePart(res, {
            type: 'tool-output-available',
            toolCallId,
            output,
            dynamic: true,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: output,
          });
        }

        // Add tool results and continue the loop
        apiMessages.push({ role: 'user', content: toolResults });
      } else {
        // Done — no more tool calls
        break;
      }
    }

    if (!closed) {
      writePart(res, { type: 'finish', finishReason: 'stop' });
      res.write('data: [DONE]\n\n');
      res.end();
      closed = true;
      clearInterval(heartbeat);
      console.log(`[chat] Done (+${Date.now() - Date.now()}ms)`);
    }
  } catch (err: any) {
    clearInterval(heartbeat);
    if (closed) return; // Client already disconnected
    closed = true;

    const message = err instanceof Error ? err.message : String(err);
    console.error('[chat] Error:', message);
    writePart(res, { type: 'error', errorText: message });
    writePart(res, { type: 'finish', finishReason: 'stop' });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// GET /api/health — server health
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/health/db — Neo4j connectivity check
app.get('/api/health/db', async (_req, res) => {
  const result = await checkNeo4jHealth();

  if (result.ok) {
    res.json({ status: 'connected', latencyMs: result.latencyMs });
  } else {
    res.status(503).json({ status: 'disconnected', error: result.error });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closeMcp();
  await closeDriver();
  server.close();
});
