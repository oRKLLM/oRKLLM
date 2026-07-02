// Navbar notification-badge store. WebSocket-driven (shares the app's single /ws/metrics + /ws/logs via
// streams.js — no extra sockets). One reactive descriptor per nav path; AppNav renders a top-right v-badge
// from badgeFor(path) and calls markViewed(path) on navigation. Per-tab semantics:
//   Dashboard  red dot   — NPU/GPU activity detected; cleared on view OR when activity drops to 0
//   Models     count     — models actively converting (live; clears itself at 0)
//   Settings   count     — new features since last release not yet seen; cleared on view
//   Logs       count     — unviewed errors/warnings, colored by worst (red=error, amber=warn); cleared on view
//   Bench      dot       — red while running (stays until done), green when ready; green cleared on view
//   Chat       count     — messages not yet viewed; cleared on view
//   Help       count     — new help entries since last viewed; cleared on view
import { reactive, computed, watch } from 'vue';
import { onMetrics, onLogLines, startStreams } from './streams.js';
import { FEATURES, HELP_ENTRIES } from './whatsnew.js';
import { benchState } from './bench.js';
import { chatState } from './chat.js';

// localStorage baseline: on first ever load, mark the current manifest as "seen" so only entries ADDED
// in a later release surface a badge (matches "new since last release"). Missing key → seed to length.
const seed = (key, len) => {
  const v = localStorage.getItem(key);
  if (v == null) { localStorage.setItem(key, String(len)); return len; }
  const n = parseInt(v, 10); return Number.isFinite(n) ? n : len;
};
const LS_FEATURES = 'ork_badge_seen_features';
const LS_HELP = 'ork_badge_seen_help';

const state = reactive({
  route: '/',
  npuGpuActive: false,   // dashboard
  dashDismissed: false,
  converting: 0,         // models (live)
  seenFeatures: seed(LS_FEATURES, FEATURES.length),
  logErrors: 0, logWarns: 0,   // logs
  bench: 'idle',         // 'idle' | 'running' | 'ready'
  benchDismissed: false,
  chatUnread: 0,         // chat
  seenHelp: seed(LS_HELP, HELP_ENTRIES.length),
});

// path → { content?, dot?, color } | null
const badges = computed(() => {
  const feat = Math.max(0, FEATURES.length - state.seenFeatures);
  const help = Math.max(0, HELP_ENTRIES.length - state.seenHelp);
  const logs = state.logErrors + state.logWarns;
  return {
    '/':         (state.npuGpuActive && !state.dashDismissed) ? { dot: true, color: 'error' } : null,
    '/models':   state.converting > 0 ? { content: state.converting, color: 'info' } : null,
    '/settings': feat > 0 ? { content: feat, color: 'primary' } : null,
    '/logs':     logs > 0 ? { content: logs, color: state.logErrors > 0 ? 'error' : 'warning' } : null,
    '/bench':    state.bench === 'running' ? { dot: true, color: 'error' }
               : (state.bench === 'ready' && !state.benchDismissed ? { dot: true, color: 'success' } : null),
    '/chat':     state.chatUnread > 0 ? { content: state.chatUnread, color: 'info' } : null,
    '/help':     help > 0 ? { content: help, color: 'orange' } : null,
  };
});

const topPath = (p) => (p === '/' ? '/' : '/' + String(p).split('/')[1]);

export function badgeFor(path) { return badges.value[path] || null; }

// Called by AppNav on every route change: track the active tab + dismiss its badge.
export function setRoute(path) { state.route = path; markViewed(path); }

export function markViewed(path) {
  switch (topPath(path)) {
    case '/':         state.dashDismissed = true; break;
    case '/settings': state.seenFeatures = FEATURES.length; localStorage.setItem(LS_FEATURES, String(FEATURES.length)); break;
    case '/logs':     state.logErrors = 0; state.logWarns = 0; break;
    case '/chat':     state.chatUnread = 0; break;
    case '/bench':    if (state.bench === 'ready') state.benchDismissed = true; break;
    case '/help':     state.seenHelp = HELP_ENTRIES.length; localStorage.setItem(LS_HELP, String(HELP_ENTRIES.length)); break;
  }
}

// Component-driven signals (chat completion, bench run state) — the parts no server stream carries.
export function noteChatMessage(n = 1) { if (!state.route.startsWith('/chat')) state.chatUnread += n; }
export function setBenchState(s) { state.bench = s; if (s !== 'ready') state.benchDismissed = false; }

function levelOf(line) {
  try {
    const o = JSON.parse(line);
    if (o && o.level != null) {
      if (typeof o.level === 'number') return { 10:'trace',20:'debug',30:'info',40:'warn',50:'error',60:'error' }[o.level] || 'info';
      return String(o.level).toLowerCase();
    }
  } catch {}
  return 'info';   // plain console lines: don't accrue error/warn (avoids substring false-positives)
}

let started = false;
export function initBadges() {
  if (started) return; started = true;
  startStreams();
  onMetrics((m) => {
    if (typeof m.converting === 'number') state.converting = m.converting;
    const active = (Number(m.npu) || 0) > 0 || (Number(m.gpu) || 0) > 0;
    if (active) state.npuGpuActive = true;
    else { state.npuGpuActive = false; state.dashDismissed = false; }   // dropped to 0 → clear + re-arm
  });
  onLogLines((lines) => {
    if (state.route.startsWith('/logs')) return;   // viewing logs → don't accrue
    for (const line of lines) {
      const lvl = levelOf(line);
      if (lvl === 'error') state.logErrors++;
      else if (lvl === 'warn') state.logWarns++;
    }
  });
  // Bench badge: mirror the shared bench store (running → red, finished-with-results → green).
  watch(() => benchState.running, (running) => {
    setBenchState(running ? 'running' : (benchState.results ? 'ready' : 'idle'));
  });
  // Chat badge: each completed generation (generating true→false) that finishes while the user is NOT
  // on the chat page counts as one unviewed message (the store keeps generating across navigation).
  watch(() => chatState.generating, (g, prev) => { if (prev && !g) noteChatMessage(); });
}
