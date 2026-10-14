// Directory-based `.orkpack` layout — several packs from one source, one stable identity.
//
// Spec: docs/ORKPACK_DIRECTORY_LAYOUT.md. Read that before changing resolution order.
//
// ONE source GGUF can reasonably carry several packs — a 4bpw native W4A4, a 4.9bpw promoted mixed,
// an 8bpw int8 — but `orkpackPathFor` is a pure extension swap, so there is exactly one slot per
// source and a second build overwrites the first.
//
// The obvious fix, naming the pack FILE for its bpw, is the wrong one. bpw is a MEASURED property of
// the artifact that changes on every re-quantize, so encoding it in the identity moves the key
// whenever the artifact is rebuilt, and it breaks `sourceGgufFor` — the reverse extension swap that
// is how a pack inherits its source's settings row. Every pack defect this project hit in the week
// before this landed was that one shape: one logical model, several ids, a lookup keyed on the wrong
// one, failing silently (pool slot reuse evicting a model to reload itself; a split model's settings
// orphaned by consolidation, which cost a 27B; an admin poll comparing against an equality that could
// not become true).
//
// So: the DIRECTORY is named for the SOURCE and the variant is an attribute.
//
//     <model-dir>/Qwen3.8-27B-BF16.gguf      source, untouched (and routinely deleted after packing)
//     <model-dir>/Qwen3.8-27B-BF16/          pack directory
//         .orkpack-dir                       the marker; the ONLY thing that makes this a pack dir
//         4bpw.orkpack      4bpw.orkpack.gguf      4bpw.orkpack.prov.json  ...
//         4.9bpw.orkpack
//         8bpw.orkpack
//
// The model id does NOT change: it stays `<base>.orkpack`, which becomes a HANDLE resolved here.
// Nothing that derives identity — sourceGgufFor, modelSettingsFor, modelAliasesFor, canonicalModelId
// — has to change, and no DB key moves. Only the few sites that touch the filesystem resolve.
//
// LEGACY `<base>.orkpack` as a FILE keeps working untouched, forever. The directory wins when it
// exists, and the legacy file is then IGNORED, never deleted. There is no write-on-read and no
// automatic migration: a crash between a move and a key rewrite is exactly how the orphaned-settings
// bug was made. Migration is an explicit, reversible, script-only action (§ bottom of this file).
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  orkpackPathFor, orkpackDirFor, isPackDir, readPackDirMarker, writePackDirMarker,
  packDirMarkerPath, isBuildingPack, BUILDING_PREFIX, isOrkpackPath, isOrkpackUsable,
  readOrkpackFooter, sigQbits, orkQuantForSource,
} from './orkpack.js';
import { measureFromPack, packQuantLabel, clearPackLabelCache } from './quant_plan.js';
import { ggufQuantBits } from './gguf.js';

// Everything a pack keeps beside itself. The directory arm does not need this (removal is the whole
// directory) but the finalize rename and the LEGACY removal arm both do.
//   .tmp        ggml-ork's in-progress write, renamed into place by ork_persist_finalize
//   .json       our progress sidecar
//   .meta.json  the retired freshness sidecar; swept so old installs don't leave litter
//   .prov.json  provenance (writeOrkpackProvenance)
//   .gmax       ggml-ork's persisted per-layer gate tuning, written at free
//   .gguf       the sparse stub extracted from the pack
const SIDECAR_SUFFIXES = ['.tmp', '.json', '.meta.json', '.prov.json', '.gmax', '.gguf'];

// ---- variants ------------------------------------------------------------------------------------

/**
 * Every pack that exists for this source, newest layout first.
 *
 * Returns `{ layout, dir, variants }` where layout is 'dir' | 'legacy' | 'none'. A directory, once
 * marked, wins outright — the legacy file is not even looked at, so the two can coexist on disk
 * through a migration or a crash without either becoming ambiguous.
 *
 * `precision` is the {orkQuant, orkHybrid} a load would SERVE at; it decides each variant's `usable`
 * flag via the same `isOrkpackUsable` the load path applies. Omit it for the weaker structural
 * question (a UI badge).
 */
