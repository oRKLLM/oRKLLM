import { randomUUID } from 'crypto';
import {
  dbCreateConversation, dbListConversations, dbGetConversation,
  dbTouchConversation, dbUpdateConversationTitle, dbDeleteConversation,
  dbAddMessage, dbGetMessages,
} from '../db.js';
import { activeStreams } from '../streams.js';
import pool from '../pool.js';


export default async function conversationRoutes(fastify) {
  // All routes require auth (inherits preHandler from parent adminRoutes)

  // GET /api/admin/conversations?model=<name>
  fastify.get('/conversations', async (request, reply) => {
    const { model } = request.query;
    if (!model) return reply.status(400).send({ error: 'model query param required' });
    return dbListConversations(model);
  });

  // POST /api/admin/conversations  { model, title? }
  fastify.post('/conversations', async (request, reply) => {
    const { model, title } = request.body || {};
    if (!model) return reply.status(400).send({ error: 'model required' });
    const id = randomUUID();
    const safeTitle = (title || 'New conversation').slice(0, 120);
    dbCreateConversation({ id, model, title: safeTitle });
    return { id, model, title: safeTitle };
  });

  // GET /api/admin/conversations/:id/messages
  fastify.get('/conversations/:id/messages', async (request, reply) => {
    const conv = dbGetConversation(request.params.id);
    if (!conv) return reply.status(404).send({ error: 'Conversation not found' });
    return { conversation: conv, messages: dbGetMessages(request.params.id) };
  });

  // GET /api/admin/conversations/:id/recover-stream
  fastify.get('/conversations/:id/recover-stream', async (request, reply) => {
    const { id } = request.params;
    const session = activeStreams.get(id);

    if (!session) {
      return reply.status(404).send({ error: 'No active stream session found for this conversation' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    if (session.abortTimer) {
      clearTimeout(session.abortTimer);
      session.abortTimer = null;
      console.log(`[Chat] client recovered stream for session ${id} — cancelled abort timer`);
    }

    // Write out all chunks generated so far
    for (const chunk of session.chunks) {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    if (session.finished) {
      if (!session.error) {
        reply.raw.write('data: [DONE]\n\n');
      }
      reply.raw.end();
      return;
    }

    session.clients.add(reply.raw);

    let connectionClosed = false;
    request.raw.on('close', () => {
      if (connectionClosed) return;
      connectionClosed = true;

      session.clients.delete(reply.raw);
      console.log(`[Chat] recovered client disconnected from session ${id}`);

      if (session.clients.size === 0 && !session.finished) {
        console.log(`[Chat] no clients connected to session ${id} after recovery disconnect — starting abort timer`);
        session.abortTimer = setTimeout(() => {
          if (session.finished) return;
          session.finished = true;
          console.log(`[Chat] abort timer expired for session ${id} after recovery disconnect — aborting generation`);
          pool.abort().catch(() => {});
          activeStreams.delete(id);
        }, 15000);
      }
    });
  });


  // PATCH /api/admin/conversations/:id  { title }
  fastify.patch('/conversations/:id', async (request, reply) => {
    const { title } = request.body || {};
    if (title) dbUpdateConversationTitle(request.params.id, title.slice(0, 120));
    return { success: true };
  });

  // DELETE /api/admin/conversations/:id
  fastify.delete('/conversations/:id', async (request, reply) => {
    dbDeleteConversation(request.params.id);
    return { success: true };
  });

  // POST /api/admin/conversations/:id/messages  { role, content }
  fastify.post('/conversations/:id/messages', async (request, reply) => {
    const { role, content } = request.body || {};
    if (!role || !content) return reply.status(400).send({ error: 'role and content required' });
    const conv = dbGetConversation(request.params.id);
    if (!conv) return reply.status(404).send({ error: 'Conversation not found' });
    const id = randomUUID();
    dbAddMessage({ id, conversationId: request.params.id, role, content });
    dbTouchConversation(request.params.id);
    return { id };
  });
}
