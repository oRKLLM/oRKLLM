<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6 fill-height d-flex flex-column" style="height: calc(100vh - 64px);">

      <div class="text-h5 font-weight-bold mb-1">Logs</div>
      <div class="text-caption text-grey mb-4">Real-time server log output via WebSocket.</div>

      <!-- Controls row -->
      <v-card class="glass-card pa-3 mb-4 flex-shrink-0">
        <div class="d-flex align-center gap-3 flex-wrap">
          <!-- Lines selector -->
          <div class="d-flex align-center gap-2">
            <span class="text-caption text-grey">Lines:</span>
            <v-btn-toggle v-model="maxLines" mandatory density="compact" color="primary">
              <v-btn :value="100" size="small">100</v-btn>
              <v-btn :value="500" size="small">500</v-btn>
              <v-btn :value="1000" size="small">1000</v-btn>
              <v-btn :value="0" size="small">All</v-btn>
            </v-btn-toggle>
          </div>

          <v-divider vertical class="mx-1 d-none d-sm-flex"></v-divider>

          <!-- Level filter -->
          <div class="d-flex align-center gap-2">
            <span class="text-caption text-grey">Level:</span>
            <v-btn-toggle v-model="levelFilter" mandatory density="compact">
              <v-btn value="ALL" size="small" color="grey">ALL</v-btn>
              <v-btn value="INFO" size="small" color="blue">INFO</v-btn>
              <v-btn value="WARN" size="small" color="warning">WARN</v-btn>
              <v-btn value="ERROR" size="small" color="error">ERROR</v-btn>
            </v-btn-toggle>
          </div>

          <v-divider vertical class="mx-1 d-none d-sm-flex"></v-divider>

          <!-- Auto-scroll toggle -->
          <v-switch
            v-model="autoScroll"
            label="Auto-scroll"
            density="compact"
            color="primary"
            hide-details
            class="flex-shrink-0"
          ></v-switch>

          <v-spacer></v-spacer>

          <!-- Status indicator -->
          <div class="d-flex align-center gap-2">
            <v-icon :color="wsConnected ? 'success' : 'error'" size="14">mdi-circle</v-icon>
            <span class="text-caption" :class="wsConnected ? 'text-success' : 'text-error'">
              {{ wsConnected ? 'Connected' : 'Disconnected' }}
            </span>
          </div>

          <!-- Clear button -->
          <v-btn size="small" variant="outlined" color="error" prepend-icon="mdi-delete-sweep-outline" @click="clearLogs">
            Clear
          </v-btn>
        </div>
      </v-card>

      <!-- Log output area -->
      <v-card class="glass-card flex-grow-1 d-flex flex-column overflow-hidden">
        <pre
          class="terminal-logs flex-grow-1 pa-4 overflow-y-auto"
          ref="logsContainer"
          style="height: 0;"
        >{{ filteredLogs }}</pre>
      </v-card>

    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'Logs',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    allLogs: [],
    maxLines: 500,
    levelFilter: 'ALL',
    autoScroll: true,
    wsConnected: false,
    logsWs: null,
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    filteredLogs() {
      let lines = this.allLogs;

      // Filter by the PARSED level of each line (not a fragile substring match, which broke on
      // Pino's numeric levels and false-matched any line containing the word "error"/"warn").
      if (this.levelFilter !== 'ALL') {
        const want = this.levelFilter.toLowerCase();
        lines = lines.filter(l => this.lineLevel(l) === want);
      }

      // Limit lines
      if (this.maxLines > 0 && lines.length > this.maxLines) {
        lines = lines.slice(lines.length - this.maxLines);
      }

      return lines.join('\n');
    }
  },
  mounted() {
    this.fetchAuth();
    this.connectWebSocket();
  },
  beforeUnmount() {
    this.disconnectWebSocket();
  },
  watch: {
    filteredLogs() {
      if (this.autoScroll) {
        this.scrollToBottom();
      }
    }
  },
  methods: {
    // Determine a line's log level. Handles both shapes the backend streams: Pino/fastify JSON
    // (a `level` field — numeric 10/20/30/40/50/60 or a text label) and plain console.* lines that
    // the backend prefixes with `[INFO]`/`[WARN]`/`[ERROR]`. Anything else defaults to info.
    lineLevel(line) {
      const s = (line || '').trim();
      if (s.startsWith('{')) {
        try {
          const o = JSON.parse(s);
          if (o && o.level != null) {
            if (typeof o.level === 'number') {
              return { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' }[o.level] || 'info';
            }
            const t = String(o.level).toLowerCase();
            return t === 'fatal' ? 'error' : t;
          }
        } catch { /* not JSON after all — fall through */ }
      }
      const m = /^\[(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]/i.exec(s);
      if (m) { const t = m[1].toLowerCase(); return t === 'fatal' ? 'error' : t; }
      return 'info';
    },
    async fetchAuth() {
      try {
        const res = await fetch('/api/admin/auth-status');
        const data = await res.json();
        if (data.user) this.user = data.user;
        else if (data.username) this.user = { username: data.username, role: 'admin', authProvider: 'local' };
      } catch (e) {}
    },
    connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const url = `${protocol}//${host}/ws/logs`;

      this.logsWs = new WebSocket(url);
      this.logsWs.onopen = () => {
        this.wsConnected = true;
        console.log('[WS] Logs WebSocket connected');
      };
      this.logsWs.onerror = (err) => {
        console.error('[WS] Logs WebSocket error', err);
      };
      this.logsWs.onmessage = (event) => {
        // Split by newlines and push each non-empty line
        const lines = event.data.split('\n').filter(l => l.trim() !== '');
        this.allLogs.push(...lines);
      };
      this.logsWs.onclose = () => {
        this.wsConnected = false;
        console.log('[WS] Logs WebSocket closed, reconnecting in 5s...');
        setTimeout(() => {
          if (!this.logsWs || this.logsWs.readyState === WebSocket.CLOSED) {
            this.connectWebSocket();
          }
        }, 5000);
      };
    },
    disconnectWebSocket() {
      if (this.logsWs) {
        this.logsWs.onclose = null; // Prevent reconnect on intentional close
        this.logsWs.close();
        this.logsWs = null;
      }
    },
    clearLogs() {
      this.allLogs = [];
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const el = this.$refs.logsContainer;
        if (el) el.scrollTop = el.scrollHeight;
      });
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

.v-theme--customLightTheme .terminal-logs {
  background-color: #F8FAFC !important;
  color: #047857 !important;
}

.terminal-logs {
  background-color: #030712 !important;
  color: #10B981 !important;
  font-family: 'Fira Code', 'Courier New', Courier, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: 12px;
}

.gap-3 { gap: 12px; }
.gap-2 { gap: 8px; }
</style>
