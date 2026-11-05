# Agent City Core + Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One agent runs one goal on LM Studio or Anthropic with 3 tools, and every model call and tool call passes a code-enforced safety gate.

**Architecture:** Four npm workspaces. `@agentcity/core` holds providers, tools, events and the agent loop, and defines the `ToolGate` interface. `@agentcity/safety` implements the gate on top of SQLite (action log, approvals, usage). `@agentcity/org` stores agent profiles (name, role, persona, model) with version history. `@agentcity/cli` reads secrets, wires the packages and exposes the `agentcity` command.

**Tech Stack:** TypeScript 5, Node 22, npm workspaces, vitest, eslint 9 (flat config), zod 4, better-sqlite3, @anthropic-ai/sdk, commander.

**Spec:** `docs/superpowers/specs/2026-10-29-core-safety-design.md`

## Global Constraints

- Node 22 or newer (this machine has 24). `"type": "module"` in every package. TypeScript `strict: true`, `module`/`moduleResolution`: `NodeNext`.
- Import direction: `cli` imports `org`, `safety` and `core`. `org` and `safety` import `core` only. `core` imports none of them (eslint `no-restricted-imports`).
- The agent loop requires a `gate`. No default gate exists anywhere.
- Data root: `~/.agentcity`, overridden by `AGENTCITY_HOME`. Every test sets `AGENTCITY_HOME` to a fresh temp folder.
- Missing or invalid project config: every gate check returns `stop("config_invalid")`.
- Defaults: `maxSteps` 20, provider retries 2 with waits 1000 ms and 4000 ms, `autoApprove.enabled` false, `budget.maxUsd` 1.0, `budget.maxTokens` 200000, `perAgent.maxUsd` 0.5, default Anthropic model `claude-haiku-5-5`, LM Studio base URL `http://localhost:1234/v1`.
- Model ids: `lmstudio/<name>` routes to LM Studio (the `lmstudio/` prefix is stripped before the request). Every other id routes to Anthropic.
- Secrets never enter messages, tool context or events. Logged payloads replace known secret values with `[secret]`.
- Files copied from AX Studio (`C:\Users\berna\Documents\GitHub\git-gui-for-designers`, MIT) start with `// Adapted from AX Studio <relative source path> (MIT).`
- Unit tests make no network calls and spend no tokens. Live tests run only when `AGENTCITY_LIVE=1`.

## Review Focus