export function listOrkpackVariants(absGguf, { precision = null } = {}) {
  const dir = orkpackDirFor(absGguf);
  if (isPackDir(dir)) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable → no variants */ }
    const variants = [];
    for (const e of ents) {
      if (!e.isFile() || !isOrkpackPath(e.name) || isBuildingPack(e.name)) continue;
      const v = describeVariant(path.join(dir, e.name), e.name.replace(/\.orkpack$/i, ''), 'dir', precision);
      if (v) variants.push(v);
    }
    return { layout: 'dir', dir, variants };
  }
  warnUnmarkedPackDir(dir);
  const legacy = orkpackPathFor(absGguf);
  const v = describeVariant(legacy, '', 'legacy', precision);
  return v ? { layout: 'legacy', dir: null, variants: [v] } : { layout: 'none', dir: null, variants: [] };
}

function describeVariant(packPath, label, layout, precision) {
  let st; try { st = fs.statSync(packPath); } catch { return null; }
  if (!st.isFile() || st.size === 0) return null;
  const footer = readOrkpackFooter(packPath);
  // bpw is MEASURED off the pack's own index, never parsed back out of the filename. The filename is
  // DERIVED from this measurement (see finalizeOrkpackBuild), so a hand-renamed file can mis-order a
  // tiebreak but can never be adopted on a wrong premise. The read is a tail read of the index and is
  // memoised on (mtime, size) inside quant_plan.js.
  const m = measureFromPack(packPath);
  return {
    label, path: packPath, layout, footer,
    qbits: footer ? sigQbits(footer.quantSig) : null,
    bpw: m && Number.isFinite(m.currentBpw) && m.currentBpw > 0 ? m.currentBpw : null,
    nEntries: footer?.nEntries ?? 0,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    usable: isOrkpackUsable(packPath, precision),
  };
}

// A directory holding packs but carrying no marker is NOT a pack directory (see orkpack.js). Say so
// once, with the fix, rather than letting it look like the packs are simply not there.
const _unmarkedWarned = new Set();
function warnUnmarkedPackDir(dir) {
  if (_unmarkedWarned.has(dir)) return;
  let ents = []; try { ents = fs.readdirSync(dir); } catch { return; }
  const packs = ents.filter(n => isOrkpackPath(n) && !isBuildingPack(n));
  if (!packs.length) return;
  _unmarkedWarned.add(dir);
  console.warn(`[orkpack] ${dir} holds ${packs.length} .orkpack file(s) but no ${path.basename(packDirMarkerPath(dir))} ` +
               `marker, so it is NOT treated as a pack directory and those packs are ignored. ` +
               `Run orkpackMigrateToDir (scripts/orkpack-migrate.mjs) to adopt them.`);
}

// ---- resolution ------------------------------------------------------------------------------------

// The NPU weight-residency budget, in MiB, used by the tiebreak below. Callers that have the DB pass
// the configured number (pool.js's resolveWcacheBudgetMB); this is the same DEFAULT that function
// uses, kept here so this module stays free of the DB — importing db.js opens a SQLite file at module
// load, which a path-resolution module (and its unit tests) has no business doing.
export function defaultPackBudgetMB() {
  return Math.max(1024, Math.floor(os.totalmem() / 1048576) - 1024);
}

/**
 * WHICH pack serves this source. A pure function of (source path, settings row, machine facts) —
 * machine facts being what `isOrkpackUsable` already consults (the runtime tag, the calibrated
 * ork_fmt) plus the memory budget, all injectable.
 *
 * Returns `{ path, label, layout, reason, variant, candidates }`, or null when nothing can serve.
 *
 * Order:
 *   1. EXPLICIT  settings.pack_variant names a label. Returned even when UNUSABLE, so the load fails
 *                loudly through the existing ORKPACK_UNUSABLE path rather than silently serving a
 *                different variant than the one that was asked for. A label that no longer exists
 *                (the re-quantize case) falls through with a one-time warning — a load, not a
 *                failure, and not a silent wrong answer.
 *   2. TIER      orkQuantForSource() gives '4' | '8' | null from the source's width and npu_quant.
 *                Keep the usable variants whose footer tier matches.
 *   3. SOLE      exactly one candidate.
 *   4. BUDGET    the highest bpw whose footprint fits the budget; if none fits, the lowest bpw.
 *                This is the SAME measured-RAM logic the tier rule uses, applied once more rather
 *                than a second unrelated rule — and it never refuses: a model that will not load is
 *                a worse failure than a defensible default.
 *
 * Nothing here reads mtime. A copy, a touch or a restore must not change which variant resolves.
 */
