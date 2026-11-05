# Agent City part 2: Org (delegation and memory) design

Date: 2026-10-31. Source brief: `AGENT-CITY-BRIEF.md`, build order step 3. Builds on part 1 (`2026-10-29-core-safety-design.md`).

## Goal

A Boss agent hands a task to a Manager, the Manager hands part of it to a Worker, and the Worker's answer flows back up. Every handoff passes the safety gate. Each agent keeps a notes file that starts its next run.

## Decisions

| Topic | Decision |
|---|---|
| Who creates agents | The user only, with `agentcity agent create`. Agents delegate only to agents that exist and are granted to the project. |
| Delegation style | Synchronous. `delegate` runs the child to the end and returns its final answer as the tool result. Children run one at a time. |
| Delegation shape | `delegate` is an ordinary tool in the agent loop. No separate planner or scheduler. |
| Role rules | Boss may delegate to manager or worker. Manager may delegate to worker. Worker may not delegate. |
| Limits | One shared cost total per delegation tree, plus depth and run-count limits per project. Part 1 limits (project budget, per-agent cap) still apply. |
| Memory | One `memory/notes.md` per agent. A tier 1 `remember` tool appends a line. The last 4000 chars go into the system prompt. Only that agent and the user edit it. |
| Deferred | Terminal chat with saved history and the in-city chat window (part 5). Integrated terminal panel in the city UI (part 4). Parallel children and async delegation (later). Agents hiring agents (later, via approval queue). |

## Packages

Import direction is unchanged: `cli` imports `org`, `safety`, `core`. `org` and `safety` import `core` only.

- `core`: run ids, parent run ids and the final answer on runs and events.
- `safety`: `RunTree` (shared limits), new `delegation` config, gate checks for `delegate`, new log columns.
- `org`: role rules, `delegate` and `remember` tools, memory store, prompt with team list and notes.
- `cli`: wires child runs, new commands, `log --tree`.

## Core changes

- `RunAgentOptions` gains `runId: string` and `parentRunId?: string`. `runId` is a random 12-char id made by the caller.
- Event `Base` gains `runId` and `parentRunId?`.
- `RunResult` gains `answer: string`: the last assistant text of the run, empty if none.
- `ToolContext` gains `runId: string` and `depth: number` (0 for the top run).
- `AbortSignal` passed to a run is passed on to its children, so Ctrl+C stops the whole tree.

## Safety changes

### Project config

New field, with defaults filled in when an older `project.json` lacks it:

```ts
delegation: { maxDepth: number; maxTreeUsd: number; maxChildRuns: number }
// defaults: { maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 }
```

### RunTree

```ts
export class RunTree {
  constructor(limits: { maxDepth: number; maxTreeUsd: number; maxChildRuns: number });
  addUsd(usd: number): void;
  readonly usd: number;
  readonly childRuns: number;
  overBudget(): boolean;                     // usd >= maxTreeUsd, same style as part 1 budget checks
  reserveChild(depth: number): { ok: true } | { ok: false; reason: "depth_limit" | "child_run_limit" };
}
```

One `RunTree` is made per top run and shared by every gate in the tree. It lives in memory only; the log keeps the record.

### Gate

`GateDeps` gains `tree: RunTree`, `depth: number` and `roleOf: (agentId: string) => "boss" | "manager" | "worker" | undefined`. The cli injects `roleOf` from `AgentStore`, so safety does not import org.

- `checkModelCall` and `checkTool`: after the existing budget check, `tree.overBudget()` true gives `stop("tree_budget")`. `recordUsage` also calls `tree.addUsd`.
- `GateDeps` also gains `runId` and `parentRunId?`; every row the gate writes carries them.
- `checkTool` for tool `delegate`, in this order, each failure a `deny`:
  1. target id not in `config.agents`: `target_not_granted`.
  2. `roleOf(target)` undefined: `target_missing`.
  3. role rule fails (caller role to target role): `role_not_allowed`.
  4. target equals caller: `self_delegation`.
  5. `tree.reserveChild(depth + 1)` fails: its reason.
- New rule names in the log: `tree_budget`, `delegation`.
- A deny returns to the parent as a normal tool result; the parent continues.

