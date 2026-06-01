<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6 fill-height align-start">

      <!-- Serving Stats Cards Row -->
      <v-card class="glass-card pa-4 mb-6 w-100">
        <div class="d-flex align-center justify-space-between mb-4 flex-wrap gap-2">
          <div class="text-h6 font-weight-bold d-flex align-center">
            <v-icon start color="primary">mdi-chart-bar</v-icon>
            Serving Statistics
          </div>
          <div class="d-flex align-center gap-2">
            <v-btn-toggle v-model="statsMode" mandatory density="compact" color="primary">
              <v-btn value="session" size="small">Session</v-btn>
              <v-btn value="allTime" size="small">All-Time</v-btn>
            </v-btn-toggle>
            <v-btn size="small" variant="outlined" color="error" @click="clearStats" prepend-icon="mdi-delete-sweep-outline">
              Clear
            </v-btn>
          </div>
        </div>

        <v-row>
          <v-col cols="12" sm="4" md="2">
            <div class="text-caption text-grey">TOTAL REQUESTS</div>
            <div class="text-h5 font-weight-bold">{{ currentStats.totalRequests }}</div>
          </v-col>
          <v-col cols="12" sm="4" md="2.5">
            <div class="text-caption text-grey">PREFILL TOKENS</div>
            <div class="text-h5 font-weight-bold">{{ currentStats.totalPrefillTokens }}</div>
          </v-col>
          <v-col cols="12" sm="4" md="2.5">
            <div class="text-caption text-grey">GENERATED TOKENS</div>
            <div class="text-h5 font-weight-bold">{{ currentStats.totalGeneratedTokens }}</div>
          </v-col>
          <v-col cols="12" sm="6" md="2.5">
            <div class="text-caption text-grey">PROMPT PROCESSING SPEED</div>
            <div class="text-h5 font-weight-bold text-success">{{ promptSpeed }} tok/s</div>
          </v-col>
          <v-col cols="12" sm="6" md="2.5">
            <div class="text-caption text-grey">TOKEN GENERATION SPEED</div>
            <div class="text-h5 font-weight-bold text-primary">{{ generateSpeed }} tok/s</div>
          </v-col>
        </v-row>
      </v-card>

      <v-row class="align-start">

        <!-- Left Side: Telemetry & API Endpoints -->
        <v-col cols="12" md="4" class="d-flex flex-column gap-6">

          <!-- Metrics Panel -->
          <v-card class="glass-card pa-5">
            <div class="text-h6 font-weight-bold mb-4 d-flex align-center">
              <v-icon start color="primary">mdi-chart-line</v-icon>
              Hardware Telemetry
            </div>

            <v-row class="text-center">
              <v-col cols="4" class="py-2">
                <v-progress-circular
                  :model-value="metrics.cpu"
                  :size="80"
                  :width="7"
                  color="blue"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-caption font-weight-bold">{{ metrics.cpu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">CPU</div>
              </v-col>

              <v-col cols="4" class="py-2">
                <v-progress-circular
                  :model-value="metrics.npu"
                  :size="80"
                  :width="7"
                  color="primary"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-caption font-weight-bold">{{ metrics.npu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">NPU</div>
              </v-col>

              <v-col cols="4" class="py-2">
                <v-progress-circular
                  :model-value="metrics.gpu"
                  :size="80"
                  :width="7"
                  color="orange"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-caption font-weight-bold">{{ metrics.gpu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">GPU</div>
              </v-col>

              <v-col cols="4" class="py-2">
                <v-progress-circular
                  :model-value="metrics.ram"
                  :size="80"
                  :width="7"
                  color="teal"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-caption font-weight-bold">{{ metrics.ram }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">RAM</div>
              </v-col>

              <v-col cols="4" class="py-2">
                <v-progress-circular
                  :model-value="metrics.disk"
                  :size="80"
                  :width="7"
                  color="amber"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-caption font-weight-bold">{{ metrics.disk }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">Disk</div>
              </v-col>

              <v-col cols="4" class="py-2">
                <v-progress-circular
                  :model-value="metrics.temp"
                  :size="80"
                  :width="7"
                  color="rose"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-caption font-weight-bold">{{ metrics.temp }}°C</span>
                </v-progress-circular>
                <div class="text-caption text-grey">Temp</div>
              </v-col>
            </v-row>
          </v-card>

          <!-- API Endpoints Panel -->
          <v-card class="glass-card pa-5">
            <div class="text-subtitle-1 font-weight-bold mb-3 d-flex align-center justify-space-between">
              <div class="d-flex align-center">
                <v-icon start color="primary">mdi-api</v-icon>
                API Endpoints
              </div>
              <div style="width: 140px;">
                <v-select
                  v-model="selectedHost"
                  :items="networkAddresses"
                  density="compact"
                  hide-details
                  variant="outlined"
                  class="text-caption"
                ></v-select>
              </div>
            </div>

            <div class="d-flex flex-column gap-3 mt-3">
              <div>
                <div class="text-caption text-grey mb-1">OpenAI API Endpoint</div>
                <div class="d-flex align-center bg-slate-page rounded pa-2 border">
                  <span class="text-caption text-truncate font-mono select-all">http://{{ selectedHost }}:{{ port }}/v1</span>
                  <v-spacer></v-spacer>
                  <v-btn icon size="x-small" variant="text" color="primary" @click="copyToClipboard(`http://${selectedHost}:${port}/v1`)">
                    <v-icon size="16">mdi-content-copy</v-icon>
                  </v-btn>
                </div>
              </div>
              <div>
                <div class="text-caption text-grey mb-1">Base HTTP Server</div>
                <div class="d-flex align-center bg-slate-page rounded pa-2 border">
                  <span class="text-caption text-truncate font-mono select-all">http://{{ selectedHost }}:{{ port }}</span>
                  <v-spacer></v-spacer>
                  <v-btn icon size="x-small" variant="text" color="primary" @click="copyToClipboard(`http://${selectedHost}:${port}`)">
                    <v-icon size="16">mdi-content-copy</v-icon>
                  </v-btn>
                </div>
              </div>
              <div v-if="libPath">
                <div class="text-caption text-grey mb-1">Active NPU SDK Runtime</div>
                <div class="text-caption font-mono text-truncate text-grey bg-slate-page pa-2 rounded border" style="max-width: 100%; overflow-x: auto;">
                  {{ libPath }}
                </div>
              </div>
            </div>
          </v-card>

        </v-col>

        <!-- Right Side: Cache Observability + Runtime Versions -->
        <v-col cols="12" md="8" class="d-flex flex-column gap-6">

          <!-- Prefix Cache Observability -->
          <v-card class="glass-card pa-5">
            <div class="d-flex align-center justify-space-between mb-4">
              <div class="text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-database-eye-outline</v-icon>
                Prefix Cache Observability
              </div>
              <div class="d-flex gap-2">
                <v-btn size="small" variant="tonal" color="error" prepend-icon="mdi-delete-sweep-outline"
                  @click="clearCache" :disabled="!cacheStats.enabled">
                  Clear Cache
                </v-btn>
              </div>
            </div>

            <div v-if="!cacheStats.enabled" class="text-caption text-grey">
              Prefix cache is disabled. Enable it in Settings.
            </div>

            <template v-else>
              <!-- Summary row -->
              <v-row class="mb-4">
                <v-col cols="6" sm="3">
                  <div class="text-caption text-grey">Hot Cache</div>
                  <div class="text-body-1 font-weight-bold">{{ cacheStats.hot?.sizeMB ?? 0 }} MB</div>
                  <div class="text-caption text-grey">/ {{ cacheStats.hot?.limitMB ?? 0 }} MB · {{ cacheStats.hot?.entries ?? 0 }} entries</div>
                </v-col>
                <v-col cols="6" sm="3">
                  <div class="text-caption text-grey">Cold Cache</div>
                  <div class="text-body-1 font-weight-bold">{{ cacheStats.cold?.sizeMB ?? 0 }} MB</div>
                  <div class="text-caption text-grey">/ {{ cacheStats.cold?.limitMB ?? 0 }} MB · {{ cacheStats.cold?.entries ?? 0 }} entries</div>
                </v-col>
                <v-col cols="6" sm="3">
                  <div class="text-caption text-grey">Cache Directory</div>
                  <div class="text-caption font-mono text-truncate" style="max-width: 200px">{{ cacheStats.cacheDir || '—' }}</div>
                </v-col>
                <v-col cols="6" sm="3">
                  <div class="text-caption text-grey">Total Entries</div>
                  <div class="text-body-1 font-weight-bold">{{ (cacheStats.hot?.entries ?? 0) + (cacheStats.cold?.entries ?? 0) }}</div>
                </v-col>
              </v-row>

              <!-- Progress bars -->
              <div class="mb-2">
                <div class="d-flex justify-space-between mb-1">
                  <span class="text-caption">Hot</span>
                  <span class="text-caption">{{ cacheStats.hot?.sizeMB ?? 0 }} / {{ cacheStats.hot?.limitMB ?? 0 }} MB</span>
                </div>
                <v-progress-linear
                  :model-value="cacheStats.hot?.limitMB ? (cacheStats.hot.sizeMB / cacheStats.hot.limitMB) * 100 : 0"
                  color="primary" rounded height="5"
                ></v-progress-linear>
              </div>
              <div>
                <div class="d-flex justify-space-between mb-1">
                  <span class="text-caption">Cold</span>
                  <span class="text-caption">{{ cacheStats.cold?.sizeMB ?? 0 }} / {{ cacheStats.cold?.limitMB ?? 0 }} MB</span>
                </div>
                <v-progress-linear
                  :model-value="cacheStats.cold?.limitMB ? (cacheStats.cold.sizeMB / cacheStats.cold.limitMB) * 100 : 0"
                  color="teal" rounded height="5"
                ></v-progress-linear>
              </div>
            </template>
          </v-card>

          <!-- RKLLM Runtime Versions -->
          <v-card class="glass-card pa-5">
            <div class="text-h6 font-weight-bold mb-4 d-flex align-center justify-space-between">
              <div class="d-flex align-center">
                <v-icon start color="primary">mdi-chip</v-icon>
                RKLLM Runtime Versions
              </div>
              <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-refresh"
                @click="fetchRuntimes">Refresh</v-btn>
            </div>

            <!-- System runtime -->
            <div class="mb-3">
              <div class="text-caption text-grey mb-1">System Runtime ({{ runtimes.systemRuntime?.path || '—' }})</div>
              <v-chip
                :color="runtimes.systemRuntime?.version ? 'primary' : 'grey'"
                variant="tonal"
                size="small"
              >
                {{ runtimes.systemRuntime?.version ? `v${runtimes.systemRuntime.version}` : 'version unknown' }}
              </v-chip>
            </div>

            <!-- Versioned runtimes table -->
            <div v-if="runtimes.runtimes && runtimes.runtimes.length">
              <div class="text-caption text-grey mb-2">Installed in {{ runtimes.runtimesDir }}</div>
              <v-table density="compact" class="text-caption">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in runtimes.runtimes" :key="r.path">
                    <td class="font-mono">{{ r.filename }}</td>
                    <td>
                      <v-chip size="x-small" color="primary" variant="tonal">
                        {{ r.version ? `v${r.version}` : '—' }}
                      </v-chip>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>
            <div v-else class="text-caption text-grey">
              No versioned runtimes installed. Enable auto-download in Settings or place
              <code>librkllmrt-aarch64-vX.Y.Z.so</code> files in the runtimes directory.
            </div>
          </v-card>

        </v-col>

      </v-row>
    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'Dashboard',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    metrics: { cpu: 0, npu: 0, gpu: 0, ram: 0, disk: 0, temp: 0 },
    models: [],
    status: { isLoaded: false, model: null, isMock: false },
    metricsWs: null,
    cacheStats: { enabled: false },
    runtimes: { systemRuntime: null, runtimes: [], runtimesDir: '' },

    // oMLX inspired telemetry stats
    statsMode: 'session',
    stats: {
      session: { totalRequests: 0, totalPrefillTokens: 0, totalGeneratedTokens: 0, totalPrefillTimeMs: 0, totalGenerateTimeMs: 0 },
      allTime: { totalRequests: 0, totalPrefillTokens: 0, totalGeneratedTokens: 0, totalPrefillTimeMs: 0, totalGenerateTimeMs: 0 }
    },
    selectedHost: '127.0.0.1',
    networkAddresses: ['localhost', '127.0.0.1'],
    port: 8000,
    libPath: '',

    // Per-model settings
    modelSettings: {},

    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    currentStats() {
      return this.statsMode === 'session' ? this.stats.session : this.stats.allTime;
    },
    promptSpeed() {
      const s = this.currentStats;
      if (!s || s.totalPrefillTimeMs === 0) return '0.0';
      return (s.totalPrefillTokens / (s.totalPrefillTimeMs / 1000)).toFixed(1);
    },
    generateSpeed() {
      const s = this.currentStats;
      if (!s || s.totalGenerateTimeMs === 0) return '0.0';
      return (s.totalGeneratedTokens / (s.totalGenerateTimeMs / 1000)).toFixed(1);
    }
  },
  mounted() {
    this.fetchAuth();
    this.fetchModels();
    this.fetchStatus();
    this.initWebSockets();
    this.fetchAllModelSettings();
    this.fetchCacheStats();
    this.fetchRuntimes();
  },
  beforeUnmount() {
    if (this.metricsWs) this.metricsWs.close();
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
        if (data.networkAddresses) {
          this.networkAddresses = data.networkAddresses;
          if (!this.networkAddresses.includes(this.selectedHost)) {
            this.selectedHost = this.networkAddresses[0] || '127.0.0.1';
          }
        }
        if (data.port) this.port = data.port;
        if (data.libPath) this.libPath = data.libPath;
      } catch (e) {}
    },
    async clearStats() {
      try {
        const endpoint = this.statsMode === 'session' ? 'clear-session' : 'clear-all';
        const res = await fetch(`/api/admin/stats/${endpoint}`, { method: 'POST' });
        if (res.ok) {
          if (this.statsMode === 'session') {
            this.stats.session = { totalRequests: 0, totalPrefillTokens: 0, totalGeneratedTokens: 0, totalPrefillTimeMs: 0, totalGenerateTimeMs: 0 };
          } else {
            this.stats.allTime = { totalRequests: 0, totalPrefillTokens: 0, totalGeneratedTokens: 0, totalPrefillTimeMs: 0, totalGenerateTimeMs: 0 };
          }
        }
      } catch (e) {}
    },
    copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        alert('Copied to clipboard: ' + text);
      }).catch(() => {
        alert('Failed to copy text');
      });
    },
    async fetchAllModelSettings() {
      try {
        const res = await fetch('/v1/models');
        const data = await res.json();
        const models = data.data || [];
        const all = {};
        await Promise.all(models.map(async (m) => {
          try {
            const r = await fetch(`/api/admin/models/settings/${encodeURIComponent(m.id)}`);
            if (r.ok) {
              const d = await r.json();
              all[m.id] = d.settings || {};
            }
          } catch (e) {}
        }));
        this.modelSettings = all;
      } catch (e) {}
    },
    async fetchCacheStats() {
      try {
        const res = await fetch('/api/admin/global-settings');
        if (!res.ok) return;
        const data = await res.json();
        this.cacheStats = data.cacheStats || { enabled: false };
      } catch (e) {}
    },
    async fetchRuntimes() {
      try {
        const res = await fetch('/api/admin/runtimes');
        if (!res.ok) return;
        this.runtimes = await res.json();
      } catch (e) {}
    },
    async clearCache() {
      try {
        await fetch('/api/admin/cache', { method: 'DELETE' });
        await this.fetchCacheStats();
      } catch (e) {}
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
    },
    initWebSockets() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const metricsUrl = `${protocol}//${host}/ws/metrics`;

      this.metricsWs = new WebSocket(metricsUrl);
      this.metricsWs.onopen = () => console.log('[WS] Metrics WebSocket connected');
      this.metricsWs.onerror = (err) => console.error('[WS] Metrics WebSocket error', err);
      this.metricsWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.metrics.cpu = data.cpu;
          this.metrics.npu = data.npu;
          this.metrics.gpu = data.gpu ?? 0;
          this.metrics.ram = data.ram.percentage;
          this.metrics.disk = data.disk?.percentage ?? 0;
          this.metrics.temp = data.temperature;
          if (data.stats) {
            this.stats = data.stats;
          }
        } catch (e) {}
      };
      this.metricsWs.onclose = () => {
        setTimeout(() => this.initWebSockets(), 5000);
      };
    },
  }
};
</script>

