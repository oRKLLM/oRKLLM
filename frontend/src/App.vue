<template>
  <v-app>
    <router-view />
  </v-app>
</template>

<script>
export default {
  name: 'App'
}
</script>

<style>
html, body {
  margin: 0;
  padding: 0;
  background-color: rgb(var(--v-theme-background)) !important;
  font-family: 'Roboto', sans-serif;
}

/* Global bg-slate-page follows the active Vuetify theme */
.bg-slate-page {
  background-color: rgb(var(--v-theme-background)) !important;
}

/* Custom scrollbars */
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
