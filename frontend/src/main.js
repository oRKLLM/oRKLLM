import { createApp } from 'vue';
import App from './App.vue';
import vuetify from './plugins/vuetify';
import router from './router';
import { notify } from './notify.js';

const app = createApp(App);

app.use(vuetify);
app.use(router);

// Global $notify — replaces browser alert() with a Vuetify snackbar
app.config.globalProperties.$notify = notify;

app.mount('#app');

// PWA service worker. registerSW is a no-op in dev (no SW emitted); in the
// built app it precaches the shell. registerType is 'autoUpdate', so a new
// version is fetched and applied automatically, reloading on the next load.
import { registerSW } from 'virtual:pwa-register';
registerSW({
  immediate: true,
  onOfflineReady() {
    notify('oRKLLM is ready to use offline', 'success');
  },
});
