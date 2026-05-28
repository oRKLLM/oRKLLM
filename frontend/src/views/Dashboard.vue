<template>
  <!-- Navbar -->
  <v-app-bar flat class="glass-nav px-4" density="comfortable">
    <v-icon color="primary" class="mr-2" size="32">mdi-chip</v-icon>
    <v-app-bar-title class="d-flex align-center gap-2">
      <span class="font-weight-bold text-h5 text-gradient">oRKLLM</span>
      <v-chip size="x-small" variant="outlined" color="primary" class="font-weight-regular text-caption mt-1">v{{ appVersion }}</v-chip>
    </v-app-bar-title>

    <v-spacer></v-spacer>

    <v-menu location="bottom end">
      <template v-slot:activator="{ props }">
        <v-btn v-bind="props" icon color="primary" variant="tonal" size="36">
          <v-icon size="20">mdi-account</v-icon>
        </v-btn>
      </template>
      <v-list density="compact" class="glass-card py-1" min-width="180">
        <v-list-item class="px-4 py-2">
          <div class="text-caption text-grey">Signed in as</div>
          <div class="text-body-2 font-weight-bold">{{ username }}</div>
        </v-list-item>
        <v-divider></v-divider>
        <v-list-item
          :prepend-icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
          :title="isDark ? 'Light Mode' : 'Dark Mode'"
          @click="toggleTheme"
        ></v-list-item>
        <v-list-item
          prepend-icon="mdi-cog-outline"
          title="Global Settings"
          @click="$router.push('/settings')"
        ></v-list-item>
        <v-divider></v-divider>
        <v-list-item
          prepend-icon="mdi-logout"
          title="Sign Out"
          @click="logout"
          class="text-error"
        ></v-list-item>
      </v-list>
    </v-menu>
  </v-app-bar>

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

      <v-row class="fill-height align-start">
        
        <!-- Left Side: Metrics, Models & Settings -->
        <v-col cols="12" md="4" class="d-flex flex-column gap-6">
          
          <!-- Metrics Panel -->
          <v-card class="glass-card pa-5">
            <div class="text-h6 font-weight-bold mb-4 d-flex align-center">
              <v-icon start color="primary">mdi-chart-line</v-icon>
              Hardware Telemetry
            </div>
            
            <v-row class="text-center">
              <v-col cols="6" class="py-2">
                <v-progress-circular
                  :model-value="metrics.cpu"
                  :size="90"
                  :width="8"
                  color="blue"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-body-2 font-weight-bold">{{ metrics.cpu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">CPU Utilization</div>
              </v-col>
              
              <v-col cols="6" class="py-2">
                <v-progress-circular
                  :model-value="metrics.npu"
                  :size="90"
                  :width="8"
                  color="primary"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-body-2 font-weight-bold">{{ metrics.npu }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">NPU Utilization</div>
              </v-col>
              
              <v-col cols="6" class="py-2">
                <v-progress-circular
                  :model-value="metrics.ram"
                  :size="90"
                  :width="8"
                  color="teal"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-body-2 font-weight-bold">{{ metrics.ram }}%</span>
                </v-progress-circular>
                <div class="text-caption text-grey">RAM Utilization</div>
              </v-col>
              
              <v-col cols="6" class="py-2">
                <v-progress-circular
                  :model-value="metrics.temp"
                  :size="90"
                  :width="8"
                  color="rose"
                  class="font-weight-bold mb-1"
                >
                  <span class="text-body-2 font-weight-bold">{{ metrics.temp }}°C</span>
                </v-progress-circular>
                <div class="text-caption text-grey">SoC Temperature</div>
              </v-col>
            </v-row>
          </v-card>

          <!-- Model Manager Panel -->
          <v-card class="glass-card pa-5 flex-grow-1">
            <div class="text-h6 font-weight-bold mb-4 d-flex align-center">
              <v-icon start color="primary">mdi-folder-open-outline</v-icon>
              Model Manager
            </div>

            <!-- Active Status Card -->
            <v-alert
              v-if="status.isLoaded"
              type="success"
              variant="tonal"
              border="start"
              class="mb-4"
              density="comfortable"
            >
              <div class="font-weight-bold text-truncate">Loaded: {{ status.model }}</div>
              <div class="text-caption">Platform: {{ status.isMock ? 'Mock Engine' : 'Rockchip NPU' }}</div>
            </v-alert>
            <v-alert
              v-else
              type="warning"
              variant="tonal"
              border="start"
              class="mb-4"
              density="comfortable"
            >
              No active model loaded in NPU
            </v-alert>

            <!-- Models list -->
            <div class="d-flex align-center justify-space-between mb-2">
              <div class="text-subtitle-2 text-grey">Available .rkllm files</div>
              <v-btn icon size="x-small" variant="text" color="grey" title="Rescan models directory" :loading="scanningModels" @click="rescanModels">
                <v-icon size="16">mdi-refresh</v-icon>
              </v-btn>
            </div>
            <v-list bg-color="transparent" class="pa-0 max-list-height overflow-y-auto mb-4 border rounded">
              <v-list-item
                v-for="model in models"
                :key="model.id"
                class="border-bottom py-3"
              >
                <template v-slot:prepend>
                  <v-icon color="grey-darken-1">mdi-file-code-outline</v-icon>
                </template>
                <v-list-item-title class="font-weight-bold text-truncate">
                  {{ modelSettings[model.id]?.display_name || model.id }}
                </v-list-item-title>
                <v-list-item-subtitle>{{ formatBytes(model.size) }}</v-list-item-subtitle>

                <template v-slot:append>
                  <div class="d-flex align-center gap-1">
                    <v-btn
                      icon
                      size="x-small"
                      variant="text"
                      color="grey"
                      title="Model Settings"
                      @click.stop="openSettings(model)"
                    >
                      <v-icon size="16">mdi-cog-outline</v-icon>
                    </v-btn>
                    <v-btn
                      icon
                      size="x-small"
                      variant="text"
                      color="error"
                      title="Delete Model"
                      :disabled="status.model === model.id"
                      @click.stop="openDeleteConfirm(model)"
                    >
                      <v-icon size="16">mdi-delete-outline</v-icon>
                    </v-btn>
                    <v-btn
                      v-if="status.model === model.id"
                      color="error"
                      size="small"
                      variant="flat"
                      :loading="loadingModelId === model.id"
                      @click="unloadModel(model.id)"
                    >
                      Unload
                    </v-btn>
                    <v-btn
                      v-else
                      color="primary"
                      size="small"
                      variant="tonal"
                      :loading="loadingModelId === model.id"
                      :disabled="loadingModelId !== null && loadingModelId !== model.id"
                      @click="loadModel(model.id)"
                    >
                      Load
                    </v-btn>
                  </div>
                </template>
              </v-list-item>
              <div v-if="models.length === 0" class="text-center py-4 text-grey">
                No models found in scan directory.
              </div>
            </v-list>

            <!-- Model Settings Dialog -->
            <v-dialog v-model="settingsDialog" max-width="460" scrollable>
              <v-card class="glass-card" v-if="settingsTarget">
                <v-card-title class="d-flex align-center justify-space-between pa-4 border-bottom">
                  <div>
                    <div class="text-subtitle-1 font-weight-bold d-flex align-center">
                      <v-icon start color="primary" size="18">mdi-cog-outline</v-icon>
                      Model Settings
                    </div>
                    <div class="text-caption text-grey text-truncate" style="max-width: 340px;">{{ settingsTarget.id }}</div>
                  </div>
                  <v-btn icon size="small" variant="text" @click="settingsDialog = false">
                    <v-icon>mdi-close</v-icon>
                  </v-btn>
                </v-card-title>

                <v-card-text class="pa-4">
                  <div class="text-caption text-grey mb-1">Display Name</div>
                  <v-text-field
                    v-model="settingsForm.display_name"
                    :placeholder="settingsTarget.id"
                    density="compact"
                    variant="outlined"
                    hide-details
                    class="mb-4"
                  ></v-text-field>

                  <div class="text-subtitle-2 font-weight-bold mb-3 mt-1">Sampling Defaults</div>
                  <div class="text-caption text-grey mb-4">Leave at 0 / empty to use the chat playground sliders.</div>

                  <v-row no-gutters class="align-center mb-3">
                    <v-col cols="5" class="text-caption">Temperature</v-col>
                    <v-col cols="5">
                      <v-slider v-model="settingsForm.temperature" min="0" max="2" step="0.05" density="compact" color="primary" hide-details></v-slider>
                    </v-col>
                    <v-col cols="2" class="pl-2">
                      <v-text-field v-model.number="settingsForm.temperature" type="number" density="compact" variant="outlined" hide-details min="0" max="2" step="0.05" style="width:56px"></v-text-field>
                    </v-col>
                  </v-row>

                  <v-row no-gutters class="align-center mb-3">
                    <v-col cols="5" class="text-caption">Top P</v-col>
                    <v-col cols="5">
                      <v-slider v-model="settingsForm.top_p" min="0" max="1" step="0.05" density="compact" color="primary" hide-details></v-slider>
                    </v-col>
                    <v-col cols="2" class="pl-2">
                      <v-text-field v-model.number="settingsForm.top_p" type="number" density="compact" variant="outlined" hide-details min="0" max="1" step="0.05" style="width:56px"></v-text-field>
                    </v-col>
                  </v-row>

                  <v-row no-gutters class="align-center mb-3">
                    <v-col cols="5" class="text-caption">Top K <span class="text-grey">(0=off)</span></v-col>
                    <v-col cols="5">
                      <v-slider v-model="settingsForm.top_k" min="0" max="100" step="1" density="compact" color="primary" hide-details></v-slider>
                    </v-col>
                    <v-col cols="2" class="pl-2">
                      <v-text-field v-model.number="settingsForm.top_k" type="number" density="compact" variant="outlined" hide-details min="0" max="100" style="width:56px"></v-text-field>
                    </v-col>
                  </v-row>

                  <v-row no-gutters class="align-center mb-3">
                    <v-col cols="5" class="text-caption">Rep. Penalty <span class="text-grey">(1=off)</span></v-col>
                    <v-col cols="5">
                      <v-slider v-model="settingsForm.rep_penalty" min="1" max="2" step="0.05" density="compact" color="primary" hide-details></v-slider>
                    </v-col>
                    <v-col cols="2" class="pl-2">
                      <v-text-field v-model.number="settingsForm.rep_penalty" type="number" density="compact" variant="outlined" hide-details min="1" max="2" step="0.05" style="width:56px"></v-text-field>
                    </v-col>
                  </v-row>

                  <v-row no-gutters class="align-center mb-3">
                    <v-col cols="5" class="text-caption">Max New Tokens</v-col>
                    <v-col cols="5">
                      <v-slider v-model="settingsForm.max_new_tokens" min="128" max="4096" step="128" density="compact" color="primary" hide-details></v-slider>
                    </v-col>
                    <v-col cols="2" class="pl-2">
                      <v-text-field v-model.number="settingsForm.max_new_tokens" type="number" density="compact" variant="outlined" hide-details min="128" max="4096" style="width:56px"></v-text-field>
                    </v-col>
                  </v-row>

                  <v-divider class="my-4"></v-divider>

                  <div class="text-subtitle-2 font-weight-bold mb-2">Idle Auto-Unload TTL</div>
                  <div class="text-caption text-grey mb-2">Per-model override. 0 = use global setting.</div>
                  <v-row no-gutters class="align-center">
                    <v-col cols="8">
                      <v-slider v-model="settingsForm.ttl_minutes" min="0" max="120" step="5" density="compact" color="teal" hide-details></v-slider>
                    </v-col>
                    <v-col cols="4" class="pl-3">
                      <v-chip size="small" class="font-weight-bold">
                        {{ settingsForm.ttl_minutes === 0 ? 'Global' : `${settingsForm.ttl_minutes}m` }}
                      </v-chip>
                    </v-col>
                  </v-row>
                </v-card-text>

                <v-card-actions class="pa-4 border-top justify-end gap-2">
                  <v-btn variant="text" color="grey" @click="settingsDialog = false">Cancel</v-btn>
                  <v-btn variant="flat" color="primary" :loading="settingsSaving" @click="saveSettings">Save</v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>

            <!-- Delete Confirm Dialog -->
            <v-dialog v-model="deleteDialog" max-width="400">
              <v-card class="glass-card" v-if="deleteTarget">
                <v-card-title class="pa-4 d-flex align-center">
                  <v-icon color="error" class="mr-2">mdi-alert-circle-outline</v-icon>
                  Delete Model
                </v-card-title>
                <v-card-text class="pa-4 pt-0">
                  <p class="mb-1">Are you sure you want to permanently delete:</p>
                  <p class="font-weight-bold text-truncate">{{ deleteTarget.id }}</p>
                  <p class="text-caption text-grey mt-2">This removes the .rkllm file from disk. This cannot be undone.</p>
                </v-card-text>
                <v-card-actions class="pa-4 justify-end gap-2">
                  <v-btn variant="text" color="grey" @click="deleteDialog = false">Cancel</v-btn>
                  <v-btn variant="flat" color="error" :loading="deleteLoading" @click="confirmDelete">Delete</v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>

            <!-- Settings -->
            <div class="text-subtitle-2 text-grey mb-2">Inactivity Auto-Unload Timeout</div>
            <v-row no-gutters class="align-center">
              <v-col cols="8">
                <v-slider
                  v-model="timeoutSlider"
                  :min="0"
                  :max="30"
                  :step="1"
                  color="primary"
                  density="compact"
                  hide-details
                ></v-slider>
              </v-col>
              <v-col cols="4" class="text-right pl-2">
                <v-chip size="small" class="font-weight-bold">
                  {{ timeoutSlider === 0 ? 'Disabled' : `${timeoutSlider}m` }}
                </v-chip>
              </v-col>
            </v-row>
            <v-btn block color="primary" variant="outlined" size="small" class="mt-3 font-weight-bold" @click="saveTimeout">
              Save Timeout
            </v-btn>
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

        <!-- Right Side: Chat Playground & Logs -->
        <v-col cols="12" md="8" class="d-flex flex-column gap-6 fill-height align-self-stretch">
          
          <!-- Chat Arena -->
          <v-card class="glass-card d-flex flex-column flex-grow-1 flex-shrink-0" style="min-height: 480px; height: 0;">
            <div class="text-h6 font-weight-bold px-5 py-4 border-bottom d-flex align-center justify-space-between">
              <div class="d-flex align-center flex-shrink-0">
                <v-icon start color="primary">mdi-chat-outline</v-icon>
                Inference Playground
              </div>
              <div class="d-flex align-center gap-2 ml-4">
                <v-select
                  v-model="playgroundModel"
                  :items="modelSelectItems"
                  density="compact"
                  hide-details
                  variant="outlined"
                  style="min-width: 200px; max-width: 340px;"
                  placeholder="Select a model..."
                  :loading="loadingModelId !== null"
                  @update:modelValue="onPlaygroundModelChange"
                ></v-select>
                <v-btn size="small" color="grey" variant="text" @click="clearChat" icon>
                  <v-icon size="18">mdi-trash-can-outline</v-icon>
                </v-btn>
              </div>
            </div>

            <!-- Chat messages -->
            <div class="chat-messages-container pa-5 flex-grow-1 overflow-y-auto" ref="chatContainer">
              <div
                v-for="(msg, idx) in chatHistory"
                :key="idx"
                :class="['d-flex mb-4', msg.role === 'user' ? 'justify-end' : 'justify-start']"
              >
                <!-- Avatar Assistant -->
                <v-avatar v-if="msg.role !== 'user'" color="primary" class="mr-3" size="36">
                  <v-icon color="white">mdi-robot-outline</v-icon>
                </v-avatar>

                <div :class="['message-bubble pa-3 rounded-lg', msg.role === 'user' ? 'bg-primary text-white' : 'bg-surface-variant']" style="max-width: 80%;">
                  <!-- Rich markdown-like formatting -->
                  <div class="message-text" v-html="formatMessage(msg.content)"></div>
                  
                  <!-- Performance stats -->
                  <div v-if="msg.perf" class="text-caption text-grey-lighten-1 mt-2 border-top-dashed pt-1">
                    Prefill: {{ msg.perf.prefill_time_ms.toFixed(1) }}ms | 
                    Rate: {{ (msg.perf.generate_tokens / (msg.perf.generate_time_ms / 1000)).toFixed(1) }} t/s
                  </div>
                </div>

                <!-- Avatar User -->
                <v-avatar v-if="msg.role === 'user'" color="teal" class="ml-3" size="36">
                  <v-icon color="white">mdi-account</v-icon>
                </v-avatar>
              </div>
              
              <!-- Loader when generating -->
              <div v-if="generating && chatHistory[chatHistory.length-1].role === 'user'" class="d-flex justify-start mb-4">
                <v-avatar color="primary" class="mr-3" size="36">
                  <v-icon color="white">mdi-robot-outline</v-icon>
                </v-avatar>
                <div class="message-bubble pa-3 rounded-lg bg-surface-variant d-flex align-center">
                  <span class="pulse-dot"></span>
                  <span class="pulse-dot delay-1"></span>
                  <span class="pulse-dot delay-2"></span>
                </div>
              </div>
            </div>

            <!-- Chat input and parameters -->
            <v-divider></v-divider>
            <div class="pa-4 bg-slate-input">
              <v-row class="align-center">
                <v-col cols="12" sm="8" class="pr-sm-2">
                  <v-text-field
                    v-model="promptInput"
                    placeholder="Enter your message..."
                    variant="outlined"
                    density="comfortable"
                    hide-details
                    append-inner-icon="mdi-send"
                    @click:append-inner="sendPrompt"
                    @keyup.enter="sendPrompt"
                    :disabled="!status.isLoaded || generating"
                  ></v-text-field>
                </v-col>
                
                <!-- Sliders for generation params -->
                <v-col cols="12" sm="4" class="d-flex justify-end gap-2 mt-2 mt-sm-0">
                  <v-menu :close-on-content-click="false" location="top">
                    <template v-slot:activator="{ props }">
                      <v-btn v-bind="props" variant="tonal" color="primary" prepend-icon="mdi-tune">
                        Params
                      </v-btn>
                    </template>

                    <v-card width="300" class="pa-4 glass-card">
                      <div class="text-subtitle-2 font-weight-bold mb-3">Inference Parameters</div>
                      <v-slider
                        v-model="params.temperature"
                        min="0.1"
                        max="2.0"
                        step="0.1"
                        label="Temp"
                        thumb-label
                        density="compact"
                        color="primary"
                      ></v-slider>
                      <v-slider
                        v-model="params.top_p"
                        min="0.1"
                        max="1.0"
                        step="0.05"
                        label="Top P"
                        thumb-label
                        density="compact"
                        color="primary"
                      ></v-slider>
                      <v-slider
                        v-model="params.top_k"
                        min="1"
                        max="100"
                        step="1"
                        label="Top K"
                        thumb-label
                        density="compact"
                        color="primary"
                      ></v-slider>
                      <v-slider
                        v-model="params.max_tokens"
                        min="32"
                        max="2048"
                        step="32"
                        label="Max Tokens"
                        thumb-label
                        density="compact"
                        color="primary"
                      ></v-slider>
                    </v-card>
                  </v-menu>
                  <v-btn v-if="generating" color="error" variant="flat" @click="abortInference">
                    Abort
                  </v-btn>
                </v-col>
              </v-row>
            </div>
          </v-card>

          <!-- System Logs Panel -->
          <v-card class="glass-card pa-5 d-flex flex-column" style="height: 250px;">
            <div class="text-subtitle-1 font-weight-bold mb-2 d-flex align-center">
              <v-icon start color="primary">mdi-console-line</v-icon>
              Server System Logs
            </div>
            <v-divider class="mb-2"></v-divider>
            <pre class="terminal-logs flex-grow-1 pa-3 overflow-y-auto" ref="logsContainer">{{ logs }}</pre>
          </v-card>

        </v-col>

      </v-row>
    </v-container>
  </v-main>
