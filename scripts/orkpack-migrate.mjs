#!/usr/bin/env node
// Move a legacy `<base>.orkpack` FILE into the directory layout `<base>/<measured-bpw>.orkpack`,
// or back. Spec: docs/ORKPACK_DIRECTORY_LAYOUT.md.
//
// SCRIPT-ONLY, on purpose, and NOT offered in the admin UI: it moves multi-GB artifacts and a stray
// click is a poor way to discover that. Nothing in the server ever calls it — the legacy layout is
// read for as long as it exists, so migrating is a convenience, never a requirement.
//
// It is non-destructive by construction: hardlink, verify (same inode, same size), and only then
// unlink the original. The bytes are reachable under at least one name at every instant, no copy is
// made, and a crash leaves either the legacy file alone or both layouts — which resolves
// deterministically, because a marked directory wins and the legacy file is ignored, not deleted.
//
//   node scripts/orkpack-migrate.mjs --list
//   node scripts/orkpack-migrate.mjs --dry-run <model.gguf>…      (relative to MODELS_DIR, or absolute)
//   node scripts/orkpack-migrate.mjs <model.gguf>…
//   node scripts/orkpack-migrate.mjs --all
//   node scripts/orkpack-migrate.mjs --revert <model.gguf>…
import fs from 'fs';
import path from 'path';
import { MODELS_DIR } from '../src/config.js';
import { orkpackPathFor, orkpackDirFor, isPackDir } from '../src/orkpack.js';
import { orkpackMigrateToDir, orkpackUnmigrateFromDir, listOrkpackVariants } from '../src/orkpack_dir.js';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const dryRun = flag('--dry-run') || flag('-n');
const revert = flag('--revert');
const names  = argv.filter(a => !a.startsWith('-'));

function* walkGgufs(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!isPackDir(p) && e.name !== '.embeddings') yield* walkGgufs(p); }
    else if (/\.gguf$/i.test(e.name) && !/\.orkpack(-\d{5}-of-\d{5})?\.gguf$/i.test(e.name)) yield p;
  }
}

const gib = (n) => `${(n / 1073741824).toFixed(2)} GiB`;

if (flag('--list') || (!names.length && !flag('--all'))) {
  let legacy = 0, dirs = 0;
  for (const g of walkGgufs(MODELS_DIR)) {
    const rel = path.relative(MODELS_DIR, g);
    if (isPackDir(orkpackDirFor(g))) {
      const vs = listOrkpackVariants(g).variants;
      console.log(`dir     ${rel}  [${vs.map(v => `${v.label} ${gib(v.sizeBytes)}`).join(', ') || 'empty'}]`);
      dirs++;
    } else {
      let st; try { st = fs.statSync(orkpackPathFor(g)); } catch { continue; }
      console.log(`legacy  ${rel}  ${gib(st.size)}`);
      legacy++;
    }
  }
  console.log(`\n${dirs} directory, ${legacy} legacy. Nothing was changed.`);
  if (!flag('--list')) console.log('Pass model names, or --all, to migrate (add --dry-run first).');
  process.exit(0);
}

const targets = flag('--all')
  ? [...walkGgufs(MODELS_DIR)]
  : names.map(n => (path.isAbsolute(n) ? n : path.join(MODELS_DIR, n)));

let ok = 0, skipped = 0, failed = 0;
for (const g of targets) {
  const rel = path.relative(MODELS_DIR, g);
  const r = revert ? orkpackUnmigrateFromDir(g, { dryRun }) : orkpackMigrateToDir(g, { dryRun });
  if (!r.ok) {
    // "nothing to do" is not a failure: --all sweeps every gguf, and most have no legacy pack.
    const benign = r.reason === 'no-legacy-pack' || r.reason === 'not-a-pack-directory'
                || String(r.reason).startsWith('already');
    if (benign) { skipped++; continue; }
    console.error(`FAIL  ${rel}: ${r.reason}`);
    failed++;
    continue;
  }
  if (r.reason?.startsWith('already')) { skipped++; continue; }
  console.log(`${dryRun ? 'would move' : 'moved'}  ${rel}  ->  ${path.relative(MODELS_DIR, r.to)}` +
              (r.moves ? `  (${r.moves.length} file(s))` : `  (${r.moved} file(s))`));
  ok++;
}
console.log(`\n${ok} ${dryRun ? 'would be migrated' : 'migrated'}, ${skipped} skipped, ${failed} failed.`);
process.exit(failed ? 1 : 0);
