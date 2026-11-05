// Adapted from AX Studio src/runtime/turn.ts (MIT).
import type { Message, ToolSpec } from "../types.js";

/** Three characters per token: conservative for code and schemas (AX Studio's estimate). */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 3);
}

export function estimateMessages(messages: Message[], tools: ToolSpec[]): number {
  return estimateTokens(JSON.stringify({ messages, ...(tools.length ? { tools } : {}) }));
}

/**
 * Keeps messages[0] (system) and messages[1] (goal). Drops the oldest assistant
 * message with the tool messages answering its toolCalls until the estimate fits
 * or only the latest assistant group remains.
 */
export function trimMessages(messages: Message[], tools: ToolSpec[], windowTokens: number): Message[] {
  let list = messages;
  while (estimateMessages(list, tools) > windowTokens) {
    const first = list.findIndex((m, i) => i >= 2 && m.role === "assistant");
    if (first < 0) break;
    const next = list.findIndex((m, i) => i > first && m.role === "assistant");
    if (next < 0) break;
    const ids = new Set(list[first].role === "assistant" ? (list[first] as { toolCalls?: { id: string }[] }).toolCalls?.map((c) => c.id) : []);
    list = list.filter((m, i) => i !== first && !(m.role === "tool" && ids.has(m.toolCallId)));
  }
  // Drop any tool message left without its assistant message.
  const seen = new Set<string>();
  return list.filter((m) => {
    if (m.role === "assistant") m.toolCalls?.forEach((c) => seen.add(c.id));
    return m.role !== "tool" || seen.has(m.toolCallId);
  });
}

/** Tool results kept whole: the newest ones the model is most likely working from. */
const KEEP_RESULTS = 3;
/** An older result longer than this is cut to RESULT_HEAD characters. Every message is resent on each step. */
const OLD_RESULT_MAX = 2000;
const RESULT_HEAD = 500;

/** A copy of messages with tool results older than the newest KEEP_RESULTS cut when longer than OLD_RESULT_MAX. */
export function shortenOldResults(messages: Message[]): Message[] {
  let newer = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "tool") continue;
    if (newer++ < KEEP_RESULTS || m.content.length <= OLD_RESULT_MAX) continue;
    out[i] = {
      ...m,
      content: `${m.content.slice(0, RESULT_HEAD)}\n[older result cut from ${m.content.length} to ${RESULT_HEAD} characters. Call the tool again to see all of it.]`,
    };
  }
  return out;
}
