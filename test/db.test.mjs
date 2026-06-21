import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Set ORKLLM_DB_PATH to a temporary file before importing
const tempDbPath = path.join(os.tmpdir(), `orkllm-test-${Date.now()}.db`);
process.env.ORKLLM_DB_PATH = tempDbPath;

const {
  dbCreateConversation,
  dbAddMessage,
  dbGetMessages,
  dbUpdateLastMessage
} = await import('../src/db.js');

describe('Database chat messages', () => {
  after(() => {
    try {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
    } catch (e) {}
  });

  test('dbUpdateLastMessage updates only when last message role matches', () => {
    const convId = 'test-conv-123';
    dbCreateConversation({ id: convId, model: 'test-model', title: 'Test Conv' });

    // No messages yet
    let updated = dbUpdateLastMessage(convId, 'assistant', 'Should fail');
    assert.equal(updated, false);

    // Add user message
    dbAddMessage({ id: 'msg-1', conversationId: convId, role: 'user', content: 'hello' });
    
    // Last message is 'user', so trying to update 'assistant' should fail
    updated = dbUpdateLastMessage(convId, 'assistant', 'Should still fail');
    assert.equal(updated, false);

    // Add assistant message
    dbAddMessage({ id: 'msg-2', conversationId: convId, role: 'assistant', content: 'initial content' });

    // Last message is 'assistant', so trying to update 'assistant' should succeed
    updated = dbUpdateLastMessage(convId, 'assistant', 'updated content!');
    assert.equal(updated, true);

    // Verify messages content updated
    const messages = dbGetMessages(convId);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'hello');
    assert.equal(messages[1].content, 'updated content!');
    assert.equal(messages[1].id, 'msg-2'); // ID remains the same

    // Trying to update 'user' role should fail because the last message is 'assistant'
    updated = dbUpdateLastMessage(convId, 'user', 'should fail');
    assert.equal(updated, false);
  });
});
