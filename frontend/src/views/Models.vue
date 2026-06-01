<template>
  <AppNav
    :app-version="appVersion"
    :user="user"
    :is-dark="isDark"
    @toggle-theme="toggleTheme"
    @logout="logout"
  />

  <v-main class="bg-slate-page fill-height">
    <v-container fluid class="pt-6 px-6" style="max-width: 1000px;">

      <div class="text-h5 font-weight-bold mb-1">Models</div>
      <div class="text-caption text-grey mb-5">Manage and download .rkllm model files.</div>

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

          <v-card class="glass-card pa-5 mb-5">
            <div class="d-flex align-center justify-space-between mb-4">
              <div class="text-h6 font-weight-bold d-flex align-center">
                <v-icon start color="primary">mdi-folder-open-outline</v-icon>
                Available Models
              </div>
              <v-btn icon size="small" variant="text" color="grey" title="Rescan models directory" :loading="scanningModels" @click="rescanModels">
                <v-icon>mdi-refresh</v-icon>
              </v-btn>
            </div>

            <v-list bg-color="transparent" class="pa-0 border rounded">
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
                </template>
              </v-list-item>
              <div v-if="models.length === 0" class="text-center py-6 text-grey">
                No models found in scan directory.
              </div>
            </v-list>
          </v-card>

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

        </v-tabs-window-item>

        <!-- Downloader Tab -->
        <v-tabs-window-item value="downloader">

          <!-- Search HuggingFace -->
          <v-card class="glass-card pa-5 mb-5">
            <div class="text-h6 font-weight-bold mb-1 d-flex align-center">
              <v-icon start color="primary">mdi-magnify</v-icon>
              Search HuggingFace
            </div>
            <div class="text-caption text-grey mb-4">Find .rkllm models on HuggingFace Hub.</div>

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

            <v-checkbox
              v-model="searchRkllmOnly"
              label="RKLLM models only (adds 'rkllm' to search)"
              density="compact"
              hide-details
              color="primary"
              class="mb-2"
            ></v-checkbox>

            <v-alert v-if="searchError" type="error" variant="tonal" density="compact" class="mb-3 text-caption">
              {{ searchError }}
            </v-alert>

            <v-list v-if="searchResults.length" class="pa-0" bg-color="transparent">
              <v-list-item
                v-for="model in searchResults"
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
                  <span v-for="tag in model.tags.slice(0,3)" :key="tag" class="ml-2">
                    <v-chip size="x-small" variant="tonal">{{ tag }}</v-chip>
                  </span>
                </v-list-item-subtitle>
                <template v-slot:append>
                  <v-btn size="small" color="primary" variant="tonal" @click="selectModel(model.id)">Use</v-btn>
                </template>
              </v-list-item>
            </v-list>

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
                    <span v-for="tag in model.tags.slice(0,3)" :key="tag" class="ml-2">
                      <v-chip size="x-small" variant="tonal">{{ tag }}</v-chip>
                    </span>
                  </v-list-item-subtitle>
                  <template v-slot:append>
                    <v-btn size="small" color="primary" variant="tonal" @click="selectModel(model.id)">Use</v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </div>
          </v-card>

          <!-- Direct Download -->
          <v-card class="glass-card pa-5 mb-5" ref="downloadCard">
            <div class="text-h6 font-weight-bold mb-1 d-flex align-center">
              <v-icon start color="primary">mdi-download-outline</v-icon>
              Download from HuggingFace
            </div>
            <div class="text-caption text-grey mb-5">Download a .rkllm model file from a HuggingFace repository.</div>

            <v-text-field
              v-model="dlRepoId"
              label="HuggingFace Repo ID"
              hint="e.g. Qwen/Qwen2.5-0.5B-Instruct"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-4"
              prepend-inner-icon="mdi-github"
            ></v-text-field>

            <v-text-field
              v-model="dlHfToken"
              label="HuggingFace Token (optional)"
              hint="Used for private or gated repositories"
              persistent-hint
              :type="showHfToken ? 'text' : 'password'"
              variant="outlined"
              density="comfortable"
              class="mb-5"
              prepend-inner-icon="mdi-key-outline"
              :append-inner-icon="showHfToken ? 'mdi-eye-off' : 'mdi-eye'"
              @click:append-inner="showHfToken = !showHfToken"
            ></v-text-field>

            <v-btn
              color="primary"
              variant="flat"
              :loading="dlLoading"
              :disabled="!dlRepoId.trim()"
              prepend-icon="mdi-download"
              @click="startDownload"
            >
              Download Model
            </v-btn>
          </v-card>

          <!-- Download status -->
          <v-card v-if="dlStatus" class="glass-card pa-5">
            <div class="text-subtitle-1 font-weight-bold mb-3 d-flex align-center">
              <v-icon start :color="dlStatusColor">{{ dlStatusIcon }}</v-icon>
              Download Status
            </div>
            <div class="text-body-2 mb-2">{{ dlStatus.message }}</div>
            <v-progress-linear
              v-if="dlStatus.progress !== undefined"
              :model-value="dlStatus.progress"
              color="primary"
              rounded
              height="6"
              class="mb-2"
            ></v-progress-linear>
            <div v-if="dlStatus.progress !== undefined" class="text-caption text-grey">
              {{ dlStatus.progress }}%
            </div>
            <v-alert
              v-if="dlStatus.error"
              type="error"
              variant="tonal"
              density="compact"
              class="mt-3 text-caption"
            >
              {{ dlStatus.error }}
            </v-alert>
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
  </v-main>
