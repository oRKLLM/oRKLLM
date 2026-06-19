import { reactive } from 'vue';

// Shared chat session state — lives at module scope (like notify.js / bench.js)
// so an in-flight generation and the conversation it belongs to survive
// navigating away from /chat and back. The streaming loop writes here whether
// or not the Chat component is currently mounted.

export const chatState = reactive({
  selectedModel: null,
  activeModel: null,
  systemPrompt: '',
  chatHistory: [],
  inputText: '',
  params: {
    temperature: 0.8,
    top_p: 0.9,
    top_k: 40,
    max_tokens: 1024
  },
  generating: false,
  messageQueue: [],
  conversations: [],
  activeConversationId: null,
  // MCP tool use for this chat: when enabled, the selected tool names are sent
  // as `mcp_tools` so the server runs the tool-execution loop scoped to them.
  mcpEnabled: false,
  mcpSelectedTools: [],
});

let abortController = null;
let beaconRegistered = false;

// Save partial response on a genuine page unload (tab close / full reload),
// where the in-flight fetch is torn down along with the JS context. Route
// changes keep this module alive, so the normal finally-block persist handles
// those — this listener only matters for real unloads, and it guards on
// `generating` so it never duplicates a response already persisted on finish.
function registerBeacon() {
  if (beaconRegistered || typeof window === 'undefined') return;
  beaconRegistered = true;
  window.addEventListener('pagehide', () => {
    if (!chatState.activeConversationId || !chatState.generating) return;
    const last = chatState.chatHistory[chatState.chatHistory.length - 1];
    if (last?.role === 'assistant' && last.content) {
      navigator.sendBeacon(
        `/api/admin/conversations/${chatState.activeConversationId}/messages`,
        new Blob([JSON.stringify({ role: 'assistant', content: last.content })],
          { type: 'application/json' })
      );
    }
  });
}
registerBeacon();

// ── Conversation management ─────────────────────────────────────────────────
export async function fetchConversations(model) {
  if (!model) return;
  try {
    const res = await fetch(`/api/admin/conversations?model=${encodeURIComponent(model)}`);
    if (res.ok) chatState.conversations = await res.json();
  } catch (e) {}
}

export async function loadConversation(id) {
  try {
    const res = await fetch(`/api/admin/conversations/${id}/messages`);
    if (!res.ok) return;
    const { messages } = await res.json();
    chatState.chatHistory = messages.map(m => ({ role: m.role, content: m.content }));
    chatState.activeConversationId = id;
  } catch (e) {}
}

export async function deleteConversation(id) {
  try {
    await fetch(`/api/admin/conversations/${id}`, { method: 'DELETE' });
    if (chatState.activeConversationId === id) {
      chatState.chatHistory = [];
      chatState.activeConversationId = null;
    }
    await fetchConversations(chatState.activeModel);
  } catch (e) {}
}

async function ensureConversation(firstMessage) {
  if (chatState.activeConversationId) return chatState.activeConversationId;
  const title = firstMessage.slice(0, 80).trim();
  const res = await fetch('/api/admin/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: chatState.activeModel, title })
  });
  const { id } = await res.json();
  chatState.activeConversationId = id;
  await fetchConversations(chatState.activeModel);
  return id;
}

