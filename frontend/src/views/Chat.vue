<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page chat-main">
    <div class="chat-outer">

      <!-- Conversation sidebar -->
      <div :class="['chat-sidebar', sidebarOpen ? 'chat-sidebar--open' : 'chat-sidebar--closed']">
        <div class="sidebar-header d-flex align-center pa-3 gap-2">
          <v-btn icon size="small" variant="text" @click="sidebarOpen = !sidebarOpen" :title="sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'">
            <v-icon>{{ sidebarOpen ? 'mdi-chevron-left' : 'mdi-chevron-right' }}</v-icon>
          </v-btn>
          <span v-if="sidebarOpen" class="text-caption font-weight-bold text-uppercase text-grey">History</span>
          <v-spacer v-if="sidebarOpen"></v-spacer>
          <v-btn v-if="sidebarOpen" icon size="small" variant="text" color="primary" title="New conversation" @click="newChat">
            <v-icon>mdi-plus</v-icon>
          </v-btn>
        </div>

        <div v-if="sidebarOpen" class="sidebar-list">
          <div v-if="conversations.length === 0" class="text-caption text-grey pa-3">
            No conversations yet for this model.
          </div>
          <div
            v-for="conv in conversations"
            :key="conv.id"
            :class="['sidebar-item pa-3', activeConversationId === conv.id ? 'sidebar-item--active' : '']"
            @click="loadConversation(conv.id)"
          >
            <div class="sidebar-item-title text-body-2">{{ conv.title }}</div>
            <div class="d-flex align-center justify-space-between mt-1">
              <span class="text-caption text-grey">{{ formatDate(conv.updated_at) }}</span>
              <v-btn
                icon size="x-small" variant="text" color="error"
                title="Delete conversation"
                @click.stop="deleteConversation(conv.id)"
              >
                <v-icon size="14">mdi-delete-outline</v-icon>
              </v-btn>
            </div>
          </div>
        </div>
      </div>

      <!-- Main chat area -->
      <div class="chat-layout">

        <!-- Toolbar row -->
        <div class="d-flex align-center gap-3 flex-shrink-0">
          <v-icon color="primary" class="d-none d-sm-flex">mdi-chat-outline</v-icon>
          <span class="text-h6 font-weight-bold d-none d-sm-flex">Chat</span>
          <v-spacer></v-spacer>

          <!-- Model selector -->
          <v-select
            v-model="selectedModel"
            :items="modelItems"
            density="compact"
            hide-details
            variant="outlined"
            style="min-width: 200px; max-width: 320px;"
            placeholder="Select a model..."
            :loading="loadingModel"
            @update:modelValue="onModelChange"
          ></v-select>

          <!-- History button — mobile only -->
          <v-btn
            class="d-sm-none"
            icon
            variant="text"
            size="small"
            title="Conversation history"
            @click="mobileHistoryOpen = true"
          >
            <v-icon>mdi-history</v-icon>
          </v-btn>

          <!-- New Chat button -->
          <v-btn
            variant="tonal"
            color="primary"
            prepend-icon="mdi-plus"
            size="small"
            @click="newChat"
          >
            New Chat
          </v-btn>
        </div>

        <!-- System prompt (collapsible) -->
        <v-expansion-panels class="flex-shrink-0" variant="accordion">
          <v-expansion-panel>
            <v-expansion-panel-title class="text-caption">
              <v-icon size="16" class="mr-2" color="primary">mdi-tune</v-icon>
              System Prompt &amp; Parameters
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <v-textarea
                v-model="systemPrompt"
                label="System Prompt"
                variant="outlined"
                density="compact"
                rows="3"
                hide-details
                class="mb-3"
                placeholder="You are a helpful AI assistant..."
              ></v-textarea>
              <v-row>
                <v-col cols="12" sm="6">
                  <div class="text-caption text-grey mb-1">Temperature: {{ params.temperature }}</div>
                  <v-slider v-model="params.temperature" min="0.1" max="2.0" step="0.1" color="primary" density="compact" hide-details thumb-label></v-slider>
                </v-col>
                <v-col cols="12" sm="6">
                  <div class="text-caption text-grey mb-1">Top-P: {{ params.top_p }}</div>
                  <v-slider v-model="params.top_p" min="0.1" max="1.0" step="0.05" color="primary" density="compact" hide-details thumb-label></v-slider>
                </v-col>
                <v-col cols="12" sm="6">
                  <div class="text-caption text-grey mb-1">Top-K: {{ params.top_k }}</div>
                  <v-slider v-model="params.top_k" min="1" max="100" step="1" color="primary" density="compact" hide-details thumb-label></v-slider>
                </v-col>
                <v-col cols="12" sm="6">
                  <div class="text-caption text-grey mb-1">Max Tokens: {{ params.max_tokens }}</div>
                  <v-slider v-model="params.max_tokens" min="32" max="4096" step="32" color="primary" density="compact" hide-details thumb-label></v-slider>
                </v-col>
              </v-row>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <!-- Messages area -->
        <div class="chat-messages-wrapper glass-card">
          <div
            class="chat-messages-container pa-4 pa-sm-5"
            ref="chatContainer"
          >
            <div
              v-for="(msg, idx) in chatHistory"
              :key="idx"
              :class="['d-flex mb-4', msg.role === 'user' ? 'justify-end' : 'justify-start']"
            >
              <v-avatar v-if="msg.role !== 'user'" color="primary" class="mr-3 flex-shrink-0" size="36">
                <v-icon color="white">mdi-robot-outline</v-icon>
              </v-avatar>

              <div
                :class="['message-bubble pa-3 rounded-lg', msg.role === 'user' ? 'bg-primary text-white' : 'bg-surface-variant']"
                style="max-width: 75%;"
              >
                <div class="message-text" v-html="formatMessage(msg.content)"></div>
                <div v-if="msg.perf" class="text-caption text-grey-lighten-1 mt-2 border-top-dashed pt-1">
                  Prefill: {{ msg.perf.prefill_time_ms.toFixed(1) }}ms |
                  Rate: {{ (msg.perf.generate_tokens / (msg.perf.generate_time_ms / 1000)).toFixed(1) }} t/s
                </div>
              </div>

              <v-avatar v-if="msg.role === 'user'" color="teal" class="ml-3 flex-shrink-0" size="36">
                <v-icon color="white">mdi-account</v-icon>
              </v-avatar>
            </div>

            <!-- Typing indicator -->
            <div v-if="generating && chatHistory[chatHistory.length - 1]?.role === 'user'" class="d-flex justify-start mb-4">
              <v-avatar color="primary" class="mr-3" size="36">
                <v-icon color="white">mdi-robot-outline</v-icon>
              </v-avatar>
              <div class="message-bubble pa-3 rounded-lg bg-surface-variant d-flex align-center">
                <span class="pulse-dot"></span>
                <span class="pulse-dot delay-1"></span>
                <span class="pulse-dot delay-2"></span>
              </div>
            </div>

            <!-- Empty state -->
            <div v-if="chatHistory.length === 0 && !generating" class="text-center py-12 text-grey">
              <v-icon size="56" color="grey-darken-2" class="mb-3">mdi-chat-outline</v-icon>
              <div class="text-h6 mb-1">Start a conversation</div>
              <div class="text-caption">Select a model above and type a message below to begin.</div>
            </div>
          </div>
        </div>

        <!-- Input area -->
        <div class="chat-input-bar bg-slate-input">
          <v-row class="align-end" no-gutters>
            <v-col class="pr-3">
              <v-textarea
                v-model="inputText"
                placeholder="Message… (Shift+Enter for newline)"
                variant="outlined"
                density="comfortable"
                hide-details
                rows="1"
                auto-grow
                max-rows="6"
                :disabled="!activeModel"
                @keydown.enter.exact.prevent="() => sendMessage()"
                @keydown.enter.shift.exact="() => {}"
              ></v-textarea>
            </v-col>
            <v-col cols="auto">
              <div class="d-flex flex-column gap-2">
                <v-btn
                  color="primary"
                  icon
                  variant="flat"
                  size="large"
                  :disabled="!inputText.trim() || !activeModel"
                  @click="() => sendMessage()"
                >
                  <v-icon>mdi-send</v-icon>
                </v-btn>
                <v-btn
                  v-if="generating"
                  color="error"
                  icon
                  variant="outlined"
                  size="large"
                  @click="abortGeneration"
                >
                  <v-icon>mdi-stop</v-icon>
                </v-btn>
              </div>
            </v-col>
          </v-row>
          <div v-if="!activeModel" class="text-caption text-warning mt-2">
            <v-icon size="14" color="warning">mdi-alert-outline</v-icon>
            No model loaded. Select and load a model to start chatting.
          </div>
        </div>

      </div>
    </div>

    <!-- Mobile conversation history bottom sheet -->
    <v-bottom-sheet v-model="mobileHistoryOpen" max-height="70vh">
      <v-card class="rounded-t-xl">
        <v-card-title class="d-flex align-center pa-4 pb-2">
          <v-icon color="primary" class="mr-2">mdi-history</v-icon>
          <span class="text-body-1 font-weight-bold">Conversation History</span>
          <v-spacer></v-spacer>
          <v-btn icon size="small" variant="text" @click="mobileHistoryOpen = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-divider></v-divider>
        <v-list class="overflow-y-auto" style="max-height: calc(70vh - 64px);">
          <v-list-item v-if="conversations.length === 0" class="text-grey text-caption">
            No conversations yet for this model.
          </v-list-item>
          <v-list-item
            v-for="conv in conversations"
            :key="conv.id"
            :active="activeConversationId === conv.id"
            active-color="primary"
            @click="loadConversation(conv.id); mobileHistoryOpen = false"
          >
            <v-list-item-title class="text-body-2">{{ conv.title }}</v-list-item-title>
            <v-list-item-subtitle class="text-caption">{{ formatDate(conv.updated_at) }}</v-list-item-subtitle>
            <template #append>
              <v-btn icon size="x-small" variant="text" color="error" @click.stop="deleteConversation(conv.id)">
                <v-icon size="16">mdi-delete-outline</v-icon>
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card>
    </v-bottom-sheet>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'Chat',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    models: [],
    selectedModel: null,
    activeModel: null,
    loadingModel: false,
    status: { isLoaded: false, model: null },
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
    abortController: null,
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme',
    // Conversation persistence
    sidebarOpen: true,
    mobileHistoryOpen: false,
    conversations: [],
    activeConversationId: null,
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    modelItems() {
      return this.models.map(m => ({ title: m.id, value: m.id }));
    }
  },
  async mounted() {
    this.fetchAuth();
    await this.fetchModels();
    await this.fetchStatus();
  },
  beforeUnmount() {
    // Page navigation during inference — save whatever was generated so far.
    // sendBeacon fires even as the page unloads; a normal fetch would be cancelled.
    if (!this.activeConversationId) return;
    const lastMsg = this.chatHistory[this.chatHistory.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.content) {
      navigator.sendBeacon(
        `/api/admin/conversations/${this.activeConversationId}/messages`,
        new Blob([JSON.stringify({ role: 'assistant', content: lastMsg.content })],
          { type: 'application/json' })
      );
    }
  },
  methods: {
    async fetchAuth() {
      try {
        const res = await fetch('/api/admin/auth-status');
        const data = await res.json();
        if (data.user) this.user = data.user;
        else if (data.username) this.user = { username: data.username, role: 'admin', authProvider: 'local' };
      } catch (e) {}
    },
    async fetchModels() {
      try {
        const res = await fetch('/v1/models');
        const data = await res.json();
        this.models = data.data || [];
      } catch (e) {}
    },
    async fetchStatus() {
      try {
        const res = await fetch('/api/admin/status');
        const data = await res.json();
        this.status = data;
        if (data.isLoaded && data.model) {
          this.selectedModel = data.model;
          this.activeModel = data.model;
          await this.fetchConversations(data.model);
        }
      } catch (e) {}
    },
    async onModelChange(modelId) {
      if (!modelId) return;
      if (modelId === this.status.model) {
        this.activeModel = modelId;
        await this.fetchConversations(modelId);
        return;
      }
      this.loadingModel = true;
      try {
        const res = await fetch('/api/admin/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, options: { max_new_tokens: this.params.max_tokens } })
        });
        if (res.ok) {
          this.activeModel = modelId;
          this.chatHistory = [];
          this.activeConversationId = null;
          await this.fetchStatus();
          await this.fetchConversations(modelId);
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to load model');
          this.selectedModel = this.status.model;
          this.activeModel = this.status.model;
        }
      } catch (e) {
        alert('Network error');
      } finally {
        this.loadingModel = false;
      }
    },

    // ── Conversation management ───────────────────────────────────────────
    async fetchConversations(model) {
      if (!model) return;
      try {
        const res = await fetch(`/api/admin/conversations?model=${encodeURIComponent(model)}`);
        if (res.ok) this.conversations = await res.json();
      } catch (e) {}
    },
    async loadConversation(id) {
      try {
        const res = await fetch(`/api/admin/conversations/${id}/messages`);
        if (!res.ok) return;
        const { messages } = await res.json();
        this.chatHistory = messages.map(m => ({ role: m.role, content: m.content }));
        this.activeConversationId = id;
        this.scrollToBottom();
      } catch (e) {}
    },
    async deleteConversation(id) {
      try {
        await fetch(`/api/admin/conversations/${id}`, { method: 'DELETE' });
        if (this.activeConversationId === id) {
          this.chatHistory = [];
          this.activeConversationId = null;
        }
        await this.fetchConversations(this.activeModel);
      } catch (e) {}
    },
    async ensureConversation(firstMessage) {
      if (this.activeConversationId) return this.activeConversationId;
      const title = firstMessage.slice(0, 80).trim();
      const res = await fetch('/api/admin/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.activeModel, title })
      });
      const { id } = await res.json();
      this.activeConversationId = id;
      await this.fetchConversations(this.activeModel);
      return id;
    },
    async persistMessage(role, content) {
      if (!this.activeConversationId) return;
      try {
        const res = await fetch(`/api/admin/conversations/${this.activeConversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, content })
        });
        if (!res.ok) console.error('[chat] persistMessage failed:', res.status, await res.text());
      } catch (e) {
        console.error('[chat] persistMessage error:', e.message);
      }
    },
    newChat() {
      this.chatHistory = [];
      this.inputText = '';
      this.activeConversationId = null;
    },
    formatDate(ts) {
      const d = new Date(ts);
      const now = new Date();
      const diffDays = Math.floor((now - d) / 86400000);
      if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },

    // ── Inference ─────────────────────────────────────────────────────────
    async sendMessage(queuedText = null) {
      const text = queuedText ?? this.inputText.trim();
      if (!text || !this.activeModel) return;
      if (queuedText === null) this.inputText = '';

      if (this.generating) {
        this.messageQueue.push(text);
        this.chatHistory.push({ role: 'user', content: text });
        this.scrollToBottom();
        return;
      }

      // Ensure a conversation exists (creates one on first message)
      try {
        await this.ensureConversation(text);
      } catch (e) {}

      this.chatHistory.push({ role: 'user', content: text });
      this.scrollToBottom();
      await this.persistMessage('user', text);

      this.generating = true;
      this.chatHistory.push({ role: 'assistant', content: '' });
      const assistantMsg = this.chatHistory[this.chatHistory.length - 1];

      this.abortController = new AbortController();

      const messages = [];
      if (this.systemPrompt.trim()) {
        messages.push({ role: 'system', content: this.systemPrompt.trim() });
      }
      for (const m of this.chatHistory.slice(0, -1)) {
        messages.push({ role: m.role, content: m.content });
      }

      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: this.abortController.signal,
          body: JSON.stringify({
            model: this.activeModel,
            messages,
            stream: true,
            temperature: this.params.temperature,
            top_p: this.params.top_p,
            top_k: this.params.top_k,
            max_tokens: this.params.max_tokens
          })
        });

        if (!res.ok) {
          const data = await res.json();
          assistantMsg.content = `Error: ${data.error || 'Request failed'}`;
          this.generating = false;
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
              if (obj.choices?.[0]?.delta?.content) {
                assistantMsg.content += obj.choices[0].delta.content;
                this.scrollToBottom();
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
          await this.persistMessage('assistant', assistantMsg.content);
          // Refresh sidebar to show updated timestamp
          await this.fetchConversations(this.activeModel);
        }
        this.generating = false;
        this.abortController = null;
        this.scrollToBottom();
        if (this.messageQueue.length > 0) {
          const next = this.messageQueue.shift();
          this.$nextTick(() => this.sendMessage(next));
        }
      }
    },
    abortGeneration() {
      if (this.abortController) {
        this.abortController.abort();
      }
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const el = this.$refs.chatContainer;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    formatMessage(content) {
      if (!content) return '';
      let text = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      text = text.replace(/```([\s\S]+?)```/g, (match, code) => {
        return `<pre class="code-block pa-2 my-2 rounded font-mono text-caption">${code}</pre>`;
      });
      text = text.replace(/`([^`\n]+?)`/g, '<code class="inline-code px-1 rounded font-mono">$1</code>');
      text = text.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
      text = text.replace(/\n/g, '<br/>');
      return text;
    },
    toggleTheme() {
      const next = this.isDark ? 'customLightTheme' : 'customDarkTheme';
      this.themeName = next;
      localStorage.setItem('orkllm-theme', next);
      try {
        this.$vuetify.theme.global.name.value = next;
      } catch {
        this.$vuetify.theme.global.name = next;
      }
    },
    async logout() {
      try {
        await fetch('/api/admin/logout', { method: 'POST' });
        this.$router.push('/login');
      } catch (e) {}
    }
  }
};
</script>

<style scoped>
/* Outer wrapper: sidebar + main side by side */
.chat-main {
  position: fixed !important;
  top: var(--v-layout-top, 64px) !important;
  right: 0 !important;
  bottom: 0 !important;
  left: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}

.chat-outer {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* Sidebar */
.chat-sidebar {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background: rgba(11, 15, 25, 0.95);
  border-right: 1px solid rgba(139, 92, 246, 0.15);
  transition: width 0.2s ease;
  overflow: hidden;
}
.chat-sidebar--open  { width: 220px; }
.chat-sidebar--closed { width: 44px; }

.v-theme--customLightTheme .chat-sidebar {
  background: rgba(241, 245, 249, 0.98);
}

.sidebar-header {
  flex-shrink: 0;
  border-bottom: 1px solid rgba(139, 92, 246, 0.1);
  min-height: 48px;
}

.sidebar-list {
  flex: 1 1 0;
  overflow-y: auto;
}

.sidebar-item {
  cursor: pointer;
  border-bottom: 1px solid rgba(139, 92, 246, 0.07);
  transition: background 0.15s;
}
.sidebar-item:hover { background: rgba(139, 92, 246, 0.08); }
.sidebar-item--active { background: rgba(139, 92, 246, 0.15) !important; }

.sidebar-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
}

/* Main chat column */
.chat-layout {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px 12px 0;
  gap: 12px;
  overflow: hidden;
  min-width: 0;
}

.chat-messages-wrapper {
  flex: 1 1 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-messages-container {
  flex: 1 1 0;
  overflow-y: auto;
  background: rgba(10, 15, 30, 0.3);
}
.v-theme--customLightTheme .chat-messages-container {
  background: rgba(241, 245, 249, 0.5);
}

.chat-input-bar {
  flex-shrink: 0;
  border-top: 1px solid rgba(139, 92, 246, 0.1);
}

.bg-slate-page {
  background: #0B0F19 !important;
}
.v-theme--customLightTheme .bg-slate-page {
  background: #F1F5F9 !important;
}

.glass-card {
  background: rgba(17, 24, 39, 0.7) !important;
  backdrop-filter: blur(16px);
  border: 1px solid rgba(139, 92, 246, 0.15) !important;
  border-radius: 12px !important;
}
.v-theme--customLightTheme .glass-card {
  background: rgba(255, 255, 255, 0.85) !important;
  border: 1px solid rgba(124, 58, 237, 0.2) !important;
}

.message-bubble {
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  line-height: 1.5;
}

.bg-surface-variant {
  background-color: #1E3048 !important;
  color: #E8EDF5 !important;
}
.v-theme--customLightTheme .bg-surface-variant {
  background-color: #D9E2EF !important;
  color: #111827 !important;
}

.bg-slate-input {
  background: rgba(17, 24, 39, 0.9);
}
.v-theme--customLightTheme .bg-slate-input {
  background: rgba(241, 245, 249, 0.9);
}

.border-top-dashed {
  border-top: 1px dashed rgba(128, 128, 128, 0.2);
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background-color: #8B5CF6;
  border-radius: 50%;
  display: inline-block;
  margin: 0 2px;
  animation: pulse 1.4s infinite ease-in-out both;
}
.delay-1 { animation-delay: 0.2s; }
.delay-2 { animation-delay: 0.4s; }

@keyframes pulse {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1.0); }
}

.gap-3 { gap: 12px; }
.gap-2 { gap: 8px; }

/* Hide sidebar on small screens */
@media (max-width: 599px) {
  .chat-sidebar { display: none; }
}
</style>

<style>
.code-block {
  background: #030712 !important;
  color: #10B981 !important;
  border-left: 3px solid #7C3AED;
  overflow-x: auto;
}
.inline-code {
  background: #111827 !important;
  color: #F43F5E !important;
}
</style>