</template>

<script>
import AppNav from '../components/AppNav.vue';

export default {
  name: 'Models',
  components: { AppNav },
  data: () => ({
    user: { username: 'admin', role: 'admin', authProvider: 'local' },
    tab: 'manager',
    models: [],
    status: { isLoaded: false, model: null, isMock: false, pinned: false },
    loadingModelId: null,
    scanningModels: false,
    timeoutSlider: 5,

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
      max_new_tokens: 512,
      ttl_minutes: 0
    },

    // Delete confirm
    deleteDialog: false,
    deleteTarget: null,
    deleteLoading: false,

    // Downloader
    dlRepoId: '',
    dlHfToken: '',
    showHfToken: false,
    dlLoading: false,
    dlStatus: null,
    dlPollTimer: null,

    // HF Search
    searchQuery: '',
    searchSort: 'downloads',
    searchRkllmOnly: true,
    searchLoading: false,
    searchResults: [],
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
  },
  beforeUnmount() {
    if (this.dlPollTimer) clearInterval(this.dlPollTimer);
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
    async rescanModels() {
      this.scanningModels = true;
      try {
        await this.fetchModels();
        await this.fetchAllModelSettings();
      } finally {
        this.scanningModels = false;
      }
    },
    async fetchStatus() {
      try {
        const res = await fetch('/api/admin/status');
        const data = await res.json();
        this.status = data;
        if (data.options && typeof data.options.idleTimeoutMs === 'number') {
          this.timeoutSlider = Math.round(data.options.idleTimeoutMs / 60000);
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
    async _doLoadModel(modelId) {
      this.loadingModelId = modelId;
      try {
        const saved = this.modelSettings[modelId] || {};
        const res = await fetch('/api/admin/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, options: { max_new_tokens: saved.max_new_tokens || 512 } })
        });
        if (res.ok) {
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
        alert('Download failed: ' + e.message);
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
        alert('Network connection error');
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
    async searchHf() {
      if (!this.searchQuery.trim() && !this.searchRkllmOnly) return;
      this.searchLoading = true;
      this.searchError = '';
      this.searchResults = [];
      try {
        const params = new URLSearchParams({
          q: this.searchQuery.trim(),
          sort: this.searchSort,
          rkllm: this.searchRkllmOnly ? 'true' : 'false',
          limit: '25',
        });
        const res = await fetch(`/api/admin/hf/search?${params}`);
        const data = await res.json();
        if (!res.ok) { this.searchError = data.error || 'Search failed'; return; }
        this.searchResults = data;
      } catch (e) {
        this.searchError = 'Network error: ' + e.message;
      } finally {
        this.searchLoading = false;
      }
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
    selectModel(id) {
      this.dlRepoId = id;
      this.$nextTick(() => {
        const el = this.$refs.downloadCard?.$el || this.$refs.downloadCard;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    formatNum(n) {
      if (!n) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    },
    async startDownload() {
      if (!this.dlRepoId.trim()) return;
      this.dlLoading = true;
      this.dlStatus = { message: 'Starting download...', progress: 0 };

      try {
        const res = await fetch('/api/admin/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: this.dlRepoId.trim(), hfToken: this.dlHfToken.trim() || undefined })
        });
        const data = await res.json();
        if (!res.ok) {
          this.dlStatus = { message: 'Failed to start download', error: data.error || 'Unknown error' };
          this.dlLoading = false;
          return;
        }
        this.dlStatus = { message: data.message || 'Download started', progress: 0 };
        this.startPollDownloadStatus();
      } catch (e) {
        this.dlStatus = { message: 'Network error', error: e.message };
        this.dlLoading = false;
      }
    },
    startPollDownloadStatus() {
      if (this.dlPollTimer) clearInterval(this.dlPollTimer);
      this.dlPollTimer = setInterval(async () => {
        try {
          const res = await fetch('/api/admin/download/status');
          if (!res.ok) {
            this.dlStatus = { message: 'Could not fetch status', error: `HTTP ${res.status}` };
            this.stopPollDownloadStatus();
            return;
          }
          const data = await res.json();
          this.dlStatus = data;
          if (data.done || data.error) {
            this.stopPollDownloadStatus();
            if (data.done) await this.fetchModels();
          }
        } catch (e) {
          this.dlStatus = { message: 'Status check failed', error: e.message };
          this.stopPollDownloadStatus();
        }
      }, 1500);
    },
    stopPollDownloadStatus() {
      if (this.dlPollTimer) {
        clearInterval(this.dlPollTimer);
        this.dlPollTimer = null;
      }
      this.dlLoading = false;
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
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
