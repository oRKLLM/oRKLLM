import fs from 'fs';

// Minimal GGUF metadata reader — just enough to pull a single string KV (the
// chat template) out of the file header without loading the model. GGUF stores
// all metadata up front, so we read/skip key-value pairs until we find the one
// we want. Used to decide thinking-mode handling per model: a template that
// supports `enable_thinking` (Qwen3+) can disable reasoning at the prompt level,
// whereas a model with no such toggle (e.g. LFM2.5-MoE) needs output stripping.
//
// Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

// gguf_metadata_value_type
const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};
const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

// Buffered sequential reader over a file descriptor. Keeps a sliding window so
// we parse from memory and refill from disk as needed (a model's tokenizer
// arrays can be several MB — we skip them without per-element syscalls).
class Reader {
  constructor(fd) {
    this.fd = fd;
    this.buf = Buffer.alloc(1 << 20); // 1 MiB window
    this.len = 0;        // valid bytes currently in buf
    this.pos = 0;        // read cursor within buf
    this.filePos = 0;    // next byte offset to read from the file
  }
  // Ensure at least n bytes are available at the cursor (grows window / refills).
  ensure(n) {
    if (this.len - this.pos >= n) return;
    if (n > this.buf.length) {
      const nb = Buffer.alloc(Math.max(n, this.buf.length * 2));
      this.buf.copy(nb, 0, this.pos, this.len);
      this.buf = nb;
    } else if (this.pos > 0) {
      this.buf.copy(this.buf, 0, this.pos, this.len);
    }
    this.len -= this.pos;
    this.pos = 0;
    while (this.len < n) {
      const got = fs.readSync(this.fd, this.buf, this.len, this.buf.length - this.len, this.filePos);
      if (got <= 0) break; // EOF
      this.filePos += got;
      this.len += got;
    }
    if (this.len < n) throw new Error('GGUF: unexpected EOF');
  }
  u32() { this.ensure(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  // u64 as Number — metadata counts/lengths are well within Number.MAX_SAFE_INTEGER.
  u64() { this.ensure(8); const v = Number(this.buf.readBigUInt64LE(this.pos)); this.pos += 8; return v; }
  str() {
    const n = this.u64();
    this.ensure(n);
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  skip(n) {
    // Advance n bytes, refilling/seeking past data we don't need.
    while (n > 0) {
      const avail = this.len - this.pos;
      if (avail >= n) { this.pos += n; return; }
      n -= avail;
      this.pos = this.len; // consume window
      this.ensure(1);      // refill (or throw at EOF)
    }
  }
  skipValue(type) {
    if (type === T.STRING) { this.skip(this.u64()); return; }
    if (type === T.ARRAY) {
      const elemType = this.u32();
      const count = this.u64();
      if (elemType === T.STRING) { for (let i = 0; i < count; i++) this.skip(this.u64()); }
      else if (elemType === T.ARRAY) { for (let i = 0; i < count; i++) this.skipValue(T.ARRAY); }
      else this.skip(SCALAR_BYTES[elemType] * count);
      return;
    }
    this.skip(SCALAR_BYTES[type] ?? 0);
  }
}

// Read a single string metadata value by key. Returns the string, or null if the
// file isn't a GGUF / the key is absent / parsing fails.
export function readGgufString(filePath, key) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const r = new Reader(fd);
    if (r.u32() !== GGUF_MAGIC) return null;
    r.u32();                 // version
    r.u64();                 // tensor_count
    const kvCount = r.u64(); // metadata_kv_count
    for (let i = 0; i < kvCount; i++) {
      const k = r.str();
      const type = r.u32();
      if (k === key) {
        return type === T.STRING ? r.str() : null;
      }
      r.skipValue(type);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Cache of chat templates by "path:mtimeMs" so we parse each model file once.
const _tmplCache = new Map();

// The model's chat template (GGUF `tokenizer.chat_template`), or '' if absent.
export function getGgufChatTemplate(filePath) {
  let key = filePath;
  try {
    const st = fs.statSync(filePath);
    key = `${filePath}:${st.mtimeMs}`;
  } catch { /* fall through with bare path */ }
  if (_tmplCache.has(key)) return _tmplCache.get(key);
  const tmpl = readGgufString(filePath, 'tokenizer.chat_template') || '';
  _tmplCache.set(key, tmpl);
  return tmpl;
}

// Does the model support an explicit non-thinking mode? Qwen3+ templates gate
// reasoning behind `enable_thinking`; models without such a toggle (LFM2.5-MoE)
// always reason. True → disable thinking via a prompt seed; false → strip output.
export function supportsThinkingToggle(filePath) {
  return /enable_thinking/.test(getGgufChatTemplate(filePath));
}

// Cache of architectures by "path:mtimeMs".
const _archCache = new Map();

// The model's `general.architecture` (e.g. "qwen3", "lfm2moe"), or '' if absent.
export function getGgufArchitecture(filePath) {
  let key = filePath;
  try {
    const st = fs.statSync(filePath);
    key = `${filePath}:${st.mtimeMs}`;
  } catch { /* fall through */ }
  if (_archCache.has(key)) return _archCache.get(key);
  const arch = (readGgufString(filePath, 'general.architecture') || '').toLowerCase();
  _archCache.set(key, arch);
  return arch;
}

// Recurrent / hybrid (state-space, gated-delta, RWKV, …) architectures. For these,
// llama.cpp's KV-state save/restore (`llama_state_seq_save_file`) — which oRKLLM's
// prefix cache relies on — is unsupported or pathologically slow: on LFM2.5-MoE a
// cached multi-turn request collapsed to ~17 s/token (≈200×). The prefix cache is
// disabled for these models (see routes.js); plain prefill is fast.
const RECURRENT_ARCH_RE = /mamba|rwkv|lfm2|jamba|falcon[-_]?h1?|plamo2|nemotron[-_]?h|hybrid|recurrent/;
export function isRecurrentArch(filePath) {
  const arch = getGgufArchitecture(filePath);
  return arch !== '' && RECURRENT_ARCH_RE.test(arch);
}