export function resolveOrkpack(absGguf, { settings = null, precision = null, budgetMB = null } = {}) {
  const { layout, variants } = listOrkpackVariants(absGguf, { precision });
  if (!variants.length) return null;
  const hit = (v, reason) => ({ path: v.path, label: v.label, layout, reason, variant: v, candidates: variants });

  if (layout === 'legacy') return hit(variants[0], 'legacy');

  // 1. EXPLICIT
  const pinned = settings?.pack_variant ? String(settings.pack_variant) : null;
  if (pinned) {
    const v = variants.find(x => x.label === pinned);
    if (v) return hit(v, 'explicit');
    warnOnce(`${absGguf}:${pinned}`,
      `[orkpack] ${path.basename(absGguf)}: pack_variant='${pinned}' names a variant that no longer exists ` +
      `(have: ${variants.map(x => x.label).join(', ') || 'none'}) — most likely a re-quantize changed its ` +
      `measured bpw. Falling back to automatic selection; re-pin it on the Models page to silence this.`);
  }

  const usable = variants.filter(v => v.usable);
  if (!usable.length) return null;

  // 2. TIER
  let pool = usable;
  let reason = 'tier';
  const want = orkQuantForSource(ggufQuantBits(absGguf), settings?.npu_quant ?? 'auto');
  if (want) {
    const tier = Number(want);
    const matched = usable.filter(v => v.qbits === tier);
    if (matched.length) pool = matched;
    else {
      reason = 'tier-unmet';
      warnOnce(`${absGguf}:tier${tier}`,
        `[orkpack] ${path.basename(absGguf)}: no usable int${tier} variant (have: ` +
        `${usable.map(v => `${v.label}=int${v.qbits}`).join(', ')}) — selecting across all tiers instead.`);
    }
  } else {
    reason = 'untiered';
  }

  // 3. SOLE
  if (pool.length === 1 && usable.length === 1) return hit(pool[0], 'sole');

  // 4. BUDGET
  if (pool.length === 1) return hit(pool[0], reason);
  const budget = (budgetMB ?? defaultPackBudgetMB()) * 1048576;
  const { variant: chosen, fit } = pickByBudget(pool, budget);
  // Ambiguity resolved silently is how we got here. Say which variants were eligible, which won and
  // why, and name the knob that overrides it.
  warnOnce(`${absGguf}:pick:${chosen.label}:${pool.map(v => v.label).join(',')}`,
    `[orkpack] ${path.basename(absGguf)}: ${pool.length} eligible variants ` +
    `(${pool.map(v => `${v.label} ${(v.sizeBytes / 1073741824).toFixed(2)}GiB`).join(', ')}) — chose ` +
    `'${chosen.label}': ${fit ? 'highest bpw that fits' : 'none fits, so the lowest bpw against'} the ` +
    `${(budget / 1073741824).toFixed(1)}GiB budget. Set pack_variant on the Models page to pin one.`);
  return hit(chosen, 'budget');
}

