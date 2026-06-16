import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeThinkStripper } from '../src/api/routes.js';

// Apply the stripper to a whole string in one feed (non-streaming path).
function whole(text, active) {
  const s = makeThinkStripper(active);
  return s.feed(text) + s.flush();
}

// Apply the stripper token-by-token (streaming path), as msg.text arrives.
function streamed(tokens, active) {
  const s = makeThinkStripper(active);
  let out = '';
  for (const t of tokens) out += s.feed(t);
  out += s.flush();
  return out;
}

describe('makeThinkStripper (reasoning-block stripping for "thinking off")', () => {
  test('strips a leading <think>…</think> block and keeps the answer (LFM2.5 shape)', () => {
    assert.equal(
      whole('<think>\nOkay, the user said hi\n</think>\n\nHello! How can I help?', true),
      'Hello! How can I help?'
    );
  });

  test('passes a direct answer through when there is no reasoning block', () => {
    assert.equal(whole('Hello! How can I help?', true), 'Hello! How can I help?');
  });

  test('never strips when inactive (thinking ON shows reasoning verbatim)', () => {
    const t = '<think>reason</think>\n\nAnswer';
    assert.equal(whole(t, false), t);
  });

  test('handles tags split across streamed tokens', () => {
    assert.equal(
      streamed(['<th', 'ink>', 'Ok', 'ay reasoning', '</thi', 'nk>', '\n\nFinal ', 'answer'], true),
      'Final answer'
    );
  });

  test('trims whitespace that spans the </think> token boundary', () => {
    assert.equal(
      streamed(['<think>r</think>', '   ', '   \n', 'Answer here'], true),
      'Answer here'
    );
  });

  test('streams a direct (no-reasoning) answer live, token by token', () => {
    assert.equal(streamed(['Hel', 'lo ', 'there'], true), 'Hello there');
  });

  test('drops truncated reasoning that never closes', () => {
    assert.equal(whole('<think>still thinking and ran out of tokens', true), '');
  });

  test('tolerates leading whitespace before <think>', () => {
    assert.equal(whole('\n  <think>x</think>\nAnswer', true), 'Answer');
  });

  test('does not treat a non-think leading "<" tag as reasoning', () => {
    assert.equal(whole('<b>bold</b> answer', true), '<b>bold</b> answer');
  });

  test('preserves newlines inside the answer body', () => {
    assert.equal(whole('<think>r</think>\n\nLine1\n\nLine2', true), 'Line1\n\nLine2');
  });
});
