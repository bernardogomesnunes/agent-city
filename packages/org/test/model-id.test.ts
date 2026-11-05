import { describe, expect, it } from "vitest";
import { parseModelId } from "../src/index.js";

describe("parseModelId", () => {
  it.each([
    ["claude-sub/sonnet", { source: "sub", alias: "sonnet" }],
    ["claude-sub/claude-opus-5-5", { source: "sub", alias: "claude-opus-5-5" }],
    ["lmstudio/qwen/qwen3-14b", { source: "lmstudio", id: "qwen/qwen3-14b" }],
    ["api/groq/llama-3.3-70b", { source: "api", connection: "groq", id: "llama-3.3-70b" }],
    ["api/groq/meta/llama", { source: "api", connection: "groq", id: "meta/llama" }],
    ["claude-haiku-5-5", { source: "anthropic", id: "claude-haiku-5-5" }],
  ])("parses %s", (m, ref) => expect(parseModelId(m, ["groq"])).toEqual({ ok: true, ref }));

  it.each([
    ["claude-sub/gpt-4", "unknown subscription model gpt-4. Use sonnet, opus, haiku or a claude-* id"],
    ["claude-sub/", "unknown subscription model . Use sonnet, opus, haiku or a claude-* id"],
    ["lmstudio/", "missing LM Studio model id"],
    ["api/none/m", "No connection none. Run: agentcity connection add none <baseUrl>"],
    ["api/groq/", "missing model id after api/groq/"],
    ["gpt-4o", "unknown model gpt-4o. Use claude-sub/, lmstudio/, api/<connection>/ or a claude-* id"],
  ])("rejects %s", (m, error) => expect(parseModelId(m, ["groq"])).toEqual({ ok: false, error }));
});
