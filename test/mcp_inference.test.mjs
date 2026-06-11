import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCall, buildToolSystemPrompt, resolveWithTools, MAX_TOOL_ROUNDS } from '../src/mcp_inference.js';

// ── parseToolCall ────────────────────────────────────────────────────────────

describe('parseToolCall', () => {
  test('extracts a well-formed tool call', () => {
    const call = parseToolCall('Sure. <tool_call>{"name": "mcp__fs__read", "arguments": {"path": "/tmp/x"}}</tool_call>');
    assert.deepEqual(call, { name: 'mcp__fs__read', arguments: { path: '/tmp/x' } });
  });

  test('defaults missing arguments to {}', () => {
    const call = parseToolCall('<tool_call>{"name": "ping"}</tool_call>');
    assert.deepEqual(call, { name: 'ping', arguments: {} });
  });

  test('returns null when there is no tool call', () => {
    assert.equal(parseToolCall('Just a normal answer.'), null);
  });

  test('returns null on malformed JSON', () => {
    assert.equal(parseToolCall('<tool_call>{not json}</tool_call>'), null);
  });
});

// ── buildToolSystemPrompt ────────────────────────────────────────────────────

describe('buildToolSystemPrompt', () => {
  test('lists tool names and the call protocol', () => {
    const prompt = buildToolSystemPrompt([
      { type: 'function', function: { name: 'mcp__a__foo', description: 'does foo', parameters: { type: 'object' } } },
    ]);
    assert.match(prompt, /mcp__a__foo/);
    assert.match(prompt, /does foo/);
    assert.match(prompt, /<tool_call>/);
  });
});

// ── resolveWithTools ─────────────────────────────────────────────────────────

describe('resolveWithTools', () => {
  const tools = [{ type: 'function', function: { name: 'mcp__t__echo', description: 'echo', parameters: {} } }];
  const lookup = new Map([['mcp__t__echo', { serverId: 's1', toolName: 'echo' }]]);

  test('returns the answer directly when the model emits no tool call', async () => {
    const generate = async () => ({ text: 'final answer', perf: { generate_tokens: 2 } });
    const out = await resolveWithTools({ messages: [{ role: 'user', content: 'hi' }], tools, lookup, formatMessages: () => '', generate });
    assert.equal(out.finalText, 'final answer');
    assert.equal(out.toolCalls.length, 0);
  });

  test('executes a tool then returns the follow-up answer', async () => {
    let round = 0;
    const generate = async () => {
      round++;
      if (round === 1) return { text: '<tool_call>{"name":"mcp__t__echo","arguments":{"v":42}}</tool_call>', perf: {} };
      return { text: 'the value is 42', perf: { generate_tokens: 4 } };
    };
    const runTool = async (name, args) => `echoed:${args.v}`;
    const out = await resolveWithTools({ messages: [{ role: 'user', content: 'echo 42' }], tools, lookup, formatMessages: m => JSON.stringify(m), generate, runTool });
    assert.equal(out.finalText, 'the value is 42');
    assert.equal(out.toolCalls.length, 1);
    assert.deepEqual(out.toolCalls[0], { name: 'mcp__t__echo', arguments: { v: 42 }, result: 'echoed:42' });
  });

  test('stops after MAX_TOOL_ROUNDS and forces a final answer', async () => {
    let calls = 0;
    // Always emit a tool call → loop should cap and then force one final generate.
    const generate = async (prompt) => {
      calls++;
      if (/final answer now/.test(prompt)) return { text: 'forced final', perf: {} };
      return { text: '<tool_call>{"name":"mcp__t__echo","arguments":{}}</tool_call>', perf: {} };
    };
    const runTool = async () => 'tool result';
    const out = await resolveWithTools({ messages: [{ role: 'user', content: 'loop' }], tools, lookup, formatMessages: m => JSON.stringify(m), generate, runTool });
    assert.equal(out.finalText, 'forced final');
    assert.equal(out.toolCalls.length, MAX_TOOL_ROUNDS);
    assert.equal(calls, MAX_TOOL_ROUNDS + 1); // N tool rounds + 1 forced final
  });
});
