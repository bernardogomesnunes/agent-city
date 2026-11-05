# Model Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each agent runs on a model picked from 4 sources: the Claude subscription via the local `claude` binary, LM Studio, OpenAI-compatible connections, the Anthropic API. The model is picked on the city agent card.

**Architecture:** `providerFor` in cli routes by model id prefix. A new core `ClaudeCliProvider` spawns `claude -p` once per step and returns text tool calls for the existing agent loop. Connections and their prices live in `config.json`. The city server lists models per source and saves a model as a new agent version.

**Tech Stack:** TypeScript, Node 24, npm workspaces, vitest, zod 4, commander, `ws`, Phaser 3 client with DOM overlays.

**Spec:** `docs/superpowers/specs/2026-11-01-providers-design.md`

## Global Constraints

- Model id forms: `claude-sub/<alias>`, `lmstudio/<id>`, `api/<connection>/<model>`, bare `claude-*` for the Anthropic API.
- Subscription aliases: `sonnet`, `opus`, `haiku`, or a full `claude-*` id.
- Connection name `^[a-z0-9-]{1,24}$`, unique. `baseUrl` scheme `http:` or `https:` only.
- Connection key secret name: `api-<name>`. `secrets` stays refused in the city terminal.
- The city never reads, stores or forwards claude.ai credentials. The `claude` child env drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- `claude` flags: `-p --output-format json --model <alias> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --system-prompt <text>`. Prompt on stdin. cwd is a fresh empty temp dir, deleted after the call.
- `claude` call timeout 180 s. Models-list fetch timeout 3 s.
- Keys never appear in `connection list`, the models list, the log, or any message to the client.
- `claude-sub/*` and `lmstudio/*` cost 0 USD. Tokens still count toward `budget.maxTokens`.
- New project allowlist: `["claude-haiku-5-5", "lmstudio/*", "claude-sub/*", "api/*"]`.
- Import rules unchanged: client imports only phaser, zod and `@agentcity/world/shared`.
- Exact error copy:
  - `claude command not found. Install it with npm i -g @anthropic-ai/claude-code, then run claude once to log in.`
  - `claude is not logged in. Run claude once in a terminal to log in.`
  - `claude did not answer in 180 s`
- Subagents: never Fable. Reviews and test runs on Haiku.

## Review Focus

1. A `claude` reply with no tool call and no text (empty `result`) must end the step as a plain empty answer and must not crash the parser.
2. A connection named in an agent's model and later removed must stop the run with a clear `No connection <name>` error, not a TypeError.
3. Windows `claude` installed by npm is `claude.cmd`. The spawn must find it without `shell: true`, so prompt text never reaches a shell.
4. A `models.list` request while LM Studio is off must return the other groups within about 3 s and show the LM Studio error in its group.
5. An agent card open while the agent's model changes from another client must show the new model after the next snapshot.

Each line has its test in the owning task (Tasks 3, 4, 3, 5, 6).

## File Structure

- `packages/safety/src/config.ts`: `Connection`, `GlobalConfig.connections`, `GlobalConfig.claudePath`, default allowlist, `saveConnections`.
- `packages/safety/src/pricing.ts`: `priceFor` with connections.
- `packages/safety/src/gate.ts`: `GateDeps.connections`.
- `packages/org/src/model-id.ts` (new): `parseModelId`.
- `packages/core/src/types.ts`: `ChatRequest.signal`.
- `packages/core/src/agent/run-agent.ts`: passes `signal` into `chat`.
- `packages/core/src/providers/claude-prompt.ts` (new): transcript and tools to prompt text.
- `packages/core/src/providers/claude-cli.ts` (new): `ClaudeCliProvider`.
- `packages/cli/src/shared.ts`: `providerFor` branches.
- `packages/cli/src/wire.ts`: `connection` commands, model validation in `agent create/edit`.
- `packages/cli/src/models.ts` (new): `listModels` for the city.
- `packages/world/src/shared/protocol.ts`, `packages/world/src/state.ts`: messages, `AgentView.model`.
- `packages/cli/src/city-server.ts`: `models.list`, `agent.model`.
- `packages/client/src/ui/agent-card.ts`, `packages/client/src/ui/index.ts`, `packages/client/src/ui/style.css`: picker.
- `README.md`: Providers section.

---

### Task 1: Connections, prices and allowlist in safety

