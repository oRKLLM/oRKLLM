import { randomUUID } from 'crypto';
import {
  dbListMcpServers, dbGetMcpServer, dbCreateMcpServer,
  dbUpdateMcpServer, dbDeleteMcpServer, dbListEnabledMcpServers,
} from '../db.js';
import { validateServer, invalidateClient, getAggregatedTools } from '../mcp.js';
import { buildToolSystemPrompt } from '../mcp_inference.js';

const TRANSPORTS = ['stdio', 'sse', 'http'];

// Validate the shape of a server payload. Returns an error string or null.
function validatePayload({ name, transport, config }) {
  if (!name || typeof name !== 'string') return 'name is required';
  if (!TRANSPORTS.includes(transport)) return `transport must be one of ${TRANSPORTS.join(', ')}`;
  const cfg = config || {};
  if (transport === 'stdio') {
    if (!cfg.command || typeof cfg.command !== 'string') return 'stdio transport requires a command';
  } else {
    if (!cfg.url || typeof cfg.url !== 'string') return `${transport} transport requires a url`;
    try { new URL(cfg.url); } catch (e) { return 'url is not a valid URL'; }
  }
  return null;
}

export default async function mcpRoutes(fastify) {
  // All routes require auth (inherits preHandler from parent adminRoutes).

  // GET /api/admin/mcp-servers — list all configured servers
  fastify.get('/mcp-servers', async () => {
    return { servers: dbListMcpServers() };
  });

  // GET /api/admin/mcp-tools — aggregated tools from enabled servers plus the
  // ready-to-use system-prompt block (identical to what the inference loop
  // injects). Used by the Chat "inject MCP tool instructions" toggle.
  //
  // Optional `?tools=a,b,c` filters the prompt to a selected subset (the Chat
  // page's per-tool checkboxes); omitted/empty = all tools (backward compatible).
  // `count`/`approxTokens` reflect the selected subset; `tools[]` always lists
  // the full catalogue so the UI can render every checkbox.
  fastify.get('/mcp-tools', async (request) => {
    const servers = dbListEnabledMcpServers();
    const { tools } = await getAggregatedTools(servers);

    const raw = (request.query?.tools ?? '').toString().trim();
    const selectedSet = raw ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean)) : null;
    const chosen = selectedSet ? tools.filter(t => selectedSet.has(t.function.name)) : tools;

    const systemPrompt = chosen.length ? buildToolSystemPrompt(chosen) : '';
    return {
      count: chosen.length,
      total: tools.length,
      tools: tools.map(t => ({ name: t.function.name, description: t.function.description })),
      systemPrompt,
      approxTokens: Math.round(systemPrompt.length / 4),
    };
  });

  // POST /api/admin/mcp-servers — create a server. If `validate` is truthy
  // (default), connect once to confirm reachability and return its tools.
  fastify.post('/mcp-servers', async (request, reply) => {
    const { name, transport, config, enabled = true, validate = true } = request.body || {};
    const err = validatePayload({ name, transport, config });
    if (err) return reply.status(400).send({ error: err });

    const id = randomUUID();
    let validation = null;
    if (validate) {
      validation = await validateServer({ id, name, transport, config });
    }
    dbCreateMcpServer({ id, name, transport, config, enabled });
    return { server: dbGetMcpServer(id), validation };
  });

  // PATCH /api/admin/mcp-servers/:id — update fields (name/transport/config/enabled)
  fastify.patch('/mcp-servers/:id', async (request, reply) => {
    const { id } = request.params;
    const existing = dbGetMcpServer(id);
    if (!existing) return reply.status(404).send({ error: 'MCP server not found' });

    const merged = {
      name: request.body?.name ?? existing.name,
      transport: request.body?.transport ?? existing.transport,
      config: request.body?.config ?? existing.config,
    };
    const err = validatePayload(merged);
    if (err) return reply.status(400).send({ error: err });

    const fields = {};
    if (request.body?.name !== undefined) fields.name = request.body.name;
    if (request.body?.transport !== undefined) fields.transport = request.body.transport;
    if (request.body?.config !== undefined) fields.config = request.body.config;
    if (request.body?.enabled !== undefined) fields.enabled = request.body.enabled;
    dbUpdateMcpServer(id, fields);
    await invalidateClient(id); // drop any stale cached connection
    return { server: dbGetMcpServer(id) };
  });

  // DELETE /api/admin/mcp-servers/:id
  fastify.delete('/mcp-servers/:id', async (request, reply) => {
    const { id } = request.params;
    if (!dbGetMcpServer(id)) return reply.status(404).send({ error: 'MCP server not found' });
    dbDeleteMcpServer(id);
    await invalidateClient(id);
    return { success: true };
  });

  // POST /api/admin/mcp-servers/:id/test — re-validate a stored server
  fastify.post('/mcp-servers/:id/test', async (request, reply) => {
    const server = dbGetMcpServer(request.params.id);
    if (!server) return reply.status(404).send({ error: 'MCP server not found' });
    const result = await validateServer(server);
    return result;
  });

  // POST /api/admin/mcp-servers/validate — validate an unsaved payload (used by
  // the "Test" button in the add/edit dialog before persisting).
  fastify.post('/mcp-servers/validate', async (request, reply) => {
    const { name, transport, config } = request.body || {};
    const err = validatePayload({ name: name || 'test', transport, config });
    if (err) return reply.status(400).send({ error: err });
    const result = await validateServer({ id: 'validate', name: name || 'test', transport, config });
    return result;
  });
}
