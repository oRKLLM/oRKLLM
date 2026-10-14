# Directory-based `.orkpack` layout — SPEC

Status: **proposed, not implemented.** Cross-repo: oRKLLM (`src/orkpack.js`, `src/conversion.js`,
`src/pool.js`, the two enumerations) and the llama.cpp fork (`ggml/src/ggml-ork/ggml-ork.cpp`).

Everything below marked **(read)** was established by reading the code named; **(measured)** by running
it; **(inferred)** is a judgement that no observation supports yet, and is flagged as such on purpose.

---

## 0. The problem, and the one property that must survive

One source GGUF can reasonably carry several packs: a 4bpw native W4A4, a 4.9bpw promoted mixed, an
8bpw int8. Today a pack's path is `orkpackPathFor(absGguf)` — a pure extension swap (`src/orkpack.js:62`,
**read**) — so there is exactly one slot per source and a second build overwrites the first.

The obvious fix, renaming the pack FILE to its bpw, is the wrong one: bpw is a **measured property of the
artifact** that changes on every re-quantize, and `sourceGgufFor` is a reverse extension swap
(`src/orkpack.js:116`, **read**) that is how a pack inherits its source's settings row
(`modelSettingsFor`, `src/pool.js:111`, **read**). Encoding a variable into the identity moves the key
whenever the artifact is rebuilt.

Every pack defect this project hit this week is the same shape — *one logical model, several ids, a
lookup keyed on the wrong one, failing silently*:

| bug | the two ids | what failed |
|---|---|---|
| pool slot reuse | `X.gguf` / `X.orkpack` | equality on the raw string evicted a model to reload itself (`e40e6c8`) |
| orphaned settings | `X-00001-of-00002.gguf` / `X.gguf` | a recorded `pack_mixed:true` never reached the build; produced an unrunnable 27B (`1153606`) |
| stale admin poll | resident id vs requested id | `/api/admin/status` reported an equality that could not become true (`15a748e`) |

★ **Therefore the governing rule of this design: the SOURCE is the identity; the variant is an
attribute.** No DB key, settings lookup, enumeration entry or alias may depend on which variant is
selected. Every decision below is justified against that rule, and the two places where it forced an
awkward choice are called out.

---

## 1. Layout

```
<model-dir>/Qwen3.8-27B-BF16.gguf            source, UNTOUCHED (may later be deleted — that is the point)
<model-dir>/Qwen3.8-27B-BF16/                PACK DIRECTORY, named for the SOURCE
    .orkpack-dir                             marker + provenance of the directory itself
    4bpw.orkpack                             a variant
    4bpw.orkpack.gguf                        its stub (ggml-ork writes `<pack>.gguf`; see §6)
    4bpw.orkpack.prov.json                   its provenance sidecar
    4bpw.orkpack.gmax                        its tuning sidecar (ggml-ork, `<pack>.gmax`)
    4bpw.orkpack.json                        its progress sidecar during a build
    4.9bpw.orkpack
    8bpw.orkpack
```

`.orkpack-dir` is a small JSON:

```json
{ "schema": 1, "source": "Qwen3.8-27B-BF16.gguf", "createdAt": "2026-10-14T…Z", "producer": "oRKLLM" }
```

It exists for one reason: **the source GGUF may be deleted**, so "is `<dir>.gguf` a sibling?" cannot be
the directory predicate. The marker survives the source and states what the directory is named after,
which is the identity. It costs one `stat`.

### Why not a `current` symlink

Considered and **rejected**: a symlink in the directory pointing at the chosen variant would let
ggml-ork resolve one fixed path and need no selection logic at all. It is rejected because it makes
resolution **stateful** — a mutable pointer that something must write, i.e. exactly the write-on-read
hazard the brief forbids — and because a symlink left pointing at a removed variant is a new silent
failure mode. Resolution stays a pure function of what is on disk plus the settings row.

---

## 2. Identity: the pack HANDLE

★ The model id for a packed model stays **exactly what it is today**: `<reldir>/<base>.orkpack`.

In the legacy layout that string is a file. In the directory layout it is a **handle** — a name that
resolves to a concrete variant file. It is never renamed, whatever the variant.

This is deliberately the least invasive choice available, and it is the only one consistent with the
governing rule. Everything that derives identity keeps working **unchanged**:

