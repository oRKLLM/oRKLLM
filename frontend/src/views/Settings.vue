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
        <v-divider class="my-4"></v-divider>
        <div class="text-subtitle-2 font-weight-medium mb-1">Trusted Proxy</div>
        <div class="text-caption text-grey mb-3">
          Trust <code>X-Forwarded-For</code> / <code>X-Forwarded-Proto</code> headers from a reverse proxy (nginx, Cloudflare, etc.).
          Use <code>true</code> to trust all proxies, or enter one or more IPs, CIDRs, or hostnames separated by commas
          (e.g. <code>10.0.0.1, 10.0.0.2</code> or <code>10.0.0.0/8, 172.16.0.0/12</code>).
          Required when running behind nginx for OIDC/SAML redirect URIs to use the correct scheme.
          Takes effect on next server restart.
        </div>
        <v-text-field
          v-model="settings.trustedProxy"
          label="Trusted Proxy"
          placeholder="false (disabled) | true (all) | 10.0.0.1, 10.0.0.2 | 10.0.0.0/8"
          variant="outlined"
          density="compact"
          hide-details
          class="font-mono"
          style="max-width: 560px;"
        ></v-text-field>
      </v-card>

      <!-- Runtime Auto-Download -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="primary" size="18" class="mr-2">mdi-download-circle-outline</v-icon>
          Runtime Auto-Download
        </div>
        <div class="d-flex align-center justify-space-between">
          <div>
            <div class="text-subtitle-2 font-weight-medium mb-1">Auto-download rkllm runtimes</div>
            <div class="text-caption text-grey">
              Automatically download versioned <code>librkllmrt.so</code> files from
              <a href="https://github.com/mafischer/rkllm-runtimes" target="_blank" class="text-primary">mafischer/rkllm-runtimes</a>
              on startup and when a model with an unknown runtime version is loaded.
              Binaries are Apache 2.0 licensed.
            </div>
          </div>
          <v-switch v-model="settings.autoDownloadRuntimes" color="primary" hide-details density="compact" class="ml-4 flex-shrink-0"></v-switch>
        </div>
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

        <div class="text-subtitle-2 font-weight-medium mb-1">NPU Worker Pool Size</div>
        <div class="text-caption text-grey mb-3">
          Number of concurrent worker processes. The RK3576 NPU allows multiple models to be loaded
          simultaneously — each worker runs independently. With 2 workers, two requests are served
          in parallel: the slower request completes ~38% faster (6.5s wall vs 10.5s sequential) with
          each worker running at slightly reduced throughput. Requires server restart to take effect.
        </div>
        <v-row no-gutters class="align-center mb-4">
          <v-col cols="9">
            <v-slider v-model="settings.npuPoolSize" :min="1" :max="4" :step="1"
              color="primary" density="compact" hide-details></v-slider>
          </v-col>
          <v-col cols="3" class="pl-3">
            <v-chip size="small" class="font-weight-bold">{{ settings.npuPoolSize }} worker{{ settings.npuPoolSize > 1 ? 's' : '' }}</v-chip>
          </v-col>
        </v-row>

        <v-divider class="mb-4"></v-divider>

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

          <div class="text-subtitle-2 font-weight-medium mb-1">KV Cache Compression</div>
          <div class="text-caption text-grey mb-3">
            Quantise saved KV cache files to reduce SSD storage. Compression runs in the background after each response;
            dequantisation (~0.3 ms per MB of context) runs before loading a cache hit. Requires ARM64 with the native addon.
          </div>
          <v-select
            v-model="settings.kvCacheQuant"
            :items="[
              { title: 'Off (FP16 — no compression)', value: 'off' },
              { title: 'Min-Max INT8 (~44% smaller, RMSE 0.05) — GPU accelerated', value: 'q8' },
              { title: 'Polar INT8 (~49% smaller, RMSE 0.06) — GPU accelerated', value: 'pq8' },
              { title: 'Polar INT4 (~74% smaller, RMSE 0.86) — GPU accelerated', value: 'pq4' },
            ]"
            density="compact" variant="outlined" hide-details class="mb-4"
            prepend-inner-icon="mdi-archive-arrow-down-outline"
          ></v-select>

          <v-divider class="mb-4"></v-divider>

          <div class="text-subtitle-2 font-weight-medium mb-1">Sliding Context Window</div>
          <div class="text-caption text-grey mb-2">Oldest non-system messages are dropped when the conversation exceeds this estimated token count. Prevents context overflow on the NPU.</div>
          <v-row no-gutters class="align-center mb-4">
            <v-col cols="9"><v-slider v-model="settings.cacheMaxContextTokens" :min="512" :max="32768" :step="512" color="orange" density="compact" hide-details></v-slider></v-col>
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

      <!-- MCP Servers -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="d-flex align-center justify-space-between mb-3 flex-wrap gap-2">
          <div class="section-heading">
            <v-icon color="primary" size="18" class="mr-2">mdi-toy-brick-outline</v-icon>
            MCP Servers
          </div>
          <v-btn color="primary" variant="tonal" size="small" prepend-icon="mdi-plus" @click="openMcpDialog()">
            Add Server
          </v-btn>
        </div>
        <div class="text-caption text-grey mb-3">
          Connect Model Context Protocol servers to expose their tools to loaded models during chat completions.
          Supports <code>stdio</code> (local command), <code>SSE</code>, and streamable <code>HTTP</code> transports.
        </div>

        <div class="d-flex align-center justify-space-between mb-3">
          <div>
            <div class="text-subtitle-2 font-weight-medium">Use MCP tools in inference</div>
            <div class="text-caption text-grey">Inject enabled servers' tools into <code>/v1/chat/completions</code> and run tool calls automatically.</div>
          </div>
          <v-switch v-model="settings.mcpInferenceEnabled" color="primary" density="compact" hide-details inset></v-switch>
        </div>

        <v-divider class="my-3"></v-divider>

        <div v-if="mcpServers.length === 0" class="text-caption text-grey py-4 text-center">
          No MCP servers configured yet.
        </div>
        <v-table v-else density="comfortable" class="mcp-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Transport</th>
              <th>Endpoint</th>
              <th class="text-center">Enabled</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in mcpServers" :key="s.id">
              <td class="font-weight-medium">{{ s.name }}</td>
              <td><v-chip size="x-small" variant="tonal" color="primary">{{ s.transport }}</v-chip></td>
              <td class="font-mono text-caption text-truncate" style="max-width: 200px;">
                {{ s.transport === 'stdio' ? s.config.command : s.config.url }}
              </td>
              <td class="text-center">
                <v-switch
                  :model-value="s.enabled"
                  color="primary" density="compact" hide-details inset
                  style="display:inline-flex"
                  @update:model-value="toggleMcp(s, $event)"
                ></v-switch>
              </td>
              <td class="text-right text-no-wrap">
                <v-btn icon size="x-small" variant="text" :loading="mcpTesting === s.id" title="Test connection" @click="testMcp(s)">
                  <v-icon size="16">mdi-connection</v-icon>
                </v-btn>
                <v-btn icon size="x-small" variant="text" color="primary" title="Edit" @click="openMcpDialog(s)">
                  <v-icon size="16">mdi-pencil-outline</v-icon>
                </v-btn>
                <v-btn icon size="x-small" variant="text" color="error" title="Delete" @click="deleteMcp(s)">
                  <v-icon size="16">mdi-delete-outline</v-icon>
                </v-btn>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <!-- MCP add/edit dialog -->
      <v-dialog v-model="mcpDialog" max-width="560">
        <v-card class="glass-card">
          <v-card-title class="pa-5 pb-2 text-h6 font-weight-bold d-flex align-center">
            <v-icon start color="primary">mdi-toy-brick-outline</v-icon>
            {{ mcpForm.id ? 'Edit MCP Server' : 'Add MCP Server' }}
          </v-card-title>
          <v-card-text class="pa-5">
            <v-text-field v-model="mcpForm.name" label="Name" variant="outlined" density="compact" class="mb-3" hide-details="auto"></v-text-field>
            <v-select
              v-model="mcpForm.transport"
              :items="[{title:'stdio (local command)',value:'stdio'},{title:'SSE',value:'sse'},{title:'Streamable HTTP',value:'http'}]"
              item-title="title" item-value="value"
              label="Transport" variant="outlined" density="compact" class="mb-3" hide-details
            ></v-select>

            <template v-if="mcpForm.transport === 'stdio'">
              <v-text-field v-model="mcpForm.command" label="Command" placeholder="npx" variant="outlined" density="compact" class="mb-3 font-mono" hide-details="auto"></v-text-field>
              <v-text-field v-model="mcpForm.argsText" label="Arguments (space-separated)" placeholder="-y @modelcontextprotocol/server-filesystem /tmp" variant="outlined" density="compact" class="mb-3 font-mono" hide-details="auto"></v-text-field>
              <v-textarea v-model="mcpForm.envText" label="Environment (KEY=value per line)" variant="outlined" density="compact" rows="2" class="mb-1 font-mono" hide-details="auto"></v-textarea>
            </template>
            <template v-else>
              <v-text-field v-model="mcpForm.url" label="URL" placeholder="https://host/mcp" variant="outlined" density="compact" class="mb-3 font-mono" hide-details="auto"></v-text-field>
              <v-textarea v-model="mcpForm.headersText" label="Headers (Key: value per line)" placeholder="Authorization: Bearer ..." variant="outlined" density="compact" rows="2" class="mb-1 font-mono" hide-details="auto"></v-textarea>
            </template>

            <div v-if="mcpError" class="text-error text-caption mt-3">{{ mcpError }}</div>
            <div v-if="mcpTestResult" :class="['text-caption mt-3', mcpTestResult.ok ? 'text-success' : 'text-error']">
              <template v-if="mcpTestResult.ok">
                Connected — {{ mcpTestResult.tools.length }} tool(s){{ mcpTestResult.tools.length ? ': ' + mcpTestResult.tools.map(t => t.name).join(', ') : '' }}
              </template>
              <template v-else>Failed: {{ mcpTestResult.error }}</template>
            </div>
          </v-card-text>
          <v-card-actions class="pa-5 pt-0 justify-end gap-2">
            <v-btn variant="text" color="grey" @click="mcpDialog = false">Cancel</v-btn>
            <v-btn variant="text" color="primary" :loading="mcpDialogTesting" @click="testMcpForm">Test</v-btn>
            <v-btn variant="flat" color="primary" :loading="mcpSaving" @click="saveMcp">Save</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

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
      npuPoolSize: 1,
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
      cacheMaxContextTokens: 8192,
      kvCacheQuant: 'off',
      trustedProxy: '',
      autoDownloadRuntimes: true,
      savedAutoDownloadRuntimes: true,
      mcpInferenceEnabled: false,
    },
    cacheStats: null,
    clearingCache: false,
    passwordForm: { current: '', next: '', confirm: '' },
    passwordError: '',
    passwordSaving: false,
    saving: false,
    hfTokenSaving: false,
    showHfToken: false,
    // MCP servers
    mcpServers: [],
    mcpDialog: false,
    mcpSaving: false,
    mcpDialogTesting: false,
    mcpTesting: null,
    mcpError: '',
    mcpTestResult: null,
    mcpForm: { id: null, name: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '' },
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
    this.fetchMcpServers();
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
        this.settings.npuPoolSize         = s.npuPoolSize         ?? 1;
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
        this.settings.cacheMaxContextTokens = s.cacheMaxContextTokens ?? 8192;
        this.settings.kvCacheQuant          = s.kvCacheQuant ?? 'off';
        this.settings.trustedProxy          = s.trustedProxy ?? '';
        this.settings.autoDownloadRuntimes  = s.autoDownloadRuntimes ?? true;
        this.savedAutoDownloadRuntimes       = this.settings.autoDownloadRuntimes;
        this.settings.mcpInferenceEnabled   = s.mcpInferenceEnabled ?? false;
        this.cacheStats = data.cacheStats || null;
      } catch (e) {}
    },

    // ── MCP servers ─────────────────────────────────────────────────────────
    async fetchMcpServers() {
      try {
        const res = await fetch('/api/admin/mcp-servers');
        if (res.ok) this.mcpServers = (await res.json()).servers || [];
      } catch (e) {}
    },
    openMcpDialog(server = null) {
      this.mcpError = '';
      this.mcpTestResult = null;
      if (server) {
        const c = server.config || {};
        this.mcpForm = {
          id: server.id,
          name: server.name,
          transport: server.transport,
          command: c.command || '',
          argsText: Array.isArray(c.args) ? c.args.join(' ') : '',
          envText: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
          url: c.url || '',
          headersText: Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
        };
      } else {
        this.mcpForm = { id: null, name: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '' };
      }
      this.mcpDialog = true;
    },
    // Build { transport, config } from the dialog's free-text fields.
    mcpFormToPayload() {
      const f = this.mcpForm;
      const config = {};
      if (f.transport === 'stdio') {
        config.command = f.command.trim();
        config.args = f.argsText.trim() ? f.argsText.trim().split(/\s+/) : [];
        config.env = {};
        for (const line of f.envText.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) config.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      } else {
        config.url = f.url.trim();
        config.headers = {};
        for (const line of f.headersText.split('\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) config.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      return { name: f.name.trim(), transport: f.transport, config };
    },
    async testMcpForm() {
      this.mcpError = '';
      this.mcpTestResult = null;
      this.mcpDialogTesting = true;
      try {
        const res = await fetch('/api/admin/mcp-servers/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.mcpFormToPayload()),
        });
        const data = await res.json();
        if (res.ok) this.mcpTestResult = data;
        else this.mcpError = data.error || 'Validation failed';
      } catch (e) {
        this.mcpError = 'Network error';
      } finally {
        this.mcpDialogTesting = false;
      }
    },
    async saveMcp() {
      this.mcpError = '';
      const payload = this.mcpFormToPayload();
      if (!payload.name) { this.mcpError = 'Name is required.'; return; }
      this.mcpSaving = true;
      try {
        const editing = !!this.mcpForm.id;
        const url = editing ? `/api/admin/mcp-servers/${this.mcpForm.id}` : '/api/admin/mcp-servers';
        const res = await fetch(url, {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, validate: false }),
        });
        if (res.ok) {
          this.mcpDialog = false;
          this.notify(editing ? 'MCP server updated' : 'MCP server added', 'success');
          await this.fetchMcpServers();
        } else {
          const d = await res.json();
          this.mcpError = d.error || 'Failed to save';
        }
      } catch (e) {
        this.mcpError = 'Network error';
      } finally {
        this.mcpSaving = false;
      }
    },
    async toggleMcp(server, enabled) {
      try {
        const res = await fetch(`/api/admin/mcp-servers/${server.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        if (res.ok) { await this.fetchMcpServers(); }
        else this.notify('Failed to update server', 'error');
      } catch (e) { this.notify('Network error', 'error'); }
    },
    async testMcp(server) {
      this.mcpTesting = server.id;
      try {
        const res = await fetch(`/api/admin/mcp-servers/${server.id}/test`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) this.notify(`${server.name}: ${data.tools.length} tool(s) available`, 'success');
        else this.notify(`${server.name}: ${data.error}`, 'error');
      } catch (e) {
        this.notify('Network error', 'error');
      } finally {
        this.mcpTesting = null;
      }
    },
    async deleteMcp(server) {
      try {
        const res = await fetch(`/api/admin/mcp-servers/${server.id}`, { method: 'DELETE' });
        if (res.ok) { this.notify('MCP server deleted', 'success'); await this.fetchMcpServers(); }
        else this.notify('Failed to delete', 'error');
      } catch (e) { this.notify('Network error', 'error'); }
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
      const wasAutoDownloadOff = !this.savedAutoDownloadRuntimes;
      const isNowOn = this.settings.autoDownloadRuntimes;

      this.saving = true;
      try {
        const res = await fetch('/api/admin/global-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.settings),
        });
        if (res.ok) {
          this.savedAutoDownloadRuntimes = this.settings.autoDownloadRuntimes;
          this.notify('Settings saved', 'success');
          // Trigger immediate sync if auto-download was just enabled
          if (wasAutoDownloadOff && isNowOn) {
            fetch('/api/admin/runtimes/sync', { method: 'POST' }).catch(() => {});
          }
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
