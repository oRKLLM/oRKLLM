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

      <!-- Snackbar -->
      <v-snackbar v-model="snackbar.show" :color="snackbar.color" location="bottom right" :timeout="3000">
        {{ snackbar.text }}
      </v-snackbar>

      <div class="text-h5 font-weight-bold mb-1">Global Settings</div>
      <div class="text-caption text-grey mb-6">Server configuration and inference defaults for oRKLLM.</div>

      <!-- Server Info -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="primary" size="18" class="mr-2">mdi-server-outline</v-icon>
          Server
        </div>
        <v-row>
          <v-col cols="12" sm="6">
            <div class="setting-label">Host</div>
            <div class="setting-value font-mono">{{ serverInfo.host || '—' }}</div>
          </v-col>
          <v-col cols="12" sm="6">
            <div class="setting-label">Port</div>
            <div class="setting-value font-mono">{{ serverInfo.port || '—' }}</div>
          </v-col>
          <v-col cols="12">
            <div class="setting-label">NPU Library Path</div>
            <div class="setting-value font-mono text-truncate">{{ serverInfo.libPath || '—' }}</div>
          </v-col>
          <v-col cols="12">
            <div class="setting-label">Models Directory</div>
            <div class="setting-value font-mono text-truncate">{{ serverInfo.modelsDir || '—' }}</div>
          </v-col>
        </v-row>
        <v-alert type="info" variant="tonal" density="compact" class="mt-3 text-caption">
          Host, Port, and paths are configured via environment variables and require a server restart to change.
        </v-alert>
      </v-card>

      <!-- Authentication -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="primary" size="18" class="mr-2">mdi-shield-account-outline</v-icon>
          Authentication
        </div>
        <div class="setting-label mb-2">Signed in as <span class="font-weight-bold text-white">{{ user.username }}</span></div>
        <v-divider class="my-4"></v-divider>
        <div class="text-subtitle-2 font-weight-medium mb-3">Change Password</div>
        <v-row>
          <v-col cols="12" sm="4">
            <v-text-field
              v-model="passwordForm.current"
              label="Current password"
              type="password"
              density="compact"
              variant="outlined"
              hide-details
            ></v-text-field>
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field
              v-model="passwordForm.next"
              label="New password"
              type="password"
              density="compact"
              variant="outlined"
              hide-details
            ></v-text-field>
          </v-col>
          <v-col cols="12" sm="4">
            <v-text-field
              v-model="passwordForm.confirm"
              label="Confirm new password"
              type="password"
              density="compact"
              variant="outlined"
              hide-details
              :error="passwordForm.next !== passwordForm.confirm && passwordForm.confirm !== ''"
            ></v-text-field>
          </v-col>
        </v-row>
        <div v-if="passwordError" class="text-error text-caption mt-2">{{ passwordError }}</div>
        <v-btn
          class="mt-4"
          color="primary"
          variant="tonal"
          size="small"
          :loading="passwordSaving"
          :disabled="!passwordForm.current || !passwordForm.next || passwordForm.next !== passwordForm.confirm"
          @click="changePassword"
        >
          Update Password
        </v-btn>
      </v-card>

      <!-- HuggingFace -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="primary" size="18" class="mr-2">mdi-robot-happy-outline</v-icon>
          HuggingFace
        </div>
        <div class="text-caption text-grey mb-4">
          Used for downloading models from private or gated HuggingFace repositories via the Models Downloader.
        </div>
        <v-row>
          <v-col cols="12" sm="8">
            <v-text-field
              v-model="settings.hfToken"
              label="HuggingFace Token"
              :type="showHfToken ? 'text' : 'password'"
              density="compact"
              variant="outlined"
              hide-details
              :append-inner-icon="showHfToken ? 'mdi-eye-off' : 'mdi-eye'"
              @click:append-inner="showHfToken = !showHfToken"
              placeholder="hf_..."
            ></v-text-field>
          </v-col>
          <v-col cols="12" sm="4" class="d-flex align-center">
            <v-btn
              color="primary"
              variant="tonal"
              size="small"
              :loading="hfTokenSaving"
              @click="saveHfToken"
              prepend-icon="mdi-content-save-outline"
            >
              Save Token
            </v-btn>
          </v-col>
        </v-row>
      </v-card>

      <!-- Model Management -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="primary" size="18" class="mr-2">mdi-chip</v-icon>
          Model Management
        </div>

        <div class="text-subtitle-2 font-weight-medium mb-1">Inactivity Auto-Unload Timeout</div>
        <div class="text-caption text-grey mb-3">Automatically unload the active model after this period of inactivity. Per-model TTL overrides this.</div>
        <v-row no-gutters class="align-center mb-1">
          <v-col cols="9">
            <v-slider
              v-model="settings.idleTimeoutMinutes"
              :min="0"
              :max="120"
              :step="5"
              color="primary"
              density="compact"
              hide-details
            ></v-slider>
          </v-col>
          <v-col cols="3" class="pl-3">
            <v-chip size="small" class="font-weight-bold">
              {{ settings.idleTimeoutMinutes === 0 ? 'Disabled' : `${settings.idleTimeoutMinutes} min` }}
            </v-chip>
          </v-col>
        </v-row>
      </v-card>

      <!-- Prefix Cache -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="primary" size="18" class="mr-2">mdi-lightning-bolt-outline</v-icon>
          Prefix Cache
        </div>
        <div class="text-caption text-grey mb-4">
          Saves KV cache state to disk after each response. On subsequent turns the model skips re-processing the conversation prefix, reducing prefill time significantly.
        </div>

        <div class="d-flex align-center mb-4">
          <v-switch v-model="settings.cacheEnabled" color="primary" hide-details density="compact" class="mr-3"></v-switch>
          <div>
            <div class="text-subtitle-2 font-weight-medium">Enable prefix cache</div>
            <div class="text-caption text-grey">Requires a restart of any active model to take effect</div>
          </div>
        </div>

        <template v-if="settings.cacheEnabled">
          <v-divider class="mb-4"></v-divider>

          <div class="text-subtitle-2 font-weight-medium mb-1">Hot Cache Limit (RAM-speed storage)</div>
          <div class="text-caption text-grey mb-2">Most-recently-used cache files kept here for lowest latency. Uses fast local SSD or tmpfs.</div>
          <v-row no-gutters class="align-center mb-4">
            <v-col cols="9"><v-slider v-model="settings.cacheHotLimitMB" :min="0" :max="8192" :step="128" color="primary" density="compact" hide-details></v-slider></v-col>
            <v-col cols="3" class="pl-3"><v-chip size="small" class="font-weight-bold">{{ settings.cacheHotLimitMB === 0 ? 'Disabled' : formatMB(settings.cacheHotLimitMB) }}</v-chip></v-col>
          </v-row>

          <div class="text-subtitle-2 font-weight-medium mb-1">Cold Cache Limit (SSD)</div>
          <div class="text-caption text-grey mb-2">Evicted hot-cache entries are demoted here. Files promoted back to hot on next access.</div>
          <v-row no-gutters class="align-center mb-4">
            <v-col cols="9"><v-slider v-model="settings.cacheColdLimitMB" :min="0" :max="102400" :step="1024" color="teal" density="compact" hide-details></v-slider></v-col>
            <v-col cols="3" class="pl-3"><v-chip size="small" class="font-weight-bold">{{ settings.cacheColdLimitMB === 0 ? 'Disabled' : formatMB(settings.cacheColdLimitMB) }}</v-chip></v-col>
          </v-row>

          <div class="text-subtitle-2 font-weight-medium mb-1">Cache Directory</div>
          <div class="text-caption text-grey mb-2">Where hot/ and cold/ subdirectories are stored. Default: ~/.config/orkllm/cache</div>
          <v-text-field v-model="settings.cacheDir" density="compact" variant="outlined" hide-details placeholder="~/.config/orkllm/cache" class="mb-4 font-mono" prepend-inner-icon="mdi-folder-outline"></v-text-field>

          <v-divider class="mb-4"></v-divider>

          <div class="text-subtitle-2 font-weight-medium mb-1">Sliding Context Window</div>
          <div class="text-caption text-grey mb-2">Oldest non-system messages are dropped when the conversation exceeds this estimated token count. Prevents context overflow on the NPU.</div>
          <v-row no-gutters class="align-center mb-4">
            <v-col cols="9"><v-slider v-model="settings.cacheMaxContextTokens" :min="512" :max="4096" :step="128" color="orange" density="compact" hide-details></v-slider></v-col>
            <v-col cols="3" class="pl-3"><v-chip size="small" class="font-weight-bold">{{ settings.cacheMaxContextTokens }} tok</v-chip></v-col>
          </v-row>

          <v-divider class="mb-4"></v-divider>

          <div class="text-subtitle-2 font-weight-medium mb-2">Cache Status</div>
          <div v-if="cacheStats" class="d-flex gap-3 flex-wrap mb-3">
            <v-chip size="small" prepend-icon="mdi-fire">Hot: {{ cacheStats.hot?.entries ?? 0 }} entries · {{ cacheStats.hot?.sizeMB ?? 0 }} MB</v-chip>
            <v-chip size="small" prepend-icon="mdi-snowflake">Cold: {{ cacheStats.cold?.entries ?? 0 }} entries · {{ cacheStats.cold?.sizeMB ?? 0 }} MB</v-chip>
          </div>
          <v-btn size="small" variant="outlined" color="error" prepend-icon="mdi-delete-sweep-outline" :loading="clearingCache" @click="clearCache">
            Clear All Cache
          </v-btn>
        </template>
      </v-card>

      <!-- Generation Defaults -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-1">
          <v-icon color="primary" size="18" class="mr-2">mdi-tune-variant</v-icon>
          Generation Defaults
        </div>
        <div class="text-caption text-grey mb-4">Applied to requests that don't specify these parameters. Per-model settings override these.</div>

        <v-row>
          <v-col cols="12" sm="6">
            <div class="setting-label mb-1">Temperature <span class="text-grey">(0 = deterministic, 2 = max random)</span></div>
            <div class="d-flex align-center gap-3">
              <v-slider v-model="settings.temperature" min="0" max="2" step="0.05" color="primary" density="compact" hide-details class="flex-grow-1"></v-slider>
              <div style="width: 60px; flex-shrink: 0;">
                <v-text-field v-model.number="settings.temperature" type="number" density="compact" variant="outlined" hide-details min="0" max="2" step="0.05"></v-text-field>
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6">
            <div class="setting-label mb-1">Top P <span class="text-grey">(nucleus sampling threshold)</span></div>
            <div class="d-flex align-center gap-3">
              <v-slider v-model="settings.topP" min="0" max="1" step="0.05" color="primary" density="compact" hide-details class="flex-grow-1"></v-slider>
              <div style="width: 60px; flex-shrink: 0;">
                <v-text-field v-model.number="settings.topP" type="number" density="compact" variant="outlined" hide-details min="0" max="1" step="0.05"></v-text-field>
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6">
            <div class="setting-label mb-1">Top K <span class="text-grey">(0 = disabled)</span></div>
            <div class="d-flex align-center gap-3">
              <v-slider v-model="settings.topK" min="0" max="100" step="1" color="primary" density="compact" hide-details class="flex-grow-1"></v-slider>
              <div style="width: 60px; flex-shrink: 0;">
                <v-text-field v-model.number="settings.topK" type="number" density="compact" variant="outlined" hide-details min="0" max="100"></v-text-field>
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6">
            <div class="setting-label mb-1">Max New Tokens</div>
            <div class="d-flex align-center gap-3">
              <v-slider v-model="settings.maxNewTokens" min="128" max="8192" step="128" color="primary" density="compact" hide-details class="flex-grow-1"></v-slider>
              <div style="width: 60px; flex-shrink: 0;">
                <v-text-field v-model.number="settings.maxNewTokens" type="number" density="compact" variant="outlined" hide-details min="128" max="8192"></v-text-field>
              </div>
            </div>
          </v-col>
          <v-col cols="12" sm="6">
            <div class="setting-label mb-1">Repetition Penalty <span class="text-grey">(1.0 = disabled)</span></div>
            <div class="d-flex align-center gap-3">
              <v-slider v-model="settings.repPenalty" min="1" max="2" step="0.05" color="primary" density="compact" hide-details class="flex-grow-1"></v-slider>
              <div style="width: 60px; flex-shrink: 0;">
                <v-text-field v-model.number="settings.repPenalty" type="number" density="compact" variant="outlined" hide-details min="1" max="2" step="0.05"></v-text-field>
              </div>
            </div>
          </v-col>
        </v-row>
      </v-card>

      <!-- Save -->
      <div class="d-flex justify-end mb-8">
        <v-btn color="primary" variant="flat" size="large" :loading="saving" @click="saveSettings" prepend-icon="mdi-content-save-outline">
          Save Settings
        </v-btn>
      </div>

    </v-container>
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'Settings',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    serverInfo: {},
    settings: {
      idleTimeoutMinutes: 5,
      temperature: 0.8,
      topP: 0.9,
      topK: 40,
      maxNewTokens: 512,
      repPenalty: 1.0,
      hfToken: '',
      cacheEnabled: false,
      cacheHotLimitMB: 512,
      cacheColdLimitMB: 10240,
      cacheDir: '',
      cacheMaxContextTokens: 3500,
    },
    cacheStats: null,
    clearingCache: false,
    passwordForm: { current: '', next: '', confirm: '' },
    passwordError: '',
    passwordSaving: false,
    saving: false,
    hfTokenSaving: false,
    showHfToken: false,
    snackbar: { show: false, text: '', color: 'success' },
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    }
  },
  mounted() {
    this.fetchAuth();
    this.fetchSettings();
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
    async fetchSettings() {
      try {
        const res = await fetch('/api/admin/global-settings');
        if (!res.ok) return;
        const data = await res.json();
        this.serverInfo = data.server || {};
        const s = data.settings || {};
        this.settings.idleTimeoutMinutes = s.idleTimeoutMinutes ?? 5;
        this.settings.temperature = s.temperature ?? 0.8;
        this.settings.topP = s.topP ?? 0.9;
        this.settings.topK = s.topK ?? 40;
        this.settings.maxNewTokens = s.maxNewTokens ?? 512;
        this.settings.repPenalty = s.repPenalty ?? 1.0;
        this.settings.hfToken = s.hfToken ?? '';
        this.settings.cacheEnabled          = s.cacheEnabled ?? false;
        this.settings.cacheHotLimitMB       = s.cacheHotLimitMB ?? 512;
        this.settings.cacheColdLimitMB      = s.cacheColdLimitMB ?? 10240;
        this.settings.cacheDir              = s.cacheDir ?? '';
        this.settings.cacheMaxContextTokens = s.cacheMaxContextTokens ?? 3500;
        this.cacheStats = data.cacheStats || null;
      } catch (e) {}
    },
    formatMB(mb) {
      if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
      return mb + ' MB';
    },
    async clearCache() {
      this.clearingCache = true;
      try {
        await fetch('/api/admin/cache', { method: 'DELETE' });
        this.notify('Cache cleared', 'success');
        await this.fetchSettings();
      } catch (e) {
        this.notify('Failed to clear cache', 'error');
      } finally {
        this.clearingCache = false;
      }
    },
    async saveSettings() {
      this.saving = true;
      try {
        const res = await fetch('/api/admin/global-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.settings)
        });
        if (res.ok) {
          this.notify('Settings saved', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to save settings', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.saving = false;
      }
    },
    async saveHfToken() {
      this.hfTokenSaving = true;
      try {
        const res = await fetch('/api/admin/global-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hfToken: this.settings.hfToken })
        });
        if (res.ok) {
          this.notify('HuggingFace token saved', 'success');
        } else {
          const d = await res.json();
          this.notify(d.error || 'Failed to save token', 'error');
        }
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.hfTokenSaving = false;
      }
    },
    async changePassword() {
      this.passwordError = '';
      if (this.passwordForm.next.length < 6) {
        this.passwordError = 'New password must be at least 6 characters.';
        return;
      }
      this.passwordSaving = true;
      try {
        const res = await fetch('/api/admin/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentPassword: this.passwordForm.current,
            newPassword: this.passwordForm.next
          })
        });
        if (res.ok) {
          this.passwordForm = { current: '', next: '', confirm: '' };
          this.notify('Password updated successfully', 'success');
        } else {
          const d = await res.json();
          this.passwordError = d.error || 'Failed to update password';
        }
      } catch (e) {
        this.passwordError = 'Network error';
      } finally {
        this.passwordSaving = false;
      }
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
    notify(text, color = 'success') {
      this.snackbar = { show: true, text, color };
    }
  }
};
</script>

<style scoped>
.bg-slate-page {
  background-color: #0B0F19 !important;
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

.text-gradient {
  background: linear-gradient(135deg, #7C3AED 0%, #F43F5E 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.section-heading {
  font-size: 0.875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(139, 92, 246, 0.9);
  display: flex;
  align-items: center;
}

.setting-label {
  font-size: 0.75rem;
  color: rgba(156, 163, 175, 1);
  margin-bottom: 2px;
}

.setting-value {
  font-size: 0.875rem;
  color: rgba(229, 231, 235, 1);
  background: rgba(3, 7, 18, 0.4);
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(75, 85, 99, 0.3);
}

.font-mono {
  font-family: 'Fira Code', 'Courier New', monospace;
}

.gap-3 { gap: 12px; }
</style>