**Files:**
- Modify: `packages/safety/src/config.ts`, `packages/safety/src/pricing.ts`, `packages/safety/src/gate.ts`, `packages/safety/src/index.ts`
- Test: `packages/safety/test/config.test.ts`, `packages/safety/test/pricing.test.ts`, `packages/safety/test/gate.test.ts`

**Interfaces:**
- Produces:
  - `interface Connection { name: string; baseUrl: string; price?: Price }`
  - `GlobalConfig { prices: Prices; lmStudioBaseUrl: string; connections: Connection[]; claudePath: string }`. Defaults: `connections: []`, `claudePath: "claude"`.
  - `CONNECTION_NAME_RE = /^[a-z0-9-]{1,24}$/`
  - `saveConnections(home: string, connections: Connection[]): void`. Rewrites `config.json`, keeping every other key in the file.
  - `priceFor(prices: Prices, model: string, connections?: Connection[]): Price | undefined`
  - `GateDeps.connections?: Connection[]`, passed to `priceFor`.

- [ ] **Step 1: Write failing tests**

```ts
// config.test.ts
it("defaults connections to [] and claudePath to claude", () => {
  expect(loadGlobalConfig(emptyHome)).toMatchObject({ connections: [], claudePath: "claude" });
});
it("rejects a duplicate connection name", () => {
  writeConfig({ connections: [{ name: "groq", baseUrl: "https://a/v1" }, { name: "groq", baseUrl: "https://b/v1" }] });
  expect(() => loadGlobalConfig(home)).toThrow("duplicate connection groq");
});
it("rejects a non-http baseUrl", () => {
  writeConfig({ connections: [{ name: "x", baseUrl: "file:///etc" }] });
  expect(() => loadGlobalConfig(home)).toThrow("invalid config.json");
});
it("saveConnections keeps other keys", () => {
  writeConfig({ lmStudioBaseUrl: "http://h:1/v1" });
  saveConnections(home, [{ name: "groq", baseUrl: "https://api.groq.com/openai/v1" }]);
  expect(loadGlobalConfig(home)).toMatchObject({ lmStudioBaseUrl: "http://h:1/v1", connections: [{ name: "groq" }] });
});
it("new projects allow claude-sub and api models", () => {
  expect(defaultProjectConfig("p").allowedModels).toEqual(["claude-haiku-5-5", "lmstudio/*", "claude-sub/*", "api/*"]);
});

// pricing.test.ts
const conns = [{ name: "groq", baseUrl: "https://g/v1", price: { inputPerMTok: 0.59, outputPerMTok: 0.79 } }, { name: "free", baseUrl: "http://o/v1" }];
it("claude-sub costs 0", () => expect(priceFor({}, "claude-sub/sonnet", conns)).toEqual({ inputPerMTok: 0, outputPerMTok: 0 }));
it("api uses the connection price", () => expect(priceFor({}, "api/groq/llama", conns)).toEqual({ inputPerMTok: 0.59, outputPerMTok: 0.79 }));
it("a full-id price overrides the connection price", () =>
  expect(priceFor({ "api/groq/llama": { inputPerMTok: 1, outputPerMTok: 2 } }, "api/groq/llama", conns)).toEqual({ inputPerMTok: 1, outputPerMTok: 2 }));
it("api with no price is unknown", () => expect(priceFor({}, "api/free/m", conns)).toBeUndefined());
it("api with no such connection is unknown", () => expect(priceFor({}, "api/none/m", conns)).toBeUndefined());

// gate.test.ts
it("allows an api model priced by its connection", async () => { /* GateDeps.connections = conns, allowedModels ["api/*"] → allow */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/safety`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the Interfaces above. Zod schema for `connections` with a refine for duplicate names, message `duplicate connection <name>`. `priceFor` splits `api/<name>/<model>` on the first two slashes.
- [ ] **Step 4: Run** `npx vitest run packages/safety`. Expected: PASS. Then `npm run typecheck`. Expected: clean. `tree-runner.ts` passes `connections: global.connections` to the gate in this task.
- [ ] **Step 5: Commit** `feat(safety): connections, claudePath, prices for claude-sub and api models`

### Task 2: Model id parsing in org, validation in the CLI

