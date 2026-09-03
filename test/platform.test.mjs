// Chipset detection. oRKLLM only ever runs on Rockchip silicon, so the SoC is a
// property of the machine that the kernel already knows — it is read, never
// configured. The file probing is board-only; parseSocSlug is the pure half and
// is what these tests pin down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSocSlug, getPlatform, getPlatformSource, getNpuCoreCount } from '../src/config.js';

test('parses the SoC out of a real device-tree compatible string (NUL-separated)', () => {
  // /proc/device-tree/compatible is a list of NUL-terminated strings, board first.
  assert.equal(parseSocSlug('friendlyelec,nanopi-m5\0rockchip,rk3576\0'), 'rk3576');
  assert.equal(parseSocSlug('radxa,rock-5b\0rockchip,rk3588\0'), 'rk3588');
});

test('keeps the SoC variant suffix distinct (rk3588s is not rk3588)', () => {
  // Same NPU IP, different part; the slug stays verbatim so NPU_CORES_BY_SOC and
  // the .orkpack calibration key can each decide for themselves what to treat as
  // equivalent, rather than the detector deciding for them.
  assert.equal(parseSocSlug('xunlong,orangepi-5\0rockchip,rk3588s\0'), 'rk3588s');
});

test('accepts a bare slug from the soc0 bus nodes and cpuinfo', () => {
  // /sys/devices/soc0/family and some cpuinfo Hardware lines carry no vendor tuple.
  assert.equal(parseSocSlug('rk3588'), 'rk3588');
  assert.equal(parseSocSlug('Hardware\t: Rockchip RK3399 Board'), 'rk3399');
});

test('is case-insensitive and tolerates whitespace after the vendor comma', () => {
  assert.equal(parseSocSlug('ROCKCHIP, RK3576'), 'rk3576');
});

test('returns null for non-Rockchip hardware and for empty input', () => {
  assert.equal(parseSocSlug('apple,j413\0apple,t8112\0'), null);
  assert.equal(parseSocSlug('raspberrypi,4-model-b\0brcm,bcm2711\0'), null);
  assert.equal(parseSocSlug(''), null);
  assert.equal(parseSocSlug(null), null);
  assert.equal(parseSocSlug(undefined), null);
});

test('does not mistake an unrelated four-digit token for an SoC', () => {
  assert.equal(parseSocSlug('some-vendor,board-3588\0'), null);
  assert.equal(parseSocSlug('serial 0x3588'), null);
});

test('getPlatform is cached and agrees with its reported source', () => {
  const a = getPlatform();
  assert.equal(getPlatform(), a, 'repeated calls must return the cached value');
  const src = getPlatformSource();
  if (a === null) {
    assert.equal(src, null, 'no slug means no source answered');
  } else {
    assert.ok(typeof src === 'string' && src.startsWith('/'), 'a detected slug must name the kernel node it came from');
  }
});

test('NPU core count degrades to a safe single core when the chipset is unknown', () => {
  const cores = getNpuCoreCount();
  assert.ok(Number.isInteger(cores) && cores >= 1);
  if (getPlatform() === null) assert.equal(cores, 1);
});