### Action log

`actions` gains `run_id TEXT` and `parent_run_id TEXT`, both nullable, added by `ALTER TABLE` when missing. Old rows keep null. Every row written by a run carries its ids.

## Org changes

### Role rules

```ts
export function canDelegate(from: AgentRole, to: AgentRole): boolean;
// boss -> manager | worker; manager -> worker; worker -> none
```

### delegate tool (tier 1)

- Args: `{ agent: string; task: string }`, task 1 to 4000 chars.
- Built by `makeDelegateTool(startChild)` where `startChild(agentId, task, parentCtx): Promise<RunResult>` is injected by cli.
- Result text: the child's `answer` when `reason` is `done`. Otherwise `child stopped: <reason>` followed by the partial answer if any.
- Offered only to agents whose role may delegate. Workers never see it.

### remember tool (tier 1)

- Args: `{ note: string }`, 1 to 500 chars, newlines replaced by spaces.
- Appends `- <ISO date> <note>` to `agents/<id>/memory/notes.md`. Writes only the calling agent's file.
- Redacts secrets before writing, like the log.

### Memory store

```ts
export class MemoryStore {
  constructor(home: string);
  read(agentId: string): string;          // whole file, "" if missing
  tail(agentId: string, maxChars: number): string;  // last maxChars, cut at a line start
  append(agentId: string, line: string): void;
  clear(agentId: string): void;
}
```

### System prompt

`buildSystemPrompt` becomes persona, then the part 1 rules, then two optional blocks:
- `Team you may delegate to:` one line per allowed target: `<id> (<role>): <first 100 chars of persona>`. Only granted agents the role rule allows.
- `Your notes:` the last 4000 chars of the notes file. Omitted when empty.

## CLI changes

| Command | Behavior |
|---|---|
| `run <project> --agent <id> "<goal>"` | Same as part 1. Makes a `RunTree` and the top `runId`. Delegate and remember tools join the tool list when allowed. |
| `agent memory <id>` | Prints the notes file. |
| `agent memory <id> --clear` | Empties the notes file after a y/n prompt. |
| `log <project> --tree` | Groups rows by `run_id`, indents each run under its parent, 2 spaces per level. |
| `init` | Also enables `delegate` and `remember` in `allowedTools`. |

- `startChild` loads the child profile, builds its prompt and gate (same tree, depth + 1), and calls `runAgent` with the parent's signal.
- Exit codes are unchanged: the top run decides them.
- The approval prompt line already starts with the agent name, so child approvals show who asks.

## Fixes carried from part 1

- `provider_error` keeps the cause message (redacted) in the stop event and log.
- Approval args are redacted before they are stored.
- Ids reject Windows reserved names: `con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`.

## Testing

All with `FakeProvider` scripts and a temp `AGENTCITY_HOME`:
- Boss to manager to worker: worker answer reaches the boss as tool result text.
- Worker never gets the `delegate` tool; a scripted worker call to it is denied as unknown tool.
- Manager to boss is denied `role_not_allowed`. Delegating to self is denied `self_delegation`.
- Ungranted target is denied `target_not_granted`. Unknown target is denied `target_missing`.
- Depth 4 is denied `depth_limit`. Child run 11 is denied `child_run_limit`.
- Tree total above `maxTreeUsd` stops the run with `tree_budget`, in the child that crosses it.
- Child that stops with `provider_error` returns `child stopped: provider_error` to the parent.
- Kill switch set during a child run stops child and parent.
- Abort during a child run stops the whole tree; no tool runs after.
- `remember` appends one line; the prompt holds only the last 4000 chars.
- `log --tree` prints child runs indented under the parent.
- Old `project.json` without `delegation` loads with defaults.
- Old db without `run_id` gets the columns on open.
- Live (LM Studio): `boss` delegates to `mgr`, `mgr` to `ada`, `ada` writes a sandbox file, `log --tree` shows 3 runs.

## Done when

- All tests, typecheck and lint pass.
- The live LM Studio tree run works and its log shows the 3 nested runs.

## Out of scope for part 2

Chat with history, city UI, integrated terminal panel, parallel or async delegation, agents creating agents, MCP, new providers.
