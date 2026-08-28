import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orkAsset, pickLlamaRelease } from '../src/llama_sync.js';

// Shapes mirror the GitHub releases API. The mirror repo carries BOTH kinds under one build number:
//   bNNNN-ork → our runtime bundle        bNNNN → the upstream llama.cpp release it was built from
const orkRelease = (n) => ({
  tag_name: `b${n}-ork`,
  published_at: `2026-08-27T23:4${n % 10}:00Z`,
  assets: [{ name: `llama-cpp-rockchip-npu-b${n}-ork.tar.gz`, size: 33620124, digest: `sha256:ork${n}` }],
});
const upstreamRelease = (n) => ({
  tag_name: `b${n}`,
  published_at: `2026-08-27T22:4${n % 10}:00Z`,
  assets: [
    { name: `cudart-llama-bin-win-cuda-12.4-x64.zip`, size: 1 },
    { name: `llama-b${n}-bin-android-arm64.tar.gz`, size: 2 },
    { name: `llama-b${n}-bin-ubuntu-arm64.tar.gz`, size: 3 },
    { name: `llama-b${n}-bin-macos-x64.tar.gz`, size: 4 },
  ],
});

describe('orkAsset', () => {
  test('finds our runtime bundle', () => {
    assert.equal(orkAsset(orkRelease(10664)).name, 'llama-cpp-rockchip-npu-b10664-ork.tar.gz');
  });

  // Every one of these ends in .tar.gz, which is why an extension filter was not enough.
  test('ignores upstream release assets entirely', () => {
    assert.equal(orkAsset(upstreamRelease(10664)), null);
  });

  test('null-safe on malformed releases', () => {
    assert.equal(orkAsset(undefined), null);
    assert.equal(orkAsset({}), null);
    assert.equal(orkAsset({ assets: [] }), null);
  });
});

describe('pickLlamaRelease', () => {
  // THE HAZARD: same build number, same .tar.gz extension. Array order used to decide, and the
  // upstream release winning would have installed a build with no ggml-ork backend in it at all.
  test('never picks an upstream mirror release that ties on build number', () => {
    const listed = [upstreamRelease(10664), orkRelease(10664)];   // upstream FIRST in API order
    assert.equal(pickLlamaRelease(listed).tag_name, 'b10664-ork');
  });

  test('picks the highest build number, not the array/publish order', () => {
    const listed = [orkRelease(10639), orkRelease(10664), orkRelease(10655)];
    assert.equal(pickLlamaRelease(listed).tag_name, 'b10664-ork');
  });

  test('a page of only upstream releases yields nothing to install', () => {
    assert.equal(pickLlamaRelease([upstreamRelease(10664), upstreamRelease(10663)]), null);
  });

  test('an explicit tag resolves to that exact release', () => {
    const listed = [orkRelease(10664), orkRelease(10655), upstreamRelease(10655)];
    assert.equal(pickLlamaRelease(listed, 'b10655-ork').tag_name, 'b10655-ork');
  });

  // Asking for the bare upstream tag must fail rather than silently install the wrong bundle.
  test('an explicit UPSTREAM tag resolves to nothing', () => {
    assert.equal(pickLlamaRelease([orkRelease(10664), upstreamRelease(10664)], 'b10664'), null);
  });

  test('an unknown tag resolves to nothing', () => {
    assert.equal(pickLlamaRelease([orkRelease(10664)], 'b99999-ork'), null);
  });

  test('empty / missing input is safe', () => {
    assert.equal(pickLlamaRelease([]), null);
    assert.equal(pickLlamaRelease(undefined), null);
  });
});
