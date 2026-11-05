# Final review: part1-core-safety (767729f..131768d)

Verdict: merge with fixes. 1 Important finding and 1 deferred minor block the merge. Both are small.

Reviewed in one pass: every source and test hunk of the diff except package-lock.json, the spec, plan Global Constraints and Review Focus, and the ledger. `npm test` re-run: 22 files, 171 tests pass, working tree clean on 131768d.

## Strengths

- The tool path fails closed end to end. `runAgent` runs a tool only on `kind === "allow"` (run-agent.ts, after the 6a101ad fix). Any other kind ends the run with `invalid_gate_decision`. Unknown tools and invalid args never reach `tool.run`.
- `gate` is a required option with no default anywhere. `core` has no import path to `safety`, and eslint enforces it.
- The gate re-reads project.json on every check. A missing or invalid file stops with `config_invalid`. An unpriced hosted model stops with `unknown_model_price`.
- A tier 2 tool always waits for the approver, including with autoApprove on. Closed stdin and an approver error both give `denied`.
- The shutdown guard in `ApprovalQueue.request` updates only rows still `pending`, so a late answer cannot overwrite a `shutdown` denial.
- Secrets: keys live in `#private` fields. Server error bodies are scrubbed. The action log and stdout events pass through `redact`. `setSecret` writes a temp file, restricts it, then renames it.
- Windows ACL, checked live in this review: `setSecret` on a scratch folder left exactly one ACE, `PC_BERNARDO\berna:(F)`. This closes the Task 14 unverified item.
- Review Focus 1, checked live on Node 24.15 / Windows: a refused `fetch` to `localhost:59999` has `cause.code === "ECONNREFUSED"` (AggregateError from happy eyeballs). The friendly LM Studio message therefore fires on this machine.
- Review Focus 2, 3 and 4 have tests: malformed args (run-agent.test), the 100000-character cut (tools.test), and the win32 case, other-drive and UNC checks (sandbox.test, `runIf(win32)`).

## Issues

### Critical

None.

### Important

1. Ctrl+C does not stop the remaining tool calls of the current model turn.
   - Files: packages/core/src/agent/run-agent.ts, the `for (const call of calls)` loop. packages/cli/src/approver.ts `cancel()`. packages/cli/src/wire.ts, the interrupt handler.
   - Problem: `signal.aborted` is checked only at the top of the step loop. `cancel()` answers only the prompts already waiting. Take a model turn with `[send_message, write_file]` or `[send_message, send_message]`, and Ctrl+C at the first prompt:
     - `write_file` (tier 1) still runs after the interrupt.
     - A second `send_message` inserts a new `pending` row after `denyAllPending` ran, then prints a new `Approve?` prompt. A `y` typed within the 2 s grace window approves it, and the outbox file gets written after Ctrl+C.
     - With no answer, `exit(130)` kills the process and leaves that row `pending`. That breaks Review Focus 5 and the spec rule "On process exit, rows still pending become denied".
   - Cause: the interrupt is not latched. Neither the loop, the gate nor the approver checks it again.
   - Fix: in `runAgent`, check `signal?.aborted` before each tool call and `return finish("interrupted")`. Make `TerminalApprover.cancel()` set a flag so later `decide()` calls return `denied` at once. Add a CLI test with a two-call turn (send_message, then write_file): Ctrl+C at the prompt, then assert no out file, an empty outbox and no `pending` rows.
   - Next: one small fix round, then merge.

### Minor

