<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6 page-container">

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

      <!-- On wide screens: config (left) beside live output + results (right). -->
      <v-row class="bench-row">
        <v-col cols="12" lg="5">
      <!-- Benchmark config card -->
      <v-card class="glass-card pa-5 mb-5 mb-lg-0">
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
        </v-col>

        <v-col cols="12" lg="7">
          <!-- Placeholder before the first run so the right column isn't empty -->
          <v-card v-if="!running && !benchOutput && !results" class="glass-card pa-8 d-flex flex-column align-center justify-center text-center" style="min-height: 200px;">
            <v-icon size="48" color="grey-darken-1" class="mb-3">mdi-speedometer-slow</v-icon>
            <div class="text-body-2 text-grey">Run a benchmark to see throughput metrics here.</div>
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
        <v-divider class="my-4"></v-divider>
        <div class="d-flex align-center flex-wrap gap-2">
          <span class="text-caption text-grey">Speculative decoding</span>
          <template v-if="results.spec_enabled">
            <v-chip size="small" color="primary" variant="tonal" prepend-icon="mdi-rocket-launch-outline">
              {{ specLabel(results.spec_strategy) }}
            </v-chip>
            <v-chip size="small" color="cyan" variant="tonal" prepend-icon="mdi-chip">
              {{ hwLabel(results.spec_hardware) }}
            </v-chip>
          </template>
          <v-chip v-else size="small" color="grey" variant="tonal">
            Disabled — standard autoregressive decode
          </v-chip>
        </div>
      </v-card>
        </v-col>
      </v-row>

      <!-- Previous runs (full width — the table benefits most from horizontal space) -->
      <v-card v-if="history.length" class="glass-card pa-5 mt-5">
        <div class="d-flex align-center justify-space-between mb-3 flex-wrap gap-2">
          <div class="text-h6 font-weight-bold d-flex align-center">
            <v-icon start color="primary">mdi-history</v-icon>
            Previous Runs
          </div>
          <v-btn size="small" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="clearHistory">Clear</v-btn>
        </div>
        <v-table density="comfortable" class="bench-history">
          <thead>
            <tr>
              <th>When</th>
              <th class="text-truncate">Model</th>
              <th class="text-right">TTFT</th>
              <th class="text-right">Prefill</th>
              <th class="text-right">Gen</th>
              <th class="text-right">Tokens</th>
              <th class="text-right">Total</th>
              <th class="text-right">Max</th>
              <th>Spec decode</th>
              <th class="text-right"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in history" :key="r.id">
              <td class="text-caption text-no-wrap">{{ formatTime(r.created_at) }}</td>
              <td class="text-caption text-truncate" style="max-width: 180px;">{{ r.model }}</td>
              <td class="text-right text-no-wrap">{{ r.ttft_ms != null ? r.ttft_ms.toFixed(0) + ' ms' : '—' }}</td>
              <td class="text-right text-no-wrap">{{ r.prefill_tps != null ? r.prefill_tps.toFixed(1) : '—' }}</td>
              <td class="text-right text-no-wrap">{{ r.gen_tps != null ? r.gen_tps.toFixed(1) : '—' }}</td>
              <td class="text-right">{{ r.gen_tokens ?? '—' }}</td>
              <td class="text-right text-no-wrap">{{ r.total_ms != null ? (r.total_ms / 1000).toFixed(2) + 's' : '—' }}</td>
              <td class="text-right">{{ r.max_tokens ?? '—' }}</td>
              <td class="text-no-wrap">
                <span v-if="r.spec_enabled" class="text-caption">{{ specLabel(r.spec_strategy) }} · {{ hwLabel(r.spec_hardware) }}</span>
                <span v-else class="text-caption text-grey">off</span>
              </td>
              <td class="text-right">
                <v-btn icon size="x-small" variant="text" color="error" title="Delete this run" @click="deleteRun(r.id)">
                  <v-icon size="16">mdi-delete-outline</v-icon>
                </v-btn>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';
import { benchState, runBenchmark as runBench, abortBenchmark as abortBench } from '../bench.js';

export default {
  name: 'Bench',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    status: { isLoaded: false, model: null, isMock: false },
    models: [],
    selectedModel: null,
    loadingModel: false,
    history: [],
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    modelItems() {
      return this.models.map(m => ({ title: m.id, value: m.id }));
    },
    // Benchmark state proxied from the shared store so it persists across navigation.
    benchPrompt: {
      get() { return benchState.benchPrompt; },
      set(v) { benchState.benchPrompt = v; }
    },
    maxTokens: {
      get() { return benchState.maxTokens; },
      set(v) { benchState.maxTokens = v; }
    },
    running() { return benchState.running; },
    benchOutput() { return benchState.benchOutput; },
    results() { return benchState.results; },
    historyDirty() { return benchState.historyDirty; }
  },
  watch: {
    // The store flips historyDirty after persisting a finished run → refresh the table.
    historyDirty(v) {
      if (v) { benchState.historyDirty = false; this.fetchHistory(); }
    }
  },
  async mounted() {
    this.fetchAuth();
    await this.fetchModels();
    await this.fetchStatus();
    this.fetchHistory();
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
    async fetchHistory() {
      try {
        const res = await fetch('/api/admin/bench-runs');
        if (res.ok) this.history = (await res.json()).runs || [];
      } catch (e) {}
    },
    async clearHistory() {
      try {
        const res = await fetch('/api/admin/bench-runs', { method: 'DELETE' });
        if (res.ok) { this.history = []; this.$notify('Benchmark history cleared', 'success'); }
      } catch (e) { this.$notify('Failed to clear', 'error'); }
    },
    async deleteRun(id) {
      try {
        const res = await fetch(`/api/admin/bench-runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.ok) {
          this.history = this.history.filter(r => r.id !== id);
          this.$notify('Run deleted', 'success');
        }
      } catch (e) { this.$notify('Failed to delete run', 'error'); }
    },
    formatTime(ts) {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      return sameDay
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    specLabel(strategy) {
      return { eagle3: 'Eagle-3', speculative: 'Draft + Target' }[strategy] || 'None';
    },
    hwLabel(hw) {
      return { npu: 'NPU', vulkan: 'Mali GPU (Vulkan)', cpu: 'CPU' }[hw] || '—';
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
          this.$notify(data.error || 'Failed to load model', 'error');
          this.selectedModel = this.status.model;
        }
      } catch (e) {
        this.$notify('Network error', 'error');
      } finally {
        this.loadingModel = false;
      }
    },
    runBenchmark() {
      if (!this.status.isLoaded || this.running) return;
      runBench(this.status.model);
    },
    abortBenchmark() {
      abortBench();
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
/* Use available horizontal space on large displays instead of a narrow column */
.page-container {
  max-width: 1400px;
  margin-inline: auto;
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
