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
                class="mb-2"
                placeholder="You are a helpful AI assistant..."
              ></v-textarea>

              <!-- MCP tools — pick which tools the server may call during this chat.
                   Selected tools are sent as `mcp_tools`, which runs the server-side
                   tool-execution loop scoped to them (no system-prompt text pasting). -->
              <div class="mb-3">
                <div class="d-flex align-center justify-space-between">
                  <div>
                    <span class="text-caption">Use MCP tools</span>
                    <span class="text-caption text-grey ml-2">
                      {{ mcpTools.length
                        ? `${mcpSelectedTools.length}/${mcpTools.length} selected · ~${mcpApproxTokens} tokens`
                        : 'no enabled MCP servers' }}
                    </span>
                  </div>
                  <v-switch
                    :model-value="mcpEnabled"
                    :disabled="mcpTools.length === 0"
                    color="primary" density="compact" hide-details inset
                    @update:model-value="toggleMcpEnabled"
                  ></v-switch>
                </div>

                <template v-if="mcpEnabled && mcpTools.length">
                  <div class="d-flex align-center justify-space-between mt-1">
                    <span class="text-caption text-grey">Tools the model may call</span>
                    <div>
                      <v-btn size="x-small" variant="text" color="primary" @click="selectAllMcp(true)">Select all</v-btn>
                      <v-btn size="x-small" variant="text" @click="selectAllMcp(false)">Clear</v-btn>
                    </div>
                  </div>
                  <div class="mcp-tool-picker">
                    <v-checkbox
                      v-for="t in mcpTools" :key="t.name"
                      :model-value="mcpSelectedSet.has(t.name)"
                      density="compact" hide-details color="primary" class="mcp-tool-check"
                      @update:model-value="v => onToggleTool(t.name, v)"
                    >
                      <template #label>
                        <span class="mcp-tool-label">
                          <code class="text-caption">{{ t.name }}</code>
                          <span class="text-caption text-grey mcp-tool-desc">{{ t.description }}</span>
                        </span>
                      </template>
                    </v-checkbox>
                  </div>
                </template>
              </div>

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
                  Prefill: {{ (msg.perf.prefill_time_ms ?? 0).toFixed(1) }}ms
                  ({{ msg.perf.prefill_time_ms && msg.perf.prefill_tokens ? (msg.perf.prefill_tokens / (msg.perf.prefill_time_ms / 1000)).toFixed(1) : '—' }} t/s) |
                  Decode: {{ msg.perf.generate_time_ms ? (msg.perf.generate_tokens / (msg.perf.generate_time_ms / 1000)).toFixed(1) : '—' }} t/s
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

  <RuntimeSyncDialog
    :model-value="showRuntimeSyncDialog"
    :sync-state="runtimeSyncState"
  />
</template>

<script>
import AppNav from '../components/AppNav.vue';
import RuntimeSyncDialog from '../components/RuntimeSyncDialog.vue';
import {
  chatState,
  fetchConversations as fetchConvs,
  loadConversation as loadConv,
  deleteConversation as delConv,
  newChat as newChatStore,
  sendMessage as sendMsg,
  abortGeneration as abortGen,
} from '../chat.js';

// Delimiters wrapping the auto-injected MCP tool-instructions block so the
// toggle can add/remove exactly that section without disturbing the user's text.
const MCP_BLOCK_START = '--- MCP TOOLS (auto-injected) ---';
const MCP_BLOCK_END = '--- END MCP TOOLS ---';

