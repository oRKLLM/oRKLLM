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

      <div class="text-h5 font-weight-bold mb-1">Models</div>
      <div class="text-caption text-grey mb-5">Manage and download servable .rkllm models, base models, and Eagle-3 draft heads.</div>

      <v-tabs v-model="tab" color="primary" class="mb-5">
        <v-tab value="manager">
          <v-icon start>mdi-folder-open-outline</v-icon>
          Manager
        </v-tab>
        <v-tab value="downloader">
          <v-icon start>mdi-download-outline</v-icon>
          Downloader
        </v-tab>
      </v-tabs>

      <v-tabs-window v-model="tab">

        <!-- Manager Tab -->
        <v-tabs-window-item value="manager">

          <!-- Active Status -->
          <!-- Loaded -->
          <v-alert
            v-if="status.isLoaded && !loadingModelId"
            type="success"
            variant="tonal"
            border="start"
            class="mb-4"
            density="comfortable"
          >
            <div class="font-weight-bold text-truncate">Loaded: {{ status.model }}</div>
            <div class="text-caption">Platform: {{ status.isMock ? 'Mock Engine' : 'Rockchip NPU' }}</div>
          </v-alert>
          <!-- Loading -->
          <v-alert
            v-else-if="loadingModelId"
            type="warning"
            variant="tonal"
            border="start"
            class="mb-4"
            density="comfortable"
          >
            <div class="d-flex align-center gap-2">
              <v-progress-circular indeterminate size="18" width="2" color="warning" class="mr-2"></v-progress-circular>
              <div>
                <div class="font-weight-bold text-truncate">Loading: {{ loadingModelId }}</div>
                <div class="text-caption">Initialising NPU…</div>
              </div>
            </div>
          </v-alert>
          <!-- Nothing loaded -->
          <v-alert
            v-else
            color="grey"
            variant="tonal"
            border="start"
            class="mb-4"
            density="comfortable"
          >
            No active model loaded in NPU
          </v-alert>

          <!-- Wide screens: model list (left) beside the Eagle-3 / auto-unload sidebar (right) -->
          <v-row>
          <v-col cols="12" lg="8">
          <!-- Models Summary -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="text-h6 font-weight-bold d-flex align-center mb-3">
              <v-icon start color="primary">mdi-chart-box-outline</v-icon>
              Models Summary
            </div>
            <v-row dense>
              <v-col cols="6" sm="3">
                <div class="text-h5 font-weight-bold">{{ models.length }}</div>
                <div class="text-caption text-grey">servable models</div>
              </v-col>
              <v-col cols="6" sm="3">
                <div class="text-h5 font-weight-bold">{{ library.base.length }}</div>
                <div class="text-caption text-grey">base models</div>
              </v-col>
              <v-col cols="6" sm="3">
                <div class="text-h5 font-weight-bold">{{ library.eagle3.length }}</div>
                <div class="text-caption text-grey">draft heads</div>
              </v-col>
              <v-col cols="6" sm="3">
                <div class="text-h5 font-weight-bold text-primary">{{ formatBytes(totalStorageBytes) }}</div>
                <div class="text-caption text-grey">total storage</div>
              </v-col>
            </v-row>
            <div v-if="library.disk" class="text-caption text-grey mt-3 d-flex align-center">
              <v-icon size="14" start>mdi-harddisk</v-icon>
              {{ formatBytes(library.disk.freeBytes) }} free of {{ formatBytes(library.disk.totalBytes) }} on disk
            </div>
          </v-card>

          <v-card class="glass-card pa-5 mb-5">
            <div class="d-flex align-center justify-space-between mb-4">
              <div class="text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-folder-open-outline</v-icon>
                Available Models
                <span class="text-caption text-grey ml-2 font-weight-regular">{{ formatBytes(modelsTotalBytes) }}</span>
              </div>
              <v-btn icon size="small" variant="text" color="grey" title="Rescan models directory" :loading="scanningModels" @click="rescanModels">
                <v-icon>mdi-refresh</v-icon>
              </v-btn>
            </div>

            <v-list bg-color="transparent" class="pa-0 border rounded">
              <v-list-item
                v-for="model in models"
                :key="model.id"
                class="border-bottom py-3 px-4"
              >
                <div class="d-flex flex-column flex-sm-row align-start align-sm-center justify-space-between w-100 gap-3">
                  <!-- Left side: Icon + Text -->
                  <div class="d-flex align-start gap-3" style="min-width: 0; flex: 1; width: 100%;">
                    <v-icon color="grey-darken-1" class="mt-1" style="flex-shrink: 0;">mdi-file-code-outline</v-icon>
                    <div style="min-width: 0; flex: 1;">
                      <div class="font-weight-bold text-break text-body-1" style="word-break: break-all;">
                        {{ modelSettings[model.id]?.display_name || model.id }}
                      </div>
                      <div class="d-flex align-center flex-wrap gap-2 mt-1">
                        <span class="text-caption text-grey">{{ formatBytes(model.size) }}</span>
                        <v-chip size="x-small" :color="model.runtime === 'llama' ? 'teal' : 'primary'" variant="tonal">
                          {{ model.runtime === 'llama' ? 'llama / .gguf' : 'rkllm / .rkllm' }}
                        </v-chip>
                      </div>
                    </div>
                  </div>

                  <!-- Right side: Actions -->
                  <div class="d-flex align-center flex-wrap gap-2" style="flex-shrink: 0;">
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
                      :color="status.pinned ? 'warning' : 'default'"
                      size="small"
                      variant="tonal"
                      :title="status.pinned ? 'Unpin model (re-enable idle timeout)' : 'Pin model (prevent auto-unload)'"
                      @click="togglePin"
                    >
                      <v-icon size="16" class="mr-1">{{ status.pinned ? 'mdi-pin' : 'mdi-pin-outline' }}</v-icon>
                      {{ status.pinned ? 'Pinned' : 'Pin' }}
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
                </div>
              </v-list-item>
              <div v-if="models.length === 0" class="text-center py-6 text-grey">
                No models found in scan directory.
              </div>
            </v-list>
          </v-card>
          </v-col>

          <v-col cols="12" lg="4">
          <!-- Eagle-3 Draft Heads -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="d-flex align-center justify-space-between mb-4">
              <div class="text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="purple">mdi-lightning-bolt-outline</v-icon>
                Eagle-3 Draft Heads
                <span class="text-caption text-grey ml-2 font-weight-regular">{{ formatBytes(eagle3TotalBytes) }}</span>
              </div>
              <v-btn icon size="small" variant="text" color="grey" title="Rescan" @click="fetchEagle3Heads(); fetchLibrary();">
                <v-icon>mdi-refresh</v-icon>
              </v-btn>
            </div>
            <v-list bg-color="transparent" class="pa-0 border rounded">
              <v-list-item
                v-for="head in library.eagle3"
                :key="head.dir"
                class="border-bottom py-3 px-4"
              >
                <div class="d-flex flex-column flex-sm-row align-start align-sm-center justify-space-between w-100 gap-3">
                  <!-- Left side: Icon + Text -->
                  <div class="d-flex align-start gap-3" style="min-width: 0; flex: 1; width: 100%;">
                    <v-icon color="purple" class="mt-1" style="flex-shrink: 0;">mdi-head-flash-outline</v-icon>
                    <div style="min-width: 0; flex: 1;">
                      <div class="font-weight-bold text-break text-body-1" style="word-break: break-all;">
                        {{ head.dir }}
                      </div>
                      <div class="d-flex align-center flex-wrap gap-2 mt-1">
                        <v-chip size="x-small" :color="head.format === 'npu' ? 'primary' : 'purple'" variant="tonal">
                          {{ head.format === 'npu' ? 'NPU (.rkllm)' : 'Vulkan (.safetensors)' }}
                        </v-chip>
                        <v-chip size="x-small" :color="head.embeddingsPresent ? 'success' : 'warning'" variant="tonal">
                          <v-icon start size="x-small">{{ head.embeddingsPresent ? 'mdi-check' : 'mdi-alert-outline' }}</v-icon>
                          {{ head.embeddingsPresent ? 'embeddings ready' : 'embeddings missing' }}
                        </v-chip>
                      </div>
                    </div>
                  </div>

                  <!-- Right side: Actions -->
                  <div class="d-flex align-center gap-1" style="flex-shrink: 0;">
                    <v-btn v-if="!head.embeddingsPresent" size="x-small" variant="tonal" color="purple" @click="openEmbedDialog(head)">Add embeddings</v-btn>
                    <v-btn icon size="x-small" variant="text" color="error" title="Delete head" @click="openDirDelete(head.dir, 'Eagle-3 draft head')">
                      <v-icon size="16">mdi-delete-outline</v-icon>
                    </v-btn>
                  </div>
                </div>
              </v-list-item>
              <div v-if="library.eagle3.length === 0" class="text-center py-6 text-grey">
                No Eagle-3 draft heads found. Download a head with "Eagle-3" in its name or path.
              </div>
            </v-list>
            <div class="text-caption text-grey mt-2">
              Vulkan heads need their base model's embeddings (not shipped in the head repo).
            </div>
          </v-card>

          <!-- Base Models (Eagle-3 embedding source) -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="d-flex align-center justify-space-between mb-4">
              <div class="text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="teal">mdi-database-outline</v-icon>
                Base Models
                <span class="text-caption text-grey ml-2 font-weight-regular">{{ formatBytes(baseTotalBytes) }}</span>
              </div>
              <v-btn icon size="small" variant="text" color="grey" title="Rescan" @click="fetchLibrary">
                <v-icon>mdi-refresh</v-icon>
              </v-btn>
            </div>
            <v-list bg-color="transparent" class="pa-0 border rounded">
              <v-list-item v-for="b in library.base" :key="b.dir" class="border-bottom py-3 px-4">
                <div class="d-flex align-start gap-3" style="min-width: 0; width: 100%;">
                  <v-icon color="teal" class="mt-1" style="flex-shrink: 0;">mdi-cube-outline</v-icon>
                  <div style="min-width: 0; flex: 1;">
                    <div class="font-weight-bold text-break text-body-1" style="word-break: break-all;">
                      {{ b.dir }}
                    </div>
                    <div class="d-flex align-center flex-wrap gap-2 mt-1">
                      <v-chip v-if="b.arch" size="x-small" color="teal" variant="tonal">{{ b.arch }}</v-chip>
                      <v-chip size="x-small" :color="b.hasEmbeddings ? 'success' : 'grey'" variant="tonal">
                        {{ b.hasEmbeddings ? 'has embed_tokens' : 'no embed_tokens' }}
                      </v-chip>
                    </div>
                  </div>
                  <v-btn icon size="x-small" variant="text" color="error" style="flex-shrink: 0;" title="Delete base model" @click="openDirDelete(b.dir, 'base model')">
                    <v-icon size="16">mdi-delete-outline</v-icon>
                  </v-btn>
                </div>
              </v-list-item>
              <div v-if="library.base.length === 0" class="text-center py-6 text-grey">
                No base models downloaded. Download a base model to supply Eagle-3 embeddings.
              </div>
            </v-list>
          </v-card>

          <!-- Add embeddings dialog -->
          <v-dialog v-model="embedDialog" max-width="560">
            <v-card class="glass-card pa-2">
              <v-card-title class="text-h6">Add base-model embeddings</v-card-title>
              <v-card-subtitle class="text-wrap">
                {{ embedTarget?.dir }} needs its base model's <code>embed_tokens</code>.
              </v-card-subtitle>
              <v-card-text>
                <v-radio-group v-model="embedSource" density="compact" hide-details class="mb-3">
                  <v-radio value="local" label="Use a downloaded base model" :disabled="library.base.filter(b=>b.hasEmbeddings).length===0"></v-radio>
                  <v-radio value="repo" label="Fetch the embedding slice from a base repo (~778 MB)"></v-radio>
                </v-radio-group>

                <v-select
                  v-if="embedSource === 'local'"
                  v-model="embedBaseDir"
                  :items="library.base.filter(b=>b.hasEmbeddings).map(b=>b.dir)"
                  label="Base model"
                  density="compact" variant="outlined" hide-details
                ></v-select>

                <v-text-field
                  v-else
                  v-model="embedBaseRepo"
                  label="Base model HF repo (e.g. Qwen/Qwen3-VL-4B-Instruct)"
                  placeholder="owner/name"
                  density="compact" variant="outlined" hide-details
                ></v-text-field>
                <div class="text-caption text-grey mt-2">
                  Only the embedding tensor is fetched, not the whole model.
                </div>
              </v-card-text>
              <v-card-actions>
                <v-spacer></v-spacer>
                <v-btn variant="text" @click="embedDialog = false">Cancel</v-btn>
                <v-btn color="purple" variant="flat" :loading="embedSubmitting"
                  :disabled="embedSource === 'local' ? !embedBaseDir : !embedBaseRepo.trim()"
                  @click="submitEmbeddings">Fetch embeddings</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>

          <!-- Auto-unload timeout -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="text-subtitle-1 font-weight-bold mb-1 d-flex align-center">
              <v-icon start color="primary">mdi-timer-outline</v-icon>
              Inactivity Auto-Unload Timeout
            </div>
            <div class="text-caption text-grey mb-3">Automatically unload the active model after this period of inactivity.</div>
            <v-row no-gutters class="align-center">
              <v-col cols="9">
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
              <v-col cols="3" class="text-right pl-2">
                <v-chip size="small" class="font-weight-bold">
                  {{ timeoutSlider === 0 ? 'Disabled' : `${timeoutSlider}m` }}
                </v-chip>
              </v-col>
            </v-row>
            <v-btn block color="primary" variant="outlined" size="small" class="mt-3 font-weight-bold" @click="saveTimeout">
              Save Timeout
            </v-btn>
          </v-card>
          </v-col>
          </v-row>

          <!-- Model Settings Dialog -->
          <v-dialog v-model="settingsDialog" max-width="580" scrollable>
            <v-card class="glass-card" v-if="settingsTarget">
              <v-card-title class="d-flex align-center justify-space-between pa-4 border-bottom">
                <div>
                  <div class="text-subtitle-1 font-weight-bold d-flex align-center">
                    <v-icon start color="primary" size="18">mdi-cog-outline</v-icon>
                    Model Settings
                  </div>
                  <div class="text-caption text-grey text-truncate" style="max-width: 440px;">{{ settingsTarget.id }}</div>
                </div>
                <v-btn icon size="small" variant="text" @click="settingsDialog = false">
                  <v-icon>mdi-close</v-icon>
                </v-btn>
              </v-card-title>

              <v-card-text class="pa-4">
                <!-- Display name -->
                <div class="text-caption text-grey mb-1">Display Name</div>
                <v-text-field
                  v-model="settingsForm.display_name"
                  :placeholder="settingsTarget.id"
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="mb-4"
                ></v-text-field>

                <!-- Sampling defaults -->
                <div class="text-subtitle-2 font-weight-bold mb-1 mt-1">Sampling Defaults</div>
                <div class="text-caption text-grey mb-3">Leave at default / 0 to use per-request values.</div>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Temperature</v-col>
                  <v-col cols="5"><v-slider v-model="settingsForm.temperature" min="0" max="2" step="0.05" density="compact" color="primary" hide-details></v-slider></v-col>
                  <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.temperature" type="number" density="compact" variant="outlined" hide-details min="0" max="2" step="0.05" style="width:56px"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Top P</v-col>
                  <v-col cols="5"><v-slider v-model="settingsForm.top_p" min="0" max="1" step="0.05" density="compact" color="primary" hide-details></v-slider></v-col>
                  <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.top_p" type="number" density="compact" variant="outlined" hide-details min="0" max="1" step="0.05" style="width:56px"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Top K <span class="text-grey">(0=off)</span></v-col>
                  <v-col cols="5"><v-slider v-model="settingsForm.top_k" min="0" max="100" step="1" density="compact" color="primary" hide-details></v-slider></v-col>
                  <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.top_k" type="number" density="compact" variant="outlined" hide-details min="0" max="100" style="width:56px"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Rep. Penalty <span class="text-grey">(1=off)</span></v-col>
                  <v-col cols="5"><v-slider v-model="settingsForm.rep_penalty" min="1" max="2" step="0.05" density="compact" color="primary" hide-details></v-slider></v-col>
                  <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.rep_penalty" type="number" density="compact" variant="outlined" hide-details min="1" max="2" step="0.05" style="width:56px"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Presence Penalty</v-col>
                  <v-col cols="5"><v-slider v-model="settingsForm.presence_penalty" min="0" max="2" step="0.05" density="compact" color="primary" hide-details></v-slider></v-col>
                  <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.presence_penalty" type="number" density="compact" variant="outlined" hide-details min="0" max="2" step="0.05" style="width:56px"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Frequency Penalty</v-col>
                  <v-col cols="5"><v-slider v-model="settingsForm.frequency_penalty" min="0" max="2" step="0.05" density="compact" color="primary" hide-details></v-slider></v-col>
                  <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.frequency_penalty" type="number" density="compact" variant="outlined" hide-details min="0" max="2" step="0.05" style="width:56px"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Max New Tokens</v-col>
                  <v-col cols="4"><v-slider v-model="settingsForm.max_new_tokens" :min="128" :max="32768" :step="128" density="compact" color="primary" thumb-label hide-details></v-slider></v-col>
                  <v-col cols="3" class="pl-2"><v-text-field v-model.number="settingsForm.max_new_tokens" type="number" density="compact" variant="outlined" hide-details :min="128" :max="32768"></v-text-field></v-col>
                </v-row>

                <v-row no-gutters class="align-center mb-3">
                  <v-col cols="5" class="text-caption">Ctx Window <span class="text-grey">(tokens; 0=default 4096)</span></v-col>
                  <v-col cols="4"><v-slider v-model="settingsForm.ctx_window" :min="0" :max="32768" :step="512" density="compact" color="primary" thumb-label hide-details></v-slider></v-col>
                  <v-col cols="3" class="pl-2"><v-text-field v-model.number="settingsForm.ctx_window" type="number" density="compact" variant="outlined" hide-details :min="0" :max="32768"></v-text-field></v-col>
                </v-row>

                <!-- TTL -->
                <v-divider class="my-4"></v-divider>
                <div class="text-subtitle-2 font-weight-bold mb-2">Idle Auto-Unload TTL</div>
                <div class="text-caption text-grey mb-2">Per-model override. 0 = use global setting.</div>
                <v-row no-gutters class="align-center mb-4">
                  <v-col cols="8"><v-slider v-model="settingsForm.ttl_minutes" min="0" max="120" step="5" density="compact" color="teal" hide-details></v-slider></v-col>
                  <v-col cols="4" class="pl-3"><v-chip size="small" class="font-weight-bold">{{ settingsForm.ttl_minutes === 0 ? 'Global' : `${settingsForm.ttl_minutes}m` }}</v-chip></v-col>
                </v-row>

                <!-- Advanced -->
                <v-expansion-panels variant="accordion" class="mb-3">
                  <v-expansion-panel>
                    <v-expansion-panel-title class="text-subtitle-2 font-weight-bold py-2 px-0">
                      Advanced
                    </v-expansion-panel-title>
                    <v-expansion-panel-text class="pa-0">
                      <!-- Shown for all models; disabled (forced on) for models with no
                           non-thinking mode (e.g. LFM2.5-MoE always reasons). -->
                      <div class="d-flex align-center justify-space-between py-2">
                        <div>
                          <div class="text-body-2">Enable Thinking</div>
                          <div class="text-caption text-grey">
                            {{ settingsTarget?.thinkingToggle === false
                                ? 'This model always reasons — thinking can’t be disabled'
                                : 'Activate reasoning mode (Qwen3 thinking models)' }}
                          </div>
                        </div>
                        <v-switch
                          :model-value="settingsTarget?.thinkingToggle === false ? true : settingsForm.thinking_enabled"
                          @update:model-value="v => settingsForm.thinking_enabled = v"
                          :disabled="settingsTarget?.thinkingToggle === false"
                          color="primary" hide-details density="compact" class="flex-shrink-0 ml-3"></v-switch>
                      </div>
                      <div class="d-flex align-center justify-space-between py-2">
                        <div>
                          <div class="text-body-2">Force Sampling</div>
                          <div class="text-caption text-grey">Override per-request sampling params with stored values</div>
                        </div>
                        <v-switch v-model="settingsForm.force_sampling" color="primary" hide-details density="compact" class="flex-shrink-0 ml-3"></v-switch>
                      </div>
                      <div class="py-2">
                        <div class="text-body-2 mb-2">Mirostat Sampler</div>
                        <v-select
                          v-model="settingsForm.mirostat"
                          :items="[{title:'Off',value:0},{title:'Mirostat v1',value:1},{title:'Mirostat v2',value:2}]"
                          density="compact"
                          variant="outlined"
                          hide-details
                          class="mb-3"
                        ></v-select>
                        <template v-if="settingsForm.mirostat > 0">
                          <v-row no-gutters class="align-center mb-2">
                            <v-col cols="5" class="text-caption">Tau</v-col>
                            <v-col cols="5"><v-slider v-model="settingsForm.mirostat_tau" min="0" max="10" step="0.1" density="compact" color="primary" hide-details></v-slider></v-col>
                            <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.mirostat_tau" type="number" density="compact" variant="outlined" hide-details min="0" max="10" step="0.1" style="width:56px"></v-text-field></v-col>
                          </v-row>
                          <v-row no-gutters class="align-center">
                            <v-col cols="5" class="text-caption">Eta</v-col>
                            <v-col cols="5"><v-slider v-model="settingsForm.mirostat_eta" min="0" max="1" step="0.01" density="compact" color="primary" hide-details></v-slider></v-col>
                            <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.mirostat_eta" type="number" density="compact" variant="outlined" hide-details min="0" max="1" step="0.01" style="width:56px"></v-text-field></v-col>
                          </v-row>
                        </template>
                      </div>
                    </v-expansion-panel-text>
                  </v-expansion-panel>

                  <!-- KV Cache Compression -->
                  <v-expansion-panel>
                    <v-expansion-panel-title class="text-subtitle-2 font-weight-bold py-2 px-0">
                      KV Cache Compression
                    </v-expansion-panel-title>
                    <v-expansion-panel-text class="pa-0">
                      <div class="text-caption text-grey mb-3">
                        Override the global KV cache compression setting for this model.
                        <template v-if="settingsTarget?.runtime === 'llama'">
                          Sets the <em>in-context</em> KV V-cache type. <strong>TurboQuant</strong> levels compress it
                          on the Mali GPU during decode (K stays at q8_0 — the asymmetric policy). The on-disk prefix
                          cache is that same state serialized natively by the runtime, so the GPU compression runs
                          <em>once</em>, not twice — the llama path never uses the SSD PolarQuant.
                        </template>
                        <template v-else>
                          Quantises the SSD prefix-cache blob (PolarQuant); dequantisation (~0.3 ms per MB of context) runs before each cache hit.
                        </template>
                      </div>
                      <v-select
                        v-model="settingsForm.kv_cache_quant"
                        :items="kvCacheItems"
                        density="compact" variant="outlined" hide-details class="mb-2"
                      ></v-select>
                    </v-expansion-panel-text>
                  </v-expansion-panel>

                  <!-- NPU Execution (llama/gguf only) -->
                  <v-expansion-panel v-if="settingsTarget?.runtime === 'llama'">
                    <v-expansion-panel-title class="text-subtitle-2 font-weight-bold py-2 px-0">
                      NPU Execution
                    </v-expansion-panel-title>
                    <v-expansion-panel-text class="pa-0">
                      <div class="text-caption text-grey mb-3">
                        How the ggml-ork NPU backend runs the model's matmuls. <strong>Auto</strong> matches the
                        file's quant (≥5-bit → INT8, otherwise INT4). The native runtime defaults to pure INT4;
                        force INT8 to keep a Q8/Q6/F16 model at full precision.
                      </div>
                      <v-select
                        v-model="settingsForm.npu_quant"
                        :items="[
                          { title: 'Auto (match the model quant)', value: 'auto' },
                          { title: 'INT4 — W4A4 (fastest, native multi-M)', value: 'int4' },
                          { title: 'INT8 — W8A8 (higher precision)', value: 'int8' },
                        ]"
                        label="Execution precision (ORK_QUANT)"
                        density="compact" variant="outlined" hide-details class="mb-3"
                      ></v-select>
                      <div class="d-flex align-center justify-space-between">
                        <div class="text-caption">
                          Hybrid offload (FFN/attn only)
                          <div class="text-caption text-grey">Keep norms/other ops off the NPU (ORK_HYBRID). Off = pure NPU loading.</div>
                        </div>
                        <v-switch v-model="settingsForm.npu_hybrid" color="primary" hide-details density="compact" class="flex-shrink-0 ml-3"></v-switch>
                      </div>
                    </v-expansion-panel-text>
                  </v-expansion-panel>

                  <!-- Speculative Decoding -->
                  <v-expansion-panel>
                    <v-expansion-panel-title class="text-subtitle-2 font-weight-bold py-2 px-0">
                      Speculative Decoding
                      <v-chip size="x-small" color="primary" variant="tonal" class="ml-2">Eagle-3 live</v-chip>
                    </v-expansion-panel-title>
                    <v-expansion-panel-text class="pa-0">
                      <v-select
                        v-model="settingsForm.speculative_mode"
                        :items="[
                          {title:'Disabled',value:null},
                          {title:'Eagle-3 — pipelined NPU+Mali (3.7× speedup, empirically validated)',value:'eagle3'},
                          {title:'Draft model — separate smaller model (limited speedup on single NPU)',value:'speculative'},
                          {title:'Native MTP (Qwen3 only)',value:'native_mtp'},
                        ]"
                        label="Speculative Mode"
                        density="compact" variant="outlined" hide-details class="mb-3"
                      ></v-select>

                      <!-- Eagle-3 settings -->
                      <template v-if="settingsForm.speculative_mode === 'eagle3'">
                        <div class="text-caption text-grey mb-2">
                          Eagle-3 uses <code>RKLLM_INFER_GET_LAST_HIDDEN_LAYER</code> to extract hidden states,
                          then runs the Eagle draft head on the Mali GPU via Vulkan, then verifies k tokens
                          simultaneously using <code>RKLLM_INFER_GET_LOGITS</code> (constant time regardless of k).
                          Measured speedup: <strong>3.73×</strong> (1.7 vs 0.5 tok/s on 1.7B model, k=4).
                        </div>
                        <v-row no-gutters class="align-center mb-3">
                          <v-col cols="6" class="text-caption">Draft tokens per step (k)</v-col>
                          <v-col cols="4"><v-slider v-model="settingsForm.spec_draft_tokens" min="1" max="8" step="1" density="compact" color="primary" hide-details></v-slider></v-col>
                          <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.spec_draft_tokens" type="number" density="compact" variant="outlined" hide-details min="1" max="8" step="1" style="width:56px"></v-text-field></v-col>
                        </v-row>
                        <v-select
                          v-model="settingsForm.eagle3_strategy"
                          :items="[
                            {title:'CPU placeholder (validates pipeline, no trained head required)',value:'cpu'},
                            {title:'NPU — .rkllm head on a spare NPU core (multi-core chips)',value:'npu'},
                            {title:'Vulkan Mali GPU — .gguf head on the GPU', value:'vulkan'},
                          ]"
                          label="Draft head compute"
                          density="compact" variant="outlined" hide-details class="mb-3"
                        ></v-select>

                        <template v-if="settingsForm.eagle3_strategy === 'npu' || settingsForm.eagle3_strategy === 'vulkan'">
                          <div class="text-caption text-grey mb-1">Eagle-3 draft head</div>
                          <div class="text-caption text-grey mb-2">
                            Select the trained draft head for this target. The
                            <strong>{{ settingsForm.eagle3_strategy === 'vulkan' ? 'Vulkan' : 'NPU' }}</strong> strategy uses a
                            <code>{{ settingsForm.eagle3_strategy === 'vulkan' ? '.gguf' : '.rkllm' }}</code> head.
                            Download published heads from HuggingFace (Eagle-3 filter) or train your own.
                          </div>
                          <v-select
                            v-model="settingsForm.eagle3_weights_path"
                            :items="[
                              {title:'(none — select a draft head)',value:null},
                              ...eagle3Heads
                                .filter(h => h.format === settingsForm.eagle3_strategy)
                                .map(h => ({title: h.id, value: h.id})),
                              ...eagle3Heads
                                .filter(h => h.format !== settingsForm.eagle3_strategy)
                                .map(h => ({title: `${h.id} (${h.format} head — wrong format for this strategy)`, value: h.id})),
                            ]"
                            label="Eagle-3 draft head"
                            density="compact" variant="outlined" hide-details class="mb-2"
                            no-data-text="No Eagle-3 heads found — download one first"
                          ></v-select>
                          <div class="text-caption text-grey">
                            Naming: <code>{Family}-{TargetParams}-Eagle3Draft-{DraftParams}-{Chipset}-{Quant}-{Algo}-v{Version}-EAGLE3.{{ settingsForm.eagle3_strategy === 'vulkan' ? 'gguf' : 'rkllm' }}</code>
                          </div>
                        </template>
                      </template>

                      <!-- Legacy draft model settings -->
                      <template v-if="settingsForm.speculative_mode === 'speculative'">
                        <div class="text-caption text-grey mb-2">
                          Separate draft model — limited speedup on single NPU. Eagle-3 is recommended instead.
                        </div>
                        <v-select
                          v-model="settingsForm.draft_model"
                          :items="[{title:'(none)',value:null},...models.map(m=>({title:m.id,value:m.id}))]"
                          label="Draft Model"
                          density="compact" variant="outlined" hide-details class="mb-3"
                        ></v-select>
                        <v-row no-gutters class="align-center">
                          <v-col cols="6" class="text-caption">Draft tokens per step (k)</v-col>
                          <v-col cols="4"><v-slider v-model="settingsForm.spec_draft_tokens" min="1" max="8" step="1" density="compact" color="primary" hide-details></v-slider></v-col>
                          <v-col cols="2" class="pl-2"><v-text-field v-model.number="settingsForm.spec_draft_tokens" type="number" density="compact" variant="outlined" hide-details min="1" max="8" step="1" style="width:56px"></v-text-field></v-col>
                        </v-row>
                      </template>
                    </v-expansion-panel-text>
                  </v-expansion-panel>
                </v-expansion-panels>
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

          <!-- Delete a base model / Eagle-3 head directory -->
          <v-dialog v-model="dirDeleteDialog" max-width="400">
            <v-card class="glass-card" v-if="dirDeleteTarget">
              <v-card-title class="pa-4 d-flex align-center">
                <v-icon color="error" class="mr-2">mdi-alert-circle-outline</v-icon>
                Delete {{ dirDeleteTarget.label }}
              </v-card-title>
              <v-card-text class="pa-4 pt-0">
                <p class="mb-1">Permanently delete this directory and all its files:</p>
                <p class="font-weight-bold text-truncate">{{ dirDeleteTarget.dir }}</p>
                <p class="text-caption text-grey mt-2">This removes the entire repo folder from disk. This cannot be undone.</p>
              </v-card-text>
              <v-card-actions class="pa-4 justify-end gap-2">
                <v-btn variant="text" color="grey" @click="dirDeleteDialog = false">Cancel</v-btn>
                <v-btn variant="flat" color="error" :loading="dirDeleteLoading" @click="confirmDirDelete">Delete</v-btn>
              </v-card-actions>
            </v-card>
          </v-dialog>

        </v-tabs-window-item>

        <!-- Downloader Tab -->
        <v-tabs-window-item value="downloader">

          <!-- Search HuggingFace -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="text-h6 font-weight-bold mb-1 d-flex align-center">
              <v-icon start color="primary">mdi-magnify</v-icon>
              Search HuggingFace
            </div>
            <div class="text-caption text-grey mb-4">Find .rkllm and .gguf models on HuggingFace Hub.</div>

            <div class="d-flex gap-3 align-start mb-3 flex-wrap">
              <v-text-field
                v-model="searchQuery"
                label="Search models"
                placeholder="e.g. Qwen3, Llama, Mistral"
                variant="outlined"
                density="comfortable"
                hide-details
                prepend-inner-icon="mdi-magnify"
                style="min-width: 220px; flex: 1;"
                @keyup.enter="searchHf"
              ></v-text-field>

              <v-select
                v-model="searchSort"
                :items="[{title:'Most Downloads',value:'downloads'},{title:'Most Likes',value:'likes'},{title:'Trending',value:'trendingScore'},{title:'Recently Updated',value:'lastModified'}]"
                item-title="title"
                item-value="value"
                label="Sort"
                variant="outlined"
                density="comfortable"
                hide-details
                style="max-width: 200px;"
              ></v-select>

              <v-btn
                color="primary"
                variant="flat"
                :loading="searchLoading"
                prepend-icon="mdi-magnify"
                @click="searchHf"
              >
                Search
              </v-btn>
            </div>

            <div class="d-flex gap-4 flex-wrap">
              <v-checkbox
                v-model="searchRkllmOnly"
                label="RKLLM models only"
                density="compact"
                hide-details
                color="primary"
              ></v-checkbox>
              <v-checkbox
                v-model="searchPlatformOnly"
                :label="detectedPlatform ? `Compatible chipset (${detectedPlatform.toUpperCase()}) only` : 'Compatible chipset only'"
                density="compact"
                hide-details
                color="primary"
              ></v-checkbox>
              <v-checkbox
                v-model="searchEagle3Only"
                label="Eagle-3 draft heads only"
                density="compact"
                hide-details
                color="primary"
              ></v-checkbox>
            </div>

            <v-alert v-if="searchError" type="error" variant="tonal" density="compact" class="mb-3 text-caption">
              {{ searchError }}
            </v-alert>

            <!-- Scrollable results container -->
            <div v-if="searchResults.length || searchLoading"
              ref="searchScrollContainer"
              class="search-results-scroll"
              @scroll="onSearchScroll"
            >
              <!-- Each result is an accordion (collapsed by default); expanding lazy-loads the repo's
                   files and lists each downloadable model/variant with its own Download button. -->
              <v-expansion-panels v-model="searchOpen" multiple variant="accordion" bg-color="transparent" class="pa-0">
                <v-expansion-panel v-for="model in searchResults" :key="model.id" :value="model.id" elevation="0" bg-color="transparent">
                  <v-expansion-panel-title class="px-0">
                    <div class="d-flex align-center" style="gap: 8px; min-width: 0;">
                      <v-icon color="grey">mdi-robot-outline</v-icon>
                      <div style="min-width: 0;">
                        <div class="text-body-2 font-weight-bold text-truncate">{{ model.id }}</div>
                        <div class="text-caption text-grey">
                          <v-icon size="12" class="mr-1">mdi-download-outline</v-icon>{{ formatNum(model.downloads) }}
                          <span class="mx-1">·</span>
                          <v-icon size="12" class="mr-1">mdi-heart-outline</v-icon>{{ formatNum(model.likes) }}
                          <template v-if="model.storageBytes"><span class="mx-1">·</span><v-icon size="12" class="mr-1">mdi-harddisk</v-icon>{{ formatBytes(model.storageBytes) }}</template>
                          <template v-if="model.paramCount"><span class="mx-1">·</span><v-icon size="12" class="mr-1">mdi-weight</v-icon>{{ formatParams(model.paramCount) }} params</template>
                          <span v-for="tag in (model.tags || []).slice(0,3)" :key="tag" class="ml-2"><v-chip size="x-small" variant="tonal">{{ tag }}</v-chip></span>
                        </div>
                      </div>
                    </div>
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <div v-if="repoState(model.id).loading" class="d-flex justify-center py-3">
                      <v-progress-circular indeterminate size="20" width="2" color="primary"></v-progress-circular>
                    </div>
                    <v-alert v-else-if="repoState(model.id).error" type="error" variant="tonal" density="compact" class="text-caption mb-0">{{ repoState(model.id).error }}</v-alert>
                    <div v-else-if="!repoState(model.id).variants.length" class="text-caption text-grey py-2">No downloadable model files in this repo.</div>
                    <v-list v-else class="pa-0" bg-color="transparent">
                      <v-list-item v-for="v in repoState(model.id).variants" :key="v.key" class="px-0">
                        <v-list-item-title class="text-body-2 font-mono d-flex align-center flex-wrap" style="gap: 6px;">
                          <v-chip v-if="v.quant" size="x-small" color="primary" variant="tonal">{{ v.quant }}</v-chip>
                          <v-chip v-if="v.size" size="x-small" color="grey" variant="tonal"><v-icon start size="11">mdi-harddisk</v-icon>{{ formatBytes(v.size) }}</v-chip>
                          <v-chip v-if="v.fileCount > 1" size="x-small" color="grey" variant="tonal"><v-icon start size="11">mdi-file-multiple-outline</v-icon>{{ v.fileCount }} files</v-chip>
                          <span class="text-truncate">{{ v.label }}</span>
                        </v-list-item-title>
                        <template #append>
                          <v-btn size="small" color="primary" variant="flat" :loading="v.downloading" @click="downloadVariant(model.id, v)">
                            <v-icon start size="16">mdi-download</v-icon>Download
                          </v-btn>
                        </template>
                      </v-list-item>
                    </v-list>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
              <!-- Loading more indicator -->
              <div v-if="searchLoadingMore" class="d-flex justify-center py-3">
                <v-progress-circular indeterminate size="20" width="2" color="primary"></v-progress-circular>
              </div>
              <div v-else-if="searchHasMore && !searchLoadingMore" class="text-center text-caption text-grey py-2">
                Scroll for more
              </div>
              <div v-else-if="searchResults.length && !searchHasMore" class="text-center text-caption text-grey py-2">
                {{ searchResults.length }} results
              </div>
            </div>

            <div v-if="searchResults.length === 0 && !searchLoading && searchQuery" class="text-caption text-grey py-2">
              No results. Try a different query.
            </div>
          </v-card>

          <!-- Browse Collection -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="text-h6 font-weight-bold mb-1 d-flex align-center">
              <v-icon start color="primary">mdi-folder-multiple-outline</v-icon>
              Browse Collection
            </div>
            <div class="text-caption text-grey mb-4">
              Browse models in a HuggingFace collection. Paste a collection URL, e.g.
              <code class="font-mono">https://huggingface.co/collections/Qwen/qwen3-...</code>
            </div>

            <div class="d-flex gap-3 align-start mb-3 flex-wrap">
              <v-text-field
                v-model="collectionUrl"
                label="Collection URL"
                placeholder="https://huggingface.co/collections/Qwen/qwen3-..."
                variant="outlined"
                density="comfortable"
                hide-details
                prepend-inner-icon="mdi-link-variant"
                style="flex: 1;"
                @keyup.enter="browseCollection"
              ></v-text-field>
              <v-btn
                color="primary"
                variant="flat"
                :loading="collectionLoading"
                prepend-icon="mdi-folder-open-outline"
                @click="browseCollection"
              >
                Browse
              </v-btn>
            </div>

            <v-alert v-if="collectionError" type="error" variant="tonal" density="compact" class="mb-3 text-caption">
              {{ collectionError }}
            </v-alert>

            <div v-if="collectionData">
              <div class="text-subtitle-2 font-weight-bold mb-1">{{ collectionData.title }}</div>
              <div v-if="collectionData.description" class="text-caption text-grey mb-3">{{ collectionData.description }}</div>
              <v-list class="pa-0" bg-color="transparent">
                <v-list-item
                  v-for="model in collectionData.models"
                  :key="model.id"
                  class="border-bottom py-2 px-0"
                >
                  <template v-slot:prepend>
                    <v-icon color="grey" class="mr-2">mdi-robot-outline</v-icon>
                  </template>
                  <v-list-item-title class="text-body-2 font-weight-bold text-truncate">{{ model.id }}</v-list-item-title>
                  <v-list-item-subtitle class="text-caption">
                    <v-icon size="12" class="mr-1">mdi-download-outline</v-icon>{{ formatNum(model.downloads) }}
                    <span class="mx-2">·</span>
                    <v-icon size="12" class="mr-1">mdi-heart-outline</v-icon>{{ formatNum(model.likes) }}
                    <template v-if="model.storageBytes">
                      <span class="mx-2">·</span>
                      <v-icon size="12" class="mr-1">mdi-harddisk</v-icon>{{ formatBytes(model.storageBytes) }}
                    </template>
                    <template v-if="model.paramCount">
                      <span class="mx-2">·</span>
                      <v-icon size="12" class="mr-1">mdi-weight</v-icon>{{ formatParams(model.paramCount) }} params
                    </template>
                    <span v-for="tag in model.tags.slice(0,3)" :key="tag" class="ml-2">
                      <v-chip size="x-small" variant="tonal">{{ tag }}</v-chip>
                    </span>
                  </v-list-item-subtitle>
                  <template v-slot:append>
                    <v-btn size="small" color="primary" variant="tonal" :loading="loadingRepoId === model.id" @click="selectModel(model.id)">Download</v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </div>
          </v-card>

          <!-- Direct Download -->
          <!-- Manual download by repo ID -->
          <v-card class="glass-card pa-5 mb-5" ref="downloadCard">
            <div class="text-h6 font-weight-bold mb-1 d-flex align-center">
              <v-icon start color="primary">mdi-download-outline</v-icon>
              Download from HuggingFace
            </div>
            <div class="text-caption text-grey mb-4">Enter a repo ID or click <strong>Download</strong> on a search result above.</div>

            <div class="d-flex gap-3 align-start flex-wrap mb-3">
              <v-text-field
                v-model="dlRepoId"
                label="HuggingFace Repo ID"
                hint="e.g. Qwen/Qwen2.5-0.5B-Instruct"
                persistent-hint
                variant="outlined"
                density="comfortable"
                style="min-width: 280px; flex: 1"
                prepend-inner-icon="mdi-github"
                @keyup.enter="fetchRepoFiles"
              ></v-text-field>
              <v-text-field
                v-model="dlHfToken"
                label="HF Token (optional)"
                hint="Override for private/gated repos"
                persistent-hint
                :type="showHfToken ? 'text' : 'password'"
                variant="outlined"
                density="comfortable"
                style="min-width: 200px; flex: 1"
                prepend-inner-icon="mdi-key-outline"
                :append-inner-icon="showHfToken ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showHfToken = !showHfToken"
              ></v-text-field>
              <v-btn
                color="primary"
                variant="flat"
                :loading="dlLoading"
                :disabled="!dlRepoId.trim()"
                prepend-icon="mdi-magnify"
                class="mt-1"
                @click="fetchRepoFiles"
              >
                Find Files
              </v-btn>
            </div>

            <!-- File picker -->
            <div v-if="dlFiles.length" class="mt-4">
              <div class="text-caption text-grey mb-2">Select a file to download:</div>
              <v-list class="pa-0" bg-color="transparent">
                <v-list-item
                  v-for="f in dlFiles"
                  :key="f.name"
                  class="border-bottom py-2 px-0"
                >
                  <v-list-item-title class="text-body-2 font-mono d-flex align-center" style="gap: 8px;">
                    <v-chip v-if="quantOf(f.name)" size="x-small" color="primary" variant="tonal">{{ quantOf(f.name) }}</v-chip>
                    <span>{{ f.name }}</span>
                  </v-list-item-title>
                  <v-list-item-subtitle v-if="f.size" class="text-caption">{{ formatBytes(f.size) }}</v-list-item-subtitle>
                  <template #append>
                    <v-btn size="small" color="primary" variant="flat" @click="startDownload(f.name)">
                      <v-icon start size="16">mdi-download</v-icon>Download
                    </v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </div>
            <div v-if="dlFileError" class="text-caption text-error mt-3">{{ dlFileError }}</div>
          </v-card>

          <!-- Downloads queue grouped by repo -->
          <v-card v-if="dlJobs.length" ref="downloadsCard" class="glass-card pa-5">
            <div class="d-flex align-center justify-space-between mb-3">
              <div class="text-subtitle-1 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-tray-arrow-down</v-icon>
                Downloads
              </div>
              <div class="d-flex align-center gap-1">
                <v-btn v-if="dlHasActive" size="x-small" variant="text" color="warning" @click="pauseAllJobs" title="Pause all downloads">
                  <v-icon size="14" start>mdi-pause-circle-outline</v-icon>Pause all
                </v-btn>
                <v-btn v-if="dlHasActive" size="x-small" variant="text" color="error" @click="abortAllJobs" title="Abort all downloads">
                  <v-icon size="14" start>mdi-stop-circle-outline</v-icon>Abort all
                </v-btn>
                <v-btn size="x-small" variant="text" color="grey" @click="clearFinishedJobs">Clear finished</v-btn>
              </div>
            </div>

            <div v-for="(jobs, repoId) in dlJobsByRepo" :key="repoId" class="mb-5">
              <!-- Repo header -->
              <div class="d-flex align-center gap-2 mb-2">
                <v-icon size="14" color="grey">mdi-github</v-icon>
                <span class="text-caption font-weight-bold text-grey">{{ repoId }}</span>
              </div>

              <!-- Files within repo -->
              <div v-for="job in jobs" :key="job.id" class="mb-3 pl-4">
                <div class="d-flex align-center justify-space-between mb-1">
                  <span class="text-body-2 font-mono text-truncate" style="max-width: 60%">{{ job.filename }}</span>
                  <div class="d-flex align-center gap-2">
                    <span v-if="job.status === 'downloading'" class="text-caption text-primary">
                      {{ formatSpeed(job.speedBps) }}
                    </span>
                    <v-chip
                      size="x-small"
                      :color="job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : job.status === 'cancelled' ? 'grey' : job.status === 'paused' ? 'warning' : job.status === 'queued' ? 'info' : 'primary'"
                      variant="tonal"
                    >{{ job.status }}</v-chip>
                    <!-- pause while downloading or queued / resume while paused -->
                    <v-btn v-if="job.status === 'downloading' || job.status === 'queued'" icon size="x-small" variant="text" color="grey" @click="pauseJob(job.id)" title="Pause">
                      <v-icon size="14">mdi-pause</v-icon>
                    </v-btn>
                    <v-btn v-if="job.status === 'paused'" icon size="x-small" variant="text" color="primary" @click="resumeJob(job.id)" title="Resume">
                      <v-icon size="14">mdi-play</v-icon>
                    </v-btn>
                    <!-- clear when finished, cancel while in-flight or paused -->
                    <v-btn v-if="job.status === 'done' || job.status === 'error' || job.status === 'cancelled'"
                      icon size="x-small" variant="text" color="grey" @click="removeJob(job.id)" title="Clear">
                      <v-icon size="14">mdi-close</v-icon>
                    </v-btn>
                    <v-btn v-else icon size="x-small" variant="text" color="error" @click="cancelJob(job.id)" title="Cancel">
                      <v-icon size="14">mdi-stop</v-icon>
                    </v-btn>
                  </div>
                </div>
                <v-progress-linear
                  :model-value="job.progress"
                  :color="job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : job.status === 'paused' ? 'warning' : 'primary'"
                  rounded height="5"
                  :indeterminate="job.status === 'downloading' && job.totalBytes === 0"
                ></v-progress-linear>
                <div class="d-flex justify-space-between mt-1">
                  <span class="text-caption text-grey">{{ (job.status === 'downloading' || job.status === 'paused') ? formatBytes(job.bytesDown) + ' / ' + (job.totalBytes ? formatBytes(job.totalBytes) : '?') : job.error ?? '' }}</span>
                  <span class="text-caption text-grey">{{ job.progress }}%</span>
                </div>
              </div>
            </div>
          </v-card>
        </v-tabs-window-item>

      </v-tabs-window>
    </v-container>

    <!-- Runtime download confirmation dialog -->
    <v-dialog v-model="runtimeDialog" max-width="480" persistent>
      <v-card class="glass-card pa-6">
        <div class="text-h6 font-weight-bold mb-3 d-flex align-center gap-2">
          <v-icon color="warning">mdi-download-circle-outline</v-icon>
          Runtime Required
        </div>
        <p class="text-body-2 mb-3">
          Model <strong>{{ runtimeDialogModel }}</strong> requires
          <strong>rkllm runtime v{{ runtimeDialogVersion }}</strong>, which is not installed.
        </p>
        <p class="text-body-2 mb-3">
          oRKLLM can download the pre-built <code>librkllmrt.so</code> binary from
          <a href="https://github.com/mafischer/rkllm-runtimes" target="_blank" class="text-primary">mafischer/rkllm-runtimes</a>.
          These binaries are redistributed under the <strong>Apache 2.0 License</strong> from Rockchip's upstream repository.
        </p>
        <p class="text-caption text-grey mb-4">
          You can also enable auto-download in Settings to skip this prompt in future.
        </p>
        <div class="d-flex gap-3 justify-end">
          <v-btn variant="text" @click="runtimeDialog = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="runtimeDownloading" @click="downloadAndLoad">
            Download &amp; Load
          </v-btn>
        </div>
      </v-card>
    </v-dialog>

    <!-- JIT runtime download progress dialog -->
    <RuntimeSyncDialog
      :model-value="showRuntimeSyncDialog"
      :sync-state="runtimeSyncState"
    />
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';
import RuntimeSyncDialog from '../components/RuntimeSyncDialog.vue';

