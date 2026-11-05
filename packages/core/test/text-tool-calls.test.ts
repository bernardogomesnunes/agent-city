import { describe, expect, it } from "vitest";
import { parseTextToolCalls } from "../src/llm/text-tool-calls.js";

const allowed = ["read_file", "write_file"];

describe("parseTextToolCalls", () => {
  it("reads <tool_call> JSON", () => {
    const { calls } = parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>', allowed);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].args).toEqual({ path: "a.txt" });
    expect(calls[0].id).toBeTruthy();
  });
  it("reads <function=name> with a JSON body", () => {
    const { calls } = parseTextToolCalls('<function=read_file>{"path":"b.txt"}</function>', allowed);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].args).toEqual({ path: "b.txt" });
  });
  it("reads <function=name> with parameter tags", () => {
    const { calls } = parseTextToolCalls(
      "<function=write_file>\n<parameter=path>\nc.txt\n</parameter>\n<parameter=content>\nhi\n</parameter>\n</function>",
      allowed,
    );
    expect(calls[0].name).toBe("write_file");
    expect(calls[0].args).toEqual({ path: "c.txt", content: "hi" });
  });
  it("reads [TOOL_CALLS]", () => {
    const { calls } = parseTextToolCalls('[TOOL_CALLS][{"name":"read_file","arguments":{"path":"d.txt"}}]', allowed);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].args).toEqual({ path: "d.txt" });
  });
  it("reads <|python_tag|>", () => {
    const { calls } = parseTextToolCalls('<|python_tag|>{"name":"read_file","parameters":{"path":"e.txt"}}', allowed);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].args).toEqual({ path: "e.txt" });
  });
  it("reads a fenced json block", () => {
    const { calls } = parseTextToolCalls('Sure.\n```json\n{"name":"read_file","arguments":{"path":"f.txt"}}\n```', allowed);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].args).toEqual({ path: "f.txt" });
  });
  it("ignores names not in allowed", () => {
    const { calls, rest } = parseTextToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', allowed);
    expect(calls).toEqual([]);
    expect(rest).toContain("rm_rf");
  });
  it("rest has the call text removed", () => {
    const { rest } = parseTextToolCalls('Before.\n<tool_call>{"name":"read_file","arguments":{}}</tool_call>\nAfter.', allowed);
    expect(rest).not.toContain("tool_call");
    expect(rest).toContain("Before.");
    expect(rest).toContain("After.");
  });
});

// Ported from AX Studio tests/core/text-tool-calls.test.ts, adapted to { id, name, args }.
describe("parseTextToolCalls (AX Studio cases)", () => {
  const tools = ["write_file", "read_file", "run_shell"];
  const parse = (text: string) => {
    const r = parseTextToolCalls(text, tools);
    return { names: r.calls.map((c) => c.name), args: r.calls.map((c) => c.args), rest: r.rest };
  };
  it("reads <tool_call> tags and keeps the surrounding text", () => {
    const r = parse('Writing it now.\n<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}\n</tool_call>');
    expect(r).toEqual({ names: ["write_file"], args: [{ path: "a.txt", content: "hi" }], rest: "Writing it now." });
  });
  it("reads several <tool_call> tags and a tag with no closing tag", () => {
    const r = parse('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}}');
    expect(r.args).toEqual([{ path: "a" }, { path: "b" }]);
    expect(r.rest).toBe("");
  });
  it("reads <function=name> with JSON and with parameter tags", () => {
    expect(parse('<function=read_file>{"path": "x"}</function>').args).toEqual([{ path: "x" }]);
    const r = parse("<function=write_file>\n<parameter=path>\nb.txt\n</parameter>\n<parameter=content>\nline 1\nline 2\n</parameter>\n</function>");
    expect(r.args).toEqual([{ path: "b.txt", content: "line 1\nline 2" }]);
  });
  it("reads both Mistral forms", () => {
    expect(parse('[TOOL_CALLS][{"name":"run_shell","arguments":{"command":"ls"}}]').args).toEqual([{ command: "ls" }]);
    expect(parse('[TOOL_CALLS]run_shell[ARGS]{"command":"ls"}').args).toEqual([{ command: "ls" }]);
  });
  it('reads <|python_tag|> with "parameters"', () => {
    expect(parse('<|python_tag|>{"name": "run_shell", "parameters": {"command": "echo }"}}').args).toEqual([{ command: "echo }" }]);
  });
  it("reads a fenced json block, a bare reply, the function wrapper and string arguments", () => {
    expect(parse('Sure:\n```json\n{"name":"read_file","arguments":{"path":"a"}}\n```').names).toEqual(["read_file"]);
    expect(parse('{"name":"read_file","arguments":{"path":"a"}}').args).toEqual([{ path: "a" }]);
    expect(parse('{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}').args).toEqual([{ path: "a" }]);
    expect(parse('[{"function":{"name":"read_file","arguments":{"path":"a"}}}]').args).toEqual([{ path: "a" }]);
  });
  it("ignores tools that are not allowed, plain JSON and broken JSON", () => {
    for (const text of [
      '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>',
      '```json\n{"theme": "dark"}\n```',
      '<tool_call>{"name": "write_file", "arguments": {</tool_call>',
      "Use write_file to save it.",
    ]) {
      const r = parseTextToolCalls(text, tools);
      expect(r.calls).toEqual([]);
      expect(r.rest).toBe(text);
    }
  });
});