// Highest bpw that FITS the measured budget; if none fits, the lowest bpw.
//
// This is the same measured-RAM logic the tier rule applies, used once more rather than invented as a
// second rule to reconcile with it — and it never refuses, because a model that will not load is a
// worse failure than a defensible default. The footprint used is the pack's FILE size, which is an
// upper bound on its resident weight bytes (it also carries the model's non-packed tensors), so the
// rule errs toward the smaller variant, which is the safe direction.
//
// Exact ties fall through to a deterministic order — more index entries (the more complete pack),
// then the lexicographically smaller filename — so the answer is a pure function of the SET. Nothing
// consults mtime: a copy, a touch or a restore must not change which variant resolves.
function pickByBudget(pool, budgetBytes) {
  const rank = (dir) => (a, b) => {
    const ab = a.bpw ?? -1, bb = b.bpw ?? -1;
    if (ab !== bb) return dir * (bb - ab);
    if (a.nEntries !== b.nEntries) return b.nEntries - a.nEntries;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };
  const fits = pool.filter(v => v.sizeBytes <= budgetBytes);
  if (fits.length) return { variant: [...fits].sort(rank(1))[0], fit: true };
  return { variant: [...pool].sort(rank(-1))[0], fit: false };   // -1 → ascending bpw → the lowest
}

const _warned = new Set();
function warnOnce(key, msg) { if (_warned.has(key)) return; _warned.add(key); console.warn(msg); }

/** Test hook: forget the one-time warnings and the measured-label memo. */
export function clearOrkpackDirState() { _warned.clear(); _unmarkedWarned.clear(); clearPackLabelCache(); }

/** The concrete pack file for this source, or null. Shorthand for resolveOrkpack(...)?.path. */
export function orkpackFileFor(absGguf, opts = {}) { return resolveOrkpack(absGguf, opts)?.path ?? null; }

/**
 * Has this .gguf been superseded by its pack? Once a USABLE pack exists the gguf is a build input,
 * not a servable model, and listing both would offer the same weights twice.
 *
 * The legacy arm keeps the old size-only test verbatim, so nothing on disk today changes behaviour.
 * The directory arm additionally requires USABILITY, because unlike the legacy layout there is no
 * single file whose mere existence means "this model is packed" — a half-built or stale variant must
 * not hide the source GGUF, which is the only thing a rebuild can start from.
 */
export function supersededByPack(absGguf, opts = {}) {
  const dir = orkpackDirFor(absGguf);
  if (isPackDir(dir)) return listOrkpackVariants(absGguf, opts).variants.some(v => v.usable);
  try { return fs.statSync(orkpackPathFor(absGguf)).size > 0; } catch { return false; }
}

// ---- building ---------------------------------------------------------------------------------------

/**
 * Where a NEW pack is built. Creates the directory and its marker if needed, and returns a temp path
 * inside it — bpw is only knowable after the build, so the file is named for its measurement on
 * success (finalizeOrkpackBuild) and the directory key never moves.
 *
 * Every new build goes to the DIRECTORY layout. The legacy path is read, never written.
 */
export function orkpackBuildTarget(absGguf, tag = '') {
  const dir = orkpackDirFor(absGguf);
  if (!isPackDir(dir)) writePackDirMarker(dir, { source: path.basename(absGguf) });
  const sfx = tag ? `-${tag}` : '';
  return path.join(dir, `${BUILDING_PREFIX}${process.pid}-${Date.now()}${sfx}.orkpack`);
}

/**
 * Name a finished build for what it MEASURES as, and move it into place.
 *
 * The label comes from `packQuantLabel` — the same call the Models page uses — so the filename and
 * the displayed label are literally the same string from the same measurement and cannot drift. A
 * pack whose index cannot be walked gets `unlabelled-<ms>` rather than a fabricated number.
 *
 * A same-label collision REPLACES: an explicit re-quantize that lands on the same measured bpw is a
 * replace, not a second variant. The rename is atomic and happens before the old sidecars are swept,
 * so the old bytes are never unlinked before the new ones are in place.
 *
 * Returns the final path.
 */
export function finalizeOrkpackBuild(buildPath) {
  clearPackLabelCache();                               // the file at this path just changed
  const label = packQuantLabel(buildPath) || `unlabelled-${Date.now()}`;
  const dir = path.dirname(buildPath);
  const final = path.join(dir, `${label}.orkpack`);
  if (final === buildPath) return final;
  const hadOld = fs.existsSync(final);
  fs.renameSync(buildPath, final);                     // atomic; replaces any same-label pack
  for (const s of SIDECAR_SUFFIXES) {
    const from = buildPath + s, to = final + s;
    try { fs.renameSync(from, to); }
    catch { if (hadOld) { try { fs.unlinkSync(to); } catch {} } }   // no new sidecar → drop the stale one
  }
  clearPackLabelCache();
  return final;
}

