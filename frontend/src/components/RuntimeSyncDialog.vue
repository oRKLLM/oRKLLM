<template>
  <v-dialog :model-value="modelValue" persistent max-width="400">
    <v-card class="glass-card pa-6">
      <div class="text-h6 font-weight-bold mb-4 d-flex align-center gap-2">
        <v-icon color="primary">mdi-download-circle-outline</v-icon>
        Downloading Runtime
      </div>
      <p class="text-body-2 mb-1">
        Fetching <strong>librkllmrt.so {{ syncState.version }}</strong> from the runtime mirror.
        This is a one-time download (~7 MB).
      </p>
      <p class="text-caption text-grey mb-4">The model will load automatically once the download completes.</p>

      <v-progress-linear
        :model-value="syncState.totalBytes > 0 ? Math.round((syncState.bytesDown / syncState.totalBytes) * 100) : 0"
        :indeterminate="syncState.totalBytes === 0"
        color="primary"
        rounded
        height="6"
        class="mb-2"
      ></v-progress-linear>

      <div class="d-flex justify-space-between text-caption text-grey">
        <span>{{ syncState.filename || '' }}</span>
        <span v-if="syncState.totalBytes > 0">
          {{ formatBytes(syncState.bytesDown) }} / {{ formatBytes(syncState.totalBytes) }}
        </span>
      </div>
    </v-card>
  </v-dialog>
</template>

<script>
export default {
  name: 'RuntimeSyncDialog',
  props: {
    modelValue: { type: Boolean, default: false },
    syncState: { type: Object, default: () => ({ active: false, version: null, filename: null, bytesDown: 0, totalBytes: 0 }) },
  },
  methods: {
    formatBytes(b) {
      if (!b) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return (b / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    },
  },
};
</script>
