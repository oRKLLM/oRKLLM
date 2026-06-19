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

      <!-- Snackbar -->
      <v-snackbar v-model="snackbar.show" :color="snackbar.color" location="bottom right" :timeout="3000">
        {{ snackbar.text }}
      </v-snackbar>

      <div class="text-h5 font-weight-bold mb-1">Global Settings</div>
      <div class="text-caption text-grey mb-6">Server configuration and inference defaults for oRKLLM.</div>

      <!-- Cards flow into 2 masonry columns on wide screens (single column below lg).
           Each card stays intact (break-inside: avoid); the MCP card spans full width. -->
      <div class="settings-masonry">

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
        <v-divider class="my-3"></v-divider>
        <div class="d-flex align-center justify-space-between">
          <div>
            <div class="text-subtitle-2 font-weight-medium mb-1">Auto performance governor</div>
            <div class="text-caption text-grey">
              While a model is loaded, pin the CPU cores and the DDR memory controller (<code>dmc</code>) to
              <code>performance</code>, restoring the board defaults when idle. Decode is memory-bandwidth-bound, so a
              DDR clock parked low by the stock governor can roughly <strong>halve token-generation speed</strong>.
              Requires privileges to write the governor sysfs nodes (RK3576/RK3588 only; no effect elsewhere).
            </div>
          </div>
          <v-switch v-model="settings.managePerformance" color="primary" hide-details density="compact" class="ml-4 flex-shrink-0"></v-switch>
        </div>
      </v-card>

      <!-- Llama Runtime (libllama.so + ggml-ork for .gguf serving) -->
      <v-card class="glass-card pa-5 mb-5">
        <div class="section-heading mb-4">
          <v-icon color="teal" size="18" class="mr-2">mdi-lightning-bolt</v-icon>
          Llama Runtime (Open NPU)
        </div>
        <div class="d-flex align-center justify-space-between mb-3">
          <div>
            <div class="text-subtitle-2 font-weight-medium mb-1">Auto-download llama runtime</div>
            <div class="text-caption text-grey">
              Downloads <code>libllama.so</code> + <code>libggml-ork.so</code> (the open NPU backend built from
              <a href="https://github.com/oRKLLM/llama.cpp-rockchip" target="_blank" class="text-primary">llama.cpp-rockchip</a>)
              from <a href="https://github.com/oRKLLM/llama.cpp-rockchip" target="_blank" class="text-primary">oRKLLM/llama.cpp-rockchip</a>.
              Required to load <code>.gguf</code> models. ARM64 (board) only.
            </div>
          </div>
          <v-switch :model-value="settings.autoDownloadLlamaRuntime" @update:model-value="onToggleAutoLlama" color="teal" hide-details density="compact" class="ml-4 flex-shrink-0"></v-switch>
        </div>
        <v-divider class="my-3"></v-divider>
        <div class="d-flex align-center gap-3 flex-wrap">
          <v-chip size="small" :color="llamaRuntime.available ? 'success' : 'grey'" variant="tonal">
            <v-icon start size="14">{{ llamaRuntime.available ? 'mdi-check-circle' : 'mdi-close-circle' }}</v-icon>
            {{ llamaRuntime.available
              ? `Installed: llama.cpp ${llamaRuntime.tag || llamaRuntime.llamaVersion || '?'}` + (llamaRuntime.orkDriverVersion ? ` / ork-driver ${llamaRuntime.orkDriverVersion}` : '')
              : 'Not installed' }}
          </v-chip>
          <v-select
            v-model="llamaSelectedTag"
            :items="llamaReleases.map((r, i) => ({ title: llamaReleaseLabel(r, i), value: r.tag }))"
            label="Release" placeholder="latest"
            density="compact" variant="outlined" hide-details
            style="min-width: 180px; max-width: 260px;"
            :no-data-text="'No releases found — the mirror may not have a release yet'"
          ></v-select>
          <v-btn size="small" variant="tonal" color="teal" :loading="llamaSyncing"
            prepend-icon="mdi-download" @click="downloadLlama">
            {{ llamaRuntime.available ? 'Sync / update' : 'Download' }}
          </v-btn>
        </div>
      </v-card>

      <!-- llama.cpp license acceptance (gates llama runtime download / auto-download) -->
      <v-dialog v-model="llamaLicense.open" max-width="660" persistent scrollable>
        <v-card class="glass-card">
          <v-card-title class="pa-5 pb-2 text-h6 font-weight-bold d-flex align-center">
            <v-icon start color="teal">mdi-license</v-icon>
            llama.cpp License
          </v-card-title>
          <v-card-text class="pa-5 pt-2">
            <div class="text-caption text-grey mb-3">
              The llama runtime is built from the
              <a href="https://github.com/ggml-org/llama.cpp" target="_blank" class="text-primary">llama.cpp project (ggml-org/llama.cpp)</a>{{ llamaLicense.source ? `, mirrored at ${llamaLicense.source}` : '' }}.
              Please read and accept their license to continue. Scroll to the bottom to enable <strong>Accept</strong>.
            </div>
            <pre ref="llamaLicenseBox" class="license-box" @scroll="onLlamaLicenseScroll">{{ llamaLicense.text || 'Loading license…' }}</pre>
          </v-card-text>
          <v-card-actions class="pa-5 pt-0 justify-end gap-2">
            <v-btn variant="text" color="grey" @click="declineLlamaLicense">Decline</v-btn>
            <v-btn variant="flat" color="teal" :disabled="!llamaLicense.scrolledToBottom" @click="acceptLlamaLicense">Accept</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

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
          Number of concurrent worker processes, each loading its own model in parallel. With more than
          one worker each model is pinned to its own NPU core, so the maximum is the chipset's core count
          (<strong>RK3576 = 2, RK3588 = 3</strong>). A single worker stays unpinned and uses all cores for
          maximum single-model throughput. Requires server restart to take effect.
          <span v-if="serverInfo.npuCores">
            Detected: <strong>{{ serverInfo.platform || 'unknown platform' }}</strong>,
            {{ serverInfo.npuCores }} NPU core{{ serverInfo.npuCores > 1 ? 's' : '' }} (max).
          </span>
        </div>
        <v-row no-gutters class="align-center mb-4">
          <v-col cols="9">
            <v-slider v-model="settings.npuPoolSize" :min="1" :max="serverInfo.npuCores || 4" :step="1"
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
          <div class="text-caption text-grey mb-2">Most-recently-used cache files kept here for lowest latency. Uses fast local SSD or tmpfs. Max {{ formatMB(hotCacheMaxMB) }} (50% of {{ serverInfo.ramTotalMB ? formatMB(serverInfo.ramTotalMB) : 'RAM' }}).</div>
          <v-row no-gutters class="align-center mb-4">
            <v-col cols="9"><v-slider v-model="settings.cacheHotLimitMB" :min="0" :max="hotCacheMaxMB" :step="128" color="primary" density="compact" hide-details></v-slider></v-col>
            <v-col cols="3" class="pl-3"><v-chip size="small" class="font-weight-bold">{{ settings.cacheHotLimitMB === 0 ? 'Disabled' : formatMB(settings.cacheHotLimitMB) }}</v-chip></v-col>
          </v-row>

          <div class="text-subtitle-2 font-weight-medium mb-1">Cold Cache Limit (SSD)</div>
          <div class="text-caption text-grey mb-2">Evicted hot-cache entries are demoted here. Files promoted back to hot on next access. Max {{ formatMB(coldCacheMaxMB) }} (80% of {{ serverInfo.diskTotalMB ? formatMB(serverInfo.diskTotalMB) : 'disk' }}).</div>
          <v-row no-gutters class="align-center mb-4">
            <v-col cols="9"><v-slider v-model="settings.cacheColdLimitMB" :min="0" :max="coldCacheMaxMB" :step="1024" color="teal" density="compact" hide-details></v-slider></v-col>
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

      <!-- MCP Servers — full width (the server table needs the room) -->
      <v-card class="glass-card pa-5 mb-5 settings-card--full">
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

      </div><!-- /settings-masonry -->

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
              <v-select
                v-model="mcpForm.authType"
                :items="[{title:'None',value:'none'},{title:'Bearer token',value:'bearer'},{title:'API key (header)',value:'apikey'},{title:'Basic',value:'basic'},{title:'Custom headers',value:'custom'}]"
                item-title="title" item-value="value"
                label="Authentication" variant="outlined" density="compact" class="mb-3" hide-details
              ></v-select>

              <v-textarea
                v-if="mcpForm.authType === 'bearer'"
                v-model="mcpForm.bearerToken" label="Bearer token" placeholder="eyJhbGciOi…"
                variant="outlined" density="compact" rows="2" class="mb-1 font-mono" hide-details="auto"
              ></v-textarea>

              <template v-else-if="mcpForm.authType === 'apikey'">
                <v-text-field v-model="mcpForm.apiKeyName" label="Header name" placeholder="X-API-Key" variant="outlined" density="compact" class="mb-3 font-mono" hide-details="auto"></v-text-field>
                <v-text-field v-model="mcpForm.apiKeyValue" label="Key value" variant="outlined" density="compact" class="mb-1 font-mono" hide-details="auto"></v-text-field>
              </template>

              <template v-else-if="mcpForm.authType === 'basic'">
                <v-text-field v-model="mcpForm.basicUser" label="Username" variant="outlined" density="compact" class="mb-3" hide-details="auto"></v-text-field>
                <v-text-field v-model="mcpForm.basicPass" label="Password" type="password" variant="outlined" density="compact" class="mb-1" hide-details="auto"></v-text-field>
              </template>

              <v-textarea
                v-else-if="mcpForm.authType === 'custom'"
                v-model="mcpForm.headersText" label="Headers (Key: value per line)" placeholder="Authorization: Bearer ...&#10;X-Custom-Header: value"
                variant="outlined" density="compact" rows="3" class="mb-1 font-mono" hide-details="auto"
              ></v-textarea>
            </template>

            <div v-if="mcpError" class="text-error text-caption mt-3">{{ mcpError }}</div>
            <div v-if="mcpTestResult && !mcpTestResult.ok" class="text-caption text-error mt-3">Failed: {{ mcpTestResult.error }}</div>

            <!-- Tool picker — populated by "Test / Load tools". Only checked tools are exposed. -->
            <div v-if="mcpForm.availableTools.length" class="mt-4">
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-subtitle-2 font-weight-medium">Tools</span>
                <span class="text-caption text-grey">{{ mcpForm.selectedTools.length }}/{{ mcpForm.availableTools.length }} enabled</span>
              </div>
              <div class="text-caption text-grey mb-2">Only checked tools are sent to the model. Fewer tools = smaller system prompt = more room for the conversation.</div>
              <div class="mcp-tool-list">
                <!-- Select-all master checkbox (indeterminate when a subset is chosen) -->
                <v-checkbox
                  :model-value="mcpAllToolsSelected"
                  :indeterminate="mcpForm.selectedTools.length > 0 && !mcpAllToolsSelected"
                  label="Select all"
                  density="compact" hide-details color="primary" class="mcp-tool-cb font-weight-medium"
                  @update:model-value="mcpSelectAllTools"
                ></v-checkbox>
                <v-divider class="my-1"></v-divider>
                <v-checkbox
                  v-for="t in mcpForm.availableTools" :key="t.name"
                  :model-value="mcpForm.selectedTools.includes(t.name)"
                  :label="t.name"
                  density="compact" hide-details color="primary" class="mcp-tool-cb"
                  @update:model-value="mcpToggleTool(t.name, $event)"
                ></v-checkbox>
              </div>
            </div>
            <div v-else-if="mcpTestResult && mcpTestResult.ok" class="text-caption text-success mt-3">
              Connected — 0 tools advertised
            </div>
          </v-card-text>
          <v-card-actions class="pa-5 pt-0 justify-end gap-2">
            <v-btn variant="text" color="grey" @click="mcpDialog = false">Cancel</v-btn>
            <v-btn variant="text" color="primary" :loading="mcpDialogTesting" @click="testMcpForm">Test / Load tools</v-btn>
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
      autoDownloadRuntimes: false,
      savedAutoDownloadRuntimes: false,
      autoDownloadLlamaRuntime: false,
      mcpInferenceEnabled: false,
      managePerformance: true,
    },
    llamaRuntime: { available: false, tag: null, llamaVersion: null, orkDriverVersion: null, licenseAccepted: false },
    llamaReleases: [],
    llamaSelectedTag: null,
    llamaSyncing: false,
    llamaLicense: { open: false, text: '', source: null, scrolledToBottom: false },
    cacheStats: null,
    cacheStatsTimer: null,
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
    mcpForm: { id: null, name: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', authType: 'none', bearerToken: '', apiKeyName: 'X-API-Key', apiKeyValue: '', basicUser: '', basicPass: '', headersText: '', allowedTools: null, availableTools: [], selectedTools: [] },
    snackbar: { show: false, text: '', color: 'success' },
    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    mcpAllToolsSelected() {
      return this.mcpForm.availableTools.length > 0
        && this.mcpForm.selectedTools.length === this.mcpForm.availableTools.length;
    },
    // Dynamic cache ceilings from detected hardware: hot ≤ 50% RAM, cold ≤ 80% disk.
    // Round to the slider step; fall back to the old fixed maxes before status loads.
    hotCacheMaxMB() {
      const ram = this.serverInfo.ramTotalMB;
      return ram ? Math.max(128, Math.floor((ram * 0.5) / 128) * 128) : 8192;
    },
    coldCacheMaxMB() {
      const disk = this.serverInfo.diskTotalMB;
      return disk ? Math.max(1024, Math.floor((disk * 0.8) / 1024) * 1024) : 102400;
    },
  },
  mounted() {
    this.fetchAuth();
    this.fetchSettings();
    this.fetchMcpServers();
    this.fetchLlamaRuntime();
    this.fetchLlamaReleases();
    // Poll prefix-cache stats so the observability figures update live as
    // inference populates the cache (the page otherwise only fetched on mount).
    this.cacheStatsTimer = setInterval(() => this.fetchCacheStats(), 4000);
  },
  beforeUnmount() {
    if (this.cacheStatsTimer) { clearInterval(this.cacheStatsTimer); this.cacheStatsTimer = null; }
  },
  methods: {
    async fetchCacheStats() {
      try {
        const res = await fetch('/api/admin/cache-stats');
        if (!res.ok) return;
        const data = await res.json();
        this.cacheStats = data.cacheStats || null;
      } catch (e) {}
    },
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
        // Clamp to the dynamic ceilings (serverInfo is set just above, so the
        // hot/cold max computeds are valid) in case a saved value predates them.
        this.settings.cacheHotLimitMB       = Math.min(s.cacheHotLimitMB ?? 512, this.hotCacheMaxMB);
        this.settings.cacheColdLimitMB      = Math.min(s.cacheColdLimitMB ?? 10240, this.coldCacheMaxMB);
        this.settings.cacheDir              = s.cacheDir ?? '';
        this.settings.cacheMaxContextTokens = s.cacheMaxContextTokens ?? 8192;
        this.settings.kvCacheQuant          = s.kvCacheQuant ?? 'off';
        this.settings.trustedProxy          = s.trustedProxy ?? '';
        this.settings.autoDownloadRuntimes  = s.autoDownloadRuntimes ?? false;
        this.savedAutoDownloadRuntimes       = this.settings.autoDownloadRuntimes;
        this.settings.autoDownloadLlamaRuntime  = s.autoDownloadLlamaRuntime ?? false;
        this.settings.mcpInferenceEnabled   = s.mcpInferenceEnabled ?? false;
        this.settings.managePerformance     = s.managePerformance ?? true;
        this.cacheStats = data.cacheStats || null;
      } catch (e) {}
    },

    async fetchLlamaRuntime() {
      try {
        const res = await fetch('/api/admin/llama-runtime');
        if (res.ok) {
          const d = await res.json();
          this.llamaRuntime = { available: d.available, tag: d.tag, llamaVersion: d.llamaVersion, orkDriverVersion: d.orkDriverVersion, licenseAccepted: !!d.licenseAccepted };
          if (!this.llamaSelectedTag && d.tag) this.llamaSelectedTag = d.tag;
        }
      } catch (e) {}
    },
    async fetchLlamaReleases() {
      try {
        const res = await fetch('/api/admin/llama-runtime/releases');
        if (res.ok) {
          this.llamaReleases = (await res.json()).releases || [];
          // Default the picker to the newest release (the list is newest-first)
          // so the one-click action installs latest; users can still pick older.
          if (!this.llamaSelectedTag && this.llamaReleases.length) {
            this.llamaSelectedTag = this.llamaReleases[0].tag;
          }
        }
      } catch (e) {}
    },
    async onToggleAutoLlama(val) {
      if (val) {
        // Enabling auto-download requires accepting the upstream llama.cpp license.
        const ok = await this.ensureLlamaLicense();
        if (!ok) { this.settings.autoDownloadLlamaRuntime = false; return; } // declined → stays off
      }
      this.settings.autoDownloadLlamaRuntime = val;
      try { await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoDownloadLlamaRuntime: val }) }); } catch (e) {}
    },
    // Show the upstream license; resolves true only once the admin scrolls + accepts.
    async ensureLlamaLicense() {
      if (this.llamaRuntime.licenseAccepted) return true;
      this.llamaLicense.text = '';
      this.llamaLicense.scrolledToBottom = false;
      this.llamaLicense.open = true;
      try {
        const d = await (await fetch('/api/admin/llama-runtime/license')).json();
        this.llamaLicense.text = d.text || 'License unavailable.';
        this.llamaLicense.source = d.source || null;
      } catch (e) { this.llamaLicense.text = 'License unavailable.'; }
      // If the text fits without scrolling, enable Accept immediately.
      this.$nextTick(() => {
        const b = this.$refs.llamaLicenseBox;
        if (b && b.scrollHeight <= b.clientHeight + 4) this.llamaLicense.scrolledToBottom = true;
      });
      return new Promise(resolve => { this._llamaLicenseResolve = resolve; });
    },
    onLlamaLicenseScroll(e) {
      const el = e.target;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) this.llamaLicense.scrolledToBottom = true;
    },
    async acceptLlamaLicense() {
      try { await fetch('/api/admin/llama-runtime/accept-license', { method: 'POST' }); } catch (e) {}
      this.llamaRuntime.licenseAccepted = true;
      this.llamaLicense.open = false;
      if (this._llamaLicenseResolve) { this._llamaLicenseResolve(true); this._llamaLicenseResolve = null; }
    },
    declineLlamaLicense() {
      this.llamaLicense.open = false;
      if (this._llamaLicenseResolve) { this._llamaLicenseResolve(false); this._llamaLicenseResolve = null; }
    },
    // Picker label: mark the installed tag, flag when its bytes differ from the
    // release (a re-released/overwritten tag → update available), and the newest.
    llamaReleaseLabel(r, i) {
      if (r.tag === this.llamaRuntime.tag) {
        const stale = r.assetDigest && this.llamaRuntime.assetSha && r.assetDigest !== this.llamaRuntime.assetSha;
        return r.tag + (stale ? ' (installed — update available)' : ' (installed)');
      }
      return r.tag + (i === 0 ? ' (latest)' : '');
    },
    async downloadLlama() {
      if (!(await this.ensureLlamaLicense())) return; // must accept the license first
      this.llamaSyncing = true;
      try {
        // force:true so an explicit sync re-fetches even at the same tag (handles a
        // re-released/overwritten release); the backend also auto-detects via sha256.
        const res = await fetch('/api/admin/llama-runtime/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: this.llamaSelectedTag || null, force: true }) });
        if (res.status === 422) {
          // License not accepted server-side (shouldn't happen if ensureLlamaLicense ran). Re-prompt.
          let code = '';
          try { code = (await res.json()).code; } catch (e) {}
          this.llamaSyncing = false;
          if (code === 'LICENSE_NOT_ACCEPTED') {
            this.llamaRuntime.licenseAccepted = false;
            if (await this.ensureLlamaLicense()) this.downloadLlama();
          }
          return;
        }
        setTimeout(() => { this.fetchLlamaRuntime(); this.llamaSyncing = false; }, 3000);
      } catch (e) { this.llamaSyncing = false; }
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
        // Repopulate auth fields from structured config.auth; fall back to a
        // legacy plain headers map (pre-auth servers) as "custom".
        const auth = c.auth || null;
        let authType = 'none', bearerToken = '', apiKeyName = 'X-API-Key', apiKeyValue = '', basicUser = '', basicPass = '', headersText = '';
        if (auth) {
          authType = auth.type || 'none';
          if (authType === 'bearer') bearerToken = auth.token || '';
          else if (authType === 'apikey') { apiKeyName = auth.headerName || 'X-API-Key'; apiKeyValue = auth.value || ''; }
          else if (authType === 'basic') { basicUser = auth.username || ''; basicPass = auth.password || ''; }
          else if (authType === 'custom') headersText = Object.entries(auth.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
        } else if (c.headers && Object.keys(c.headers).length) {
          authType = 'custom';
          headersText = Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
        }
        this.mcpForm = {
          id: server.id,
          name: server.name,
          transport: server.transport,
          command: c.command || '',
          argsText: Array.isArray(c.args) ? c.args.join(' ') : '',
          envText: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
          url: c.url || '',
          authType, bearerToken, apiKeyName, apiKeyValue, basicUser, basicPass, headersText,
          allowedTools: Array.isArray(c.allowedTools) ? c.allowedTools : null,
          availableTools: [], selectedTools: [],
        };
      } else {
        this.mcpForm = { id: null, name: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', authType: 'none', bearerToken: '', apiKeyName: 'X-API-Key', apiKeyValue: '', basicUser: '', basicPass: '', headersText: '', allowedTools: null, availableTools: [], selectedTools: [] };
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
        // Build a structured auth object; the backend turns it into request
        // headers (resolveHeaders in src/mcp.js).
        const auth = { type: f.authType || 'none' };
        if (auth.type === 'bearer') {
          auth.token = f.bearerToken.trim();
        } else if (auth.type === 'apikey') {
          auth.headerName = (f.apiKeyName || 'X-API-Key').trim();
          auth.value = f.apiKeyValue.trim();
        } else if (auth.type === 'basic') {
          auth.username = f.basicUser;
          auth.password = f.basicPass;
        } else if (auth.type === 'custom') {
          auth.headers = {};
          for (const line of f.headersText.split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) auth.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        }
        config.auth = auth;
      }
      // Tool allow-list: once tools have been loaded in the dialog, persist the
      // checked subset (null when all are checked → future tools auto-included).
      // If never loaded, keep whatever was stored.
      if (f.availableTools.length) {
        config.allowedTools = f.selectedTools.length === f.availableTools.length ? null : [...f.selectedTools];
      } else if (Array.isArray(f.allowedTools)) {
        config.allowedTools = f.allowedTools;
      }
      return { name: f.name.trim(), transport: f.transport, config };
    },
    async testMcpForm() {
      this.mcpError = '';
      this.mcpTestResult = null;
      this.mcpDialogTesting = true;
      try {
        // Validate without the allow-list so we see ALL advertised tools to pick from.
        const payload = this.mcpFormToPayload();
        if (payload.config) delete payload.config.allowedTools;
        const res = await fetch('/api/admin/mcp-servers/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
          this.mcpTestResult = data;
          this.mcpForm.availableTools = data.tools || [];
          // Pre-check from the stored allow-list, or all tools when unset.
          const allow = this.mcpForm.allowedTools;
          this.mcpForm.selectedTools = allow
            ? this.mcpForm.availableTools.filter(t => allow.includes(t.name)).map(t => t.name)
            : this.mcpForm.availableTools.map(t => t.name);
        } else {
          this.mcpError = data.error || 'Validation failed';
        }
      } catch (e) {
        this.mcpError = 'Network error';
      } finally {
        this.mcpDialogTesting = false;
      }
    },
    mcpToggleTool(name, on) {
      const set = new Set(this.mcpForm.selectedTools);
      if (on) set.add(name); else set.delete(name);
      this.mcpForm.selectedTools = [...set];
    },
    mcpSelectAllTools(on) {
      this.mcpForm.selectedTools = on ? this.mcpForm.availableTools.map(t => t.name) : [];
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

/* Use available horizontal space on large displays instead of a narrow column */
.page-container {
  max-width: 1400px;
  margin-inline: auto;
}

/* Settings cards: single column by default, two masonry columns on lg+.
   Each card stays intact; the MCP card spans the full width. */
.settings-masonry > .v-card {
  break-inside: avoid;
}
@media (min-width: 1280px) {
  .settings-masonry {
    column-count: 2;
    column-gap: 20px;
  }
  .settings-card--full {
    column-span: all;
  }
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

.license-box {
  max-height: 340px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Fira Code', 'Courier New', monospace;
  font-size: 11.5px;
  line-height: 1.5;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(139, 92, 246, 0.15);
  border-radius: 8px;
  padding: 12px;
}

.mcp-tool-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid rgba(139, 92, 246, 0.15);
  border-radius: 8px;
  padding: 4px 10px;
}
.mcp-tool-cb :deep(.v-label) {
  font-family: 'Fira Code', 'Courier New', monospace;
  font-size: 12px;
  opacity: 1;
}
</style>