/** Drop an abandoned build and everything beside it. Never touches a finished variant. */
export function discardOrkpackBuild(buildPath) {
  if (!isBuildingPack(buildPath)) return;
  for (const p of [buildPath, ...SIDECAR_SUFFIXES.map(s => buildPath + s)]) {
    try { fs.unlinkSync(p); } catch {}
  }
}

// ---- removal ---------------------------------------------------------------------------------------

/**
 * Remove a source's pack(s) and every sidecar that belongs to them.
 *
 * DIRECTORY: remove the directory. Every stub, sibling symlink, provenance record and tuning profile
 * is inside it by construction, which RETIRES the missed-sidecar class rather than patching it — the
 * old hardcoded sweep was already known to miss a split pack's `<base>.orkpack-00002-of-00002.gguf`
 * stub siblings. Pass `variant` to remove just one.
 *
 * LEGACY: the explicit suffix list, PLUS an anchored sweep of the parent directory for anything whose
 * name begins with `<base>.orkpack` — which is what finally catches those stub siblings. Prefix
 * collision with a different model is impossible: the anchor is the full `<base>.orkpack` string, and
 * `Qwen3-1.7B-extra.orkpack` does not begin with `Qwen3-1.7B.orkpack`.
 */
export function removeOrkpack(absGguf, { variant = null } = {}) {
  clearPackLabelCache();
  const dir = orkpackDirFor(absGguf);
  if (isPackDir(dir)) {
    if (variant) {
      const anchor = `${variant}.orkpack`;
      for (const n of safeReaddir(dir)) if (n === anchor || n.startsWith(anchor)) rm(path.join(dir, n));
      // An empty directory (marker only) is not a pack directory worth keeping around.
      if (safeReaddir(dir).every(n => n === path.basename(packDirMarkerPath(dir)))) rm(dir);
    } else rm(dir);
    return;
  }
  const pack = orkpackPathFor(absGguf);
  for (const s of ['', ...SIDECAR_SUFFIXES]) rm(pack + s);
  const base = path.basename(pack);
  for (const n of safeReaddir(path.dirname(pack))) if (n !== base && n.startsWith(base)) rm(path.join(path.dirname(pack), n));
}

const safeReaddir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

// ---- migration — explicit, reversible, script-only ---------------------------------------------------
//
// NOT exposed in the admin UI and NOT run by any scan, load or enumeration. It moves multi-GB
// artifacts and a stray click is a poor way to discover that. See scripts/orkpack-migrate.mjs.
//
// HARDLINK, verify, only then unlink. Same filesystem, so each link is O(1) and no bytes are copied,
// and at EVERY instant the bytes are reachable under at least one name. If verification fails nothing
// is unlinked and the legacy layout is intact. A crash leaves either (a) legacy only or (b) both
// present — and (b) resolves deterministically, because a marked directory wins outright and the
// legacy file is ignored rather than deleted. Nothing here ever deletes a pack it did not just write.

