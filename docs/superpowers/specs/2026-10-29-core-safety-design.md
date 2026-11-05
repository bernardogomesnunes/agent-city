# Agent City part 1: Core + Safety design

Date: 2026-10-29. Source brief: `AGENT-CITY-BRIEF.md`.

## Goal

One agent runs one goal against a real model and uses 3 tools. Every tool call and model call passes a safety gate enforced in code. Parts 2 to 6 (org, world, avatar, more providers and MCP, paper trading) build on this.

## Decisions

| Topic | Decision |
|---|---|
| Language | TypeScript on Node 22 or newer, so AX Studio code (MIT, same author) copies over. |
| Layout | npm workspaces: `@agentcity/core`, `@agentcity/safety`, `@agentcity/org`, `@agentcity/cli`. |
| Agent identity | Each agent has a stored profile with name, role, persona and model, versioned on change. The persona starts every run's system prompt. Profiles work the same for every provider. |
| First backends | LM Studio (OpenAI-compatible HTTP) and the Anthropic API. |
| Interface | Terminal CLI with y/n approval prompts. |
| Approval default | Every Tier 2 and Tier 3 action waits for the user. Auto-approve under a limit is opt-in per project, Tier 3 only. |
| Storage | SQLite via `better-sqlite3` plus plain files under `~/.agentcity`. |
| Deferred | MCP client (part 5), Claude subscription backend (part 5, after a terms check), Ollama (part 5), hosted OpenAI (part 5). |

## Packages

```
packages/
  core/     providers, agent loop, tool types, events
  safety/   project config, gate, budget, approvals, action log, secrets redaction
  org/      agent profiles and versions (part 2 adds roles and delegation here)
  cli/      `agentcity` command; wires core, safety and org
```

- Import direction: `cli` imports `org`, `safety` and `core`. `org` and `safety` import `core` only. `core` imports none of them.
- An eslint `no-restricted-imports` rule in `packages/core` blocks imports of `@agentcity/safety` and `@agentcity/cli`.
- Build: TypeScript project references, `tsc -b` from the root. Tests: one root vitest config.

## Core

### Provider

```ts
interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolSpec[];   // name, description, JSON schema
  maxTokens: number;
}
interface ChatResponse {
  message: AssistantMessage;   // text content
  toolCalls: ToolCall[];       // { id, name, args }
  usage: { inputTokens: number; outputTokens: number };
}
interface Provider {
  id: string;                  // "anthropic" | "lmstudio" | "fake"
  chat(req: ChatRequest): Promise<ChatResponse>;
}
```

- `AnthropicProvider` uses `@anthropic-ai/sdk` with native tool use. Default model `claude-haiku-5-5`.
- `OpenAICompatProvider` uses `fetch` against a base URL (default `http://localhost:1234/v1` for LM Studio). It reads native `tool_calls`. When a response has none, a text tool-call parser copied from AX Studio scans the text.
- `FakeProvider` returns scripted responses in order. Tests use it.
- Price table: `{ [model]: { inputPerMTok, outputPerMTok } }` in the global config. Local models default to 0. An unknown hosted model is denied by the gate (fails closed).

### Tools

```ts
interface Tool<A> {
  name: string;
  description: string;
  tier: 0 | 1 | 2 | 3;
  schema: z.ZodType<A>;
  estimateUsd?(args: A): number;   // required for tier 3
  run(args: A, ctx: ToolContext): Promise<string>;
}
interface ToolContext { projectId: string; agentId: string; sandboxDir: string; outboxDir: string }
```

Part 1 tools:

- `read_file` (tier 0): reads a file inside `sandboxDir`.
- `write_file` (tier 1): writes a file inside `sandboxDir`. It resolves the real path and rejects any path outside the sandbox, including `..` and symlinks.
- `send_message` (tier 2): writes `{ to, body }` as a JSON file into `outboxDir`. No network.

Arguments that fail the zod schema return an error result to the model. The tool does not run.

### Agent loop

```ts
runAgent({ provider, model, tools, gate, events, goal, systemPrompt, maxSteps = 20, contextWindow })
```

`gate` is required and has no default. Each step:

1. Trim messages to `contextWindow` with the context trimming code copied from AX Studio.
2. `gate.checkModelCall({ model, estimatedInputTokens })`. On deny, stop with reason.
3. `provider.chat(...)`. On error, retry 2 times with 1 s and 4 s waits, then stop with reason `provider_error`.
4. `gate.recordUsage(usage)`.
5. No tool calls: stop with reason `done`.
6. For each tool call: `gate.checkTool(call)` returns `allow`, `deny(reason)` or `stop(reason)`. Approval waits happen inside `checkTool`. On `allow`, run the tool. On `deny`, return `denied: <reason>` as the tool result. On `stop`, end the run.
7. A tool that throws returns `error: <message>` as its result. The run continues.

The loop stops after `maxSteps` with reason `max_steps`. It returns `{ reason, steps, usage }`.

### Events

`core` emits typed events through an `EventSink` passed into `runAgent`: `run.started`, `model.call`, `model.result`, `tool.requested`, `tool.result`, `run.stopped`. Each event has `ts`, `projectId`, `agentId`. Safety writes them to the action log. Part 3 reads the same events for the city.

## Agent profiles (`org`)

Stored at `~/.agentcity/agents/<id>/agent.json` and validated with zod:

```json
{
  "id": "ada",
  "name": "Ada",
  "role": "worker",
  "persona": "You are Ada, a careful researcher. You cite sources and say when you are unsure.",
  "model": "lmstudio/qwen3-8b",
  "version": 1,
  "createdAt": "2026-10-29T12:00:00.000Z",
  "updatedAt": "2026-10-29T12:00:00.000Z"
}
```

- `id`: lowercase letters, digits and `-`, 1 to 32 chars. `role`: `boss`, `manager` or `worker`. `persona`: 1 to 8000 chars.
- Saving a profile whose `persona`, `model` or `role` changed bumps `version` and writes a snapshot to `agents/<id>/versions/<version>.json`. The first save writes version 1. Adapted from AX Studio `src/core/agents/definitions.ts` (`AgentStore`).
- `agents/<id>/memory/` is created empty. Part 2 decides how memory works.
- The run's system prompt is `persona`, a blank line, then the project rules: project id, sandbox rule, and the list of allowed tools.
- The action log, events and per-agent budget use the profile `id`. A `run.started` event also carries `agentName` and `agentVersion`.

## Safety

### Project config

Stored at `~/.agentcity/projects/<id>/project.json` and validated with zod:

```json
{
  "id": "demo",
  "agents": ["ada"],
  "allowedTools": ["read_file", "write_file", "send_message"],
  "allowedModels": ["claude-haiku-5-5", "lmstudio/*"],
  "budget": { "maxTokens": 200000, "maxUsd": 1.0 },
  "perAgent": { "maxUsd": 0.5 },
  "autoApprove": { "enabled": false, "maxUsdPerAction": 0, "maxUsdPerDay": 0 },
  "killSwitch": false
}
```

- `sandboxDir` and `outboxDir` are fixed at `projects/<id>/sandbox` and `projects/<id>/outbox`.
- `allowedModels` entries match exactly or by a `provider/*` prefix.
- A missing file or a schema error makes every check return `stop("config_invalid")`.
- The config is read again before every check, so `agentcity kill` takes effect at the next step.

### Gate

`checkTool(call)` runs these checks in order. The first failure decides.

1. Kill switch on: `stop("killed")`.
2. Agent not in `agents`: `stop("agent_not_allowed")`. Tool not in `allowedTools`: `deny("tool_not_allowed")`.
3. Project tokens or dollars at or over cap, or agent dollars at or over `perAgent.maxUsd`: `stop("budget")`.
4. Tier rule:
   - Tier 0 and 1: `allow`.
   - Tier 2: queue an approval and wait.
   - Tier 3: auto-approve only when `autoApprove.enabled`, `estimateUsd(args) <= maxUsdPerAction`, and today's auto-approved total plus this amount `<= maxUsdPerDay`. Otherwise queue an approval and wait. A tier 3 tool without `estimateUsd` is denied.
5. Write the decision to the action log with the rule that decided it.

`checkModelCall` runs check 1, the agent part of check 2, check 3, the model allowlist and the price table lookup.

### Budget

The `usage` table holds running totals per project and per agent: tokens and dollars. `recordUsage` adds `inputTokens * inputPerMTok / 1e6 + outputTokens * outputPerMTok / 1e6`. A run can overshoot its cap by at most one model call. The next check stops it.

### Approval queue

The `approvals` table holds `id, ts, projectId, agentId, tool, argsJson, tier, estimatedUsd, status (pending|approved|denied), decidedAt, decidedBy`. The gate inserts a `pending` row and waits on an `Approver` interface:

```ts
interface Approver { decide(req: ApprovalRequest): Promise<"approved" | "denied"> }
```

The CLI provides a terminal approver. Tests provide a scripted one. On process exit, rows still `pending` become `denied` with `decidedBy = "shutdown"`.

### Action log

The `actions` table holds `id, ts, projectId, agentId, type, payloadJson, usd`. SQLite triggers raise an error on `UPDATE` and `DELETE`, so rows can only be added. Every event, gate decision, approval and usage record goes here.

### Secrets

- `~/.agentcity/secrets.json` holds provider keys. On Windows the CLI sets the file ACL to the current user only via `icacls`. On other systems it sets mode `600`.
- Only `cli` reads the file. It passes each key to its provider constructor. Keys never enter messages, tool context or events.
- The action log writer replaces any known secret value in payloads with `[secret]`.

## CLI

| Command | Effect |
|---|---|
| `agentcity init <project>` | Creates the project folder and a default config (`agents` empty, `autoApprove` off, `maxUsd` 1.0). |
| `agentcity agent create <id> --name <name> --role <role> --model <model> --persona <text> \| --persona-file <path>` | Creates a profile at version 1. |
| `agentcity agent edit <id> [--name] [--role] [--model] [--persona \| --persona-file]` | Saves changes; bumps version when persona, model or role changed. |
| `agentcity agent list` / `agent show <id> [--version <n>]` | Lists profiles; shows one profile or one old version. |
| `agentcity grant <project> <agent>` / `revoke <project> <agent>` | Adds or removes the agent in the project's `agents` list. |
| `agentcity run <project> --agent <id> "<goal>" [--model <id>]` | Runs that agent with its persona. `--model` overrides the profile model for this run. Prints events as they happen. Tier 2 and 3 calls print agent name, tool, args, tier and cost, then wait for `y` or `n`. |
| `agentcity log <project> [--tail]` | Prints the action log. `--tail` follows new rows. |
| `agentcity kill <project>` / `unkill <project>` | Sets `killSwitch` true or false. |
| `agentcity secrets set <provider>` | Reads a key with hidden input and stores it. |

`--model lmstudio/<name>` selects LM Studio. Any other model id selects Anthropic.

## Data folder

```
~/.agentcity/
  config.json         price table, LM Studio base URL
  agentcity.db        actions, approvals, usage
  secrets.json        owner-only
  agents/<id>/
    agent.json
    versions/<n>.json
    memory/
  projects/<id>/
    project.json
    sandbox/
    outbox/
```

`AGENTCITY_HOME` overrides the root path. Tests set it to a temp folder.

## Testing

- Unit tests use `FakeProvider` and a temp `AGENTCITY_HOME`. No network, no tokens.
- Gate: one test per check, the order of checks, tier 3 auto-approve inside and outside limits, and `config_invalid` stops everything.
- Action log: `UPDATE` and `DELETE` both throw.
- Sandbox: `..`, absolute paths and symlinks out of the sandbox are rejected.
- Secrets: a key value inside a payload is logged as `[secret]`.
- Profiles: create writes version 1; a persona edit writes version 2 and keeps version 1; a name-only edit keeps the version; invalid ids are rejected; the system prompt starts with the persona.
- Gate: an agent missing from the project's `agents` list is stopped.
- Loop: stops on `done`, `max_steps`, `budget`, `killed` and `provider_error`.
- End to end: a scripted run reads a file, writes a file, calls `send_message`, and gets approved by a scripted approver. The outbox file exists and the log holds all steps.
- Live tests run only with `AGENTCITY_LIVE=1`: one LM Studio run and one Anthropic run.

## Done when

1. `npm test`, `npm run typecheck` and `npm run lint` pass.
2. A live LM Studio run reads a file, writes to the sandbox, and stops on `send_message` for approval.
3. `agentcity log` shows every step of that run.

## Code copied from AX Studio

From `C:\Users\berna\Documents\GitHub\git-gui-for-designers` (MIT): the text tool-call parser, the context trimming code, and agent versioning (`AgentStore`). The MCP client waits for part 5. Each copied file keeps a header comment naming its source path.

## Out of scope for part 1

Boss, Manager and Worker behavior (the `role` field is stored only). Agent memory. The city and avatar. MCP servers. Tier 3 tools (the gate logic for tier 3 is built and tested). Live money. Ollama and the Claude subscription backend.