1. LM Studio is not running (connection refused): the run stops with `provider_error` after 2 retries, and the CLI prints `Cannot reach LM Studio at <url>. Is it running?`. Test in Task 6 and Task 14.
2. The model sends malformed tool arguments (bad JSON text or wrong types): the tool does not run, the model gets `error: invalid arguments: <zod message>`, the run continues. Test in Task 5.
3. `read_file` on a large file: output is cut at 100000 characters with `[file cut at 100000 characters]` appended, so one read cannot fill the context window. Test in Task 3.
4. Windows paths: a sandbox check compares resolved real paths case-insensitively on `win32`, and rejects other drive letters and UNC paths. Test in Task 3.
5. Ctrl+C while an approval prompt waits: the pending approval row becomes `denied` with `decidedBy = "shutdown"`, and the log keeps a `run.stopped` row with reason `interrupted`. Test in Task 11 (queue) and Task 14 (CLI).

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`
- Create: `packages/{core,safety,org,cli}/package.json`, `packages/{core,safety,org,cli}/tsconfig.json`, `packages/{core,safety,org,cli}/src/index.ts`
- Test: `packages/core/test/scaffold.test.ts`

**Interfaces:**
- Produces: root scripts `build` (`tsc -b`), `typecheck` (`tsc -b`; build mode type-checks every referenced package), `test` (`vitest run`), `lint` (`eslint --max-warnings=0 .`), `setup` (`npm install && npm run build && npm link -w @agentcity/cli`). Package names `@agentcity/core`, `@agentcity/safety`, `@agentcity/org`, `@agentcity/cli`. `cli` has `"bin": { "agentcity": "dist/main.js" }`.

- [ ] **Step 1: Write the scaffold files.** Root `package.json` has `"private": true`, `"workspaces": ["packages/*"]`. Each package `tsconfig.json` sets `rootDir: src`, `outDir: dist`, `composite: true`, and `references` per the import direction. Vitest `include: ["packages/*/test/**/*.test.ts"]`, excludes `**/*.live.test.ts` unless `AGENTCITY_LIVE=1`. `.gitignore`: `node_modules`, `dist`, `*.tsbuildinfo`.
- [ ] **Step 2: Add the boundary rule.** In `eslint.config.js`, for `packages/core/**` set `no-restricted-imports` with patterns `@agentcity/safety`, `@agentcity/org`, `@agentcity/cli` and their `../../<pkg>/*` relative forms. For `packages/safety/**` restrict `@agentcity/org` and `@agentcity/cli`. For `packages/org/**` restrict `@agentcity/safety` and `@agentcity/cli`.
- [ ] **Step 3: Write test** `scaffold.test.ts`: `it("core exports a version", () => expect(VERSION).toBe("0.1.0"))` with `export const VERSION = "0.1.0"` in `packages/core/src/index.ts`.
- [ ] **Step 4: Verify the boundary.** Temporarily add `import "@agentcity/safety";` to `packages/core/src/index.ts`. Run `npm run lint`. Expected: 1 error `no-restricted-imports`. Remove the line.
- [ ] **Step 5: Run** `npm install && npm run build && npm test && npm run lint`. Expected: all pass, 1 test.
- [ ] **Step 6: Commit** `chore: scaffold npm workspaces for core, safety, cli`.

### Task 2: Core types, events and FakeProvider

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/events.ts`, `packages/core/src/providers/fake.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/test/fake-provider.test.ts`

**Interfaces:**
- Produces (in `types.ts`):
```ts
export interface ToolCall { id: string; name: string; args: unknown }
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface Usage { inputTokens: number; outputTokens: number }
export interface ChatRequest { model: string; messages: Message[]; tools: ToolSpec[]; maxTokens: number }
export interface ChatResponse { text: string; toolCalls: ToolCall[]; usage: Usage }
export interface Provider { id: string; chat(req: ChatRequest): Promise<ChatResponse> }
export type GateDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "stop"; reason: string };
```
- Produces (in `events.ts`):
```ts
type Base = { ts: string; projectId: string; agentId: string };
export type AgentEvent = Base & (
  | { type: "run.started"; goal: string; model: string; agentName: string; agentVersion: number }
  | { type: "model.call"; model: string; messageCount: number }
  | { type: "model.result"; usage: Usage; toolCallCount: number }
  | { type: "tool.requested"; call: ToolCall }
  | { type: "tool.result"; callId: string; name: string; outcome: "ok" | "denied" | "error"; result: string }
  | { type: "run.stopped"; reason: string; steps: number });
export interface EventSink { emit(e: AgentEvent): void }
export class MemorySink implements EventSink { events: AgentEvent[] }
```
- Produces: `class FakeProvider implements Provider` with `constructor(script: Array<ChatResponse | Error>)`, `id = "fake"`, `requests: ChatRequest[]`. Each `chat` call shifts the next item. An `Error` item is thrown. An empty script throws `Error("FakeProvider script exhausted")`.

- [ ] **Step 1: Write failing tests:** `returns scripted responses in order` (2 items, assert `text` of each), `throws scripted errors`, `records requests` (`requests.length === 2`, `requests[0].model === "m"`), `throws when exhausted`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/fake-provider.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `types.ts` (without `ToolGate`), `events.ts`, `providers/fake.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 passed.
- [ ] **Step 5: Commit** `feat(core): message types, events, FakeProvider`.

### Task 3: Tools, sandbox and the ToolGate interface

**Files:**
- Create: `packages/core/src/tools/types.ts`, `sandbox.ts`, `read-file.ts`, `write-file.ts`, `send-message.ts`, `index.ts` (all under `packages/core/src/tools/`)
- Test: `packages/core/test/tools.test.ts`, `packages/core/test/sandbox.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `Usage`, `GateDecision` from Task 2.
- Produces:
```ts
export interface ToolContext { projectId: string; agentId: string; sandboxDir: string; outboxDir: string }
export interface Tool<A> {
  name: string; description: string; tier: 0 | 1 | 2 | 3;
  schema: z.ZodType<A>;
  estimateUsd?(args: A): number;
  run(args: A, ctx: ToolContext): Promise<string>;
}
export type AnyTool = Tool<any>;
export interface ToolGate {
  checkModelCall(req: { model: string; estimatedInputTokens: number }): Promise<GateDecision>;
  recordUsage(model: string, usage: Usage): Promise<void>;
  checkTool(call: ToolCall, tool: AnyTool): Promise<GateDecision>;
}
export function toolSpec(t: AnyTool): ToolSpec;               // inputSchema = z.toJSONSchema(t.schema)
export function resolveInSandbox(sandboxDir: string, p: string): Promise<string>; // throws SandboxError
export class SandboxError extends Error {}
export const readFileTool: Tool<{ path: string }>;            // tier 0
export const writeFileTool: Tool<{ path: string; content: string }>; // tier 1
export const sendMessageTool: Tool<{ to: string; body: string }>;    // tier 2
export const builtInTools: AnyTool[];                          // the 3 above
export const READ_LIMIT = 100_000;
```
- `resolveInSandbox`: resolve `p` against `sandboxDir`. Take `fs.realpath` of the sandbox and of the deepest existing ancestor of the target (the target may not exist yet for writes). Reject when the real target is not the sandbox or inside it. On `win32` compare lowercased paths. Reject UNC paths (`\\\\`) and a different drive letter.
- `send_message` writes `outboxDir/<Date.now()>-<4 random hex>.json` with `{ to, body }` and returns `queued: <filename>`.
- `read_file` returns the content cut at `READ_LIMIT` with `\n[file cut at 100000 characters]` appended when cut.
- `write_file` creates parent folders inside the sandbox and returns `wrote <n> bytes to <relative path>`.

- [ ] **Step 1: Write failing sandbox tests** in `sandbox.test.ts` using a temp dir: `allows a nested path`, `rejects ..` (`../x`), `rejects an absolute path outside`, `rejects a symlink pointing outside` (skip on win32 when `fs.symlink` throws EPERM), `allows a not-yet-existing file`, `win32: accepts different case of the sandbox path` (`it.runIf(process.platform === "win32")`), `win32: rejects another drive and UNC` (`it.runIf(process.platform === "win32")`, inputs `D:\\x` when sandbox is on C:, and `\\\\server\\share\\x`).
- [ ] **Step 2: Write failing tool tests** in `tools.test.ts`: `read_file reads a file`, `read_file cuts at 100000 characters` (write 150000 `a` chars, assert length `100000 + "\n[file cut at 100000 characters]".length`), `write_file writes inside sandbox`, `write_file rejects ../escape.txt` (rejects with `SandboxError`), `send_message writes one JSON file to outbox` (parse file, assert `{ to: "a@b.c", body: "hi" }`), `tiers are 0, 1, 2`, `toolSpec has an object inputSchema with required path`.
- [ ] **Step 3: Run** `npx vitest run packages/core/test/sandbox.test.ts packages/core/test/tools.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 4: Implement** the files above.
- [ ] **Step 5: Run** the same command. Expected: all pass (win32-only tests run on this machine).
- [ ] **Step 6: Commit** `feat(core): sandboxed file tools, outbox send tool, ToolGate interface`.

### Task 4: Text tool-call parser and context trimming (copied from AX Studio)

**Files:**
- Create: `packages/core/src/llm/text-tool-calls.ts` (from `src/core/llm/text-tool-calls.ts`)
- Create: `packages/core/src/llm/trim.ts` (estimate code and `trimToWindow` idea from `src/runtime/turn.ts`)
- Test: `packages/core/test/text-tool-calls.test.ts`, `packages/core/test/trim.test.ts`

**Interfaces:**
- Produces:
```ts
export function parseTextToolCalls(text: string, allowed: string[]): { calls: ToolCall[]; rest: string };
export function estimateTokens(text: string): number;          // copy AX Studio's estimate
export function estimateMessages(messages: Message[], tools: ToolSpec[]): number;
export function trimMessages(messages: Message[], tools: ToolSpec[], windowTokens: number): Message[];
```
- Parser change from AX Studio: return our `ToolCall` (`{ id, name, args }` with `args` as an object) in place of the OpenAI shape. Keep every written form AX Studio reads. Copy AX Studio's existing parser tests if `tests/` has them, adapted to the new shape.
- `trimMessages` rule (differs from AX Studio, which drops whole user turns; an agent run has one user message): keep `messages[0]` (system) and `messages[1]` (goal) always. Drop the oldest assistant message together with all `tool` messages that answer its `toolCalls`, repeat until the estimate fits or only system, goal and the latest assistant group remain. Never return a `tool` message without its assistant message.

- [ ] **Step 1: Write failing parser tests:** one per form (`<tool_call>`, `<function=name>` JSON body, `<function=name><parameter=...>`, `[TOOL_CALLS]`, `<|python_tag|>`, fenced json block), plus `ignores names not in allowed` and `rest has the call text removed`. Each asserts `calls[0].name` and `calls[0].args`.
- [ ] **Step 2: Write failing trim tests:** `returns input unchanged when it fits`, `drops the oldest assistant group first` (3 groups, window fits 2, assert first group's tool ids are gone), `never drops system or goal`, `never leaves an orphan tool message` (assert every `tool` message's `toolCallId` appears in an earlier assistant's `toolCalls`).
- [ ] **Step 3: Run** `npx vitest run packages/core/test/text-tool-calls.test.ts packages/core/test/trim.test.ts`. Expected: FAIL.
- [ ] **Step 4: Copy and adapt** both files with the source header comment.
- [ ] **Step 5: Run** the same command. Expected: all pass.
- [ ] **Step 6: Commit** `feat(core): text tool-call parser and context trimming from AX Studio`.

### Task 5: Agent loop

**Files:**
- Create: `packages/core/src/agent/run-agent.ts`
- Test: `packages/core/test/run-agent.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
```ts
export interface RunAgentOptions {
  provider: Provider; model: string; tools: AnyTool[]; gate: ToolGate; events: EventSink;
  projectId: string; agentId: string; agentName: string; agentVersion: number; goal: string; toolContext: ToolContext;
  systemPrompt?: string; maxSteps?: number; contextWindow?: number; maxTokens?: number;
  sleep?: (ms: number) => Promise<void>; signal?: AbortSignal;
}
export interface RunResult { reason: string; steps: number; usage: Usage }
export function runAgent(opts: RunAgentOptions): Promise<RunResult>;
export const DEFAULT_SYSTEM_PROMPT: string;
```
- Defaults: `maxSteps` 20, `contextWindow` 32000, `maxTokens` 4096, `sleep` = `setTimeout` promise. Retry waits `[1000, 4000]`.
- Step order per the spec's "Agent loop" section, items 1 to 7. Stop reasons: `done`, `max_steps`, `provider_error`, `interrupted` (when `signal.aborted` at the start of a step), or the gate's `stop` reason.
- Tool call handling: unknown name returns `error: unknown tool <name>` (no gate call). Args go through `tool.schema.safeParse`; a failure returns `error: invalid arguments: <issues joined by "; ">` (no gate call). Gate `deny` returns `denied: <reason>`. Thrown errors return `error: <message>`. Each emits `tool.result` with the matching `outcome`.
- When the provider returns no `toolCalls` but text, run `parseTextToolCalls(text, toolNames)` and use its calls.
- `emit` is called for every event listed in Task 2, with `ts = new Date().toISOString()`.

- [ ] **Step 1: Write failing tests** with `FakeProvider`, `MemorySink`, a temp sandbox, and a `fakeGate(decisions)` helper that returns scripted `GateDecision`s and records calls:
  - `stops with done when the model makes no tool calls` (reason `done`, steps 1)
  - `runs an allowed tool and feeds the result back` (second request's last message is a `tool` message with the file content)
  - `returns denied:<reason> on deny and continues`
  - `stops on gate stop from checkTool` (reason `budget`)
  - `stops on gate stop from checkModelCall` (reason `killed`, provider never called)
  - `stops with max_steps` (`maxSteps: 2`, model always calls `read_file`)
  - `retries provider errors twice then stops with provider_error` (script: 3 errors; `sleep` spy called with 1000 then 4000)
  - `recovers when a retry succeeds` (script: 1 error then a reply)
  - `unknown tool name returns an error result without a gate call`
  - `malformed args return invalid arguments without a gate call` (args `{ path: 5 }`)
  - `tool exceptions become error results`
  - `parses text tool calls when toolCalls is empty`
  - `sums usage across steps`
  - `stops with interrupted when the signal is aborted`
  - `emits run.started first and run.stopped last`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/run-agent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `runAgent` and export it from `packages/core/src/index.ts`.
- [ ] **Step 4: Run** the same command. Expected: 15 passed.
- [ ] **Step 5: Commit** `feat(core): agent loop with required gate`.

### Task 6: OpenAI-compatible provider (LM Studio)

**Files:**
- Create: `packages/core/src/providers/openai-compat.ts`
- Test: `packages/core/test/openai-compat.test.ts`

**Interfaces:**
- Produces: `class OpenAICompatProvider implements Provider` with `constructor(opts: { baseUrl: string; apiKey?: string; fetch?: typeof fetch; id?: string })`, default `id` `"lmstudio"`. `class ProviderUnreachableError extends Error { baseUrl: string }`.
- Maps our `Message` to OpenAI chat format (`tool_calls` with `function.arguments` as a JSON string; `tool` role with `tool_call_id`). Maps response `choices[0].message.tool_calls` back, parsing `arguments` with `JSON.parse`; a parse failure keeps the raw string as `args` so the loop's schema check reports it. Reads `usage.prompt_tokens` and `usage.completion_tokens` (missing means 0).
- A `fetch` rejection with `cause.code === "ECONNREFUSED"` throws `ProviderUnreachableError`. Non-2xx throws `Error("HTTP <status>: <first 500 chars of body>")`.
- Reuse request mapping ideas from AX Studio `src/core/llm/openai-compatible-client.ts` where they fit.

- [ ] **Step 1: Write failing tests** with a stub `fetch`: `posts to <baseUrl>/chat/completions with model and tools`, `maps tool_calls back to ToolCall with parsed args`, `keeps unparsable arguments as a string`, `maps usage`, `throws ProviderUnreachableError on ECONNREFUSED`, `throws HTTP error on 500`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/openai-compat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 6 passed.
- [ ] **Step 5: Commit** `feat(core): OpenAI-compatible provider for LM Studio`.

### Task 7: Anthropic provider

**Files:**
- Create: `packages/core/src/providers/anthropic.ts`
- Test: `packages/core/test/anthropic.test.ts`

**Interfaces:**
- Produces: `class AnthropicProvider implements Provider` with `constructor(opts: { apiKey: string; client?: Pick<Anthropic, "messages"> })`, `id = "anthropic"`.
- Maps `system` message to the top-level `system` field. Maps assistant `toolCalls` to `tool_use` blocks and `tool` messages to `tool_result` blocks inside a `user` message (consecutive tool results merge into one user message). Maps `ToolSpec.inputSchema` to `input_schema`. Response: text blocks joined into `text`, `tool_use` blocks to `ToolCall`, `usage.input_tokens`/`output_tokens` to `Usage`.
- Check current request and response shapes with the `claude-api` skill before writing the mapping.

- [ ] **Step 1: Write failing tests** with a stub `client.messages.create`: `sends system separately`, `maps tools to input_schema`, `maps tool results into one user message`, `maps tool_use blocks back`, `maps usage`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/anthropic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `@anthropic-ai/sdk` to `packages/core` dependencies.
- [ ] **Step 4: Run.** Expected: 5 passed.
- [ ] **Step 5: Commit** `feat(core): Anthropic provider`.

### Task 8: Data folder, database and append-only action log

**Files:**
- Create: `packages/safety/src/home.ts`, `db.ts`, `redact.ts`, `action-log.ts`
- Test: `packages/safety/test/action-log.test.ts`, `packages/safety/test/helpers.ts` (temp home factory)

**Interfaces:**
- Consumes: `AgentEvent`, `EventSink` from core.
- Produces:
```ts
export function agentCityHome(): string;  // AGENTCITY_HOME or ~/.agentcity
export function projectDirs(home: string, id: string): { root: string; config: string; sandbox: string; outbox: string };
export function openDb(home: string): Database.Database; // creates folder, schema, WAL, busy_timeout 5000
export function redact<T>(value: T, secrets: string[]): T; // deep-copies, replaces every secret substring (length >= 8) with "[secret]"
export interface ActionRow { id: number; ts: string; projectId: string; agentId: string; type: string; payload: unknown; usd: number }
export class ActionLog {
  constructor(db: Database.Database, secrets: string[]);
  append(e: { projectId: string; agentId: string; type: string; payload: unknown; usd?: number; ts?: string }): number;
  list(projectId: string, afterId?: number): ActionRow[];
  sink(): EventSink;   // appends each event with type = event.type
}
```
- Schema (exact):
```sql
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS actions_no_update BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'actions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS actions_no_delete BEFORE DELETE ON actions BEGIN SELECT RAISE(ABORT, 'actions is append-only'); END;
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL, tier INTEGER NOT NULL, estimated_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')), decided_at TEXT, decided_by TEXT);
CREATE TABLE IF NOT EXISTS usage (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (project_id, agent_id));
```

- [ ] **Step 1: Write failing tests:** `append then list returns rows in order`, `UPDATE throws append-only` (`expect(() => db.prepare("UPDATE actions SET type='x'").run()).toThrow(/append-only/)`), `DELETE throws append-only`, `redacts a secret inside nested payload` (secret `sk-test-12345678` inside `{ a: ["x sk-test-12345678 y"] }` logs as `"x [secret] y"`), `sink appends events with their type`, `two connections can write` (open 2 dbs on one home, append from both, list has 2 rows).
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/action-log.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `better-sqlite3` and `@types/better-sqlite3` to `packages/safety`.
- [ ] **Step 4: Run.** Expected: 6 passed.
- [ ] **Step 5: Commit** `feat(safety): SQLite store with append-only action log and redaction`.

### Task 9: Project config, global config and pricing

**Files:**
- Create: `packages/safety/src/config.ts`, `packages/safety/src/pricing.ts`
- Test: `packages/safety/test/config.test.ts`, `packages/safety/test/pricing.test.ts`

**Interfaces:**
- Produces:
```ts
export const ProjectConfigSchema: z.ZodType<ProjectConfig>; // fields and defaults exactly as the spec's JSON example
export type ProjectConfig = { id: string; agents: string[]; allowedTools: string[]; allowedModels: string[];
  budget: { maxTokens: number; maxUsd: number }; perAgent: { maxUsd: number };
  autoApprove: { enabled: boolean; maxUsdPerAction: number; maxUsdPerDay: number }; killSwitch: boolean };
export function defaultProjectConfig(id: string): ProjectConfig;
export function loadProjectConfig(home: string, id: string): { ok: true; config: ProjectConfig } | { ok: false; error: string };
export function saveProjectConfig(home: string, config: ProjectConfig): void; // also creates sandbox/ and outbox/
export type Prices = Record<string, { inputPerMTok: number; outputPerMTok: number }>;
export interface GlobalConfig { prices: Prices; lmStudioBaseUrl: string }
export function loadGlobalConfig(home: string): GlobalConfig; // merges config.json over defaults
export const DEFAULT_PRICES: Prices;
export function modelAllowed(allowed: string[], model: string): boolean; // exact or "<prefix>/*"
export function priceFor(prices: Prices, model: string): { inputPerMTok: number; outputPerMTok: number } | undefined; // lmstudio/* -> zeros
export function costUsd(price: { inputPerMTok: number; outputPerMTok: number }, usage: Usage): number;
```
- `DEFAULT_PRICES` holds `claude-haiku-5-5` with the current list price. Read it with the `claude-api` skill at implementation time. Tests use their own price table and never assert on `DEFAULT_PRICES` values.
- `defaultProjectConfig` default `agents`: `[]`; default `allowedModels`: `["claude-haiku-5-5", "lmstudio/*"]`.

- [ ] **Step 1: Write failing tests:** `default config round-trips through save and load`, `missing file returns ok:false`, `invalid JSON returns ok:false`, `negative maxUsd returns ok:false`, `save creates sandbox and outbox`, `modelAllowed matches exact and prefix/*` (`lmstudio/qwen` true, `lmstudiox/q` false), `priceFor returns zeros for lmstudio models`, `priceFor returns undefined for unknown hosted model`, `costUsd computes from per-million prices` (price `{3, 15}`, usage `{1_000_000, 100_000}` gives `4.5`).
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/config.test.ts packages/safety/test/pricing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 9 passed.
- [ ] **Step 5: Commit** `feat(safety): project config, global config, pricing`.

### Task 10: Budget ledger

**Files:**
- Create: `packages/safety/src/budget.ts`
- Test: `packages/safety/test/budget.test.ts`

**Interfaces:**
- Produces:
```ts
export class Budget {
  constructor(db: Database.Database);
  add(projectId: string, agentId: string, tokens: number, usd: number): void; // upsert
  project(projectId: string): { tokens: number; usd: number };               // sum over agents
  agent(projectId: string, agentId: string): { tokens: number; usd: number };
}
```

- [ ] **Step 1: Write failing tests:** `starts at zero`, `adds per agent`, `project sums all agents`, `survives reopening the db`.
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 4 passed.
- [ ] **Step 5: Commit** `feat(safety): budget ledger`.

### Task 11: Approval queue

**Files:**
- Create: `packages/safety/src/approvals.ts`
- Test: `packages/safety/test/approvals.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ApprovalRequest { projectId: string; agentId: string; tool: string; args: unknown; tier: number; estimatedUsd: number }
export type ApprovalStatus = "approved" | "denied";
export interface Approver { decide(req: ApprovalRequest & { id: number }): Promise<ApprovalStatus> }
export class ApprovalQueue {
  constructor(db: Database.Database, now?: () => Date);
  request(req: ApprovalRequest, approver: Approver): Promise<ApprovalStatus>; // inserts pending, awaits, writes status, decided_by "user"
  recordAuto(req: ApprovalRequest): void;                                      // inserts approved, decided_by "auto"
  autoTotalToday(projectId: string): number;  // sum estimated_usd where decided_by='auto' and date(ts) = date(now) in local time
  denyAllPending(decidedBy?: string): number; // default "shutdown"; returns rows changed
  pending(projectId: string): Array<ApprovalRequest & { id: number }>;
}
```
- If the approver promise rejects, the row becomes `denied` with `decided_by = "error"` and `request` returns `"denied"`.

- [ ] **Step 1: Write failing tests:** `approved decision is stored`, `denied decision is stored`, `row is pending while the approver waits` (approver resolves on a deferred; assert `pending()` has 1 row before resolving), `approver error becomes denied`, `denyAllPending marks waiting rows shutdown` (start a request with a never-resolving approver, call `denyAllPending()`, expect 1 and status `denied`, `decided_by` `shutdown`), `autoTotalToday sums only today's auto rows` (inject `now`; one auto row yesterday at 2.0, two today at 1.0 and 0.5, one user row today at 9.0; expect 1.5).
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/approvals.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 6 passed.
- [ ] **Step 5: Commit** `feat(safety): approval queue`.

### Task 12: Gate

**Files:**
- Create: `packages/safety/src/gate.ts`
- Modify: `packages/safety/src/index.ts` (export everything from Tasks 8 to 12)
- Test: `packages/safety/test/gate.test.ts`

**Interfaces:**
- Consumes: `ToolGate`, `AnyTool`, `ToolCall`, `Usage`, `GateDecision` (core); Tasks 8 to 11.
- Produces:
```ts
export interface GateDeps {
  home: string; projectId: string; agentId: string;
  log: ActionLog; budget: Budget; approvals: ApprovalQueue; approver: Approver; prices: Prices;
}
export class Gate implements ToolGate { constructor(deps: GateDeps) }
```
- `checkTool` order and results exactly as the spec's "Gate" section, checks 1 to 5. Budget check: `project.tokens >= budget.maxTokens || project.usd >= budget.maxUsd || agent.usd >= perAgent.maxUsd` gives `stop("budget")`.
- Check 2 first tests `config.agents.includes(agentId)`, else `stop("agent_not_allowed")`, then the tool allowlist.
- `checkModelCall` order: config invalid gives `stop("config_invalid")`; kill switch gives `stop("killed")`; agent not in `agents` gives `stop("agent_not_allowed")`; `!modelAllowed` gives `stop("model_not_allowed")`; `priceFor` undefined gives `stop("unknown_model_price")`; budget check gives `stop("budget")`.
- `recordUsage` adds tokens and `costUsd` to `Budget` and appends a `usage` action with `usd` set.
- Every decision appends a `gate.decision` action with payload `{ check: "tool" | "model", name, decision: kind, reason?, rule }`, where `rule` is one of `config_invalid`, `kill_switch`, `agent_allowlist`, `allowlist`, `budget`, `tier0`, `tier1`, `user_approval`, `auto_approve`, `no_estimate`.
- A tier 2 or 3 `denied` approval returns `deny("user_denied")`.

- [ ] **Step 1: Write failing tests** with a temp home, `saveProjectConfig` (with `agents: ["ada"]` and `agentId` `ada` unless the test says otherwise), and a scripted `Approver`:
  - `config_invalid stops tool and model checks` (no project.json)
  - `kill switch stops before the allowlist` (kill on, tool not allowed: reason `killed`)
  - `agent not in agents stops tool and model checks` (reason `agent_not_allowed`)
  - `tool not in allowedTools is denied`
  - `budget over project usd stops`, `budget over tokens stops`, `budget over agent usd stops`
  - `tier 0 and tier 1 are allowed without the approver` (approver spy not called)
  - `tier 2 asks the approver; approved allows, denied returns user_denied`
  - `tier 2 asks even when autoApprove is on`
  - `tier 3 auto-approves within both limits` (enabled, perAction 5, perDay 10, estimate 4: allow, approver not called, `autoTotalToday` 4)
  - `tier 3 asks when over the per-action limit` (estimate 6)
  - `tier 3 asks when the daily total would pass the limit` (prior auto 8, estimate 4)
  - `tier 3 without estimateUsd is denied with no_estimate`
  - `model not allowed stops`, `unknown hosted model price stops`, `lmstudio model is allowed at zero cost`
  - `recordUsage adds cost to budget`
  - `config change is seen on the next check` (allow, then save with killSwitch true, then stop)
  - `every decision writes a gate.decision row`
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 20 passed.
- [ ] **Step 5: Commit** `feat(safety): gate with kill switch, allowlist, budget and tier rules`.

### Task 13: Agent profiles

**Files:**
- Create: `packages/org/src/profile.ts`, `packages/org/src/store.ts`, `packages/org/src/prompt.ts`
- Modify: `packages/org/src/index.ts`
- Test: `packages/org/test/store.test.ts`, `packages/org/test/prompt.test.ts`

**Interfaces:**
- Consumes: nothing from safety. Takes the data root as `home`.
- Produces:
```ts
export const AgentProfileSchema: z.ZodType<AgentProfile>;
export type AgentRole = "boss" | "manager" | "worker";
export interface AgentProfile { id: string; name: string; role: AgentRole; persona: string; model: string; version: number; createdAt: string; updatedAt: string }
export type AgentInput = Pick<AgentProfile, "id" | "name" | "role" | "persona" | "model">;
export class AgentStore {
  constructor(home: string, now?: () => Date);
  create(input: AgentInput): AgentProfile;                                   // throws if id exists
  update(id: string, patch: Partial<Omit<AgentInput, "id">>): AgentProfile;  // throws if missing
  get(id: string): AgentProfile | undefined;
  list(): AgentProfile[];                                                    // sorted by id
  versions(id: string): AgentProfile[];                                      // sorted by version
  getVersion(id: string, version: number): AgentProfile | undefined;
}
export function buildSystemPrompt(profile: AgentProfile, project: { id: string; allowedTools: string[] }): string;
```
- Validation per the spec's "Agent profiles" section: id `^[a-z0-9-]{1,32}$`, persona 1 to 8000 chars, role enum.
- Version rule: a change to `persona`, `model` or `role` bumps `version` and writes `versions/<version>.json`. `create` writes `versions/1.json`. A name-only change updates `agent.json` and `updatedAt` only. Writes go through write-temp-then-rename. Adapt from AX Studio `src/core/agents/definitions.ts` (`AgentStore`, `writeJsonAtomic`, `safeId`), with the source header.
- `create` also makes the empty `memory/` folder.
- `buildSystemPrompt` returns `persona + "\n\n" + rules`, where rules are 3 lines: `Project: <id>.`, `You may only write files inside the project sandbox.`, `Tools you may use: <comma list>.`

- [ ] **Step 1: Write failing tests:** `create writes agent.json, versions/1.json and memory/`, `create rejects an existing id`, `create rejects id "Bad_Id"`, `create rejects empty persona`, `persona edit bumps to version 2 and keeps version 1` (`getVersion(id, 1).persona` is the old text), `model edit bumps version`, `name-only edit keeps version 1`, `list is sorted by id`, `get returns undefined for a missing id`, `buildSystemPrompt starts with the persona and lists tools`.
- [ ] **Step 2: Run** `npx vitest run packages/org/test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `zod` to `packages/org`.
- [ ] **Step 4: Run.** Expected: 10 passed.
- [ ] **Step 5: Commit** `feat(org): versioned agent profiles with personas`.

### Task 14: CLI

**Files:**
- Create: `packages/cli/src/secrets.ts`, `approver.ts`, `wire.ts`, `main.ts`
- Test: `packages/cli/test/secrets.test.ts`, `packages/cli/test/approver.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: everything exported by core and safety.
- Produces:
```ts
// secrets.ts
export function readSecrets(home: string): Record<string, string>;          // {} when the file is missing
export function setSecret(home: string, provider: string, key: string): void; // writes then restrictToOwner
export function restrictToOwner(file: string): void; // win32: icacls "<file>" /inheritance:r /grant:r "<USERNAME>:F"; else chmod 600
// approver.ts
export class TerminalApprover implements Approver { constructor(io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) }
// prints tool, args (JSON, 2-space indent), tier, estimated cost; reads one line; "y" or "yes" approves, anything else denies
// wire.ts
export function providerFor(model: string, secrets: Record<string, string>, global: GlobalConfig): { provider: Provider; model: string };
export function buildProgram(deps?: { home?: string; io?: {...}; providerOverride?: Provider }): Command; // commander program
// main.ts: buildProgram().parseAsync(process.argv)
```
- Commands and behavior exactly as the spec's "CLI" table, including `agent create|edit|list|show`, `grant`, `revoke`, and `run --agent`. `run` loads the profile with `AgentStore.get`, exits 1 with `No agent <id>. Run: agentcity agent create <id> ...` when missing, uses `--model` or the profile model, and passes `buildSystemPrompt(profile, config)`, `agentName` and `agentVersion` to `runAgent`. The approval prompt line starts with the agent name. `run` prints each event as one line `[HH:MM:SS] <type> <short detail>`. `run` with a missing `anthropic` secret and a non-lmstudio model exits 1 with `No Anthropic key. Run: agentcity secrets set anthropic`. A `ProviderUnreachableError` prints `Cannot reach LM Studio at <url>. Is it running?`.
- `run` registers `SIGINT`: abort the run's `AbortController`, call `approvals.denyAllPending()`, append `run.stopped` with reason `interrupted` if the loop has not, close the db, exit 130.
- `secrets set` reads the key with echo off (readline with a muted output stream).

- [ ] **Step 1: Write failing tests:**
  - `secrets.test.ts`: `missing file gives {}`, `set then read round-trips`, `restrictToOwner on win32 calls icacls with /inheritance:r` (inject an exec spy).
  - `approver.test.ts`: `y approves`, `n denies`, `empty line denies`, `prints tool name and tier`.
  - `cli.test.ts` (temp home, `providerOverride` = `FakeProvider`, `io` with a `PassThrough` input):
    - `init creates project.json, sandbox and outbox`
    - `agent create then show prints the persona and version 1`
    - `agent edit --persona bumps to version 2`
    - `grant adds the agent to project agents, revoke removes it`
    - `run with an ungranted agent stops with agent_not_allowed`
    - `run sends the persona as the start of the system prompt` (inspect `FakeProvider.requests[0].messages[0]`)
    - `run with a missing agent exits 1 with the hint`
    - (every `run` test below first creates agent `ada` and grants it to the project)
    - `run executes read, write, send with approval y` (script: read_file, write_file, send_message, then done; input `y\n`; expect outbox has 1 file, exit code 0)
    - `run with approval n leaves outbox empty`
    - `kill then run stops with killed` and `unkill restores`
    - `log prints every action type of a run` (`run.started`, `gate.decision`, `tool.result`, `run.stopped`)
    - `run without anthropic key exits 1 with the hint`
    - `interrupt during approval denies pending and logs interrupted` (send the abort through the exported handler, not a real signal)
- [ ] **Step 2: Run** `npx vitest run packages/cli/test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `commander` to `packages/cli`.
- [ ] **Step 4: Run.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(cli): agentcity init, agent, grant, run, log, kill, unkill, secrets`.

### Task 15: Live tests and done check

**Files:**
- Create: `packages/cli/test/live.live.test.ts`
- Create: `README.md` (setup: `npm run setup`, `agentcity secrets set anthropic`, LM Studio server on port 1234, creating and granting an agent, every command)

**Interfaces:**
- Consumes: `buildProgram` from Task 14.

- [ ] **Step 1: Write live tests**, both inside `describe.skipIf(process.env.AGENTCITY_LIVE !== "1")`:
  - Setup: create agent `ada` with persona `You are Ada, a careful assistant.` and grant it to the test project.
  - `lmstudio run reads, writes and waits for approval`: model from `AGENTCITY_LMSTUDIO_MODEL`; goal `Read notes.txt, write a one-line summary to summary.txt, then send it to test@example.com with send_message.`; input `n\n`; expect `summary.txt` exists, outbox empty, log has a `gate.decision` with rule `user_approval`.
  - `anthropic run completes one tool call`: model `claude-haiku-5-5`, key from `readSecrets(agentCityHome())`, goal `Read notes.txt and reply with its first word.`; expect reason `done`.
- [ ] **Step 2: Run** `npm run build && npm run typecheck && npm run lint && npm test`. Expected: all pass, live tests skipped.
- [ ] **Step 3: Run live** with LM Studio up: `AGENTCITY_LIVE=1 AGENTCITY_LMSTUDIO_MODEL=<loaded model> npx vitest run packages/cli/test/live.live.test.ts`. Expected: 2 passed. Paste the output into the task report.
- [ ] **Step 4: Manual check:** `agentcity init demo`, `agentcity agent create ada --name Ada --role worker --model lmstudio/<model> --persona "You are Ada, a careful assistant."`, `agentcity grant demo ada`, put `notes.txt` in the sandbox, `agentcity run demo --agent ada "<goal from step 1>"`, answer `n`, then `agentcity log demo`. Expected: the log lists every step.
- [ ] **Step 5: Commit** `test: live provider runs and README`.