export default {
  name: 'Chat',
  components: { AppNav, RuntimeSyncDialog },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    models: [],
    loadingModel: false,
    status: { isLoaded: false, model: null },
    showRuntimeSyncDialog: false,
    runtimeSyncState: { active: false, version: null, filename: null, bytesDown: 0, totalBytes: 0 },
    runtimeSyncPoller: null,
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme',
    // View-only UI state (safe to reset on navigation)
    sidebarOpen: true,
    mobileHistoryOpen: false,
    // MCP tool picker — catalogue of available tools (the selection itself and
    // the enabled flag live in chatState so they persist across navigation).
    mcpTools: [],          // [{ name, description }] from enabled servers
    mcpApproxTokens: 0,    // token cost of the current selection (server-computed)
    mcpTokenTimer: null,   // debounce for the token-cost refresh
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    modelItems() {
      return this.models.map(m => ({ title: m.id, value: m.id }));
    },
    // Session state proxied from the shared store so an in-flight generation
    // and its conversation survive navigating away from /chat and back.
    selectedModel: {
      get() { return chatState.selectedModel; },
      set(v) { chatState.selectedModel = v; }
    },
    systemPrompt: {
      get() { return chatState.systemPrompt; },
      set(v) { chatState.systemPrompt = v; }
    },
    inputText: {
      get() { return chatState.inputText; },
      set(v) { chatState.inputText = v; }
    },
    params() { return chatState.params; },
    mcpEnabled() { return chatState.mcpEnabled; },
    mcpSelectedTools() { return chatState.mcpSelectedTools; },
    mcpSelectedSet() { return new Set(chatState.mcpSelectedTools); },
    activeModel() { return chatState.activeModel; },
    chatHistory() { return chatState.chatHistory; },
    generating() { return chatState.generating; },
    conversations() { return chatState.conversations; },
    activeConversationId() { return chatState.activeConversationId; }
  },
  watch: {
    // Autoscroll as tokens stream in (deep — assistant content mutates in place)
    // and when restoring history after navigating back to the page.
    chatHistory: {
      handler() { this.scrollToBottom(); },
      deep: true
    }
  },
  async mounted() {
    this.fetchAuth();
    await this.fetchModels();
    await this.fetchStatus();
    // Clean up any tool-instructions block pasted by the old (text-injection)
    // version of this feature — the loop now injects server-side.
    if (chatState.systemPrompt.includes(MCP_BLOCK_START)) {
      chatState.systemPrompt = this.stripMcpBlock(chatState.systemPrompt);
    }
    await this.fetchMcpTools();
    this.scrollToBottom();
  },
  beforeUnmount() {
    // Generation now lives in the store and continues across route changes,
    // persisting normally on completion — no per-navigation beacon needed.
    // Only the component-local runtime-sync poller must be torn down here.
    if (this.runtimeSyncPoller) clearInterval(this.runtimeSyncPoller);
  },
  methods: {
    startRuntimeSyncPoller() {
      if (this.runtimeSyncPoller) return;
      this.runtimeSyncPoller = setInterval(async () => {
        try {
          const res = await fetch('/api/admin/runtimes');
          if (!res.ok) return;
          const data = await res.json();
          this.runtimeSyncState = data.syncState || {};
          this.showRuntimeSyncDialog = !!data.syncState?.active;
          if (!data.syncState?.active) {
            clearInterval(this.runtimeSyncPoller);
            this.runtimeSyncPoller = null;
            this.showRuntimeSyncDialog = false;
          }
        } catch (e) {}
      }, 600);
    },
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
          chatState.selectedModel = data.model;
          chatState.activeModel = data.model;
          await fetchConvs(data.model);
        }
      } catch (e) {}
    },
    async onModelChange(modelId) {
      if (!modelId) return;
      if (modelId === this.status.model) {
        chatState.activeModel = modelId;
        await fetchConvs(modelId);
        return;
      }
      this.loadingModel = true;
      this.startRuntimeSyncPoller();
      try {
        const res = await fetch('/api/admin/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, options: { max_new_tokens: this.params.max_tokens } })
        });
        if (res.ok) {
          // 202 Accepted — the load runs asynchronously; poll status for it.
          if (await this.pollUntilLoaded(modelId)) {
            chatState.activeModel = modelId;
            chatState.chatHistory = [];
            chatState.activeConversationId = null;
            await fetchConvs(modelId);
          } else {
            chatState.selectedModel = this.status.model;
            chatState.activeModel = this.status.model;
          }
        } else {
          const data = await res.json().catch(() => ({}));
          this.$notify(data.error || 'Failed to load model', 'error');
          chatState.selectedModel = this.status.model;
          chatState.activeModel = this.status.model;
        }
      } catch (e) {
        this.$notify('Network error', 'error');
      } finally {
        this.loadingModel = false;
        if (this.runtimeSyncPoller) { clearInterval(this.runtimeSyncPoller); this.runtimeSyncPoller = null; }
        this.showRuntimeSyncDialog = false;
      }
    },
    // /api/admin/load returns 202 and loads in the background (a heavy gguf load
    // can take tens of seconds). Poll status until loaded or errored so no
    // single request stays open long enough for a reverse proxy to reset it.
    async pollUntilLoaded(modelId, timeoutMs = 300000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 1200));
        let data;
        try {
          const r = await fetch('/api/admin/status');
          if (!r.ok) continue;
          data = await r.json();
        } catch { continue; }
        this.status = data;
        if (data.loadError && data.loadError.model === modelId) {
          this.$notify(data.loadError.message || 'Failed to load model', 'error');
          return false;
        }
        if (data.isLoaded && data.model === modelId && !data.loading) return true;
      }
      this.$notify('Model load timed out', 'error');
      return false;
    },

    // ── Conversation management — delegate to the shared store ────────────
    fetchConversations(model) { return fetchConvs(model); },
    loadConversation(id) { return loadConv(id); },
    deleteConversation(id) { return delConv(id); },
    newChat() { newChatStore(); },

    // ── MCP tool picker ───────────────────────────────────────────────────
    async fetchMcpTools() {
      try {
        const res = await fetch('/api/admin/mcp-tools');
        if (!res.ok) return;
        const d = await res.json();
        this.mcpTools = d.tools || [];
        // Drop any selected names that no longer exist (server config changed).
        const valid = new Set(this.mcpTools.map(t => t.name));
        const pruned = chatState.mcpSelectedTools.filter(n => valid.has(n));
        if (pruned.length !== chatState.mcpSelectedTools.length) chatState.mcpSelectedTools = pruned;
        if (this.mcpEnabled) this.refreshMcpTokens();
      } catch (e) {}
    },
    toggleMcpEnabled(on) {
      chatState.mcpEnabled = !!on;
      if (on) {
        // Default to all tools when nothing has been picked yet.
        if (chatState.mcpSelectedTools.length === 0) {
          chatState.mcpSelectedTools = this.mcpTools.map(t => t.name);
        }
        this.refreshMcpTokens();
      }
    },
    onToggleTool(name, checked) {
      const set = new Set(chatState.mcpSelectedTools);
      if (checked) set.add(name); else set.delete(name);
      // Preserve catalogue order for a stable prompt.
      chatState.mcpSelectedTools = this.mcpTools.map(t => t.name).filter(n => set.has(n));
      this.refreshMcpTokens();
    },
    selectAllMcp(all) {
      chatState.mcpSelectedTools = all ? this.mcpTools.map(t => t.name) : [];
      this.refreshMcpTokens();
    },
    // Exact token cost of the selection, from the server (same builder the loop
    // uses). Debounced so rapid checkbox toggling doesn't spam the aggregator.
    refreshMcpTokens() {
      clearTimeout(this.mcpTokenTimer);
      if (!chatState.mcpSelectedTools.length) { this.mcpApproxTokens = 0; return; }
      this.mcpTokenTimer = setTimeout(async () => {
        try {
          const q = encodeURIComponent(chatState.mcpSelectedTools.join(','));
          const res = await fetch(`/api/admin/mcp-tools?tools=${q}`);
          if (res.ok) this.mcpApproxTokens = (await res.json()).approxTokens || 0;
        } catch (e) {}
      }, 350);
    },
    stripMcpBlock(text) {
      // Remove a previously injected block by locating its delimiters directly.
      // (String search — the markers contain regex-special chars like "()", so
      // building a RegExp from them would silently fail to match.)
      const start = text.indexOf(MCP_BLOCK_START);
      if (start === -1) return text;
      const endIdx = text.indexOf(MCP_BLOCK_END, start);
      if (endIdx === -1) return text;
      const end = endIdx + MCP_BLOCK_END.length;
      return (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, '\n\n').trimEnd();
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

    // ── Inference — delegate to the shared store ──────────────────────────
    sendMessage(queuedText = null, alreadyInChat = false) {
      return sendMsg(queuedText, alreadyInChat);
    },
    abortGeneration() { abortGen(); },
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
  /* Breathing room so the input + send button don't butt against the screen
     edge (which reads like content is cut off). Extra bottom inset clears a
     mobile home indicator / notch. */
  padding: 12px 16px;
  padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));
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

/* MCP tool picker — scrollable so a long tool list can't overflow the panel */
.mcp-tool-picker {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid rgba(139, 92, 246, 0.15);
  border-radius: 8px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.15);
}
.mcp-tool-check :deep(.v-selection-control) {
  align-items: flex-start;
  min-height: unset;
}
.mcp-tool-check :deep(.v-label) {
  opacity: 1;
  padding-top: 2px;
}
.mcp-tool-label {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.mcp-tool-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

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