</template>

<script>
export default {
  name: 'Dashboard',
  data: () => ({
    username: 'admin',
    metrics: { cpu: 0, npu: 0, ram: 0, temp: 0 },
    models: [],
    status: { isLoaded: false, model: null, isMock: false },
    timeoutSlider: 5,
    actionLoading: false,
    loadingModelId: null,
    promptInput: '',
    chatHistory: [
      { role: 'assistant', content: 'Welcome to the oRKLLM Inference playground! Please load a model in NPU memory on the left sidebar to start testing inference.' }
    ],
    params: {
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 512
    },
    generating: false,
    logs: '',
    metricsWs: null,
    logsWs: null,

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
    settingsDialog: false,
    settingsTarget: null,
    settingsSaving: false,
    settingsForm: {
      display_name: '',
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      rep_penalty: 1.0,
      max_new_tokens: 512,
      ttl_minutes: 0
    },

    // Delete confirm
    deleteDialog: false,
    deleteTarget: null,
    deleteLoading: false,

    // Playground model selector
    playgroundModel: null,

    scanningModels: false,
    appVersion: __APP_VERSION__
  }),
  computed: {
    isDark() {
      return this.$vuetify.theme.global.name.value === 'customDarkTheme';
    },
    modelSelectItems() {
      return this.models.map(m => ({
        title: this.modelSettings[m.id]?.display_name || m.id,
        value: m.id
      }));
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
  },
  beforeUnmount() {
    if (this.metricsWs) this.metricsWs.close();
    if (this.logsWs) this.logsWs.close();
  },
  methods: {
    async fetchAuth() {
      try {
        const res = await fetch('/api/admin/auth-status');
        const data = await res.json();
        if (data.username) this.username = data.username;
      } catch (e) {}
    },
    async fetchModels() {
      try {
        const res = await fetch('/v1/models');
        const data = await res.json();
        this.models = data.data || [];
      } catch (e) {}
    },
    async rescanModels() {
      this.scanningModels = true;
      try {
        await this.fetchModels();
        await this.fetchModelSettings();
      } finally {
        this.scanningModels = false;
      }
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
        if (data.options && typeof data.options.idleTimeoutMs === 'number') {
          this.timeoutSlider = Math.round(data.options.idleTimeoutMs / 60000);
        }
        if (data.model && this.playgroundModel !== data.model) {
          this.playgroundModel = data.model;
        }
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
    async openSettings(model) {
      this.settingsTarget = model;
      const saved = this.modelSettings[model.id] || {};
      this.settingsForm = {
        display_name: saved.display_name || '',
        temperature: saved.temperature ?? 0.8,
        top_p: saved.top_p ?? 0.9,
        top_k: saved.top_k ?? 40,
        rep_penalty: saved.rep_penalty ?? 1.0,
        max_new_tokens: saved.max_new_tokens ?? 512,
        ttl_minutes: saved.ttl_minutes ?? 0
      };
      this.settingsDialog = true;
    },
    async saveSettings() {
      if (!this.settingsTarget) return;
      this.settingsSaving = true;
      try {
        const res = await fetch(`/api/admin/models/settings/${encodeURIComponent(this.settingsTarget.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.settingsForm)
        });
        if (res.ok) {
          this.modelSettings[this.settingsTarget.id] = { ...this.settingsForm };
          this.settingsDialog = false;
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to save settings');
        }
      } catch (e) {
        alert('Network connection error');
      } finally {
        this.settingsSaving = false;
      }
    },
    openDeleteConfirm(model) {
      this.deleteTarget = model;
      this.deleteDialog = true;
    },
    async confirmDelete() {
      if (!this.deleteTarget) return;
      this.deleteLoading = true;
      try {
        const res = await fetch(`/api/admin/models/${encodeURIComponent(this.deleteTarget.id)}`, { method: 'DELETE' });
        if (res.ok) {
          delete this.modelSettings[this.deleteTarget.id];
          this.deleteDialog = false;
          this.deleteTarget = null;
          await this.fetchModels();
          await this.fetchAllModelSettings();
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to delete model');
        }
      } catch (e) {
        alert('Network connection error');
      } finally {
        this.deleteLoading = false;
      }
    },
    async loadModel(modelId) {
      this.loadingModelId = modelId;
      try {
        const saved = this.modelSettings[modelId] || {};
        const maxTokens = saved.max_new_tokens || this.params.max_tokens;
        const res = await fetch('/api/admin/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, options: { max_new_tokens: maxTokens } })
        });
        if (res.ok) {
          this.playgroundModel = modelId;
          if (saved.temperature) this.params.temperature = saved.temperature;
          if (saved.top_p) this.params.top_p = saved.top_p;
          if (saved.top_k) this.params.top_k = saved.top_k;
          if (saved.max_new_tokens) this.params.max_tokens = saved.max_new_tokens;
          await this.fetchStatus();
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to load model');
        }
      } catch (e) {
        alert('Network connection error');
      } finally {
        this.loadingModelId = null;
      }
    },
    async onPlaygroundModelChange(modelId) {
      if (modelId && modelId !== this.status.model) {
        await this.loadModel(modelId);
      }
    },
    async unloadModel(modelId) {
      this.loadingModelId = modelId;
      try {
        const res = await fetch('/api/admin/unload', { method: 'POST' });
        if (res.ok) {
          await this.fetchStatus();
        }
      } catch (e) {
        alert('Network connection error');
      } finally {
        this.loadingModelId = null;
      }
    },
    async saveTimeout() {
      try {
        const res = await fetch('/api/admin/timeout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeout: this.timeoutSlider })
        });
        if (res.ok) {
          alert('Timeout saved successfully');
        }
      } catch (e) {
        alert('Network error saving timeout');
      }
    },
    toggleTheme() {
      const next = this.isDark ? 'customLightTheme' : 'customDarkTheme';
      this.$vuetify.theme.global.name.value = next;
      localStorage.setItem('orkllm-theme', next);
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
      const logsUrl = `${protocol}//${host}/ws/logs`;

      console.log(`[WS] Connecting to metrics: ${metricsUrl}`);
      console.log(`[WS] Connecting to logs: ${logsUrl}`);

      // Metrics WebSocket
      this.metricsWs = new WebSocket(metricsUrl);
      this.metricsWs.onopen = () => console.log('[WS] Metrics WebSocket connected');
      this.metricsWs.onerror = (err) => console.error('[WS] Metrics WebSocket error', err);
      this.metricsWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.metrics.cpu = data.cpu;
          this.metrics.npu = data.npu;
          this.metrics.ram = data.ram.percentage;
          this.metrics.temp = data.temperature;
          if (data.stats) {
            this.stats = data.stats;
          }
        } catch (e) {}
      };
      this.metricsWs.onclose = (event) => {
        console.log(`[WS] Metrics WebSocket closed. Code: ${event.code}. Reason: ${event.reason}`);
        setTimeout(() => this.initWebSockets(), 5000); // Retry reconnect in 5s
      };

      // Logs WebSocket
      this.logsWs = new WebSocket(logsUrl);
      this.logsWs.onopen = () => console.log('[WS] Logs WebSocket connected');
      this.logsWs.onerror = (err) => console.error('[WS] Logs WebSocket error', err);
      this.logsWs.onmessage = (event) => {
        this.logs += event.data;
        // Auto scroll to bottom
        this.$nextTick(() => {
          const logsEl = this.$refs.logsContainer;
          if (logsEl) logsEl.scrollTop = logsEl.scrollHeight;
        });
      };
      this.logsWs.onclose = (event) => {
        console.log(`[WS] Logs WebSocket closed. Code: ${event.code}. Reason: ${event.reason}`);
      };
    },
    clearChat() {
      this.chatHistory = [
        { role: 'assistant', content: 'Chat history cleared. You can start a new testing session.' }
      ];
    },
    async sendPrompt() {
      if (!this.promptInput.trim() || !this.status.isLoaded || this.generating) return;
      
      const userPrompt = this.promptInput;
      this.promptInput = '';
      this.chatHistory.push({ role: 'user', content: userPrompt });
      
      // Auto-scroll chat
      this.scrollToBottom();

      this.generating = true;
      
      // Create empty assistant response entry
      this.chatHistory.push({ role: 'assistant', content: '' });
      const assistantMessage = this.chatHistory[this.chatHistory.length - 1];

      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.playgroundModel || this.status.model,
            messages: this.chatHistory.slice(0, -1).map(c => ({ role: c.role, content: c.content })),
            stream: true,
            temperature: this.params.temperature,
            top_p: this.params.top_p,
            top_k: this.params.top_k,
            max_tokens: this.params.max_tokens
          })
        });

        if (!res.ok) {
          const data = await res.json();
          assistantMessage.content = `Error: ${data.error || 'Failed to generate completion'}`;
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
          buffer = lines.pop(); // Hold onto incomplete lines

          for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine.startsWith('data: ')) continue;
            
            const dataStr = cleanLine.substring(6);
            if (dataStr === '[DONE]') continue;

            try {
              const dataObj = JSON.parse(dataStr);
              if (dataObj.choices && dataObj.choices[0].delta && dataObj.choices[0].delta.content) {
                assistantMessage.content += dataObj.choices[0].delta.content;
                this.scrollToBottom();
              }
              if (dataObj.perf) {
                assistantMessage.perf = dataObj.perf;
              }
            } catch (err) {}
          }
        }
      } catch (err) {
        assistantMessage.content += `\n[Stream Error: ${err.message}]`;
      } finally {
        this.generating = false;
        this.scrollToBottom();
      }
    },
    async abortInference() {
      try {
        await fetch('/api/admin/unload', { method: 'POST' }); // Swaps worker releases NPU
        await this.fetchStatus();
        this.generating = false;
      } catch (e) {}
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const chatEl = this.$refs.chatContainer;
        if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
      });
    },
    formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },
    formatMessage(content) {
      if (!content) return '';
      // Escape HTML tags to prevent cross site scripting
      let text = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Simple code block matching (```code```)
      text = text.replace(/```([\s\S]+?)```/g, (match, code) => {
        return `<pre class="code-block pa-2 my-2 rounded font-mono text-caption">${code}</pre>`;
      });

      // Simple inline code (`code`)
      text = text.replace(/`([^`\n]+?)`/g, '<code class="inline-code px-1 rounded font-mono">$1</code>');

      // Bold (**text**)
      text = text.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');

      // Line breaks
      text = text.replace(/\n/g, '<br/>');

      return text;
    }
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

.max-list-height {
  max-height: 250px;
}

.chat-messages-container {
  background: rgba(10, 15, 30, 0.3);
}

.message-bubble {
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  line-height: 1.5;
}

.bg-surface-variant {
  background-color: #1F2937 !important;
}

.bg-slate-input {
  background: rgba(17, 24, 39, 0.9);
}

.terminal-logs {
  background-color: #030712 !important;
  color: #10B981 !important;
  border-radius: 8px;
  font-family: 'Fira Code', 'Courier New', Courier, monospace;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
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

.inline-code {
  background: #111827 !important;
  color: #F43F5E !important;
}
</style>