async function persistMessage(role, content) {
  if (!chatState.activeConversationId) return;
  try {
    const res = await fetch(`/api/admin/conversations/${chatState.activeConversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content })
    });
    if (!res.ok) console.error('[chat] persistMessage failed:', res.status, await res.text());
  } catch (e) {
    console.error('[chat] persistMessage error:', e.message);
  }
}

export function newChat() {
  chatState.chatHistory = [];
  chatState.inputText = '';
  chatState.activeConversationId = null;
}

// ── Inference ───────────────────────────────────────────────────────────────
export async function sendMessage(queuedText = null, alreadyInChat = false) {
  const text = queuedText ?? chatState.inputText.trim();
  if (!text || !chatState.activeModel) return;
  if (queuedText === null) chatState.inputText = '';

  if (chatState.generating) {
    // Show message immediately in chat and queue it for sending after generation
    chatState.messageQueue.push({ text, inChat: true });
    chatState.chatHistory.push({ role: 'user', content: text });
    return;
  }

  // Ensure a conversation exists (creates one on first message)
  try {
    await ensureConversation(text);
  } catch (e) {}

  // Only push to chatHistory if not already shown (queued messages are shown immediately)
  if (!alreadyInChat) {
    chatState.chatHistory.push({ role: 'user', content: text });
  }
  await persistMessage('user', text);

  chatState.generating = true;
  chatState.chatHistory.push({ role: 'assistant', content: '' });
  const assistantMsg = chatState.chatHistory[chatState.chatHistory.length - 1];

  abortController = new AbortController();

  const messages = [];
  if (chatState.systemPrompt.trim()) {
    messages.push({ role: 'system', content: chatState.systemPrompt.trim() });
  }
  for (const m of chatState.chatHistory.slice(0, -1)) {
    messages.push({ role: m.role, content: m.content });
  }

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        model: chatState.activeModel,
        messages,
        stream: true,
        temperature: chatState.params.temperature,
        top_p: chatState.params.top_p,
        top_k: chatState.params.top_k,
        max_tokens: chatState.params.max_tokens,
        // Drive the server-side tool-execution loop scoped to the picked tools.
        ...(chatState.mcpEnabled ? { mcp_tools: chatState.mcpSelectedTools } : {})
      })
    });

    if (!res.ok) {
      // The error body may not be JSON: a reverse proxy (nginx) returns an HTML
      // 502/504 page when the upstream is still cold-loading a large model or
      // restarting — parsing that as JSON throws "Unexpected token '<'". Read as
      // text and only then attempt JSON, falling back to a status-aware hint.
      const raw = await res.text().catch(() => '');
      let msg;
      try {
        const data = JSON.parse(raw);
        msg = (typeof data.error === 'object' ? data.error?.message : data.error) || 'Request failed';
      } catch {
        msg = (res.status === 502 || res.status === 504)
          ? `the model may still be loading (HTTP ${res.status}) — try again in a moment`
          : `server error (HTTP ${res.status})`;
      }
      assistantMsg.content = `Error: ${msg}`;
      chatState.generating = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine.startsWith('data: ')) continue;
        const dataStr = cleanLine.substring(6);
        if (dataStr === '[DONE]') continue;
        try {
          const obj = JSON.parse(dataStr);
          if (obj.error) {
            assistantMsg.content += `\n[Error: ${typeof obj.error === 'object' ? obj.error.message : obj.error}]`;
          }
          if (obj.choices?.[0]?.delta?.content) {
            assistantMsg.content += obj.choices[0].delta.content;
          }
          if (obj.perf) assistantMsg.perf = obj.perf;
        } catch (err) {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      assistantMsg.content += `\n[Error: ${err.message}]`;
    } else {
      assistantMsg.content += '\n[Generation stopped]';
    }
  } finally {
    // Persist completed assistant response
    if (assistantMsg.content) {
      await persistMessage('assistant', assistantMsg.content);
      // Refresh sidebar to show updated timestamp
      await fetchConversations(chatState.activeModel);
    }
    chatState.generating = false;
    abortController = null;
    if (chatState.messageQueue.length > 0) {
      const { text: next, inChat } = chatState.messageQueue.shift();
      Promise.resolve().then(() => sendMessage(next, inChat));
    }
  }
}

export function abortGeneration() {
  if (abortController) {
    abortController.abort();
  }
  // Aborting the fetch only closes the client→proxy connection; a buffering reverse
  // proxy (nginx) may not propagate that to the upstream, so the server never sees
  // the socket close and keeps decoding. Hit an explicit endpoint so the worker is
  // aborted regardless of how the stream is proxied. Fire-and-forget.
  fetch('/api/admin/abort', { method: 'POST' }).catch(() => {});
}