/** Legacy file -> directory. Idempotent. `{ ok, layout, from, to, reason }`. */
export function orkpackMigrateToDir(absGguf, { dryRun = false } = {}) {
  const dir = orkpackDirFor(absGguf);
  if (isPackDir(dir)) return { ok: true, layout: 'dir', reason: 'already-a-pack-directory' };
  const legacy = orkpackPathFor(absGguf);
  let lst; try { lst = fs.statSync(legacy); } catch { return { ok: false, reason: 'no-legacy-pack' }; }
  if (!lst.isFile() || lst.size === 0) return { ok: false, reason: 'no-legacy-pack' };

  const label = packQuantLabel(legacy) || `unlabelled-${Date.now()}`;
  const to = path.join(dir, `${label}.orkpack`);
  const moves = [[legacy, to]];
  for (const s of SIDECAR_SUFFIXES) if (fs.existsSync(legacy + s)) moves.push([legacy + s, to + s]);
  // Anything else anchored on the pack name — the split stub's sibling symlinks, above all.
  const base = path.basename(legacy);
  for (const n of safeReaddir(path.dirname(legacy))) {
    if (n === base || !n.startsWith(base)) continue;
    const from = path.join(path.dirname(legacy), n);
    if (!moves.some(([f]) => f === from)) moves.push([from, to + n.slice(base.length)]);
  }
  if (dryRun) return { ok: true, layout: 'dir', from: legacy, to, moves, dryRun: true };

  writePackDirMarker(dir, { source: path.basename(absGguf) });
  const linked = [];
  try {
    for (const [from, dst] of moves) { link(from, dst); linked.push([from, dst]); }
    for (const [from, dst] of linked) verifySame(from, dst);
  } catch (e) {
    for (const [, dst] of linked) rm(dst);                       // nothing was unlinked; legacy intact
    try { fs.unlinkSync(packDirMarkerPath(dir)); fs.rmdirSync(dir); } catch {}
    return { ok: false, reason: `link/verify failed: ${e.message}` };
  }
  for (const [from] of linked) { try { fs.unlinkSync(from); } catch {} }
  clearPackLabelCache();
  return { ok: true, layout: 'dir', from: legacy, to, moved: linked.length };
}

/** Directory -> legacy file. The exact reverse; refuses when the directory holds several variants. */
export function orkpackUnmigrateFromDir(absGguf, { dryRun = false } = {}) {
  const dir = orkpackDirFor(absGguf);
  if (!isPackDir(dir)) return { ok: false, reason: 'not-a-pack-directory' };
  const { variants } = listOrkpackVariants(absGguf);
  if (variants.length !== 1) return { ok: false, reason: `expected exactly 1 variant, found ${variants.length}` };
  const from = variants[0].path;
  const to = orkpackPathFor(absGguf);
  if (fs.existsSync(to)) return { ok: false, reason: 'a legacy pack already exists at the target' };
  const fbase = path.basename(from);
  const moves = [[from, to]];
  for (const n of safeReaddir(dir)) {
    if (n === fbase || !n.startsWith(fbase)) continue;
    moves.push([path.join(dir, n), to + n.slice(fbase.length)]);
  }
  if (dryRun) return { ok: true, layout: 'legacy', from, to, moves, dryRun: true };

  const linked = [];
  try {
    for (const [f, d] of moves) { link(f, d); linked.push([f, d]); }
    for (const [f, d] of linked) verifySame(f, d);
  } catch (e) {
    for (const [, d] of linked) rm(d);
    return { ok: false, reason: `link/verify failed: ${e.message}` };
  }
  rm(dir);
  clearPackLabelCache();
  return { ok: true, layout: 'legacy', from, to, moved: linked.length };
}

// Hardlink, falling back to a copy only across devices (which cannot happen for a sibling path, but a
// bind mount or an overlayfs could surprise us and a failed migration is worse than a slow one).
function link(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.linkSync(from, to); }
  catch (e) { if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; fs.copyFileSync(from, to); }
}

// The verification that licenses the unlink: same inode (it really is a hardlink, so the bytes are
// literally the same bytes) and same size. Deliberately NOT a content compare — a 13 GiB pack would
// cost 26 GiB of IO to re-read, and on the hardlink path the inode check is strictly stronger anyway.
// On the EXDEV copy fallback the inode differs by definition, so only size is checked and the caller
// is told; that path cannot arise for a sibling directory, which is the only way we call this.
function verifySame(from, to) {
  const a = fs.statSync(from), b = fs.statSync(to);
  if (a.size !== b.size) throw new Error(`${to}: size ${b.size} != ${a.size}`);
  if (a.ino !== b.ino) console.warn(`[orkpack] ${to} was COPIED, not hardlinked (different filesystem) — verified by size only`);
}

export { orkpackDirFor, isPackDir, readPackDirMarker, writePackDirMarker, SIDECAR_SUFFIXES };
