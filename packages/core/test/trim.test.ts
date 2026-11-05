import { describe, expect, it } from "vitest";
import type { Message } from "../src/types.js";
import { estimateMessages, estimateTokens, shortenOldResults, trimMessages } from "../src/llm/trim.js";

const group = (n: number): Message[] => [
  { role: "assistant", content: "step " + n, toolCalls: [{ id: "c" + n, name: "read_file", args: { path: "x" } }] },
  { role: "tool", toolCallId: "c" + n, name: "read_file", content: "x".repeat(300) },
];
const base: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "goal" },
];

describe("shortenOldResults", () => {
  const result = (n: number, len: number): Message[] => [
    { role: "assistant", content: "", toolCalls: [{ id: "c" + n, name: "read_file", args: { path: "x" } }] },
    { role: "tool", toolCallId: "c" + n, name: "read_file", content: "y".repeat(len) },
  ];
  it("cuts long results older than the newest 3 to 500 characters and leaves the input as it was", () => {
    const msgs = [...base, ...result(1, 5000), ...result(2, 5000), ...result(3, 5000), ...result(4, 5000), ...result(5, 100)];
    const out = shortenOldResults(msgs);
    const tool = (m: Message[], id: string) => m.find((x) => x.role === "tool" && x.toolCallId === id)!.content;
    const cut = "y".repeat(500) + "\n[older result cut from 5000 to 500 characters. Call the tool again to see all of it.]";
    expect(tool(out, "c1")).toBe(cut);
    expect(tool(out, "c2")).toBe(cut);
    expect(tool(out, "c3")).toHaveLength(5000);
    expect(tool(out, "c4")).toHaveLength(5000);
    expect(tool(out, "c5")).toHaveLength(100);
    expect(tool(msgs, "c1")).toHaveLength(5000);
  });
  it("keeps old results of 2000 characters or less", () => {
    const msgs = [...base, ...result(1, 2000), ...result(2, 1), ...result(3, 1), ...result(4, 1)];
    expect(shortenOldResults(msgs)).toEqual(msgs);
  });
});

describe("trimMessages", () => {
  it("returns input unchanged when it fits", () => {
    const msgs = [...base, ...group(1)];
    expect(trimMessages(msgs, [], 100000)).toEqual(msgs);
  });
  it("drops the oldest assistant group first", () => {
    const msgs = [...base, ...group(1), ...group(2), ...group(3)];
    const window = estimateMessages([...base, ...group(2), ...group(3)], []);
    const out = trimMessages(msgs, [], window);
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(false);
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "c2")).toBe(true);
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "c3")).toBe(true);
  });
  it("never drops system or goal", () => {
    const msgs = [...base, ...group(1), ...group(2)];
    const out = trimMessages(msgs, [], 1);
    expect(out[0]).toEqual(base[0]);
    expect(out[1]).toEqual(base[1]);
    expect(out.slice(2)).toEqual(group(2));
  });
  it("never leaves an orphan tool message", () => {
    const msgs = [...base, ...group(1), ...group(2), ...group(3), ...group(4)];
    for (const w of [1, 200, 400, 600, 900]) {
      const out = trimMessages(msgs, [], w);
      out.forEach((m, i) => {
        if (m.role !== "tool") return;
        const ok = out.slice(0, i).some((a) => a.role === "assistant" && a.toolCalls?.some((c) => c.id === m.toolCallId));
        expect(ok).toBe(true);
      });
    }
  });
});

describe("estimateTokens", () => {
  it("is ceil(length / 3)", () => {
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});