<style scoped>
.bg-slate-page {
  background-color: #0B0F19 !important;
}

.glass-nav {
  background: rgba(17, 24, 39, 0.8) !important;
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(139, 92, 246, 0.15) !important;
}
.v-theme--customLightTheme .glass-nav {
  background: rgba(255, 255, 255, 0.85) !important;
  border-bottom: 1px solid rgba(124, 58, 237, 0.15) !important;
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

.bg-slate-page {
  background: #0B0F19 !important;
}
.v-theme--customLightTheme .bg-slate-page {
  background: #F1F5F9 !important;
}

.text-gradient {
  background: linear-gradient(135deg, #7C3AED 0%, #F43F5E 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.border-bottom {
  border-bottom: 1px solid rgba(139, 92, 246, 0.1) !important;
}

.border-top-dashed {
  border-top: 1px dashed rgba(128, 128, 128, 0.2);
}

.chat-messages-container {
  background: rgba(10, 15, 30, 0.3);
}
.v-theme--customLightTheme .chat-messages-container {
  background: rgba(241, 245, 249, 0.5);
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

/* Pulse dots animation for LLM wait indicator */
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

.gap-4 { gap: 16px; }
.gap-6 { gap: 24px; }
.gap-3 { gap: 12px; }
.gap-2 { gap: 8px; }
</style>

<style>
/* Unscoped global adjustments for code blocks inside messages */
.code-block {
  background: #030712 !important;
  color: #10B981 !important;
  border-left: 3px solid #7C3AED;
  overflow-x: auto;
}
.v-theme--customLightTheme .code-block {
  background: #F1F5F9 !important;
  color: #047857 !important;
}

.inline-code {
  background: #111827 !important;
  color: #F43F5E !important;
}
.v-theme--customLightTheme .inline-code {
  background: #E2E8F0 !important;
  color: #BE123C !important;
}
</style>