**Files:**
- Create: `packages/org/src/model-id.ts`
- Modify: `packages/org/src/index.ts`, `packages/cli/src/wire.ts` (agent create, agent edit, run `--model`)
- Test: `packages/org/test/model-id.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Produces:

```ts
export type ModelRef =
  | { source: "sub"; alias: string }
  | { source: "lmstudio"; id: string }
  | { source: "api"; connection: string; id: string }
  | { source: "anthropic"; id: string };
export function parseModelId(model: string, connections: string[]): { ok: true; ref: ModelRef } | { ok: false; error: string };
export const SUB_ALIASES = ["sonnet", "opus", "haiku"] as const;
```

- [ ] **Step 1: Write failing tests**

```ts
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

// cli.test.ts
it("agent create rejects an unknown model id", async () => { /* exit 1, stderr has "unknown model gpt-4o" */ });
it("agent edit --model claude-sub/haiku saves version 2", async () => { /* agent show prints claude-sub/haiku, v2 */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/org packages/cli/test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `parseModelId`. In `wire.ts`, `agent create`, `agent edit` and `run --model` call it with `loadGlobalConfig(home).connections.map(c => c.name)` and `fail(error)` on `ok: false`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `npx vitest run`. Expected: all PASS, since existing tests use `claude-haiku-5-5` and `lmstudio/` ids.
- [ ] **Step 5: Commit** `feat(org): parse and validate model ids for 4 sources`

### Task 3: Claude subscription provider in core

**Files:**
- Create: `packages/core/src/providers/claude-prompt.ts`, `packages/core/src/providers/claude-cli.ts`, `packages/core/test/fixtures/fake-claude.mjs`
- Modify: `packages/core/src/types.ts`, `packages/core/src/agent/run-agent.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/claude-prompt.test.ts`, `packages/core/test/claude-cli.test.ts`, `packages/core/test/run-agent.test.ts`

**Interfaces:**
- Consumes: `parseTextToolCalls(text, allowed)` from `core/src/llm/text-tool-calls.ts`.
- Produces:
  - `ChatRequest.signal?: AbortSignal`. `runAgent` passes its `signal`.
  - `renderClaudePrompt(req: ChatRequest): { system: string; prompt: string }`. System is the system message plus the tool block. Prompt is the rest of the transcript.
  - `class ClaudeCliProvider implements Provider` with `id = "claude-sub"` and `constructor(opts: { claudePath?: string; alias: string; timeoutMs?: number; spawn?: typeof import("node:child_process").spawn; env?: NodeJS.ProcessEnv })`. `timeoutMs` defaults to 180000.
  - `resolveClaudeBin(path: string, platform: NodeJS.Platform, exists: (p: string) => boolean): string`. On `win32`, a path with no extension becomes the first of `<path>.cmd`, `<path>.exe` found on `PATH`, else the path unchanged.

Prompt format, fixed so tests can pin it:

```
TOOLS
You can call one or more tools. To call a tool, write exactly:
<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>
When the task is done, answer in plain text with no tool call.

- <name>: <description>
  input schema: <JSON.stringify(inputSchema)>
```

Transcript lines: `USER:\n<content>`, `ASSISTANT:\n<content>` followed by one `<tool_call>{...}</tool_call>` line per earlier call, `TOOL RESULT (<name>, <toolCallId>):\n<content>`. Blocks are joined by a blank line.

- [ ] **Step 1: Write the fake binary.** `fake-claude.mjs` reads argv and stdin. It writes `argv`, `cwd`, `ANTHROPIC_API_KEY` presence and stdin to the path in env `FAKE_CLAUDE_LOG` as JSON. Then it acts on env `FAKE_CLAUDE_MODE`: `tool` prints `{"type":"result","is_error":false,"result":"<tool_call>{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.txt\",\"content\":\"hi\"}}</tool_call>","usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":1,"output_tokens":7}}`; `text` prints result `done`; `empty` prints result `""`; `error` prints `is_error: true` and result `Invalid API key · Please run /login`; `exit` writes `boom` to stderr and exits 2; `hang` never exits.
- [ ] **Step 2: Write failing tests**

```ts
// claude-prompt.test.ts
it("puts tools in the system text", () => {
  const { system } = renderClaudePrompt(req({ tools: [{ name: "write_file", description: "Write", inputSchema: { type: "object" } }] }));
  expect(system).toContain('<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>');
  expect(system).toContain("- write_file: Write");
});
it("renders an earlier call and its result", () => {
  const { prompt } = renderClaudePrompt(req({ messages: [
    { role: "system", content: "S" }, { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", args: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", name: "write_file", content: "ok" } ] }));
  expect(prompt).toBe('USER:\ngo\n\nASSISTANT:\n\n<tool_call>{"name":"write_file","arguments":{"path":"a"}}</tool_call>\n\nTOOL RESULT (write_file, c1):\nok');
});

// claude-cli.test.ts, claudePath = process.execPath wrapper or a .mjs launched through a spawn stub
it("returns a parsed tool call and mapped usage", async () => {
  const r = await provider("tool").chat(req({ tools: [writeFileSpec] }));
  expect(r.toolCalls).toEqual([expect.objectContaining({ name: "write_file", args: { path: "a.txt", content: "hi" } })]);
  expect(r.usage).toEqual({ inputTokens: 16, outputTokens: 7 });
});
it("passes the required flags and drops API keys from env", async () => {
  await provider("text", { env: { ...process.env, ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t" } }).chat(req());
  const log = readLog();
  expect(log.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt"]));
  expect(log.hasApiKey).toBe(false); expect(log.hasAuthToken).toBe(false);
});
it("runs in an empty temp dir that is deleted after", async () => { /* log.cwd listing was [], and the dir no longer exists */ });
it("returns plain text with no calls", async () => expect((await provider("text").chat(req())).text).toBe("done"));
it("handles an empty result", async () => expect(await provider("empty").chat(req())).toMatchObject({ text: "", toolCalls: [] }));
it("maps a login error", async () => await expect(provider("error").chat(req())).rejects.toThrow("claude is not logged in. Run claude once in a terminal to log in."));
it("reports stderr on a non-zero exit", async () => await expect(provider("exit").chat(req())).rejects.toThrow("boom"));
it("reports a missing binary", async () => await expect(new ClaudeCliProvider({ claudePath: "no-such-claude-xyz", alias: "haiku" }).chat(req())).rejects.toThrow("claude command not found. Install it with npm i -g @anthropic-ai/claude-code, then run claude once to log in."));
it("kills the child on timeout", async () => await expect(provider("hang", { timeoutMs: 300 }).chat(req())).rejects.toThrow("claude did not answer in 0.3 s"));
it("kills the child on abort", async () => { /* AbortController aborts after 100 ms; rejects; child pid no longer alive */ });
it.each([
  ["C:\\npm\\claude", "win32", ["C:\\npm\\claude.cmd"], "C:\\npm\\claude.cmd"],
  ["claude", "win32", ["D:\\bin\\claude.cmd"], "D:\\bin\\claude.cmd"],
  ["claude", "linux", [], "claude"],
])("resolveClaudeBin(%s, %s)", (p, plat, present, want) => { /* exists = (x) => present.includes(x), PATH = "D:\\bin" */ });

// run-agent.test.ts
it("passes the run signal into chat", async () => { /* fake provider records req.signal === controller.signal */ });
```

The timeout message uses `timeoutMs / 1000` seconds, so the default reads `claude did not answer in 180 s`. A `.cmd` file runs through `spawn` with `windowsVerbatimArguments: false` and no `shell` option. If Node refuses to spawn a `.cmd` without a shell (EINVAL, Node 24 security change), spawn `process.env.ComSpec` with `["/d", "/s", "/c", bin, ...args]` and pass the prompt only on stdin, never in argv. The system prompt goes through `--system-prompt-file <tmp>/system.txt` in that case, inside the temp dir. Record the choice in the ledger.

- [ ] **Step 3: Run** `npx vitest run packages/core`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement** the Interfaces. Login error test: `is_error` true and the result text matches `/login|log in|authenticat|api key/i`, else the result text itself.
- [ ] **Step 5: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(core): claude subscription provider via the local claude binary`

### Task 4: providerFor branches and connection commands in the CLI

**Files:**
- Modify: `packages/cli/src/shared.ts`, `packages/cli/src/wire.ts`, `packages/cli/src/terminal-session.ts` (no change expected: `connection` is allowed), `README.md`
- Test: `packages/cli/test/provider.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `ClaudeCliProvider`, `parseModelId`, `GlobalConfig.connections`, `GlobalConfig.claudePath`, `saveConnections`, `CONNECTION_NAME_RE`.
- Produces: `providerFor(model, secrets, global)` returns, by source:
  - sub: `ClaudeCliProvider({ claudePath: global.claudePath, alias })`, model unchanged.
  - api: `OpenAICompatProvider({ baseUrl, apiKey: secrets["api-<name>"], id: "api-<name>" })` wrapped to strip `api/<name>/` on the wire.
  - api with no connection: throws `No connection <name>. Run: agentcity connection add <name> <baseUrl>`.

- [ ] **Step 1: Write failing tests**

```ts
it("routes claude-sub to the claude provider", () => expect(providerFor("claude-sub/haiku", {}, global).provider.id).toBe("claude-sub"));
it("routes api to its connection and strips the prefix", async () => {
  /* global.connections = [{ name: "groq", baseUrl: "https://g/v1" }], secrets { "api-groq": "k" }; stub fetch sees model "llama" and header "Bearer k" */
});
it("sends no Authorization header without a key", async () => { /* no api-free secret → no header */ });
it("throws for a removed connection", () =>
  expect(() => providerFor("api/gone/m", {}, global)).toThrow("No connection gone. Run: agentcity connection add gone <baseUrl>"));

// cli.test.ts
it("connection add, list, remove", async () => {
  /* add groq https://api.groq.com/openai/v1 --input-price 0.59 --output-price 0.79
     list prints "groq  https://api.groq.com/openai/v1  $0.59/$0.79 per MTok  no key"
     secrets set api-groq (piped key) then list prints "key set" and never the key value
     remove groq → list prints "No connections." */
});
it("connection add rejects one price alone", async () => { /* exit 1, "Give both --input-price and --output-price, or neither." */ });
it("connection add rejects a bad name and a file: URL", async () => { /* exit 1 each */ });
it("a run on a removed connection stops with the message", async () => { /* agent on api/gone/m after remove → stderr has "No connection gone" */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/provider.test.ts packages/cli/test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `connection list` prints `No connections.` when empty. Price column reads `no price` when absent.
- [ ] **Step 4: README.** Add a "Models" section: the 4 id forms table, `connection add` example, `secrets set api-<name>`, how to add `claude-sub/*` and `api/*` to an old `project.json`, and the subscription note: install `@anthropic-ai/claude-code`, run `claude` once to log in, own plan on own machine only, link `https://code.claude.com/docs/en/legal-and-compliance`, terms may change.
- [ ] **Step 5: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 6: Commit** `feat(cli): route claude-sub and api models; connection commands`

### Task 5: Models list and model save in the city server

**Files:**
- Create: `packages/cli/src/models.ts`
- Modify: `packages/world/src/shared/protocol.ts`, `packages/world/src/state.ts`, `packages/cli/src/city-server.ts`
- Test: `packages/cli/test/models.test.ts`, `packages/cli/test/city-server.test.ts`, `packages/world/test/` protocol and state tests

**Interfaces:**
- Produces:
  - `ClientMsg` adds `{ type: "models.list" }` and `{ type: "agent.model"; agentId: string; model: string }` (model max 200 chars).
  - `ServerMsg` adds `{ type: "models"; groups: ModelGroup[] }` and `{ type: "agent.saved"; agentId: string; version: number }`.
  - `ModelGroup = { label: string; models: string[]; error?: string }`.
  - `AgentView.model: string`. `AgentInfo` gains `model`.
  - `listModels(global: GlobalConfig, secrets: Record<string, string>, fetchFn?: typeof fetch): Promise<ModelGroup[]>`. Group order: `Claude subscription`, `LM Studio`, one per connection labelled `API: <name>`, `Anthropic API`. LM Studio ids get the `lmstudio/` prefix, connection ids `api/<name>/`. Anthropic API lists bare `claude-*` keys of `global.prices`. Each fetch has a 3 s `AbortSignal.timeout`. A failed fetch sets `error` to `cannot reach <baseUrl>` or `HTTP <status>`.

- [ ] **Step 1: Write failing tests**

```ts
// models.test.ts
it("lists 4 kinds of groups in order", async () => { /* labels ["Claude subscription","LM Studio","API: groq","Anthropic API"]; sub models ["claude-sub/sonnet","claude-sub/opus","claude-sub/haiku"] */ });
it("prefixes LM Studio and connection ids", async () => { /* stub returns {data:[{id:"qwen/qwen3-14b"}]} → "lmstudio/qwen/qwen3-14b"; groq → "api/groq/llama" */ });
it("returns other groups when LM Studio is off, within the timeout", async () => {
  /* LM Studio fetch never resolves until aborted; result arrives in under 3500 ms; LM Studio group { models: [], error: "cannot reach http://localhost:1234/v1" } */
});
it("sends the connection key and never returns it", async () => { /* header Bearer k; JSON.stringify(groups) lacks "k-secret" */ });

