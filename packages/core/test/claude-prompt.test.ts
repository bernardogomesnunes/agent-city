import { describe, expect, it } from "vitest";
import { renderClaudePrompt } from "../src/index.js";
import type { ChatRequest } from "../src/index.js";

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "claude-sub/haiku", messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }], tools: [], maxTokens: 100, ...over,
});

describe("renderClaudePrompt", () => {
  it("puts the system message and tools in the system text", () => {
    const { system } = renderClaudePrompt(req({ tools: [{ name: "write_file", description: "Write", inputSchema: { type: "object" } }] }));
    expect(system.startsWith("S\n\nTOOLS\n")).toBe(true);
    expect(system).toContain('<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>');
    expect(system).toContain('- write_file: Write\n  input schema: {"type":"object"}');
  });

  it("leaves the tool block out when there are no tools", () => {
    expect(renderClaudePrompt(req()).system).toBe("S");
  });

  it("renders an earlier call and its result", () => {
    const { prompt } = renderClaudePrompt(req({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", args: { path: "a" } }] },
        { role: "tool", toolCallId: "c1", name: "write_file", content: "ok" },
      ],
    }));
    expect(prompt).toBe('USER:\ngo\n\nASSISTANT:\n\n<tool_call>{"name":"write_file","arguments":{"path":"a"}}</tool_call>\n\nTOOL RESULT (write_file, c1):\nok');
  });
});
