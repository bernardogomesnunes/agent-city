// Adapted from AX Studio src/core/llm/text-tool-calls.ts (MIT).
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../types.js";

/**
 * Local models sometimes write a tool call into the reply text instead of the
 * tool_calls field. This finds the common written forms and returns them as
 * real calls, with the call text removed from the reply.
 *
 * Forms read:
 * - <tool_call>{"name": ..., "arguments": {...}}</tool_call>  (Qwen, Hermes)
 * - <function=name>{...}</function> or <function=name><parameter=key>value</parameter></function>  (Llama, Qwen3 Coder)
 * - [TOOL_CALLS][{...}] or [TOOL_CALLS]name[ARGS]{...}  (Mistral)
 * - <|python_tag|>{...}  (Llama 3.1)
 * - a fenced ```json block, or the whole reply, holding {"name", "arguments"}
 *
 * Only calls to a name in `allowed` count, so an example in prose stays text.
 */
export function parseTextToolCalls(text: string, allowed: string[]): { calls: ToolCall[]; rest: string } {
  const names = new Set(allowed);
  const calls: ToolCall[] = [];
  const cuts: [number, number][] = [];
  const add = (start: number, end: number, found: ParsedCall[]) => {
    const ok = found.filter((c) => names.has(c.name));
    if (!ok.length || overlaps(cuts, start, end)) return;
    for (const c of ok) {
      calls.push({ id: `text-${randomUUID().slice(0, 8)}`, name: c.name, args: c.args });
    }
    cuts.push([start, end]);
  };

  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g)) {
    add(m.index!, m.index! + m[0].length, callsFromJson(m[1]));
  }
  for (const m of text.matchAll(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
    const body = m[2].trim();
    const args = body.startsWith('{') ? parseObject(body) : parameterTags(body);
    if (args) add(m.index!, m.index! + m[0].length, [{ name: m[1], args }]);
  }
  for (const m of text.matchAll(/\[TOOL_CALLS\]\s*/g)) {
    const at = m.index! + m[0].length;
    const named = /^([\w.-]+)\[ARGS\]/.exec(text.slice(at));
    if (named) {
      const json = readJson(text, at + named[0].length);
      const args = json && parseObject(json.text);
      if (json && args) add(m.index!, json.end, [{ name: named[1], args }]);
    } else {
      const json = readJson(text, at);
      if (json) add(m.index!, json.end, callsFromJson(json.text));
    }
  }
  for (const m of text.matchAll(/<\|python_tag\|>\s*/g)) {
    const json = readJson(text, m.index! + m[0].length);
    if (json) add(m.index!, json.end, callsFromJson(json.text));
  }
  for (const m of text.matchAll(/```(?:json|tool_call|tool)?[ \t]*\n([\s\S]*?)```/g)) {
    add(m.index!, m.index! + m[0].length, callsFromJson(m[1]));
  }
  if (!calls.length) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) add(0, text.length, callsFromJson(trimmed));
  }

  if (!calls.length) return { calls, rest: text };
  let rest = '';
  let pos = 0;
  for (const [s, e] of cuts.sort((a, b) => a[0] - b[0])) {
    rest += text.slice(pos, s);
    pos = e;
  }
  rest += text.slice(pos);
  return { calls, rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

const overlaps = (cuts: [number, number][], s: number, e: number) => cuts.some(([a, b]) => s < b && a < e);

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Reads {"name", "arguments"} objects, a list of them, or the {"function": {...}} wrapper. */
function callsFromJson(text: string): ParsedCall[] {
  let v: unknown;
  try {
    v = JSON.parse(text.trim());
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  const out: ParsedCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return [];
    const o = ((item as { function?: unknown }).function ?? item) as Record<string, unknown>;
    if (typeof o.name !== 'string') return [];
    let args: unknown = o.arguments ?? o.parameters ?? o.args ?? {};
    if (typeof args === 'string') args = parseObject(args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
    out.push({ name: o.name, args: args as Record<string, unknown> });
  }
  return out;
}

/** <parameter=key>value</parameter> pairs; values that parse as JSON keep their type. */
function parameterTags(body: string): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  let found = false;
  for (const m of body.matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
    found = true;
    const raw = m[2];
    try {
      const v = JSON.parse(raw);
      args[m[1]] = typeof v === 'object' || typeof v === 'number' || typeof v === 'boolean' ? v : raw;
    } catch {
      args[m[1]] = raw;
    }
  }
  return found || body === '' ? args : undefined;
}

/** The JSON object or array starting at `start`, found by matching brackets outside strings. */
function readJson(text: string, start: number): { text: string; end: number } | undefined {
  const open = text[start];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return undefined;
}
