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

// Deterministic staleness check: on load, ask the server its version and
// compare to the version baked into this bundle. If the cached client is
// behind (the service worker is serving an old shell), don't rely on the SW's
// own update/activation timing — which is browser-dependent and was leaving
// users stale until a manual hard-reload. Instead clear the precache, drop the
// service worker, and reload so the new build is fetched straight from the
// server; the SW then re-registers fresh. Guarded by the version check, so it
// fires at most once per deploy and can't loop (after reload, versions match).
async function checkForNewVersion() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version || version === __APP_VERSION__) return;
    console.info(`[update] server ${version} ≠ client ${__APP_VERSION__} — refreshing`);
    try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch {}
    try { await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister())); } catch {}
    location.reload();
  } catch (e) {}
}
checkForNewVersion();
