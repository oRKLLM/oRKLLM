import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyThinkTrimmer } from '../src/api/routes.js';

const whole = (t, active) => { const s = makeEmptyThinkTrimmer(active); return s.feed(t) + s.flush(); };
const streamed = (toks, active) => { const s = makeEmptyThinkTrimmer(active); let o = ''; for (const t of toks) o += s.feed(t); return o + s.flush(); };

describe('makeEmptyThinkTrimmer (removes only an empty leading think marker)', () => {
  test('drops a leading empty <think></think> and keeps the answer', () => {
    assert.equal(whole('<think>\n\n</think>\n\nFour', true), 'Four');
  });

  test('passes a plain answer through unchanged', () => {
    assert.equal(whole('Four', true), 'Four');
  });

  test('NEVER removes a think block with real reasoning (not reasoning-stripping)', () => {
    const t = '<think>\nlet me compute 2+2\n</think>\n\nFour';
    assert.equal(whole(t, true), t);
  });

  test('inactive → pure passthrough', () => {
    assert.equal(whole('<think>\n\n</think>\n\nFour', false), '<think>\n\n</think>\n\nFour');
  });

  test('handles the empty marker split across streamed tokens', () => {
    assert.equal(streamed(['<th', 'ink>', '\n', '\n', '</thi', 'nk>', '\n\n', 'Four'], true), 'Four');
  });

  test('streams real reasoning live (emits as soon as non-whitespace appears inside think)', () => {
    assert.equal(streamed(['<think>', '\nreason', 'ing', '</think>', '\n\nFour'], true), '<think>\nreasoning</think>\n\nFour');
  });

  test('answer that is not a think block streams from the first token', () => {
    assert.equal(streamed(['Hel', 'lo'], true), 'Hello');
  });

  test('trims whitespace that spans the close-tag token boundary', () => {
    assert.equal(streamed(['<think></think>', '   ', '\n', 'Four'], true), 'Four');
  });
});