1. `READ_LIMIT` does not keep one read inside the default window. 100000 characters estimate to 33,334 tokens, and the default `contextWindow` is 32000. `trimMessages` cannot drop the newest group, so the request goes out over the window. Anthropic accepts it. A small LM Studio context rejects or truncates it. The Task 4 ruling assumed the cap made this safe. Review Focus 3's stated goal ("one read cannot fill the context window") does not hold at the defaults. Fix in part 2: cut tool results to a share of `contextWindow`, or pass a real window from the model.
2. Approval args are not redacted. `ApprovalQueue.insert` stores `JSON.stringify(req.args)` raw in `approvals.args_json`, and the approver prints the raw args. A key that reaches tool args (for example from a sandbox file) lands in agentcity.db in clear text. The spec names only the action log, so this is a gap and not a violation. Fix: pass the secret list to `ApprovalQueue` and redact before insert.
3. Approvals have no own rows in the action log. The spec says "Every event, gate decision, approval and usage record goes here." The `gate.decision` rows with rule `user_approval` record approve and deny. A `shutdown` denial shows only in the approvals table. Fix: append an `approval` row in `request` and in `denyAllPending`.
4. Pending rows survive any exit other than SIGINT (SIGTERM, a closed terminal, a crash), and no startup sweep exists. Part 1 never reads old pending rows, so the effect is stale data. Fix with Important 1 or in part 2: sweep rows older than the process start in `openDb` callers.
5. The project token cap counts free LM Studio tokens and never resets. Every step resends the whole context. A few local runs can reach 200000 tokens, and after that every run prints `Run stopped: budget`. Nothing names the fix (edit project.json). This follows the spec, so it is a plan issue. Part 2 should add a budget period or a reset command.
6. Provider calls have no timeout. `OpenAICompatProvider` uses `fetch` with no signal, so a hung LM Studio hangs the run until Ctrl+C. The Anthropic SDK retries 2 times by default on top of the loop's 2 retries, which allows up to 9 attempts per step. Fix: pass `AbortSignal.timeout` and the run signal, and set `maxRetries: 0` on the SDK client.
7. A kill during an approval wait does not stop the approved tool. The gate does not re-read the config after the approver returns. Answering `y` after `agentcity kill` runs the tool. The spec says the kill takes effect "at the next step", so this is within the spec. A re-check after `approvals.request` costs one config read.
8. Unknown-tool and invalid-args results skip the gate, so they have no `gate.decision` row. `tool.requested` and `tool.result` rows still record them. Acceptable. Note it for the part 3 city view.

## Deferred minors (ledger triage)

Must fix before merge:

- Task 5: "tests: stop/deny do not assert tool never ran". The 6a101ad Important bug lived in exactly this branch of `runAgent`. No unit test asserts that a `stop` from `checkTool` leaves `tool.run` uncalled. The CLI `n` test covers deny only. Add a run counter to the fake tool in the stop and deny tests. It is 2 assertions on the central safety invariant.

Fine to defer to part 2 (everything else):

- Task 1: all 5 lines (scaffold hygiene).
- Task 2: FakeProvider and MemorySink tests.
- Task 3: the TOCTOU window. Only the agent writes to the sandbox in part 1, and the write re-checks after mkdir. The whole-file read (a huge file throws, which gives an error result), `send_message` without `wx`, ENOTDIR/isWin/"." and the stricter dangling-link rule are also fine to defer.
- Task 4: all 3 lines.
- Task 5: gate throw without `run.stopped` (fails closed), steps count. The dropped provider_error cause can also wait. It is the first thing to fix in part 2, because a bad Anthropic key prints only `Run stopped: provider_error` after 3 attempts.
- Task 6-7: Authorization header test, array args and two user messages in a row. Native Anthropic calls never give array input, and the empty assistant message happens only on the final turn.
- Task 8: all lines. Payloads are plain JSON events.
- Task 9: the >100K price tier is unreachable with a 32000 window. The non-atomic save fails closed. Validation gaps.
- Task 10-11: the late-approval guard is covered indirectly by the CLI interrupt test, which asserts `decided_by = "shutdown"` after `cancel()` answers. The other lines are fine.
- Task 12: the atomicity concern is part 2 (parallel agents). The other lines fail closed or are test depth.
- Task 13: all lines. Reserved Windows names are odd but not unsafe.
- Task 14: the unscoped `denyAllPending` fails closed across two terminals. The other lines are fine. The ACL item is now verified.
- Task 15: all 3 lines. The temp key copy lives in the per-user %TEMP%, and `afterEach` removes it.

## Unverified after this review

- The Anthropic path has never run live. Request mapping is unit-tested against a stubbed client only.
- The `claude-haiku-5-5` price of 0.10 / 0.50 USD per MTok comes from a skill table. Confirm it against Anthropic pricing.
- Done-when 2 and 3 rest on the Task 15 implementer log (23 rows, send_message `user_denied`). Its row list matches what the code emits.

## Declined to judge

- Check order inside `checkModelCall` (allowlist and price before budget, where the spec lists budget first): every branch is a `stop`, so only the reason text differs.
- Hard links and NTFS alternate data streams in the sandbox: the agent cannot create hard links, and an ADS write stays inside the sandbox file.
- Dist freshness: the ACL check used packages/cli/dist. secrets.ts last changed in c6b91e1, before the final commit.

## Assessment

Ready to merge: with fixes (Important 1 and the Task 5 test assertions).

Reasoning: every tool runs only after an explicit allow, secrets stay out of messages and logs, and the 5 Review Focus inputs are met except for Focus 5's mid-turn interrupt case. That case lets a tier 1 tool run, and a tier 2 tool be approved, after Ctrl+C. It can also leave a `pending` row behind.
