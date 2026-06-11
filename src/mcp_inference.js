// MCP tool-use loop for inference.
//
// RKLLM generates plain text (no native OpenAI function-calling), so tool use
// is driven by a prompt protocol: the available tools are described in the
// system prompt, the model emits a `<tool_call>{...}</tool_call>` line when it
// wants a tool, we execute it via the MCP client, feed the result back as a
// `tool` message, and re-generate — looping until the model answers normally
// or a round cap is hit. This depends on the model following the protocol;
// models that don't will simply answer directly (the loop returns round 1).

import { executeToolCall } from './mcp.js';
import { dbGetMcpServer } from './db.js';

export const MAX_TOOL_ROUNDS = 5;

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/;

/** Extract a tool call from generated text, or null if none. */
export function parseToolCall(text) {
  const m = text && text.match(TOOL_CALL_RE);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && typeof obj.name === 'string') {
      return { name: obj.name, arguments: obj.arguments && typeof obj.arguments === 'object' ? obj.arguments : {} };
    }
  } catch (e) {}
  return null;
}

// Cap on the tool catalogue size. The full JSON schema for every tool can run
// to tens of thousands of tokens (e.g. 53 tools ≈ 19k tokens) and overflow the
// model's context, so we emit one compact line per tool (name + short
// description + argument names) and stop listing once the budget is hit.
const TOOL_CATALOG_CHAR_BUDGET = 12000;

/** One compact line per tool: `- name: short desc [args: a*, b]` (* = required). */
function toolLine(t) {
  const fn = t.function || {};
  const desc = (fn.description || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const props = fn.parameters && fn.parameters.properties ? Object.keys(fn.parameters.properties) : [];
  const required = (fn.parameters && fn.parameters.required) || [];
  const args = props.length ? ` [args: ${props.map(p => (required.includes(p) ? `${p}*` : p)).join(', ')}]` : '';
  return `- ${fn.name}: ${desc || '(no description)'}${args}`;
}

/** Build the system-prompt block describing the available tools. */
export function buildToolSystemPrompt(tools) {
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const t of tools) {
    const line = toolLine(t);
    if (used + line.length > TOOL_CATALOG_CHAR_BUDGET && lines.length > 0) {
      omitted = tools.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) lines.push(`- …and ${omitted} more tool(s) not listed (catalogue truncated to fit the context window)`);
  return [
    'You can use external tools to help answer. Available tools (* = required argument):',
    ...lines,
    '',
    'To call a tool, reply with ONLY this exact form on its own line:',
    '<tool_call>{"name": "<tool_name>", "arguments": { ... }}</tool_call>',
    'You will then receive the result as a message with role "tool". You may call tools multiple times.',
    'When you have enough information, reply normally with your final answer and no tool_call.',
  ].join('\n');
}

// Merge the tool instructions into the message list — appended to an existing
// system message if present, otherwise inserted as a new leading system message.
function injectToolPrompt(messages, toolPrompt) {
  const out = messages.map(m => ({ ...m }));
  const sysIdx = out.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) {
    out[sysIdx].content = `${out[sysIdx].content}\n\n${toolPrompt}`;
  } else {
    out.unshift({ role: 'system', content: toolPrompt });
  }
  return out;
}

/**
 * Run the tool-use loop.
 *
 * @param {object}   p
 * @param {object[]} p.messages   - OpenAI-style messages (system/user/assistant)
 * @param {object[]} p.tools      - aggregated OpenAI tool defs
 * @param {Map}      p.lookup     - toolName → { serverId, toolName }
 * @param {function} p.formatMessages - (msgs) => ChatML prompt string (must handle role 'tool')
 * @param {function} p.generate   - async (prompt) => { text, perf }
 * @returns {Promise<{ finalText, perf, toolCalls }>}
 */
// Default tool executor: look the call up in the registry and run it via the
// owning MCP server. Injectable (`runTool`) so the loop is unit-testable.
async function defaultRunTool(name, args, lookup) {
  const entry = lookup.get(name);
  if (!entry) return `Error: unknown tool "${name}"`;
  const server = dbGetMcpServer(entry.serverId);
  if (!server) return `Error: server for tool "${name}" no longer exists`;
  const exec = await executeToolCall(server, entry.toolName, args);
  return exec.content;
}

export async function resolveWithTools({ messages, tools, lookup, formatMessages, generate, runTool = defaultRunTool }) {
  const working = injectToolPrompt(messages, buildToolSystemPrompt(tools));
  const toolCalls = [];
  let lastPerf = {};

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const prompt = formatMessages(working);
    const result = await generate(prompt);
    lastPerf = result.perf || {};
    const text = result.text || '';

    const call = parseToolCall(text);
    if (!call) {
      return { finalText: text, perf: lastPerf, toolCalls };
    }

    // Record the assistant's tool-call turn, then resolve it.
    working.push({ role: 'assistant', content: text });
    const resultContent = await runTool(call.name, call.arguments, lookup);
    toolCalls.push({ name: call.name, arguments: call.arguments, result: resultContent });
    working.push({ role: 'tool', content: resultContent });
  }

  // Hit the round cap — force a final answer with no further tool access.
  const finalPrompt = formatMessages([
    ...working,
    { role: 'system', content: 'Tool call limit reached. Provide your best final answer now without calling any more tools.' },
  ]);
  const final = await generate(finalPrompt);
  return { finalText: final.text || '', perf: final.perf || lastPerf, toolCalls };
}