// city-server.test.ts
it("answers models.list", async () => { /* client sends models.list → gets { type: "models" } */ });
it("agent.model saves a new version and replies agent.saved", async () => { /* ada v1 → v2 with claude-sub/haiku; next snapshot AgentView.model is claude-sub/haiku */ });
it("agent.model with a bad id replies error", async () => { /* error message "unknown model gpt-4o. ..." ; version unchanged */ });
it("agent.model for a missing agent replies error", async () => { /* "No agent ghost" */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/models.test.ts packages/cli/test/city-server.test.ts packages/world`. Expected: FAIL.
- [ ] **Step 3: Implement.** The server reads `loadGlobalConfig(home)` and `readSecrets(home)` per request, so new connections and keys show without a restart. `agent.model` uses `AgentStore.update(id, { model })`. A model change makes the agent ids set unchanged, so the next poll sends a patch with the new `model`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(city): list models per source and save an agent's model`

### Task 6: Model picker on the agent card

**Files:**
- Modify: `packages/client/src/ui/agent-card.ts`, `packages/client/src/ui/index.ts`, `packages/client/src/ui/style.css`
- Test: `packages/client/test/agent-card.test.ts` (new, jsdom as in `hq-panel.test.ts`)

**Interfaces:**
- Consumes: `ModelGroup`, `ClientMsg` from Task 5; `Send` from `hq-panel.ts`.
- Produces: `AgentCard` constructor gains `send: Send` as its second parameter. Methods `setModels(groups: ModelGroup[]): void` and `saved(agentId: string, version: number): void`.

- [ ] **Step 1: Write failing tests**

```ts
it("sends models.list once per open", () => { /* show("ada") twice while open → one send; close, show → two sends */ });
it("renders optgroups with the current model selected", () => { /* groups from Task 5 test; select.value === "lmstudio/qwen/qwen3-14b" */ });
it("keeps an unlisted current model as an option", () => { /* model api/groq/x not in groups → option present and selected */ });
it("shows a group error as one disabled option", () => { /* option text "cannot reach http://localhost:1234/v1", disabled */ });
it("other... reveals a text input and Save sends that id", () => { /* type api/groq/llama-3.3-70b → send({type:"agent.model",agentId:"ada",model:"api/groq/llama-3.3-70b"}) */ });
it("Save sends the selected model", () => { /* select claude-sub/haiku, click Save → send agent.model */ });
it("shows saved v2", () => { /* saved("ada", 2) → card text contains "saved v2" */ });
it("refresh after a snapshot shows a model changed elsewhere", () => { /* find returns model claude-sub/opus, refresh() → select.value claude-sub/opus, when the user has not touched the select */ });
it("game keys stay off while the model input has focus", () => { /* gameKeysEnabled(input) === false */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/client`. Expected: FAIL.
- [ ] **Step 3: Implement.** `index.ts` routes `models` to `card.setModels` and `agent.saved` to `card.saved`. The card keeps the user's unsaved pick across `refresh()` calls until Save or close.
- [ ] **Step 4: Run** `npx vitest run packages/client`. Expected: PASS. Then `npm run build`. Expected: clean.
- [ ] **Step 5: Commit** `feat(client): model picker on the agent card`

### Task 7: Whole-branch check

- [ ] **Step 1: Run** `npm run typecheck && npm run lint && npx vitest run && npm run build`. Expected: all clean.
- [ ] **Step 2: Live city check** with the throwaway home from `.claude/launch.json`. Open ada's card, see 4 groups, switch ada to an `lmstudio/` model and back, run once. With no `claude` installed, a run on `claude-sub/haiku` must stop with the "claude command not found" message in the terminal.
- [ ] **Step 3: Optional live checks**, only when available: one run on `claude-sub/haiku` after the user installs and logs in to `claude`; one run on an `api/` connection if the user has a key. The user runs `secrets set` in their own terminal.
