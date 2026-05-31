import { randomUUID } from 'crypto';
import {
  dbCreateConversation, dbListConversations, dbGetConversation,
  dbTouchConversation, dbUpdateConversationTitle, dbDeleteConversation,
  dbAddMessage, dbGetMessages,
} from '../db.js';

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