| derivation | site | behaviour under the directory layout |
|---|---|---|
| `sourceGgufFor(id)` | `orkpack.js:116` | unchanged — still the reverse extension swap |
| `modelSettingsFor` | `pool.js:111` | unchanged — keys on the handle, falls back to the source gguf, then the pre-consolidation shard id |
| `modelAliasesFor` | `pool.js:181` | unchanged — `[handle, source.gguf]` |
| `canonicalModelId` | `pool.js:189` | unchanged — `X.gguf` → `X.orkpack` when superseded |
| `isOrkpackPath` | `orkpack.js:74` | unchanged |
| `ggufDisplayName` / `modelDisplayName` | `gguf.js`, `quant_plan.js:271` | unchanged input; the label now comes from the RESOLVED variant |

The cost: a handle is not a file, so every site that does `fs.statSync(path.join(MODELS_DIR, id))` on a
pack must go through a resolver. That set is small and enumerated in §8.

---

## 3. New API in `src/orkpack.js`

All of it pure or `fs`-read-only. No function below writes anything.

```js
orkpackDirFor(absGguf)            // absGguf with .gguf stripped. '/m/X.gguf' -> '/m/X'
orkpackHandleFor(absGguf)         // === today's orkpackPathFor. Kept under the old name too.
isPackDir(absDir)                 // marker present, or the §3.1 fallback
readPackDirMarker(absDir)         // the parsed .orkpack-dir, or null

listOrkpackVariants(absGguf)      // [] | [variant…]
resolveOrkpack(absGguf, opts)     // { path, variant, layout, reason } | null
```

A **variant** record:

```js
{
  label:    '4.9bpw',          // the variant name; '' for the legacy file (it has none)
  path:     '/m/X/4.9bpw.orkpack',
  layout:   'dir' | 'legacy',
  footer:   { version, orkFmt, quantSig, nEntries, size } | null,   // readOrkpackFooter
  qbits:    4 | 8 | null,      // sigQbits(footer.quantSig), null when no footer
  bpw:      4.9 | null,        // MEASURED: measureFromPack().currentBpw. null when the index is unreadable
  mtimeMs, sizeBytes,
  usable:   true | false,      // isOrkpackUsable(path, precision) with the caller's precision
}
```

`bpw` is the measured number, not the filename parsed back. The filename is *derived from* the
measurement (§5) and may be stale if someone renamed a file by hand; the measurement never is. Reading
it costs an index tail-read, already memoised on `(mtime, size)` by `cachedPackLabel`
(`quant_plan.js:210`, **read**) — the same memo is reused.

### 3.1 `isPackDir`

```
marker:    <dir>/.orkpack-dir exists and parses        -> true     (authoritative)
fallback:  <dir> contains >=1 *.orkpack
           AND contains no *.gguf that is not an orkpack stub   -> true
otherwise                                                        -> false
```

The fallback exists so a directory copied from another board, or made by hand, is still recognised.
Its second clause is what keeps it from misfiring on a legacy repo directory: `Qwen3-1.7B-GGUF/`
contains `…UD-Q4_K_XL.orkpack` **and** its source `…UD-Q4_K_XL.gguf`, so it is correctly *not* a pack
directory (**read** — this is the real shape on disk today, per `test/model_settings_fallback.test.mjs:10`).
The fallback is never written back to disk. **(inferred)** — the clause is reasoned from the layout,
not observed failing or passing on a real copied directory.

### 3.2 `resolveOrkpack(absGguf, { settings, precision })` — the resolution order

Pure function of `(source path, settings row, machine facts)`. "Machine facts" are what
`isOrkpackUsable` already consults — `expectedOrkFmt()` and the runtime tag — and they are injectable
for tests.

