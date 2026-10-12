// Write a minimal but REAL GGUF: magic, version, counts, one KV (general.alignment), the tensor-info
// section, and a data blob of the right length. Shared by the quant_plan unit tests and the E2E
// Quantization-tab specs so both exercise the actual parser rather than a mock of it.
//
// `tensors` is [{ name, dims:[…], bytes }]. `bytes` is what that tensor occupies in the file, which
// is what the reader derives both its size and its bits-per-element from.
import fs from 'fs';

export function writeGguf(file, tensors, { alignment = 32 } = {}) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s) => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u64(d.length), d]); };

  parts.push(u32(0x46554747), u32(3), u64(tensors.length), u64(1));
  parts.push(str('general.alignment'), u32(4), u32(alignment));     // 4 = GGUF UINT32

  let off = 0;
  const laidOut = tensors.map(t => {
    const rec = { ...t, offset: off };
    off += Math.ceil(t.bytes / alignment) * alignment;
    return rec;
  });
  for (const t of laidOut) {
    parts.push(str(t.name), u32(t.dims.length));
    for (const d of t.dims) parts.push(u64(d));
    parts.push(u32(0), u64(t.offset));          // ggml_type — the reader ignores it by design
  }
  const head = Buffer.concat(parts);
  const dataStart = Math.ceil(head.length / alignment) * alignment;
  const out = Buffer.alloc(dataStart + off);
  head.copy(out, 0);
  fs.writeFileSync(file, out);
  return { dataStart, dataBytes: off };
}

// An f16 tensor of the given shape.
export const f16 = (dims) => ({ dims, bytes: dims.reduce((a, b) => a * b, 1) * 2 });
