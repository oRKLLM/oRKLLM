#!/usr/bin/env node
/* Regression tests for the open NPU regcmd matmul kernels (Phases 1-3 + perf + polish).
 *
 * Each kernel self-validates its result against a CPU reference and exits 0 (CORRECT)
 * or 2 (WRONG); a hang is caught by a wall-clock timeout. This harness compiles every
 * kernel on the board and runs it across a matrix of shapes that stay inside the
 * VALIDATED regime for that kernel, asserting all pass. It needs NPU hardware
 * (/dev/dri/card1) but NOT the proprietary librknnrt (the synthesized kernels use raw
 * DRM submission). Runs serially with a settle delay — the NPU is single-stream and a
 * wedged submit can stall the next one.
 *
 *   BOARD=user@host node test/regression.mjs           # full suite
 *   BOARD=user@host node test/regression.mjs sched     # only kernels matching "sched"
 *
 * Env: BOARD (default michael@10.3.0.236), BOARD_DIR (/tmp/rknpu_regress),
 *      TEST_TIMEOUT seconds/test (90), SETTLE_MS between tests (400).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BOARD = process.env.BOARD || 'michael@10.3.0.236';
const DIR = process.env.BOARD_DIR || '/tmp/rknpu_regress';
const TIMEOUT = process.env.TEST_TIMEOUT || '90';
const SETTLE = process.env.SETTLE_MS || '400';
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const filter = process.argv[2];

/* kernel -> { src, shapes:[[M,K,N]|[NW]] }. Shapes restricted to each kernel's proven
 * regime: sched/sched_i8 = decode (M=1) + single-M-tile (M<R) + multi-tile only at
 * K<=512 (closed-form); hybrids = arbitrary K incl non-power-of-2 (fallback path). */
const SUITE = {
  // M2.2 fp16 GEMM (software M-tiling, single-pass K<=2048)
  rknpu_synth:     { src:'rknpu_synth.c',     shapes:[[4,32,16],[64,512,16],[128,512,128],[256,1024,64],[512,2048,16]] },
  // M2.3 int8/w8a8 GEMM
  rknpu_synth_i8:  { src:'rknpu_synth_i8.c',  shapes:[[4,32,32],[64,512,32],[128,1024,64],[256,2048,128]] },
  // M3.1 resident weights (>150-ctx wall bypass) — arg is weight count
  rknpu_resident:  { src:'rknpu_resident.c',  shapes:[[256],[512]] },
  // perf: fp16 single-submit scheduler — decode + single-M-tile + K<=512 multi-tile
  rknpu_sched:     { src:'rknpu_sched.c',     shapes:[[1,2048,16],[1,4096,128],[1,8192,512],[4,4096,32],[64,512,16],[256,512,128]] },
  // polish: int8 single-submit scheduler — decode + single-M-tile
  rknpu_sched_i8:  { src:'rknpu_sched_i8.c',  shapes:[[1,2048,32],[1,4096,128],[1,8192,512],[8,2048,64],[64,512,64]] },
  // M-tiling perf: fp16 K-split hybrid (pooled, ARBITRARY K incl non-power-of-2)
  rknpu_hybrid:    { src:'rknpu_hybrid.c',    shapes:[[128,512,16],[512,4096,512],[512,8192,128],[384,11008,64],[256,5120,256],[128,1536,64]] },
  // int8 K-split hybrid (pooled, arbitrary K)
  rknpu_hybrid_i8: { src:'rknpu_hybrid_i8.c', shapes:[[512,8192,128],[256,11008,32],[256,14336,32],[512,4096,512],[128,1280,64]] },
  // single-submit general-M large-K via M-tile PC-chaining (calibrated power-of-2 K)
  rknpu_pcchain:   { src:'rknpu_pcchain.c',   shapes:[[128,4096,16],[512,4096,128],[256,8192,16],[512,2048,128],[64,1024,64],[512,512,64],[256,8192,512]] },
};

const kernels = Object.entries(SUITE).filter(([k]) => !filter || k.includes(filter));
if (!kernels.length) { console.error(`no kernels match "${filter}"`); process.exit(1); }

function ssh(cmd) { return execFileSync('ssh', ['-n', BOARD, cmd], { encoding: 'utf8', maxBuffer: 1 << 24 }); }

// 1. ship sources + headers to the board
console.log(`→ syncing kernels + headers to ${BOARD}:${DIR}`);
execFileSync('bash', ['-c',
  `cd ${JSON.stringify(SRC)} && tar cf - *.c *.h | ssh ${BOARD} "mkdir -p ${DIR} && tar xf - -C ${DIR}"`],
  { stdio: ['ignore', 'inherit', 'inherit'] });

// 2. compile every kernel under test
console.log('→ compiling');
for (const [bin, { src }] of kernels) {
  try { ssh(`cd ${DIR} && gcc -O2 -I. -o ${bin} ${src}`); }
  catch (e) { console.error(`✗ COMPILE FAILED: ${bin}\n${e.stderr || e.message}`); process.exit(1); }
}

// 3. run the matrix serially, one ssh per test (clean per-test timeout + isolation)
let pass = 0, fail = 0; const failures = [];
for (const [bin, { shapes }] of kernels) {
  for (const shape of shapes) {
    const args = shape.join(' ');
    let code;
    try {
      const out = ssh(`cd ${DIR} && sudo timeout ${TIMEOUT} ./${bin} ${args} >/dev/null 2>&1; echo EXIT:$?; sleep ${(+SETTLE/1000).toFixed(2)}`);
      code = parseInt((out.match(/EXIT:(\d+)/) || [])[1] ?? '255', 10);
    } catch { code = 255; }
    const ok = code === 0;
    if (ok) pass++; else { fail++; failures.push(`${bin} [${args}]  exit=${code === 124 ? 'TIMEOUT' : code}`); }
    console.log(`  ${ok ? '✓' : '✗'} ${bin.padEnd(16)} [${args}]${ok ? '' : `  exit=${code === 124 ? 'TIMEOUT' : code}`}`);
  }
}

console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} passed`);
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  ' + f)); process.exit(1); }