```
0. If a pack DIRECTORY exists for this source, it wins outright. The legacy file is not consulted.
   Otherwise fall through to the legacy file.

   Directory:
   1. EXPLICIT. settings.pack_variant names a label.
      - the file exists           -> return it, reason 'explicit'.
                                     Returned even when !usable, so the load fails LOUDLY through the
                                     existing ORKPACK_UNUSABLE path rather than silently serving a
                                     different variant than the one that was asked for.
      - the file is gone          -> fall through to 2, reason 'explicit-missing' (warn once per source).
                                     This is the re-quantize-changed-the-bpw case; see §7.
   2. TIER. orkQuantForSource(sourceBits, settings.npu_quant) gives '4' | '8' | null.
      If it gives a tier, keep only usable variants whose footer sigQbits matches it.
      If that leaves >=1, go to 4 over that subset, reason 'tier'.
      If it leaves 0, go to 4 over ALL usable variants, reason 'tier-unmet' (warn once).
   3. SOLE. Exactly one usable variant -> it, reason 'sole'.
   4. TIEBREAK, deterministic, in this order:
        a. highest measured bpw
        b. then highest footer.nEntries   (a more complete pack)
        c. then lexicographically smallest filename
      reason 'tiebreak'.
      NOTHING here reads mtime: a copy or a touch must not change which variant resolves.
   5. No usable variant at all -> null (the handle resolves to nothing; the model is "needs a build").

   Legacy:
   1. <base>.orkpack exists -> one variant, label '', layout 'legacy'.
   2. else null.
```

**Tiebreak rationale.** Step 2 already picked the compute tier, so step 4 only ever breaks ties *within*
a tier. Within a tier, higher bpw is the promoted/mixed build — strictly better quality on the same
compute path. Highest-bpw-wins is therefore quality-maximising and, unlike mtime, is a pure function of
the set. It deliberately does **not** encode "smaller is faster": that trade is the tier rule's job
(`orkQuantForSource`, `orkpack.js:132`, **read**), and `pack_variant` is there for anyone who disagrees
with the automatic answer.

### 3.3 `supersededByPack(absGguf)`

Becomes: *the source has a pack directory holding at least one usable variant, or a usable legacy file.*

Today it is `statSync(orkpackPathFor(abs)).size > 0` (`orkpack.js:143`, **read**) — size only, no
usability check. **Widening it to require usability is a behaviour change** and is done deliberately:
under the directory layout a half-built or stale variant must not hide the source GGUF, because unlike
today there is no single file whose mere existence means "this model is packed". For the legacy arm the
old size-only test is kept verbatim, so nothing currently on disk changes behaviour.

---

## 4. Enumeration

Both walks (`src/api/routes.js:95`, `src/admin/routes.js:869`, **read**) recurse into subdirectories and
emit every `.rkllm|.gguf|.orkpack` file as a model id. Two changes, identical in both:

1. **A pack directory is not descended into.** It emits ONE entry — the handle `<prefix>/<D>.orkpack` —
   and the walk does not recurse. Without this, a 3-variant directory lists as three models with ids
   like `Qwen3.8-27B-BF16/4bpw.orkpack`, and `sourceGgufFor` on that id yields
   `Qwen3.8-27B-BF16/4bpw.gguf`, which does not exist — the settings row is lost. That is precisely the
   failure in the table in §0, and it is why §2 keeps the handle.
2. **A source `.gguf` with a pack directory is skipped** (superseded), exactly as today. The directory
   already emitted the handle, so the model appears exactly once whichever of the two the walk reaches
   first.

Size, display name and template for a handle come from the **resolved** variant. `modelDisplayName(id,
abs)` is called with the resolved concrete path, so the Models page shows the bpw of the variant that
would actually load — the filename and the label come from the same measurement (§5) and cannot
disagree.

---

## 5. Variant naming — from the existing measurement, not a new one

The variant filename is `${packQuantLabel(pack)}.orkpack`, where `packQuantLabel` is the function that
already landed in `817b839` (`src/quant_plan.js:247`, **read**): measured `currentBpw` formatted to one
decimal (`4.9bpw`), falling back to the footer tier (`int4` / `int8`) when the index cannot be walked,
and `null` when the file cannot tell us. Reusing it is the point — the filename and the Models-page
label are then **the same string from the same call**, and cannot drift.

bpw is only knowable after a build, so:

```
build target:   <dir>/.building-<pid>-<epochms>.orkpack      (ggml-ork writes <that>.tmp and renames)
on success:     label = packQuantLabel(built)
                null label -> 'unlabelled-<epochms>'         (never fabricate a number)
                rename   <building>.orkpack       -> <label>.orkpack
                rename   <building>.orkpack.gguf  -> <label>.orkpack.gguf      (and each sidecar)
on failure:     unlink the building-* set; the directory is otherwise untouched
```

