<template>
  <v-app>
    <router-view />
    <v-snackbar
      v-model="snackbar.show"
      :color="snackbar.color"
      :timeout="snackbar.timeout"
      location="bottom right"
      rounded="lg"
      elevation="4"
      min-width="260"
    >
      {{ snackbar.message }}
      <template #actions>
        <v-btn variant="text" size="small" @click="snackbar.show = false">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </template>
    </v-snackbar>
  </v-app>
</template>

<script>
import { snackbar } from './notify.js';

export default {
  name: 'App',
  setup() {
    return { snackbar };
  },
}
</script>

<style>
html, body {
  margin: 0;
  padding: 0;
  background-color: rgb(var(--v-theme-background)) !important;
  font-family: 'Roboto', sans-serif;
}

.bg-slate-page {
  background-color: rgb(var(--v-theme-background)) !important;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: rgb(var(--v-theme-background));
}
::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-background), 0.15);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--v-theme-on-background), 0.25);
}
</style>
