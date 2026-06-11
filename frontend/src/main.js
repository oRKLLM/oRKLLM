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
const updateSW = registerSW({
  immediate: true,
  onOfflineReady() {
    notify('oRKLLM is ready to use offline', 'success');
  },
});

// Deterministic staleness check: on load, ask the server its version and
// compare to the version baked into this bundle. If the cached client is
// behind (the service worker served an old shell), proactively pull the new
// service worker so it re-caches and reloads — rather than waiting for the
// browser's lazy update cycle. Guards against a reload loop (only acts on a
// genuine mismatch; once reloaded, versions match and it's a no-op).
async function checkForNewVersion() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== __APP_VERSION__) {
      console.info(`[update] server ${version} ≠ client ${__APP_VERSION__} — updating`);
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await reg.update();      // fetch the new sw.js + precache now
      updateSW(true);                   // activate it and reload to the new build
    }
  } catch (e) {}
}
checkForNewVersion();