Same filesystem, so each rename is O(1) and atomic. The directory key does not move — which is the
whole point of the scheme.

**Collision** (`<label>.orkpack` already exists): the new build replaces it. An explicit re-quantize
that lands on the same measured bpw is a replace, not a second variant. Order: rename the new one over
the old (atomic on POSIX), then remove the old one's orphaned sidecars. The old bytes are never unlinked
before the new ones are in place.

The `.building-` prefix is chosen so `listOrkpackVariants` can filter it with one test and an
interrupted build never resolves as a variant.

---

## 6. The ggml-ork contract

ggml-ork derives its pack path independently from `-m` (`ork_default_orkpack_path`,
`ggml-ork.cpp:2083`, **read**) and builds one there if absent (`ork_persist_init`, `:2231`). Both halves
must land together or a multi-GB pack is silently rebuilt at the legacy path.

**What is already true and needs no code (read):**

- `ORK_ORKPACK_PATH` already wins over the derivation (`:2249`), and oRKLLM already sets it on every
  worker fork (`src/pool.js:238`) because an N-API embedder has no `-m` on its command line.
- Every sidecar keys off `ctx->persist_final`, the *resolved* path — `.tmp` (`:2583`), `.gmax`
  (`:2587`, `:6749`, `:11679`), the stub (`:3983`). So they all land inside the directory for free.

**Changes:**

1. **Promote `ORK_ORKPACK_PATH` from "development override only" to a supported input.** This is a
   documentation change in three places — the file header (`:26-28`), the `ORK_PERSIST` abort message
   (`:2242`) and the comment above `ork_default_orkpack_path` (`:2079`). No behaviour moves. Saying so
   plainly: *the runtime half of the contract is mostly prose*; the functional work is #2 and #3.
   (An agent independently recommended this same promotion for an unrelated reason, so it is doubly
   justified.)
2. **Teach the derivation about the directory**, so a bare `llama-completion -m X.gguf`, `ork_bench` or
   `llama-bench` next to a populated pack directory ADOPTS a variant instead of building a legacy pack
   beside it. Resolution, in `ork_default_orkpack_path`:

   ```
   a. <model-dir>/<base>/ exists and holds *.orkpack
      -> read each candidate's 64-byte footer; keep those whose version/ork_fmt this build accepts;
         prefer sig_qbits == the forced ORK_QUANT when one is set;
         tiebreak by bpw PARSED FROM THE FILENAME, descending, then strcmp.
   b. else <model-dir>/<base>.orkpack                (legacy — unchanged)
   c. build target: if (a)'s directory exists, build inside it as .building-<pid>-<ms>.orkpack;
      else the legacy file (unchanged for a greenfield CLI user).
   ```

   The C side parses bpw from the **filename**, and that is acceptable here *only* because it is a
   tiebreak among already-footer-validated candidates — never an adoption decision. Adoption stays the
   footer's job, unchanged. (oRKLLM guarantees the filename comes from the measurement, §5; a
   hand-renamed file can only mis-order a tie, not be wrongly adopted.)
3. **oRKLLM's conversion subprocess must pass `ORK_ORKPACK_PATH` explicitly.** `_spawnBuild`
   (`src/conversion.js:365`, **read**) spawns `llama-completion -m <abs>` and relies on the derivation
   to place the pack; under the new layout it must name the `.building-…` target itself. This is the
   real coupling, and it is on the oRKLLM side.

**Not fixed, flagged:** ggml-ork's own stub naming is `persist_final + ".gguf"` (`:3983`), a plain
append, so it does **not** keep a split shard suffix terminal the way `stubPathFor` does
(`orkpack.js:88`, **read**). It cannot bite oRKLLM — conversion consolidates splits before packing and
sets `ORK_NO_STUB=1` (`pool.js:224`) — but a CLI user packing a split gguf gets an unloadable stub.
Out of scope; recorded here so it is not rediscovered.

---

## 7. Settings, and the re-quantize test

`pack_variant` is a new per-model setting, stored on the **handle's** row (or inherited from the source
gguf's row through the existing `modelSettingsFor` chain). It holds a **label**, never a path.

The property the brief asks to be tested:

> re-quantize `Qwen3.8-27B-BF16` from 4.0bpw to 4.9bpw.
> The file moves: `4bpw.orkpack` → `4.9bpw.orkpack`.
> The handle does not: `Qwen3.8-27B-BF16.orkpack`.
> `modelSettingsFor('…/Qwen3.8-27B-BF16.orkpack')` returns the same row before and after.
> If that row pinned `pack_variant:'4bpw'`, resolution reports `explicit-missing`, warns once, and
> falls through to the tier rule — a load, not a silent wrong answer and not a failure.

Compare with the rejected bpw-in-the-filename scheme, where the handle itself becomes
`Qwen3.8-27B-4.9bpw.orkpack`, `sourceGgufFor` yields `Qwen3.8-27B-4.9bpw.gguf` (nonexistent), and the
row is orphaned — the `1153606` bug again.

---

## 8. Sites that must change

oRKLLM:

| file | site | change |
|---|---|---|
| `src/orkpack.js` | `orkpackPathFor` | kept, renamed in meaning to "the handle"; new `orkpackDirFor` / `listOrkpackVariants` / `resolveOrkpack` / `isPackDir` beside it |
| | `supersededByPack:143` | directory-aware; legacy arm byte-identical |
| | `stubPathFor`, `provPathFor` | unchanged — they already take a CONCRETE pack path and must keep doing so |
| `src/conversion.js` | `hasOrkpack:128`, `isOrkpackFresh:144` | resolve first |
| | `removeOrkpack:152` | §9 |
| | `_spawnBuild:365` | build to `.building-…` inside the directory; pass `ORK_ORKPACK_PATH`; rename on success |
| | `quantize:487` | the pass-1/pass-2 `qerrAt` dance becomes two `.building-…` names in the directory (it currently renames the pack aside precisely *because* ggml-ork derives the output path — §6.3 removes that need) |
| | `noteGguf:243`, `_discardSplitPack:292` | sidecar + removal paths through the resolver |
| `src/pool.js` | `:573` `modelPath` | ONE insertion point: a handle resolves to the concrete variant |
| | `:630` `isOrkpackUsable`, `:667` `slotOptions.orkpack/stub_path`, `:839` `orkpackPath` | already take a concrete path once `:573` resolves |
| `src/api/routes.js` | `scanDir:96` + the `statSync` at `:118` | §4 |
| `src/admin/routes.js` | `scanModels:869`, `:1577` `quantPlan` | §4; `quantPlan` takes the resolved variant |
| `src/gguf.js` | `isOrkpackStub` | unchanged — the stub shape inside a directory is still `<pack>.gguf` |

Fork: `ggml/src/ggml-ork/ggml-ork.cpp` only, §6.

---

## 9. Removal

Today `removeOrkpack` sweeps a hardcoded sidecar list (`conversion.js:154`, **read**) —
`.tmp .json .meta.json .prov.json .gmax .gguf` — and is already known to **miss split-stub siblings**
(`<base>.orkpack-00002-of-00002.gguf`, which `stubSiblingShards` creates as symlinks, `orkpack.js:100`).

- **Directory layout:** removal is `rm -r` of the directory. Every sidecar, stub and sibling is inside
  it by construction, so the missed-sibling class disappears rather than being patched. Removing a
  single variant removes `<label>.orkpack` plus everything in the directory whose name begins with
  `<label>.orkpack`, which is the same closed set.
- **Legacy layout:** keep today's explicit list and add a sweep of the parent directory for any entry
  whose name starts with `<packBasename>` and ends in one of the known sidecar shapes, *including*
  `-NNNNN-of-NNNNN.gguf`. Prefix collision with a different model is impossible: the sweep is anchored
  on the full `<base>.orkpack` string, and `Qwen3-1.7B-extra.orkpack` does not start with
  `Qwen3-1.7B.orkpack`.
- **Nothing is removed that was not just written**, in either arm, except on an explicit user action.

---

## 10. Migration — explicit, reversible, never destructive

★ Legacy must keep working untouched. `<base>.orkpack` as a FILE is what is on both boards right now,
including a 13.28 GiB 27B pack installed today. There is **no write-on-read and no automatic
migration**: a crash between a move and a key rewrite is exactly how the orphaned-settings bug was made.

Offered as an explicit, idempotent action (`orkpackMigrateToDir(absGguf, { dryRun })`), not run by any
scan, load or enumeration:

```
1. mkdir <dir>;  write .orkpack-dir
2. label = packQuantLabel(<base>.orkpack)   (or 'unlabelled-<ms>')
3. HARDLINK  <base>.orkpack            -> <dir>/<label>.orkpack
   HARDLINK  each existing sidecar     -> <dir>/<label>.orkpack<suffix>
4. VERIFY every link: same st_ino, same st_size as its source
5. only then unlink the originals
```

Hardlink, not copy: same filesystem, O(1), and at **every instant** the bytes are reachable under at
least one name. If step 4 fails nothing is unlinked and the legacy layout is intact. A crash leaves
either (a) legacy only, or (b) both present — and (b) resolves deterministically, because §3.2 step 0
says the directory wins outright and the legacy file is simply ignored, not deleted.

`orkpackUnmigrateFromDir` runs the same five steps in reverse. Neither direction ever deletes a pack it
did not just write.

---

## 11. What this does NOT do

- **No automatic migration, no write-on-read.** §10.
- **No bpw in the handle.** §0 — the whole reason the directory scheme exists.
- **No `current` symlink / no pointer file.** §1 — resolution stays stateful-free.
- **No `ORKPACK_VERSION` change.** This spec does not touch the footer, the version predicate or
  `isOrkpackUsable`'s gates. `fix/orkpack-v8` is held back deliberately and nothing here depends on or
  conflicts with it; the only shared file is `src/orkpack.js`, and these edits are additions outside the
  footer-reading block.
- **No change to the pack/handle id strings**, so no DB migration and no change to
  `model_settings` keys.
- **No fix to ggml-ork's split-stub naming.** §6, flagged.
- **No cross-variant sharing of `.gmax`.** Each variant keeps its own; the tuning profile describes
  specific packed contents (`conversion.js:147`, **read**).
- **No multi-variant residency.** One variant loads at a time; the pool is unchanged.

---

## 12. Test plan (`test/orkpack_dir.test.mjs`, node:test, no NPU)

Baseline: **212/212 unit tests green on `alpha`** (**measured**, `npm run test:unit`, 2026-10-14).

1. legacy file layout — resolves, `layout:'legacy'`, `supersededByPack` true, byte-identical to today
2. directory, one variant — resolves it, `reason:'sole'`
3. directory, three variants, no settings — tier rule picks, tiebreak deterministic, **independent of
   mtime** (touch a loser, re-resolve, same answer)
4. directory, `pack_variant` pinned — explicit wins, even over a better tier match
5. directory, `pack_variant` pinned to a label that no longer exists — `explicit-missing`, falls through,
   resolves, warns once
6. directory, none usable — `null`; `supersededByPack` false; the source `.gguf` reappears in enumeration
7. both layouts present — directory wins, legacy file untouched on disk afterwards
8. `isPackDir` says **false** for a legacy repo directory holding `X.orkpack` + `X.gguf`
9. removal — directory: whole tree gone; legacy: the hardcoded set **plus** a split-stub sibling
10. enumeration — a 3-variant directory yields exactly ONE id, equal to the handle, and the walk does not
    descend
11. **the re-quantize test** (§7): same settings row before and after a bpw change; and the negative
    control that a bpw-in-the-filename handle would have orphaned it
12. migration round-trip — migrate, verify inodes, unmigrate, byte-identical; and a simulated crash
    after step 3 resolves to the directory with the legacy file still present

E2E: the pre-commit hook gates on `npm run test:e2e`; it is run before any commit that touches `src/`.

---

## 13. Things I could not verify

- No board was touched and nothing was deployed, per the brief. Nothing here is measured on hardware.
- The `isPackDir` fallback clause (§3.1) is **inferred** from the on-disk shapes in the repo's tests and
  comments; I did not inspect a real `MODELS_DIR` to confirm no directory in the wild holds `.orkpack`
  files and no non-stub `.gguf`.
- ggml-ork §6.2 is a reading of `ork_default_orkpack_path` and `ork_persist_init`; I did not build or
  run the fork, so "sidecars follow `persist_final` for free" is **read, not measured**.
- Whether `fix/orkpack-v8`'s reader bump collides textually with these additions: I read neither branch,
  only `alpha` and `feat/orkpack-4bit-footprint`'s HEAD subject. The claim of no conflict is about
  *semantics* (nothing here touches the version predicate), not about a git merge.
