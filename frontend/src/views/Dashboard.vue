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

      <!-- DRAM throttle warning: decode is bandwidth-bound; a parked DDR clock ~halves it -->
      <v-alert
        v-if="status.dram && status.dram.throttled"
        type="warning"
        variant="tonal"
        density="comfortable"
        class="mb-6 w-100"
        icon="mdi-memory"
      >
        <div class="font-weight-bold">DRAM is running below its maximum clock ({{ status.dram.curFreqMhz }} / {{ status.dram.maxFreqMhz }} MHz)</div>
        <div class="text-body-2 mt-1">
          <template v-if="status.dram.management && status.dram.management.failed">
            oRKLLM tried to pin the memory controller to <code>performance</code> but couldn't: <strong>{{ status.dram.management.reason }}</strong>. Decode is memory-bandwidth-bound, so a parked DDR clock can roughly <strong>halve token-generation speed</strong>. Run oRKLLM with privileges to let it manage governors automatically, or apply it manually:
          </template>
          <template v-else>
            The DDR DVFS governor is <code>{{ status.dram.governor }}</code> and auto-management is off. On many RK3576/RK3588 boards this doesn't ramp DRAM for NPU traffic, which can roughly <strong>halve token-generation speed</strong> (decode is memory-bandwidth-bound). Enable <em>Auto performance governor</em> in Settings, or pin it manually:
          </template>
          <pre class="mt-2 pa-2 rounded text-caption" style="background: rgba(0,0,0,0.25); overflow-x:auto;">echo performance | sudo tee /sys/class/devfreq/dmc/governor</pre>
        </div>
      </v-alert>

      <!-- CPU throttle warning: prefill is CPU-op bound; a non-performance governor below max clock slows it -->
      <v-alert
        v-if="status.cpuFreq && status.cpuFreq.throttled"
        type="warning"
        variant="tonal"
        density="comfortable"
        class="mb-6 w-100"
        icon="mdi-cpu-64-bit"
      >
        <div class="font-weight-bold">CPU running below its maximum clock ({{ status.cpuFreq.curFreqMhz }} / {{ status.cpuFreq.maxFreqMhz }} MHz)</div>
        <div class="text-body-2 mt-1">
          <template v-if="status.cpuFreq.management && status.cpuFreq.management.failed">
            oRKLLM tried to pin the CPU to <code>performance</code> but couldn't: <strong>{{ status.cpuFreq.management.reason }}</strong>. Prefill runs attention/softmax/norm on the CPU, so a throttled governor slows prompt processing. Run oRKLLM with privileges, or apply it manually:
          </template>
          <template v-else>
            The CPU governor is <code>{{ status.cpuFreq.governor }}</code> and auto-management is off. Prefill is CPU-op-bound (attention/softmax/norm), so a governor that doesn't ramp the cores slows prompt processing. Enable <em>Auto performance governor</em> in Settings, or pin it manually:
          </template>
          <pre class="mt-2 pa-2 rounded text-caption" style="background: rgba(0,0,0,0.25); overflow-x:auto;">for c in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do echo performance | sudo tee $c; done</pre>
        </div>
      </v-alert>

      <v-row class="align-start">

        <!-- Left Side: Telemetry & API Endpoints -->
        <v-col cols="12" md="4" class="d-flex flex-column gap-6" style="min-width: 0;">

          <!-- Metrics Panel -->
          <v-card class="glass-card pa-5 telemetry-card">
            <div class="text-h6 font-weight-bold mb-4 d-flex align-center justify-space-between">
              <div class="d-flex align-center">
                <v-icon start color="primary">mdi-chart-line</v-icon>
                Hardware Telemetry
              </div>
              <v-btn-toggle v-model="telemetryUnits" mandatory density="compact" rounded="lg" color="primary" variant="outlined">
                <v-btn :value="false" size="x-small" title="Show percentages">
                  <v-icon size="14">mdi-percent</v-icon>
                </v-btn>
                <v-btn :value="true" size="x-small" title="Show units">
                  <v-icon size="14">mdi-counter</v-icon>
                </v-btn>
              </v-btn-toggle>
            </div>

            <div class="telemetry-grid text-center">
              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.cpu" :size="80" :width="7" color="blue" class="font-weight-bold mb-1">
                  <span class="text-caption font-weight-bold">{{ metrics.cpu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">CPU</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.npu" :size="80" :width="7" color="primary" class="font-weight-bold mb-1">
                  <span class="text-caption font-weight-bold">{{ metrics.npu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">NPU</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.gpu" :size="80" :width="7" color="orange" class="font-weight-bold mb-1">
                  <span class="text-caption font-weight-bold">{{ metrics.gpu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">GPU</div>
              </div>

              <!-- Memory row: RAM usage, RAM bandwidth, Swap -->
              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.ram" :size="80" :width="7" color="teal" class="font-weight-bold mb-1">
                  <span v-if="!telemetryUnits" class="text-caption font-weight-bold">{{ metrics.ram }}%</span>
                  <span v-else class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    {{ formatGb(metricsRaw.ramUsed) }}<br>
                    <span class="text-grey" style="font-size: 0.55rem;">/ {{ formatGb(metricsRaw.ramTotal) }}</span>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">RAM</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.memBw" :size="80" :width="7" :color="metricsRaw.memBwAvailable ? 'deep-purple-lighten-1' : 'grey'" class="font-weight-bold mb-1">
                  <span v-if="!metricsRaw.memBwAvailable" class="text-caption font-weight-bold text-grey">N/A</span>
                  <span v-else-if="!telemetryUnits" class="text-caption font-weight-bold">{{ metrics.memBw }}%</span>
                  <span v-else class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    {{ metricsRaw.memBwFreqMhz || '—' }}<br><span class="text-grey" style="font-size: 0.55rem;">MHz DDR</span>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">RAM BW</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.swap" :size="80" :width="7" :color="metricsRaw.swapTotal ? 'blue-grey-lighten-1' : 'grey'" class="font-weight-bold mb-1">
                  <span v-if="!metricsRaw.swapTotal" class="text-caption font-weight-bold text-grey">none</span>
                  <span v-else-if="!telemetryUnits" class="text-caption font-weight-bold">{{ metrics.swap }}%</span>
                  <span v-else class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    {{ formatGb(metricsRaw.swapUsed) }}<br>
                    <span class="text-grey" style="font-size: 0.55rem;">/ {{ formatGb(metricsRaw.swapTotal) }}</span>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">Swap</div>
              </div>

              <!-- Disk I/O row: utilization, live read, live write -->
              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.disk" :size="80" :width="7" color="amber" class="font-weight-bold mb-1">
                  <span v-if="!telemetryUnits" class="text-caption font-weight-bold">{{ metrics.disk }}%</span>
                  <span v-else class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    {{ formatGb(metricsRaw.diskUsed) }}<br>
                    <span class="text-grey" style="font-size: 0.55rem;">/ {{ formatGb(metricsRaw.diskTotal) }}</span>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">Disk</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="diskReadRing" :size="80" :width="7" color="light-green" class="font-weight-bold mb-1">
                  <span class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    {{ fmtRate(metrics.diskRead) }}<br>
                    <span class="text-grey" style="font-size: 0.55rem;">read</span>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">Disk Read</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="diskWriteRing" :size="80" :width="7" color="deep-orange-lighten-1" class="font-weight-bold mb-1">
                  <span class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    {{ fmtRate(metrics.diskWrite) }}<br>
                    <span class="text-grey" style="font-size: 0.55rem;">write</span>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">Disk Write</div>
              </div>

              <!-- Thermal row: disk temp, SoC temp, fan -->
              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.diskTemp || 0" :size="80" :width="7" :color="metricsRaw.diskTempAvailable ? 'pink-lighten-1' : 'grey'" class="font-weight-bold mb-1">
                  <span v-if="!metricsRaw.diskTempAvailable" class="text-caption font-weight-bold text-grey">N/A</span>
                  <span v-else class="text-caption font-weight-bold">{{ metrics.diskTemp }}°C</span>
                </v-progress-circular>
                <div class="text-caption text-grey">Disk Temp</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.temp" :size="80" :width="7" color="rose" class="font-weight-bold mb-1">
                  <span class="text-caption font-weight-bold">{{ metrics.temp }}°C</span>
                </v-progress-circular>
                <div class="text-caption text-grey">Temp</div>
              </div>

              <div class="py-2 d-flex flex-column align-center">
                <v-progress-circular :model-value="metrics.fan" :size="80" :width="7" :color="metricsRaw.fanAvailable ? 'cyan' : 'grey'" class="font-weight-bold mb-1">
                  <span v-if="!metricsRaw.fanAvailable" class="text-caption font-weight-bold text-grey">N/A</span>
                  <span v-else-if="!telemetryUnits" class="text-caption font-weight-bold">{{ metrics.fan }}%</span>
                  <span v-else class="font-weight-bold" style="font-size: 0.62rem; line-height: 1.2; text-align: center;">
                    <template v-if="metricsRaw.fanRpm">{{ metricsRaw.fanRpm }}<br><span class="text-grey" style="font-size: 0.55rem;">RPM</span></template>
                    <template v-else>{{ metrics.fan }}%<br><span class="text-grey" style="font-size: 0.55rem;">PWM</span></template>
                  </span>
                </v-progress-circular>
                <div class="text-caption text-grey">Fan</div>
              </div>
            </div>

            <!-- Disk table -->
            <div v-if="disks.length" class="mt-4">
              <v-divider class="mb-3"></v-divider>
              <v-table density="compact" class="text-caption telemetry-table">
                <thead>
                  <tr>
                    <th class="text-left">Device</th>
                    <th class="text-left">Type</th>
                    <th class="text-right">Size</th>
                    <th class="text-right">Read</th>
                    <th class="text-right">Write</th>
                    <th class="text-right">TBW</th>
                    <th class="text-center">SMART</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="d in disks" :key="d.device">
                    <td class="font-mono">{{ d.device }}</td>
                    <td>{{ d.type }}</td>
                    <td class="text-right">{{ formatGb(d.size) }}</td>
                    <td class="text-right text-grey">{{ d.readMBs != null ? fmtRate(d.readMBs) : '—' }}</td>
                    <td class="text-right text-grey">{{ d.writeMBs != null ? fmtRate(d.writeMBs) : '—' }}</td>
                    <td class="text-right text-grey">{{ d.tbw != null ? d.tbw + ' TB' : '—' }}</td>
                    <td class="text-center">
                      <v-chip
                        size="x-small"
                        :color="d.smartStatus === 'Ok' ? 'success' : d.smartStatus === 'Bad' ? 'error' : d.smartStatus === 'Degraded' ? 'warning' : 'grey'"
                        variant="tonal"
                      >{{ d.smartStatus }}</v-chip>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>

            <!-- Accelerator Devices table -->
            <div class="mt-4">
              <v-divider class="mb-3"></v-divider>
              <v-table density="compact" class="text-caption telemetry-table">
                <thead>
                  <tr>
                    <th class="text-left">Device</th>
                    <th class="text-left">Type</th>
                    <th class="text-left">Detail</th>
                    <th class="text-left">Driver</th>
                    <th class="text-right">Load</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="dev in acceleratorDevices" :key="dev.name">
                    <td>{{ dev.name }}</td>
                    <td>
                      <v-chip size="x-small" :color="dev.color" variant="tonal">{{ dev.type }}</v-chip>
                    </td>
                    <td class="text-grey">{{ dev.detail || '—' }}</td>
                    <td class="font-mono text-grey">{{ dev.driver || '—' }}</td>
                    <td class="text-right">
                      <v-chip size="x-small" :color="dev.load > 70 ? 'warning' : 'grey'" variant="tonal">
                        {{ dev.load }}%
                      </v-chip>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>
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
                  <span class="text-caption text-truncate font-mono select-all" style="min-width: 0;">http://{{ selectedHost }}:{{ port }}/v1</span>
                  <v-spacer></v-spacer>
                  <v-btn icon size="x-small" variant="text" color="primary" @click="copyToClipboard(`http://${selectedHost}:${port}/v1`)">
                    <v-icon size="16">mdi-content-copy</v-icon>
                  </v-btn>
                </div>
              </div>
              <div>
                <div class="text-caption text-grey mb-1">Base HTTP Server</div>
                <div class="d-flex align-center bg-slate-page rounded pa-2 border">
                  <span class="text-caption text-truncate font-mono select-all" style="min-width: 0;">http://{{ selectedHost }}:{{ port }}</span>
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

        <!-- Right Side: Serving Statistics + Cache Observability + Runtime Versions -->
        <v-col cols="12" md="8" class="d-flex flex-column gap-6" style="min-width: 0;">

          <!-- Serving Statistics -->
          <v-card class="glass-card pa-4">
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
              <v-col cols="6" sm="4" md="2">
                <div class="text-caption text-grey">TOTAL REQUESTS</div>
                <div class="text-h5 font-weight-bold">{{ currentStats.totalRequests }}</div>
              </v-col>
              <v-col cols="6" sm="4" md="2.5">
                <div class="text-caption text-grey">PREFILL TOKENS</div>
                <div class="text-h5 font-weight-bold">{{ currentStats.totalPrefillTokens }}</div>
              </v-col>
              <v-col cols="6" sm="4" md="2.5">
                <div class="text-caption text-grey">GENERATED TOKENS</div>
                <div class="text-h5 font-weight-bold">{{ currentStats.totalGeneratedTokens }}</div>
              </v-col>
              <v-col cols="6" sm="6" md="2.5">
                <div class="text-caption text-grey">PROMPT PROCESSING SPEED</div>
                <div class="text-h5 font-weight-bold text-success">{{ promptSpeed }} tok/s</div>
              </v-col>
              <v-col cols="6" sm="6" md="2.5">
                <div class="text-caption text-grey">TOKEN GENERATION SPEED</div>
                <div class="text-h5 font-weight-bold text-primary">{{ generateSpeed }} tok/s</div>
              </v-col>
            </v-row>
          </v-card>

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
                  <div class="text-body-1 font-weight-bold">{{ formatMB(cacheStats.hot?.sizeMB ?? 0) }}</div>
                  <div class="text-caption text-grey">/ {{ formatMB(cacheStats.hot?.limitMB ?? 0) }} · {{ cacheStats.hot?.entries ?? 0 }} entries</div>
                </v-col>
                <v-col cols="6" sm="3">
                  <div class="text-caption text-grey">Cold Cache</div>
                  <div class="text-body-1 font-weight-bold">{{ formatMB(cacheStats.cold?.sizeMB ?? 0) }}</div>
                  <div class="text-caption text-grey">/ {{ formatMB(cacheStats.cold?.limitMB ?? 0) }} · {{ cacheStats.cold?.entries ?? 0 }} entries</div>
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
                  <span class="text-caption">{{ formatMB(cacheStats.hot?.sizeMB ?? 0) }} / {{ formatMB(cacheStats.hot?.limitMB ?? 0) }}</span>
                </div>
                <v-progress-linear
                  :model-value="cacheStats.hot?.limitMB ? (cacheStats.hot.sizeMB / cacheStats.hot.limitMB) * 100 : 0"
                  color="primary" rounded height="5"
                ></v-progress-linear>
              </div>
              <div>
                <div class="d-flex justify-space-between mb-1">
                  <span class="text-caption">Cold</span>
                  <span class="text-caption">{{ formatMB(cacheStats.cold?.sizeMB ?? 0) }} / {{ formatMB(cacheStats.cold?.limitMB ?? 0) }}</span>
                </div>
                <v-progress-linear
                  :model-value="cacheStats.cold?.limitMB ? (cacheStats.cold.sizeMB / cacheStats.cold.limitMB) * 100 : 0"
                  color="teal" rounded height="5"
                ></v-progress-linear>
              </div>
            </template>
          </v-card>

          <!-- Inference Engines -->
          <v-card class="glass-card pa-5">
            <div class="text-h6 font-weight-bold mb-4 d-flex align-center justify-space-between">
              <div class="d-flex align-center">
                <v-icon start color="primary">mdi-cpu-64-bit</v-icon>
                Inference Engines
              </div>
              <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-refresh"
                @click="fetchRuntimes">Refresh</v-btn>
            </div>

            <!-- Llama subsection -->
            <div class="mb-4">
              <div class="text-overline text-grey-darken-1 mb-2" style="letter-spacing:0.08em">Llama (Open NPU)</div>
              <div v-if="status.llamaRuntime?.available">
                <div class="d-flex flex-wrap gap-2 mb-1">
                  <v-chip size="small" color="teal" variant="tonal">
                    llama.cpp {{ status.llamaRuntime.llamaVersion || status.llamaRuntime.tag || '—' }}
                  </v-chip>
                  <v-chip v-if="status.llamaRuntime.orkDriverVersion" size="small" color="teal" variant="tonal">
                    ork-driver v{{ status.llamaRuntime.orkDriverVersion }}
                  </v-chip>
                </div>
                <div class="text-caption text-grey">Runs GGUF models on the Rockchip NPU via the clean-room open stack (ork-driver + ggml-ork) — no proprietary librknnrt — with w8a8 and mixed int4/int8 (NF4) weight packing and .orkpack persistence.</div>
              </div>
              <div v-else class="text-caption text-grey">
                Not installed. Sync via Settings → Llama Runtime.
              </div>
            </div>

            <v-divider class="mb-3" />

            <!-- RKLLM subsection -->
            <div class="mb-4">
              <div class="text-overline text-grey-darken-1 mb-2" style="letter-spacing:0.08em">RKLLM</div>
              <!-- Effective runtime — the lib that will be used for the next load -->
              <div class="mb-2">
                <div class="text-caption text-grey mb-1">Active runtime ({{ runtimes.effectiveRuntime?.file || runtimes.effectiveRuntime?.path || '—' }})</div>
                <v-chip
                  :color="runtimes.effectiveRuntime?.version ? 'primary' : runtimes.effectiveRuntime?.exists === false ? 'grey' : 'warning'"
                  variant="tonal"
                  size="small"
                >
                  {{ runtimes.effectiveRuntime?.version ? `v${runtimes.effectiveRuntime.version}` : runtimes.effectiveRuntime?.exists === false ? 'not installed' : 'version unknown' }}
                </v-chip>
              </div>
              <div v-if="runtimes.runtimes && runtimes.runtimes.length">
                <div class="text-caption text-grey mb-2">Installed — {{ runtimes.runtimesDir }}</div>
                <v-table density="compact" class="text-caption">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in runtimes.runtimes" :key="r.path">
                      <td class="font-mono">{{ r.file }}</td>
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
                No versioned runtimes. Enable auto-download in Settings or place
                <code>librkllmrt-aarch64-vX.Y.Z.so</code> files in the runtimes directory.
              </div>
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
    metrics: { cpu: 0, npu: 0, gpu: 0, ram: 0, disk: 0, temp: 0, fan: 0, memBw: 0, swap: 0, diskRead: 0, diskWrite: 0, diskTemp: 0 },
    diskReadMax: 1,   // rolling peak read MB/s — self-calibrates the Disk Read gauge ring
    diskWriteMax: 1,  // rolling peak write MB/s — self-calibrates the Disk Write gauge ring
    metricsRaw: {
      ramUsed: 0, ramTotal: 0, diskUsed: 0, diskTotal: 0,
      fanAvailable: false, fanRpm: null,
      memBwAvailable: false, memBwFreqMhz: null,
      swapUsed: 0, swapTotal: 0,
      diskTempAvailable: false,
    },
    disks: [],
    telemetryUnits: false,
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
    },
    acceleratorDevices() {
      const platform = this.status?.platform;
      const npuCores = this.status?.npuCores;
      const drivers = this.status?.drivers;
      const fmtDriver = (d) => d ? `${d.name}${d.version ? ' ' + d.version : ''}` : null;
      const GPU_BY_SOC = { rk3576: 'Mali-G52 MC3', rk3588: 'Mali-G610 MP4', rk3588s: 'Mali-G610 MP4' };
      const NPU_BY_SOC = { rk3576: 'Rockchip NPU (RK3576)', rk3588: 'Rockchip NPU (RK3588)', rk3588s: 'Rockchip NPU (RK3588S)' };
      const npu = {
        type: 'NPU',
        name: platform ? (NPU_BY_SOC[platform] || `Rockchip NPU (${platform})`) : 'Rockchip NPU',
        detail: npuCores ? `${npuCores} core${npuCores > 1 ? 's' : ''}` : null,
        driver: fmtDriver(drivers?.npu),
        load: this.metrics.npu,
        color: 'primary',
      };
      // Prefer the real Mali gpuinfo (model + shader-core count); fall back to the SoC map.
      const gpuInfo = this.status?.gpu;
      const gpuCores = gpuInfo?.cores;
      const gpu = {
        type: 'GPU',
        name: gpuInfo?.model || (platform ? (GPU_BY_SOC[platform] || 'Mali GPU') : 'Mali GPU'),
        detail: gpuCores ? `${gpuCores} shader core${gpuCores > 1 ? 's' : ''}` : null,
        driver: fmtDriver(drivers?.gpu),
        load: this.metrics.gpu,
        color: 'orange',
      };
      // CPU split into the big.LITTLE clusters (RK3588: A76 perf cores 4-7, A55 eff cores 0-3).
      // Per-cluster load/freq come from the telemetry `cpuClusters` field; fall back to the
      // aggregate CPU load / em-dash when per-cluster data isn't available (non-big.LITTLE host).
      const clusters = this.metrics.cpuClusters || {};
      const cpuDriver = fmtDriver(drivers?.cpu);
      const cpuRow = (label, coreRange, c) => ({
        type: 'CPU',
        name: label,
        detail: c?.freqMhz ? `cores ${coreRange} · ${c.freqMhz} MHz` : `cores ${coreRange}`,
        driver: cpuDriver,
        load: c && typeof c.load === 'number' ? c.load : this.metrics.cpu,
        color: 'green',
      });
      const cpuBig = cpuRow('CPU (big / A76)', '4–7', clusters.big);
      const cpuLittle = cpuRow('CPU (little / A55)', '0–3', clusters.little);
      return [cpuBig, cpuLittle, npu, gpu];
    },
    // Disk-read gauge ring, scaled to the session peak (self-calibrating, since a
    // disk has no meaningful fixed max throughput to scale against).
    diskReadRing() {
      return this.diskReadMax > 0 ? Math.min(100, (this.metrics.diskRead / this.diskReadMax) * 100) : 0;
    },
    diskWriteRing() {
      return this.diskWriteMax > 0 ? Math.min(100, (this.metrics.diskWrite / this.diskWriteMax) * 100) : 0;
    },
  },
  mounted() {
    this.fetchAuth();
    this.fetchModels();
    this.fetchStatus();
    this.fetchMetrics();
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
    formatMB(mb) {
      if (!mb && mb !== 0) return '0 B';
      if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
      return mb + ' MB';
    },
    formatGb(bytes) {
      if (!bytes) return '0 B';
      if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
      return (bytes / 1024).toFixed(0) + ' KB';
    },
    // Format a throughput in MB/s, rolling up to GB/s past 1000.
    fmtRate(mbs) {
      const v = Number(mbs) || 0;
      if (v >= 1000) return (v / 1000).toFixed(1) + ' GB/s';
      if (v >= 100) return Math.round(v) + ' MB/s';
      return v.toFixed(1) + ' MB/s';
    },
    copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        this.$notify('Copied to clipboard', 'success');
      }).catch(() => {
        this.$notify('Failed to copy to clipboard', 'error');
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
    applyMetrics(data) {
      this.metrics.cpu = data.cpu;
      this.metrics.npu = data.npu;
      this.metrics.gpu = data.gpu ?? 0;
      this.metrics.ram = data.ram.percentage;
      this.metrics.disk = data.disk?.percentage ?? 0;
      this.metricsRaw.ramUsed = data.ram.used ?? 0;
      this.metricsRaw.ramTotal = data.ram.total ?? 0;
      this.metricsRaw.diskUsed = data.disk?.used ?? 0;
      this.metricsRaw.diskTotal = data.disk?.total ?? 0;
      if (data.disks) this.disks = data.disks;
      this.metrics.temp = data.temperature;
      // Fan + RAM bandwidth (null when the board exposes no such sensor)
      this.metricsRaw.fanAvailable = !!data.fan;
      this.metrics.fan = data.fan?.percentage ?? 0;
      this.metricsRaw.fanRpm = data.fan?.rpm ?? null;
      this.metricsRaw.memBwAvailable = !!data.memBw;
      this.metrics.memBw = data.memBw?.percentage ?? 0;
      this.metricsRaw.memBwFreqMhz = data.memBw?.freqMhz ?? null;
      this.metrics.swap = data.swap?.percentage ?? 0;
      this.metricsRaw.swapUsed = data.swap?.used ?? 0;
      this.metricsRaw.swapTotal = data.swap?.total ?? 0;
      // Live disk throughput (aggregate MB/s); each ring scales to its session peak.
      this.metrics.diskRead = data.diskRead ?? 0;
      this.metrics.diskWrite = data.diskWrite ?? 0;
      if (this.metrics.diskRead > this.diskReadMax) this.diskReadMax = this.metrics.diskRead;
      if (this.metrics.diskWrite > this.diskWriteMax) this.diskWriteMax = this.metrics.diskWrite;
      // Disk temperature (°C from SMART); null when no disk reports it.
      this.metricsRaw.diskTempAvailable = data.diskTemp != null;
      this.metrics.diskTemp = data.diskTemp ?? 0;
      if (data.stats) {
        this.stats = data.stats;
      }
    },
    // Prefill gauges from the cached server-side snapshot so the dashboard isn't
    // blank for the few seconds the WebSocket's first poll takes on cold start.
    async fetchMetrics() {
      try {
        const res = await fetch('/api/admin/metrics');
        if (res.ok) this.applyMetrics(await res.json());
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
          this.applyMetrics(JSON.parse(event.data));
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

/* Responsive Container Grid for Hardware Telemetry Gauges */
.telemetry-card {
  container-type: inline-size;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

.telemetry-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  justify-items: center;
}

@container (max-width: 330px) {
  .telemetry-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
}

@container (max-width: 220px) {
  .telemetry-grid {
    grid-template-columns: repeat(1, 1fr);
    gap: 8px;
  }
}

.telemetry-table :deep(table) {
  min-width: 500px;
}
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
