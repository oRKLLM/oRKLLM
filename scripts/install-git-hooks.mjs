#!/usr/bin/env node
// Wire scripts/pre-commit into .git/hooks/pre-commit. Run from `postinstall`,
// but only on developer installs — skipped in production / CI installs and when
// there's no git checkout (e.g. the deployed board or a tarball install), so
// production deploys never get a test-gated commit hook.
import { existsSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function done(msg) { if (msg) console.log(`[orkllm] ${msg}`); process.exit(0); }

// Production / CI installs: hooks are a developer convenience only.
const production =
  process.env.NODE_ENV === 'production' ||
  process.env.npm_config_production === 'true' ||
  (process.env.npm_config_omit || '').split(',').includes('dev') ||
  process.env.CI === 'true';
if (production) done();

// Need a git checkout to install into.
let gitDir;
try {
  gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {
  done(); // not a git repo (deployed copy / tarball) — nothing to wire up
}
const resolvedGitDir = isAbsolute(gitDir) ? gitDir : join(repoRoot, gitDir);
const hooksDir = join(resolvedGitDir, 'hooks');

try {
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  const src = join(repoRoot, 'scripts', 'pre-commit');
  const dest = join(hooksDir, 'pre-commit');
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  done('Installed git pre-commit hook (E2E gate).');
} catch (e) {
  // Never fail the install over a hook.
  console.warn(`[orkllm] Could not install git hook: ${e.message}`);
  process.exit(0);
}
