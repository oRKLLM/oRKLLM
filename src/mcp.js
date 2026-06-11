// MCP (Model Context Protocol) client layer.
//
// Wraps @modelcontextprotocol/sdk to: connect to a configured server over any
// of the three transports (stdio / SSE / streamable HTTP), validate it by
// listing its tools, keep a small cache of live clients for enabled servers,
// aggregate their tools into OpenAI function-tool format for inference, and
// execute tool calls. All failures are surfaced as { ok:false, error } rather
// than thrown, so the admin UI and the inference path can degrade gracefully.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CLIENT_INFO = { name: 'orkllm', version: '1.0.0' };
const CONNECT_TIMEOUT_MS = 15000;

// Cache of live clients keyed by server id. Each entry stores a `key` (a hash
// of transport+config) so a config change invalidates the stale connection.
const clients = new Map();

function configKey(server) {
  return `${server.transport}:${JSON.stringify(server.config || {})}`;
}

function buildTransport(server) {
  const cfg = server.config || {};
  if (server.transport === 'stdio') {
    if (!cfg.command) throw new Error('stdio transport requires a command');
    return new StdioClientTransport({
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: { ...getDefaultEnvironment(), ...(cfg.env || {}) },
      stderr: 'ignore',
    });
  }
  if (server.transport === 'sse') {
    if (!cfg.url) throw new Error('sse transport requires a url');
    const headers = cfg.headers || {};
    return new SSEClientTransport(new URL(cfg.url), {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers || {}), ...headers } }),
      },
    });
  }
  if (server.transport === 'http') {
    if (!cfg.url) throw new Error('http transport requires a url');
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers || {} },
    });
  }
  throw new Error(`Unknown transport: ${server.transport}`);
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function openClient(server) {
  const transport = buildTransport(server);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'MCP connect');
  return client;
}

/**
 * Connect to a server, list its tools, then disconnect. Used for validation
 * (the "Test" button / create-time check). Never throws.
 */
export async function validateServer(server) {
  let client;
  try {
    client = await openClient(server);
    const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'MCP listTools');
    const tools = (res.tools || []).map(t => ({ name: t.name, description: t.description || '' }));
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (client) { try { await client.close(); } catch (e) {} }
  }
}

/** Get (or lazily open) a cached client for an enabled server. */
async function getClient(server) {
  const key = configKey(server);
  const existing = clients.get(server.id);
  if (existing && existing.key === key) return existing.client;
  if (existing) { try { await existing.client.close(); } catch (e) {} clients.delete(server.id); }
  const client = await openClient(server);
  clients.set(server.id, { client, key });
  return client;
}

// OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$. We namespace each
// tool as mcp__<server>__<tool> so names from different servers can't collide,
// and keep a reverse lookup so executeToolCall can route back to the source.
function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function toolName(server, tool) {
  return `mcp__${sanitize(server.name)}__${sanitize(tool)}`.slice(0, 64);
}

/**
 * Aggregate tools across the given enabled servers into OpenAI tool format.
 * Returns { tools, lookup } where lookup maps the namespaced name back to
 * { serverId, toolName }. Servers that fail to connect are skipped (logged).
 */
export async function getAggregatedTools(servers) {
  const tools = [];
  const lookup = new Map();
  for (const server of servers) {
    try {
      const client = await getClient(server);
      const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'MCP listTools');
      for (const t of res.tools || []) {
        const name = toolName(server, t.name);
        lookup.set(name, { serverId: server.id, toolName: t.name });
        tools.push({
          type: 'function',
          function: {
            name,
            description: t.description || '',
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    } catch (e) {
      console.error(`[MCP] Skipping server "${server.name}": ${e.message}`);
    }
  }
  return { tools, lookup };
}

/** Execute a single tool call against the owning server. Never throws. */
export async function executeToolCall(server, toolName, args) {
  try {
    const client = await getClient(server);
    const res = await withTimeout(
      client.callTool({ name: toolName, arguments: args || {} }),
      CONNECT_TIMEOUT_MS,
      'MCP callTool'
    );
    // Flatten MCP content blocks to a string for the OpenAI tool message.
    const text = (res.content || [])
      .map(c => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
    return { ok: !res.isError, content: text || (res.isError ? 'Tool reported an error' : '') };
  } catch (e) {
    return { ok: false, content: `Error executing tool: ${e.message}` };
  }
}

/** Drop a cached client (e.g. after a server is edited or deleted). */
export async function invalidateClient(id) {
  const entry = clients.get(id);
  if (entry) { try { await entry.client.close(); } catch (e) {} clients.delete(id); }
}

/** Close all live clients (server shutdown). */
export async function closeAllClients() {
  for (const [id, entry] of clients) {
    try { await entry.client.close(); } catch (e) {}
  }
  clients.clear();
}
