<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6" style="max-width: 860px;">

      <div class="d-flex align-center justify-space-between mb-5 flex-wrap gap-3">
        <div>
          <div class="text-h5 font-weight-bold mb-1">Benchmark</div>
          <div class="text-caption text-grey">Measure inference throughput on the selected model.</div>
        </div>
        <!-- Model selector — same pattern as Chat -->
        <v-select
          v-model="selectedModel"
          :items="modelItems"
          density="compact"
          hide-details
          variant="outlined"
          style="min-width: 240px; max-width: 360px;"
          placeholder="Select a model..."
          :loading="loadingModel"
          @update:modelValue="onModelChange"
        ></v-select>
      </div>

      <!-- Status banner — only shows if a model is active -->
      <v-alert
        v-if="status.isLoaded"
        type="success"
        variant="tonal"
        border="start"
        class="mb-5"
        density="comfortable"
      >
        <div class="font-weight-bold">Active: {{ status.model }}</div>
        <div class="text-caption">Platform: {{ status.isMock ? 'Mock Engine' : 'Rockchip NPU' }}</div>
      </v-alert>

      <!-- Benchmark config card -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="text-h6 font-weight-bold mb-4 d-flex align-center">
          <v-icon start color="primary">mdi-speedometer</v-icon>
          Performance Benchmark
        </div>

        <div class="text-caption text-grey mb-1">Benchmark Prompt</div>
        <v-textarea
          v-model="benchPrompt"
          variant="outlined"
          density="comfortable"
          rows="4"
          hide-details
          class="mb-5 font-mono"
          :disabled="running"
        ></v-textarea>

        <div class="text-caption text-grey mb-1">Max Tokens: <strong>{{ maxTokens }}</strong></div>
        <v-slider
          v-model="maxTokens"
          :min="128"
          :max="2048"
          :step="128"
          color="primary"
          density="compact"
          hide-details
          class="mb-5"
          :disabled="running"
        ></v-slider>

        <v-btn
          color="primary"
          variant="flat"
          size="large"
          :loading="running"
          :disabled="!status.isLoaded || !selectedModel"
          prepend-icon="mdi-play"
          @click="runBenchmark"
        >
          Run Benchmark
        </v-btn>
        <v-btn
          v-if="running"
          color="error"
          variant="outlined"
          size="large"
          class="ml-3"
          @click="abortBenchmark"
        >
          Abort
        </v-btn>
      </v-card>

      <!-- Live output during run -->
      <v-card v-if="running || benchOutput" class="glass-card pa-5 mb-5">
        <div class="text-subtitle-1 font-weight-bold mb-3 d-flex align-center">
          <v-icon start color="primary">mdi-text-box-outline</v-icon>
          Output
        </div>
        <pre class="terminal-logs pa-3 rounded overflow-y-auto" style="max-height: 240px;">{{ benchOutput || '…' }}</pre>
      </v-card>

      <!-- Results card -->
      <v-card v-if="results" class="glass-card pa-5">
        <div class="text-h6 font-weight-bold mb-4 d-flex align-center">
          <v-icon start color="success">mdi-check-circle-outline</v-icon>
          Results
        </div>
        <v-row>
          <v-col cols="12" sm="4" class="text-center">
            <div class="text-caption text-grey mb-1">TIME TO FIRST TOKEN</div>
            <div class="text-h4 font-weight-bold text-primary">{{ results.ttft_ms.toFixed(0) }}<span class="text-body-2 ml-1">ms</span></div>
          </v-col>
          <v-col cols="12" sm="4" class="text-center">
            <div class="text-caption text-grey mb-1">PREFILL SPEED</div>
            <div class="text-h4 font-weight-bold text-success">{{ results.prefill_tps.toFixed(1) }}<span class="text-body-2 ml-1">tok/s</span></div>
          </v-col>
          <v-col cols="12" sm="4" class="text-center">
            <div class="text-caption text-grey mb-1">GENERATION SPEED</div>
            <div class="text-h4 font-weight-bold text-warning">{{ results.gen_tps.toFixed(1) }}<span class="text-body-2 ml-1">tok/s</span></div>
          </v-col>
        </v-row>
        <v-divider class="my-4"></v-divider>
        <v-row class="text-center">
          <v-col cols="6" sm="3">
            <div class="text-caption text-grey">Total tokens generated</div>
            <div class="text-body-1 font-weight-bold">{{ results.gen_tokens }}</div>
          </v-col>
          <v-col cols="6" sm="3">
            <div class="text-caption text-grey">Total time</div>
            <div class="text-body-1 font-weight-bold">{{ (results.total_ms / 1000).toFixed(2) }}s</div>
          </v-col>
          <v-col cols="6" sm="3">
            <div class="text-caption text-grey">Model</div>
            <div class="text-body-1 font-weight-bold text-truncate">{{ results.model }}</div>
          </v-col>
          <v-col cols="6" sm="3">
            <div class="text-caption text-grey">Max tokens setting</div>
            <div class="text-body-1 font-weight-bold">{{ results.max_tokens }}</div>
          </v-col>
        </v-row>
      </v-card>

    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

