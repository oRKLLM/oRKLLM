<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page chat-main">
    <div class="chat-layout">

      <!-- Toolbar row -->
      <div class="d-flex align-center gap-3 flex-shrink-0">
        <v-icon color="primary">mdi-chat-outline</v-icon>
        <span class="text-h6 font-weight-bold">Chat</span>
        <v-spacer></v-spacer>

        <!-- Model selector -->
        <v-select
          v-model="selectedModel"
          :items="modelItems"
          density="compact"
          hide-details
          variant="outlined"
          style="min-width: 220px; max-width: 340px;"
          placeholder="Select a model..."
          :loading="loadingModel"
          @update:modelValue="onModelChange"
        ></v-select>

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
          <v-expansion-panel-title class="text-caption text-grey py-2">
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
                <div class="text-caption text-grey mb-1">Top P: {{ params.top_p }}</div>
                <v-slider v-model="params.top_p" min="0.1" max="1.0" step="0.05" color="primary" density="compact" hide-details thumb-label></v-slider>
              </v-col>
              <v-col cols="12" sm="6">
                <div class="text-caption text-grey mb-1">Top K: {{ params.top_k }}</div>
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

      <!-- Messages area — scrollable -->
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
            <!-- Avatar Assistant -->
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

            <!-- Avatar User -->
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

      <!-- Input area — fixed at bottom, outside scroll -->
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
                :disabled="!activeModel || generating"
                @keydown.enter.exact.prevent="sendMessage"
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
                  :disabled="!inputText.trim() || !activeModel || generating"
                  @click="sendMessage"
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
    abortController: null,
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
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
    await this.fetchModels();  // models must load before status sets selectedModel
    await this.fetchStatus();
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
        }
      } catch (e) {}
    },
    async onModelChange(modelId) {
      if (!modelId || modelId === this.status.model) {
        this.activeModel = modelId;
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
          await this.fetchStatus();
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
    newChat() {
      this.chatHistory = [];
      this.inputText = '';
    },
    async sendMessage() {
      const text = this.inputText.trim();
      if (!text || !this.activeModel || this.generating) return;

      this.inputText = '';
      this.chatHistory.push({ role: 'user', content: text });
      this.scrollToBottom();

      this.generating = true;
      this.chatHistory.push({ role: 'assistant', content: '' });
      const assistantMsg = this.chatHistory[this.chatHistory.length - 1];

      this.abortController = new AbortController();

      // Build messages array
      const messages = [];
      if (this.systemPrompt.trim()) {
        messages.push({ role: 'system', content: this.systemPrompt.trim() });
      }
      // Include history, excluding the last empty assistant placeholder
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
              if (obj.perf) {
                assistantMsg.perf = obj.perf;
              }
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
        this.generating = false;
        this.abortController = null;
        this.scrollToBottom();
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
/* Chat page fills the viewport height, input pinned to bottom */
.chat-main {
  height: 100dvh !important;   /* dvh = dynamic viewport, respects mobile browser chrome */
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

.chat-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px 12px 0;
  gap: 12px;
  overflow: hidden;
}

/* Toolbar + expansion panels are flex-shrink-0 by default */

/* Messages wrapper scrolls, input bar does not */
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

/* Input bar stays fixed at the very bottom */
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
  background-color: #1F2937 !important;
}
.v-theme--customLightTheme .bg-surface-variant {
  background-color: #E2E8F0 !important;
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

/* Pulse dots */
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