export default {
  name: 'Models',
  components: { AppNav, RuntimeSyncDialog },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    tab: 'manager',
    models: [],
    eagle3Heads: [],
    // Downloaded models sorted into categories (GET /api/admin/library)
    library: { available: [], base: [], eagle3: [] },
    // "Add embeddings" dialog for an Eagle-3 head
    embedDialog: false,
    embedTarget: null,          // the eagle3 head row
    embedSource: 'local',       // 'local' (downloaded base) | 'repo' (HF slice)
    embedBaseDir: null,         // selected base model dir (local source)
    embedBaseRepo: '',          // base repo id (repo source)
    embedSubmitting: false,
    status: { isLoaded: false, model: null, isMock: false, pinned: false },
    loadingModelId: null,
    scanningModels: false,
    timeoutSlider: 5,

    loadingRepoId: null,
    showRuntimeSyncDialog: false,
    runtimeSyncState: { active: false, version: null, filename: null, bytesDown: 0, totalBytes: 0 },
    statusPoller: null,
    runtimeSyncPoller: null,

    // Runtime download prompt
    runtimeDialog: false,
    runtimeDialogModel: null,
    runtimeDialogVersion: null,
    runtimeDownloading: false,
    autoDownloadRuntimes: true,

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
      presence_penalty: 0,
      frequency_penalty: 0,
      max_new_tokens: 512,
      ctx_window: 0,
      ttl_minutes: 0,
      thinking_enabled: false,
      force_sampling: false,
      mirostat: 0,
      mirostat_tau: 5.0,
      mirostat_eta: 0.1,
      speculative_mode:     null,
      draft_model:          null,
      spec_draft_tokens:    4,
      eagle3_strategy:      'cpu',
      eagle3_weights_path:  null,
      kv_cache_quant:       null,
      npu_quant:            'auto',
      npu_hybrid:           false,
    },

    // Delete confirm
    deleteDialog: false,
    deleteTarget: null,
    deleteLoading: false,
    dirDeleteDialog: false,
    dirDeleteTarget: null,
    dirDeleteLoading: false,

    // Downloader
    dlRepoId: '',
    dlFiles: [],
    dlFileError: '',
    dlHfToken: '',
    showHfToken: false,
    dlLoading: false,
    dlStatus: null,
    dlPollTimer: null,
    dlJobs: [],

    // HF Search
    searchOpen: [],          // open accordion panels (repo ids); expanding lazy-loads that repo's files
    repoFiles: {},           // repoId -> { loading, error, variants:[{key,label,quant,size,files,companion,downloading}] }
    searchQuery: '',
    searchSort: 'downloads',
    searchRkllmOnly: false,
    searchPlatformOnly: true,
    searchEagle3Only: false,
    detectedPlatform: null,
    searchLoading: false,
    searchLoadingMore: false,
    searchResults: [],
    searchOffset: 0,
    searchHasMore: false,
    searchPageSize: 20,
    searchError: '',

    // Collection browser
    collectionUrl: '',
    collectionLoading: false,
    collectionData: null,
    collectionError: '',

    appVersion: __APP_VERSION__,
    themeName: localStorage.getItem('orkllm-theme') || 'customDarkTheme'
  }),
  computed: {
    isDark() {
      return this.themeName === 'customDarkTheme';
    },
    // KV Cache Compression options. The SSD-blob PolarQuant schemes (q8/pq8/pq4) apply
    // to both backends. The TurboQuant levels set the in-context V-cache type and are
    // only meaningful for the llama/gguf backend (libllama ggml types), so they're
    // appended only for llama models. A turbo selection skips the legacy SSD PolarQuant
    // server-side (the runtime already serializes the cache turbo-compressed).
    kvCacheItems() {
      if (this.settingsTarget?.runtime === 'llama') {
        // llama backend: the dropdown sets the in-context KV V-cache type. The
        // on-disk prefix cache (.llamacache) is the same state serialized natively
        // (one GPU pass for turbo) — it never uses the rkllm PolarQuant path.
        return [
          { title: 'Use global setting', value: null },
          { title: 'Off (FP16)', value: 'off' },
          { title: 'INT8 (q8_0) — live V-cache', value: 'q8_0' },
          { title: 'TurboQuant ~4.5-bit (turbo4) — live V-cache, GPU', value: 'turbo4' },
          { title: 'TurboQuant ~3.5-bit (turbo3) — live V-cache, GPU', value: 'turbo3' },
          { title: 'TurboQuant ~2.7-bit (turbo2) — live V-cache, GPU', value: 'turbo2' },
        ];
      }
      // rkllm backend: SSD prefix-cache (.rkllmcache) blob compression via PolarQuant
      // (kvcache_quant_napi) — quantises the saved blob, dequantises before each hit.
      return [
        { title: 'Use global setting', value: null },
        { title: 'Off (FP16)', value: 'off' },
        { title: 'Min-Max INT8 (~44% smaller) — SSD blob, GPU', value: 'q8' },
        { title: 'Polar INT8 (~49% smaller) — SSD blob, GPU', value: 'pq8' },
        { title: 'Polar INT4 (~74% smaller) — SSD blob, GPU', value: 'pq4' },
      ];
    },
    dlJobsByRepo() {
      const groups = {};
      for (const job of this.dlJobs) {
        const key = job.repoId || 'unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(job);
      }
      return groups;
    },
    dlHasActive() {
      return this.dlJobs.some(j => j.status === 'downloading' || j.status === 'queued' || j.status === 'paused');
    },
    modelsTotalBytes() {
      return this.models.reduce((s, m) => s + (m.size || 0), 0);
    },
    baseTotalBytes() {
      return (this.library.base || []).reduce((s, b) => s + (b.sizeBytes || 0), 0);
    },
    eagle3TotalBytes() {
      return (this.library.eagle3 || []).reduce((s, h) => s + (h.sizeBytes || 0), 0);
    },
    totalStorageBytes() {
      return this.modelsTotalBytes + this.baseTotalBytes + this.eagle3TotalBytes;
    },
    dlStatusColor() {
      if (!this.dlStatus) return 'grey';
      if (this.dlStatus.error) return 'error';
      if (this.dlStatus.done) return 'success';
      return 'primary';
    },
    dlStatusIcon() {
      if (!this.dlStatus) return 'mdi-information-outline';
      if (this.dlStatus.error) return 'mdi-alert-circle-outline';
      if (this.dlStatus.done) return 'mdi-check-circle-outline';
      return 'mdi-loading mdi-spin';
    }
  },
  mounted() {
    this.fetchAuth();
    this.fetchModels();
    this.fetchStatus();
    this.fetchAllModelSettings();
    this.fetchGlobalSettings();
    this.fetchPlatform();
    this.fetchEagle3Heads();
    this.fetchLibrary();
    this.refreshDownloadQueue();
    // Poll server state so the loaded-model indicator stays current across tabs
    this.statusPoller = setInterval(() => this.fetchStatus(), 5000);
  },
  beforeUnmount() {
    if (this.dlPollTimer) clearInterval(this.dlPollTimer);
    if (this.statusPoller) clearInterval(this.statusPoller);
    this.stopRuntimeSyncPoller?.();
  },
  watch: {
    tab(val) {
      if (val === 'downloader') this.refreshDownloadQueue();
    },
    searchOpen(open) {
      // Lazy-load files for each newly-expanded repo accordion.
      for (const repoId of open) this.loadRepoFiles(repoId);
    },
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
    async fetchEagle3Heads() {
      try {
        const res = await fetch('/api/admin/eagle3-heads');
        if (res.ok) this.eagle3Heads = (await res.json()).heads || [];
      } catch (e) {}
    },
    async fetchLibrary() {
      try {
        const res = await fetch('/api/admin/library');
        if (res.ok) this.library = await res.json();
      } catch (e) {}
    },
    openEmbedDialog(head) {
      this.embedTarget = head;
      // Default to a local base model if one with embeddings is available.
      const localBase = this.library.base.find(b => b.hasEmbeddings);
      this.embedSource = localBase ? 'local' : 'repo';
      this.embedBaseDir = localBase ? localBase.dir : null;
      this.embedBaseRepo = '';
      this.embedDialog = true;
    },
    async submitEmbeddings() {
      if (!this.embedTarget) return;
      const body = { headDir: this.embedTarget.dir };
      if (this.embedSource === 'local') {
        if (!this.embedBaseDir) return;
        body.baseDir = this.embedBaseDir;
      } else {
        if (!this.embedBaseRepo.trim()) return;
        body.baseRepoId = this.embedBaseRepo.trim();
      }
      this.embedSubmitting = true;
      try {
        const res = await fetch('/api/admin/eagle3/embeddings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) { this.$notify(data.error || 'Failed to start embeddings download', 'error'); return; }
        this.embedDialog = false;
        this.$notify('Fetching base-model embeddings — see the download queue.', 'info');
        this.tab = 'downloader';
        this.refreshDownloadQueue();
        // Refresh library once the job likely finished.
        setTimeout(() => this.fetchLibrary(), 3000);
      } catch (e) {
        this.$notify('Failed to start embeddings download: ' + e.message, 'error');
      } finally {
        this.embedSubmitting = false;
      }
    },
    async rescanModels() {
      this.scanningModels = true;
      try {
        await this.fetchModels();
        await this.fetchAllModelSettings();
        await this.fetchLibrary();
      } finally {
        this.scanningModels = false;
      }
    },
    async fetchStatus() {
      try {
        const res = await fetch('/api/admin/status');
        const data = await res.json();
        this.status = data;
        if (typeof data.idleTimeoutMs === 'number') {
          this.timeoutSlider = Math.round(data.idleTimeoutMs / 60000);
        }
      } catch (e) {}
    },
    async fetchGlobalSettings() {
      try {
        const res = await fetch('/api/admin/global-settings');
        if (!res.ok) return;
        const data = await res.json();
        if (data.settings?.hfToken) this.dlHfToken = data.settings.hfToken;
        this.autoDownloadRuntimes = data.settings?.autoDownloadRuntimes ?? true;
      } catch (e) {}
    },
    async fetchPlatform() {
      try {
        const res = await fetch('/api/admin/status');
        if (!res.ok) return;
        const data = await res.json();
        this.detectedPlatform = data.platform ?? null;
      } catch (e) {}
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
      // The manager list comes from /v1/models (no thinkingToggle); pull that flag
      // from the library entry so the dialog can disable Enable-Thinking for models
      // with no non-thinking mode (e.g. LFM2.5-MoE).
      const lib = (this.library.available || []).find(m => m.id === model.id);
      this.settingsTarget = { ...model, thinkingToggle: lib?.thinkingToggle };
      const saved = this.modelSettings[model.id] || {};
      this.settingsForm = {
        display_name: saved.display_name || '',
        temperature: saved.temperature ?? 0.8,
        top_p: saved.top_p ?? 0.9,
        top_k: saved.top_k ?? 40,
        rep_penalty: saved.rep_penalty ?? 1.0,
        presence_penalty: saved.presence_penalty ?? 0,
        frequency_penalty: saved.frequency_penalty ?? 0,
        max_new_tokens: saved.max_new_tokens ?? 512,
        ctx_window: saved.ctx_window ?? 0,
        ttl_minutes: saved.ttl_minutes ?? 0,
        thinking_enabled: saved.thinking_enabled ?? false,
        force_sampling: saved.force_sampling ?? false,
        mirostat: saved.mirostat ?? 0,
        mirostat_tau: saved.mirostat_tau ?? 5.0,
        mirostat_eta: saved.mirostat_eta ?? 0.1,
        speculative_mode:    saved.speculative_mode    ?? null,
        draft_model:         saved.draft_model         ?? null,
        spec_draft_tokens:   saved.spec_draft_tokens   ?? 4,
        eagle3_strategy:     saved.eagle3_strategy     ?? 'cpu',
        eagle3_weights_path: saved.eagle3_weights_path ?? null,
        kv_cache_quant:      saved.kv_cache_quant      ?? null,
        npu_quant:           saved.npu_quant           ?? 'auto',
        npu_hybrid:          saved.npu_hybrid          ?? false,
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
          this.$notify(data.error || 'Failed to save settings', 'error');
        }
      } catch (e) {
        this.$notify('Network connection error', 'error');
      } finally {
        this.settingsSaving = false;
      }
    },
    openDeleteConfirm(model) {
      this.deleteTarget = model;
      this.deleteDialog = true;
    },
    openDirDelete(dir, label) {
      this.dirDeleteTarget = { dir, label };
      this.dirDeleteDialog = true;
    },
    async confirmDirDelete() {
      if (!this.dirDeleteTarget) return;
      this.dirDeleteLoading = true;
      try {
        const rel = this.dirDeleteTarget.dir.split('/').map(encodeURIComponent).join('/');
        const res = await fetch(`/api/admin/library/${rel}`, { method: 'DELETE' });
        if (res.ok) {
          this.dirDeleteDialog = false;
          this.dirDeleteTarget = null;
          await this.fetchLibrary();
          await this.fetchEagle3Heads();
          await this.fetchModels();
        } else {
          const data = await res.json().catch(() => ({}));
          this.$notify(data.error || 'Failed to delete directory', 'error');
        }
      } catch (e) {
        this.$notify('Failed to delete directory', 'error');
      } finally {
        this.dirDeleteLoading = false;
      }
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
          this.$notify(data.error || 'Failed to delete model', 'error');
        }
      } catch (e) {
        this.$notify('Network connection error', 'error');
      } finally {
        this.deleteLoading = false;
      }
    },
    async loadModel(modelId) {
      // If auto-download is off, check whether the required runtime is present
      if (!this.autoDownloadRuntimes) {
        const model = this.models.find(m => m.id === modelId);
        const version = model?.runtimeVersion;
        if (version) {
          const runtimesRes = await fetch('/api/admin/runtimes').catch(() => null);
          if (runtimesRes?.ok) {
            const { runtimes, systemRuntime } = await runtimesRes.json();
            const hasVersion = runtimes.some(r => r.version === version)
              || systemRuntime?.version === version;
            if (!hasVersion) {
              this.runtimeDialogModel = modelId;
              this.runtimeDialogVersion = version;
              this.runtimeDialog = true;
              return;
            }
          }
        }
      }
      await this._doLoadModel(modelId);
    },
    startRuntimeSyncPoller() {
      if (this.runtimeSyncPoller) return;
      this.runtimeSyncPoller = setInterval(async () => {
        try {
          const res = await fetch('/api/admin/runtimes');
          if (!res.ok) return;
          const data = await res.json();
          this.runtimeSyncState = data.syncState || {};
          this.showRuntimeSyncDialog = !!data.syncState?.active;
          if (!data.syncState?.active) this.stopRuntimeSyncPoller();
        } catch (e) {}
      }, 600);
    },
    stopRuntimeSyncPoller() {
      if (this.runtimeSyncPoller) {
        clearInterval(this.runtimeSyncPoller);
        this.runtimeSyncPoller = null;
      }
      this.showRuntimeSyncDialog = false;
    },
    async _doLoadModel(modelId) {
      this.loadingModelId = modelId;
      this.startRuntimeSyncPoller();
      try {
        const saved = this.modelSettings[modelId] || {};
        const res = await fetch('/api/admin/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, options: { max_new_tokens: saved.max_new_tokens || 512 } })
        });
        if (res.ok) {
          // 202 Accepted — load runs asynchronously; poll status for completion.
          await this.pollUntilLoaded(modelId);
        } else {
          const data = await res.json().catch(() => ({}));
          this.$notify(data.error || 'Failed to load model', 'error');
        }
      } catch (e) {
        this.$notify('Network connection error', 'error');
      } finally {
        this.loadingModelId = null;
        this.stopRuntimeSyncPoller();
      }
    },
    // /api/admin/load returns 202 and loads in the background (a heavy gguf load
    // can take tens of seconds). Poll status until loaded or errored so no
    // single request stays open long enough for a reverse proxy to reset it.
    async pollUntilLoaded(modelId, timeoutMs = 300000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 1200));
        let data;
        try {
          const r = await fetch('/api/admin/status');
          if (!r.ok) continue;
          data = await r.json();
        } catch { continue; }
        this.status = data;
        if (data.loadError && data.loadError.model === modelId) {
          this.$notify(data.loadError.message || 'Failed to load model', 'error');
          return false;
        }
        if (data.isLoaded && data.model === modelId && !data.loading) return true;
      }
      this.$notify('Model load timed out', 'error');
      return false;
    },
    async downloadAndLoad() {
      this.runtimeDownloading = true;
      try {
        await fetch('/api/admin/runtimes/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: this.runtimeDialogVersion }),
        });
        // Wait briefly for download to start, then attempt load
        // (pool will retry after sync completes internally)
        await new Promise(r => setTimeout(r, 1500));
        this.runtimeDialog = false;
        await this._doLoadModel(this.runtimeDialogModel);
      } catch (e) {
        this.$notify('Download failed: ' + e.message, 'error');
      } finally {
        this.runtimeDownloading = false;
      }
    },
    async togglePin() {
      const endpoint = this.status.pinned ? '/api/admin/unpin' : '/api/admin/pin';
      try {
        const res = await fetch(endpoint, { method: 'POST' });
        if (res.ok) await this.fetchStatus();
      } catch (e) {
        this.$notify('Network connection error', 'error');
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
        this.$notify('Network connection error', 'error');
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
          this.$notify('Timeout saved', 'success');
        }
      } catch (e) {
        this.$notify('Network error saving timeout', 'error');
      }
    },
    _buildSearchParams(offset = 0) {
      // Build query string: append eagle3/platform tags to user's query
      let q = this.searchQuery.trim();
      if (this.searchEagle3Only) q = `${q} eagle3`.trim();

      const params = new URLSearchParams({
        q,
        sort:   this.searchSort,
        rkllm:  this.searchRkllmOnly ? 'true' : 'false',
        limit:  String(this.searchPageSize),
        offset: String(offset),
      });
      if (this.searchPlatformOnly && this.detectedPlatform)
        params.set('platform', this.detectedPlatform);
      return params;
    },
    async searchHf() {
      if (!this.searchQuery.trim() && !this.searchRkllmOnly && !this.searchPlatformOnly && !this.searchEagle3Only) return;
      this.searchLoading = true;
      this.searchError = '';
      this.searchResults = [];
      this.searchOffset = 0;
      this.searchHasMore = false;
      try {
        const res = await fetch(`/api/admin/hf/search?${this._buildSearchParams(0)}`);
        const data = await res.json();
        if (!res.ok) { this.searchError = data.error || 'Search failed'; return; }
        this.searchResults = data;
        this.searchOffset = data.length;
        this.searchHasMore = data.length >= this.searchPageSize;
      } catch (e) {
        this.searchError = 'Network error: ' + e.message;
      } finally {
        this.searchLoading = false;
      }
    },
    async loadMoreSearch() {
      if (this.searchLoadingMore || !this.searchHasMore) return;
      this.searchLoadingMore = true;
      try {
        const res = await fetch(`/api/admin/hf/search?${this._buildSearchParams(this.searchOffset)}`);
        if (!res.ok) return;
        const data = await res.json();
        this.searchResults = [...this.searchResults, ...data];
        this.searchOffset += data.length;
        this.searchHasMore = data.length >= this.searchPageSize;
      } catch { /* silent */ } finally {
        this.searchLoadingMore = false;
      }
    },
    onSearchScroll(e) {
      const el = e.target;
      const threshold = 120; // px from bottom
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold)
        this.loadMoreSearch();
    },
    async browseCollection() {
      if (!this.collectionUrl.trim()) return;
      this.collectionLoading = true;
      this.collectionError = '';
      this.collectionData = null;
      try {
        const res = await fetch(`/api/admin/hf/collection?url=${encodeURIComponent(this.collectionUrl.trim())}`);
        const data = await res.json();
        if (!res.ok) { this.collectionError = data.error || 'Failed to load collection'; return; }
        this.collectionData = data;
      } catch (e) {
        this.collectionError = 'Network error: ' + e.message;
      } finally {
        this.collectionLoading = false;
      }
    },
    // Parse a JSON response, but give a clean message for non-JSON bodies —
    // e.g. an nginx 502/503 HTML page while the server is restarting — instead
    // of a cryptic "Unexpected token '<'". Returns parsed JSON even for error
    // statuses when the body is JSON, so callers can still read data.error.
    async _readJson(res) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.json();
      if ([502, 503, 504].includes(res.status))
        throw new Error('server is restarting or unavailable — try again in a moment');
      throw new Error(`unexpected response from server (HTTP ${res.status})`);
    },
    // ---- Search-result accordion: lazy file load + per-variant download ----
    repoState(repoId) {
      return this.repoFiles[repoId] || { loading: false, error: '', variants: [] };
    },
    // Fetch a repo's files (once) and group them into downloadable "models" (variants): weight files
    // sharing a variant key — the `-N-of-M` shard suffix + extension stripped — collapse into one entry
    // (a sharded model is one download); distinct keys (e.g. GGUF quants) are separate entries. The
    // non-weight companion files (config/tokenizer json…) are shared and pulled with whichever variant
    // the user downloads.
    async loadRepoFiles(repoId) {
      const cur = this.repoFiles[repoId];
      if (cur && (cur.loading || cur.variants.length || cur.error)) return;   // already loading/loaded
      this.repoFiles[repoId] = { loading: true, error: '', variants: [] };
      try {
        const res = await fetch(`/api/admin/hf/files?repoId=${encodeURIComponent(repoId)}`);
        const data = await this._readJson(res);
        if (!res.ok) { this.repoFiles[repoId] = { loading: false, error: data.error || 'Failed to fetch files', variants: [] }; return; }
        const files = data.files || [];
        const isWeight = (n) => /\.(rkllm|gguf|safetensors|bin|pt|pth)$/i.test(n);
        const variantKey = (n) => n.replace(/-\d+-of-\d+(?=\.)/i, '').replace(/\.(rkllm|gguf|safetensors|bin|pt|pth)$/i, '');
        const companion = files.filter(f => !isWeight(f.name));
        const groups = {};
        for (const f of files.filter(f => isWeight(f.name))) {
          const k = variantKey(f.name);
          (groups[k] = groups[k] || { key: k, files: [], size: 0 });
          groups[k].files.push(f); groups[k].size += f.size || 0;
        }
        const variants = Object.values(groups).map(g => ({
          key: g.key,
          quant: this.quantOf(g.files[0].name),
          label: g.files.length > 1 ? g.key : g.files[0].name,   // shard count shown as a chip
          size: g.size,
          fileCount: g.files.length,
          files: g.files,
          companion,
          downloading: false,
        }));
        this.repoFiles[repoId] = { loading: false, error: '', variants };
      } catch (e) {
        this.repoFiles[repoId] = { loading: false, error: 'Network error: ' + e.message, variants: [] };
      }
    },
    async downloadVariant(repoId, variant) {
      variant.downloading = true;
      try {
        const toGet = [...variant.files, ...(variant.companion || [])];
        await Promise.all(toGet.map(f => this._postDownload(repoId, f.name)));
        // Surface the in-progress files in the bottom Downloads queue card (populate immediately,
        // then scroll there) — the accordion is just the catalog; downloads live in the queue.
        await this.refreshDownloadQueue();
        this.$notify(`Started downloading ${variant.label}`, 'success');
        this.$nextTick(() => {
          const el = this.$refs.downloadsCard?.$el || this.$refs.downloadsCard;
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } catch (e) {
        this.$notify('Network error: ' + e.message, 'error');
      } finally {
        variant.downloading = false;
      }
    },
    async _postDownload(repoId, filename) {
      const res = await fetch('/api/admin/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, filename, hfToken: this.dlHfToken.trim() || undefined }),
      });
      const data = await this._readJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to start download');
    },
    async selectModel(id) {
      // Fetch all .rkllm files and start every download immediately
      this.dlRepoId = id;
      this.dlFiles = [];
      this.dlFileError = '';
      this.dlLoading = true;
      this.loadingRepoId = id;
      try {
        const res = await fetch(`/api/admin/hf/files?repoId=${encodeURIComponent(id)}`);
        const data = await this._readJson(res);
        if (!res.ok) { this.dlFileError = data.error || 'Failed to fetch files'; return; }
        if (data.files.length === 0) { this.dlFileError = `No .rkllm or .gguf files found in ${id}.`; return; }
        // Multiple weight files mean one of two different things:
        //   (a) QUANT VARIANTS to choose between — several GGUF quants (Q4_K_M,
        //       Q8_0, …) — so show the picker; downloading all would pull tens of
        //       GB of redundant variants.
        //   (b) SHARDS of ONE model — e.g. a base model's
        //       model-00001-of-00002.safetensors, or a single quant split across
        //       shards — which is one model → download all of them.
        // Distinguish by a variant key: strip the `-N-of-M` shard suffix and the
        // extension. >1 distinct key ⇒ real alternatives ⇒ picker; otherwise it's a
        // single model (lone file or sharded) ⇒ download everything directly.
        const weights = data.files.filter(f => /\.(rkllm|gguf|safetensors|bin|pt|pth)$/i.test(f.name));
        const variantKey = (n) => n.replace(/-\d+-of-\d+(?=\.)/i, '').replace(/\.(rkllm|gguf|safetensors|bin|pt|pth)$/i, '');
        const variants = new Set(weights.map(f => variantKey(f.name)));   // f is a file OBJECT; key off its .name
        const scrollToDownload = () => this.$nextTick(() => {
          const el = this.$refs.downloadCard?.$el || this.$refs.downloadCard;
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        if (variants.size > 1) {
          // Multiple variants → file picker (quant chip per GGUF) for the user to choose.
          this.dlFiles = data.files;
          scrollToDownload();
        } else {
          // One model (single file or sharded) → download all its files directly.
          await Promise.all(data.files.map(f => this.startDownload(f.name)));
          scrollToDownload();
        }
      } catch (e) {
        this.dlFileError = 'Network error: ' + e.message;
      } finally {
        this.dlLoading = false;
        this.loadingRepoId = null;
      }
    },
    async fetchRepoFiles() {
      if (!this.dlRepoId.trim()) return;
      this.dlLoading = true;
      this.dlFiles = [];
      this.dlFileError = '';
      try {
        const res = await fetch(`/api/admin/hf/files?repoId=${encodeURIComponent(this.dlRepoId.trim())}`);
        const data = await this._readJson(res);
        if (!res.ok) { this.dlFileError = data.error || 'Failed to fetch files'; return; }
        // The endpoint returns { repoId, files:[{name,size}] } (already filtered
        // to downloadable weights + companion json) — use that shape directly.
        this.dlFiles = data.files || [];
        if (this.dlFiles.length === 0) {
          this.dlFileError = `No downloadable files found in ${this.dlRepoId.trim()}.`;
        }
      } catch (e) {
        this.dlFileError = 'Network error: ' + e.message;
      } finally {
        this.dlLoading = false;
      }
    },
    // Extract the quantization label from a GGUF filename (Q4_K_M, Q5_K_M,
    // Q6_K, Q8_0, IQ4_XS, F16, …) for the picker chip; null if none.
    quantOf(name) {
      const m = (name || '').match(/(IQ\d+\w*|Q\d+(?:_K(?:_[SML])?|_[01])?|BF16|F16|F32)/i);
      return m ? m[1].toUpperCase() : null;
    },
    formatNum(n) {
      if (!n) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    },
    async startDownload(filename) {
      try {
        const res = await fetch('/api/admin/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoId: this.dlRepoId.trim(),
            filename,
            hfToken: this.dlHfToken.trim() || undefined,
          }),
        });
        const data = await this._readJson(res);
        if (!res.ok) { this.$notify(data.error || 'Failed to start download', 'error'); return; }
        this.dlFiles = [];
        this.startPollDownloadStatus();
      } catch (e) {
        this.$notify('Network error: ' + e.message, 'error');
      }
    },
    async refreshDownloadQueue() {
      try {
        const res = await fetch('/api/admin/download/status');
        if (!res.ok) return;
        this.dlJobs = await res.json();
        // Restart poller if there are active downloads
        const anyActive = this.dlJobs.some(j => j.status === 'downloading' || j.status === 'queued');
        if (anyActive) this.startPollDownloadStatus();
      } catch (e) {}
    },
    startPollDownloadStatus() {
      if (this.dlPollTimer) return; // already polling
      this.dlPollTimer = setInterval(async () => {
        try {
          const res = await fetch('/api/admin/download/status');
          if (!res.ok) return;
          this.dlJobs = await res.json();
          const anyActive = this.dlJobs.some(j => j.status === 'downloading' || j.status === 'queued');
          if (!anyActive) {
            clearInterval(this.dlPollTimer);
            this.dlPollTimer = null;
            await this.fetchModels();
          }
        } catch (e) {}
      }, 500);
    },
    async cancelJob(id) {
      await fetch(`/api/admin/download/${id}`, { method: 'DELETE' }).catch(() => {});
      this.refreshDownloadQueue();
    },
    async pauseJob(id) {
      await fetch(`/api/admin/download/${id}/pause`, { method: 'POST' }).catch(() => {});
      this.refreshDownloadQueue();   // reflect 'paused' immediately
    },
    async resumeJob(id) {
      await fetch(`/api/admin/download/${id}/resume`, { method: 'POST' }).catch(() => {});
      this.refreshDownloadQueue();   // back to 'downloading' + restart the active status poller
    },
    async removeJob(id) {
      await fetch(`/api/admin/download/${id}`, { method: 'DELETE' }).catch(() => {});
      this.dlJobs = this.dlJobs.filter(j => j.id !== id);
    },
    async clearFinishedJobs() {
      const active = ['downloading', 'paused', 'queued'];
      const finished = this.dlJobs.filter(j => !active.includes(j.status));
      await Promise.all(finished.map(j => fetch(`/api/admin/download/${j.id}`, { method: 'DELETE' }).catch(() => {})));
      this.dlJobs = this.dlJobs.filter(j => active.includes(j.status));
    },
    async pauseAllJobs() {
      await fetch('/api/admin/download/pause-all', { method: 'POST' }).catch(() => {});
      this.refreshDownloadQueue();
    },
    async abortAllJobs() {
      await fetch('/api/admin/download/abort-all', { method: 'POST' }).catch(() => {});
      this.refreshDownloadQueue();
    },
    formatSpeed(bps) {
      if (!bps) return '';
      if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
      if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
      return bps + ' B/s';
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
    formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    },
    formatParams(n) {
      if (!n) return null;
      if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
      if (n >= 1e9)  return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
      if (n >= 1e6)  return (n / 1e6).toFixed(0) + 'M';
      return n.toLocaleString();
    }
  }
};
</script>

<style scoped>
/* Use available horizontal space on large displays instead of a narrow column */
.page-container {
  max-width: 1400px;
  margin-inline: auto;
}
.search-results-scroll {
  max-height: 480px;
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: 4px;
  scrollbar-width: thin;
}
.search-results-scroll::-webkit-scrollbar { width: 4px; }
.search-results-scroll::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 2px; }

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

.text-gradient {
  background: linear-gradient(135deg, #7C3AED 0%, #F43F5E 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.border-bottom {
  border-bottom: 1px solid rgba(139, 92, 246, 0.1) !important;
}

.border-top {
  border-top: 1px solid rgba(139, 92, 246, 0.1) !important;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
</style>
