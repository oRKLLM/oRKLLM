// Curated "what's new" manifests that drive the Settings and Help nav badges. Append one entry per
// release; the navbar shows a badge counting the entries the user hasn't seen yet (cleared when they
// open the corresponding page). On a fresh install the current list is marked seen (no badge) — only
// entries ADDED in a later release surface, matching "new since last release". See src/badges.js.

// New/changed user-facing features — drives the Settings badge (primary color, count of unseen).
export const FEATURES = [
  { id: 'multicore-decode', text: 'Faster token generation (multi-core NPU decode)' },
  { id: 'orkpack-warm',     text: 'Models never cold-start — the NPU weight cache is built before load' },
  { id: 'models-dir',       text: 'Available Models card shows the models directory' },
  { id: 'nav-badges',       text: 'Navbar notification badges' },
];

// Help topics — drives the Help badge (orange, count of unseen entries).
export const HELP_ENTRIES = [
  { id: 'getting-started', text: 'Getting started' },
  { id: 'downloading',     text: 'Downloading models' },
  { id: 'runtimes',        text: 'Runtimes & conversion (.orkpack)' },
  { id: 'kv-quant',        text: 'KV-cache compression' },
];
