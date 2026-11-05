# Model Providers Design

Date: 2026-11-01. Part 3 of Agent City: per-agent model choice across 4 sources.

## Goal

Each agent runs on one model the user picks. The user picks it in the city on the agent card, or with `agent create` and `agent edit`. Four sources exist:

| Source | Model id form | Example | Billing |
|---|---|---|---|
| Claude subscription | `claude-sub/<alias>` | `claude-sub/sonnet` | The user's plan limits, 0 USD in the budget |
| LM Studio | `lmstudio/<id>` | `lmstudio/qwen/qwen3-14b` | 0 USD |
| OpenAI-compatible URL | `api/<connection>/<model>` | `api/groq/llama-3.3-70b` | Price from config, required |
| Anthropic API | bare Claude id | `claude-haiku-5-5` | `prices` in config.json |

LM Studio and the Anthropic API work today and keep their behavior.

## What the user said

- Subscription and API use both matter now.
- External APIs: any OpenAI-compatible URL. One connection type covers OpenAI, Groq, Together, Ollama and similar.
- Picker: a dropdown on the agent card. Saving makes a new agent version.
- Subscription approach A: one `claude -p` call per agent step. The city's loop, gate, log and approvals stay the single path.

## Subscription terms

Anthropic does not let third-party apps offer claude.ai login or route other users' traffic through a plan. An end user may sign in to the unmodified Claude Code binary with their own plan. `claude -p` draws from that plan's limits.

Rules that follow from this:

1. The city spawns the user's own installed `claude` binary on the user's own machine. It never reads, stores or forwards claude.ai credentials or session tokens.
2. The child process gets the parent environment minus `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, so the binary uses the user's own login.
3. README states the feature is for the user's own plan on their own machine, links the Anthropic terms, and says Anthropic may change them.
4. The subscription provider is off until the user runs `claude` once and logs in. A missing binary or a logged-out binary gives a clear error (below).

## Architecture

`providerFor(model, secrets, global)` in `packages/cli/src/shared.ts` already routes by prefix. It gains two branches. Order: `claude-sub/`, `lmstudio/`, `api/`, then the Anthropic API.

### Subscription provider (`packages/core/src/providers/claude-cli.ts`)

`ClaudeCliProvider implements Provider`. `chat(req)`:

1. Renders `req.messages` and `req.tools` into one prompt text. The system message becomes `--system-prompt`. Tool specs are listed with name, description and JSON schema. The prompt tells the model to call a tool by writing `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` and to write plain text when done. Earlier tool calls and results appear in the transcript in that same form.
2. Spawns `claude -p --output-format json --model <alias> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --system-prompt <text>` and writes the prompt on stdin. Built-in tools, MCP servers, hooks and settings from the user's own Claude Code setup are all off. The working directory is a fresh empty temp directory, deleted after the call.
3. Reads the JSON result. `result` is the reply text. `usage.input_tokens` plus cache-read and cache-creation tokens become `inputTokens`, `usage.output_tokens` becomes `outputTokens`.
4. Runs `parseTextToolCalls(text, toolNames)` from `core/src/llm/text-tool-calls.ts` and returns `{ text: rest, toolCalls: calls, usage }`.

Flags are checked against the installed `claude --help` in the first plan task. A flag the installed version lacks gets the nearest equivalent, recorded in the plan ledger. Built-in tools off is required: without a way to turn them off, the provider refuses to run.

Process rules:

- Binary path: `claudePath` in `config.json`, default `claude`. On Windows the spawn resolves `claude.cmd` when `claude` has no extension, without `shell: true`.
- Timeout: 180 s per call. On timeout the child is killed and the call throws an Error "claude did not answer in 180 s".
- The run's abort signal kills the child.
- `ENOENT`: "claude command not found. Install it with npm i -g @anthropic-ai/claude-code, then run claude once to log in."
- Exit code not 0, or `is_error: true` in the JSON: the error text from the JSON or the first 300 chars of stderr. A login failure reads "claude is not logged in. Run claude once in a terminal to log in."
- Aliases allowed: `sonnet`, `opus`, `haiku`, or a full `claude-*` id. Anything else is rejected at `agent create/edit` time.

### OpenAI-compatible connections

`config.json` gains:

```json
"connections": [
  { "name": "groq", "baseUrl": "https://api.groq.com/openai/v1", "price": { "inputPerMTok": 0.59, "outputPerMTok": 0.79 } }
]
```

- `name`: `^[a-z0-9-]{1,24}$`. Unique.
- `baseUrl`: `http:` or `https:` only.
- `price`: optional. Applies to every model on that connection. A connection with no price has no known price, so the gate stops the run with `unknown_model_price` as it does today. A full-id entry in `prices` (`api/groq/llama-3.3-70b`) overrides the connection price.
- Key: `agentcity secrets set api-<name>`, from a normal terminal only (the city terminal refuses `secrets`). A connection with no key sends no `Authorization` header, for Ollama and similar.
- `providerFor` builds `OpenAICompatProvider({ baseUrl, apiKey })` and strips `api/<name>/` on the wire.

CLI commands, allowed in the city terminal:

- `agentcity connection add <name> <baseUrl> [--input-price <usd>] [--output-price <usd>]`. Both prices or neither.
- `agentcity connection list`. Prints name, URL, price, and `key set` or `no key`. Never the key.
- `agentcity connection remove <name>`.

### Pricing and allowlist (`packages/safety`)

- `priceFor`: `claude-sub/*` and `lmstudio/*` cost 0. `api/<name>/<model>`: the full-id entry in `prices`, else the connection price, else undefined.
- `priceFor` gains the connections list through `GlobalConfig`.
- New projects allow `["claude-haiku-5-5", "lmstudio/*", "claude-sub/*", "api/*"]`. Existing `project.json` files keep their list. README tells the user to add the two patterns to old projects.
- Subscription tokens still count toward `budget.maxTokens`.

### Model id validation (`packages/org`)

`parseModelId(id)` returns `{ source: "sub" | "lmstudio" | "api" | "anthropic", ... }` or an error. `agent create` and `agent edit` reject ids that parse to an error. `api/<name>/...` with no such connection is an error at create/edit time.

### City picker

Protocol, `packages/world/src/shared/protocol.ts`:

- Client to server: `{ type: "models.list" }` and `{ type: "agent.model", agentId, model }`.
- Server to client: `{ type: "models", groups: [{ label, models: string[], error?: string }] }`, and `{ type: "agent.saved", agentId, version }`.
- `AgentView` gains `model: string`.

Server, `packages/cli/src/city-server.ts`:

- `models.list` builds 3+ groups. "Claude subscription": `claude-sub/sonnet`, `claude-sub/opus`, `claude-sub/haiku`. "LM Studio": GET `<lmStudioBaseUrl>/models`. One group per connection: GET `<baseUrl>/models` with its key. Anthropic API: the bare ids in `prices`. Each fetch times out at 3 s. A failed fetch gives the group an `error` text and an empty list.
- `agent.model` validates with `parseModelId`, then `AgentStore.update(id, { model })`. A running agent keeps its model until its next run. Errors come back as the existing `error` message.

Client, `packages/client/src/ui/agent-card.ts`:

- The card shows a `model` row with a `<select>` grouped by `<optgroup>`. The current model is selected, even when absent from the lists.
- Opening the card sends `models.list` once per open. A group with an error shows one disabled option with the error text.
- A free-text option "other..." shows an input for any id, for an API model the list does not return.
- Save button sends `agent.model`. The card shows "saved v<N>" on `agent.saved`.

## Error handling

- Every provider error ends the run with `provider_error` and the message in the log, as today.
- The city terminal and HQ show the message through the existing `error` and `term.out` paths.
- Keys never appear in `connection list`, the models list, the log, or the client. The log redacts every value in the secrets file today, so `api-*` keys are redacted with no change.

## Testing

- `ClaudeCliProvider`: a fake `claude` script (Node, path set through `claudePath`) prints canned JSON. Tests cover: tool call parsed, plain text answer, usage mapped, `is_error`, non-zero exit, ENOENT, timeout kill, abort kill, env lacks `ANTHROPIC_API_KEY`, cwd is an empty temp dir and gets deleted.
- Prompt rendering: unit tests for a transcript with a tool call and a tool result.
- `providerFor`: one test per source, plus unknown connection.
- `priceFor`: sub 0, connection price, full-id override, no price.
- Connections config: schema, duplicate name, bad URL, add/list/remove, no key printed.
- `parseModelId`: valid and invalid forms of each source.
- City: `models.list` with a stubbed fetch (one group failing), `agent.model` saves a new version, bad id returns `error`.
- Client: card renders groups, keeps an unlisted current model, sends `agent.model`.
- Live check: one run on `claude-sub/haiku` after the user installs and logs in to `claude`, and one on an `api/` connection if the user has a key. Both are manual and optional.

## Out of scope

- Ollama as its own source (it works as an `api/` connection).
- MCP servers and per-project MCP grants.
- Streaming replies.
- Showing subscription limits or remaining usage.