const DEFAULT_PROMPT = 'Explain the theory of relativity in detail, covering both the special and general theories, their implications, and practical applications in modern technology.';

export default {
  name: 'Bench',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    status: { isLoaded: false, model: null, isMock: false },
    models: [],
    selectedModel: null,
    loadingModel: false,
    benchPrompt: DEFAULT_PROMPT,
    maxTokens: 512,
    running: false,
    benchOutput: '',
    results: null,
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
    await this.fetchModels();
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
        if (data.isLoaded && data.model && !this.selectedModel) {
          this.selectedModel = data.model;
        }
      } catch (e) {}
    },
    async onModelChange(modelId) {
      if (!modelId || modelId === this.status.model) {
        this.selectedModel = modelId;
        return;
      }
      this.loadingModel = true;
      try {
        const res = await fetch('/api/admin/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId })
        });
        if (res.ok) {
          await this.fetchStatus();
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to load model');
          this.selectedModel = this.status.model;
        }
      } catch (e) {
        alert('Network error');
      } finally {
        this.loadingModel = false;
      }
    },
    async runBenchmark() {
      if (!this.status.isLoaded || this.running) return;

      this.running = true;
      this.benchOutput = '';
      this.results = null;
      this.abortController = new AbortController();

      const t0 = performance.now();
      let ttft = null;
      let genTokens = 0;
      let prefillTimeMs = 0;
      let genTimeMs = 0;

      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: this.abortController.signal,
          body: JSON.stringify({
            model: this.status.model,
            messages: [{ role: 'user', content: this.benchPrompt }],
            stream: true,
            max_tokens: this.maxTokens,
            temperature: 0.7,
            top_p: 0.9
          })
        });

        if (!res.ok) {
          const data = await res.json();
          this.benchOutput = `Error: ${data.error || 'Request failed'}`;
          this.running = false;
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
                if (ttft === null) {
                  ttft = performance.now() - t0;
                }
                this.benchOutput += obj.choices[0].delta.content;
                genTokens++;
              }

              if (obj.perf) {
                prefillTimeMs = obj.perf.prefill_time_ms || 0;
                genTimeMs = obj.perf.generate_time_ms || 0;
                genTokens = obj.perf.generate_tokens || genTokens;
              }
            } catch (err) {}
          }
        }

        const total = performance.now() - t0;

        this.results = {
          ttft_ms: ttft ?? total,
          prefill_tps: prefillTimeMs > 0 ? ((this.benchPrompt.split(' ').length) / (prefillTimeMs / 1000)) : 0,
          gen_tps: genTimeMs > 0 ? (genTokens / (genTimeMs / 1000)) : (genTokens / (total / 1000)),
          gen_tokens: genTokens,
          total_ms: total,
          model: this.status.model,
          max_tokens: this.maxTokens
        };

      } catch (err) {
        if (err.name !== 'AbortError') {
          this.benchOutput += `\n[Error: ${err.message}]`;
        }
      } finally {
        this.running = false;
        this.abortController = null;
      }
    },
    abortBenchmark() {
      if (this.abortController) {
        this.abortController.abort();
      }
      this.running = false;
      this.benchOutput += '\n[Benchmark aborted]';
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

.terminal-logs {
  background-color: #030712 !important;
  color: #10B981 !important;
  font-family: 'Fira Code', 'Courier New', Courier, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.font-mono {
  font-family: 'Fira Code', 'Courier New', monospace;
}
</style>
