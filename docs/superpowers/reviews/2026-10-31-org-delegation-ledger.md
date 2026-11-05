# SDD ledger — plan: docs/superpowers/plans/2026-10-31-org-delegation.md

Spec: docs/superpowers/specs/2026-10-31-org-delegation-design.md. Branch part2-org, base 719e366.

## Preflight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T3 | event runId/parentRunId -> sink columns | match |
| T1 -> T5 | RunResult.answer/reason -> delegate result text | match |
| T1 -> T7 | ToolContext.runId/depth -> startChild | match |
| T2 -> T4 | config.delegation -> RunTree limits | match |
| T3 -> T4 | append runId -> gate rows | match |
| T3 -> T8 | ActionRow.runId/parentRunId -> log --tree | match |
| T4 <- T5 | canDelegate injected into GateDeps, defined in org | match (injection keeps import rule) |
| T5 -> T7 | MemoryStore, makeDelegateTool, makeRememberTool | match |
| T6 -> T7 | buildSystemPrompt extra -> TreeRunner | match |
| T7 / T8 | both modify wire.ts | sequential, no conflict |
| T1 self | 7 tests, 181 total = 174 + 7 | consistent |
| T2 self | reserved list duplicated in safety and org | consistent with import rule |
| T3 self | old-db migration test | consistent |
| T4 self | depth 3 caller -> reserveChild(4) -> depth_limit | consistent with maxDepth 3 |
| T5 self | tail rule and 5000-char line test | consistent |
| T6 self | no extra -> part 1 prompt | consistent |
| T7 self | no_provider test with providerOverride present | conflict: override hides missing key |
| T8 self | log --tree format | consistent |
| T9 self | live test skips when LM Studio down | consistent |

Ruling: T7 TreeRunner calls providerFor first for its error check, then substitutes providerOverride when given — makes the no_provider test possible with fakes — if wrong, part 1 tests that use override with a claude model and no key need a fake key stored.
Ruling: top run ending no_provider prints the providerFor message (part 1 hint) and exits 1 — keeps part 1 behavior — if wrong, one message differs.
Ruling: existing projects do not get delegate/remember added; only init adds them — spec says init — if wrong, users edit project.json by hand; README in T9 says so.

Task 1: minor (deferred): finish() builds result twice via ternaries; conditional spread is cleaner.
Task 1: minor (deferred): events carry explicit parentRunId: undefined key when absent.
Task 1: minor (deferred): no test that caller depth survives into toolContext, or that parentRunId is absent.
Task 1: complete (commits 719e366..22c46ba, review clean)
Ruling: Tasks 2 and 3 go to one implementer as two commits and one review — both are small safety-package edits with no shared files — if wrong, one review covers two tasks and a finding may need sorting by task.
Ruling: subagent commits keep their own model's Co-Authored-By trailer — same ruling as part 1 — if wrong, trailers name the wrong model; history is otherwise correct.
Task 2: Ruling: duplicated reserved-id list (plan-mandated) gets a drift test in packages/cli tests — keeps the import rule and catches drift — if wrong, one extra test.
Task 3: confirmed gap: ApprovalQueue passes unredacted args to approver.decide; TerminalApprover prints JSON args to stdout (approver.ts:46) — breaks "secrets never reach stdout".
Task 2: minor (deferred): no test for reserved project id in ProjectConfigSchema.
Task 2: minor (deferred): store.test "nul" uses bare toThrow().
Task 3: minor (deferred): ALTER TABLE race between two processes opening a part 1 db gives duplicate column error.
Tasks 2-3: fix round 1/5 (2 addressed, 0 open — approver redaction; reserved id drift test; commits 8ef1440..52a732d)
Task 3: minor (deferred): undefined approval args now print as null.
Task 3: minor (deferred, part 1 design): redact skips secrets shorter than 8 chars.
Task 2: complete (commits 22c46ba..bb0674d, plus fix 52a732d, review clean)
Task 3: complete (commits bb0674d..52a732d, review clean)
Ruling: Task 4 updates wire.ts Gate construction minimally (RunTree from project delegation or defaults, depth 0, one runId shared with runAgent, roleOf from AgentStore, canDelegate: () => false until Task 7) — keeps the build green between tasks — if wrong, Task 7 rewrites these lines anyway.
Task 4: cannot-verify 2 resolved: Task 2 review confirmed delegation limits are finite, non-negative, with defaults.
Task 4: cannot-verify 1 carried to Task 5: delegate schema keeps `agent` a plain string with no transform, since the gate checks raw args.
Task 4: minor (deferred): addUsd(NaN) disables overBudget.
Task 4: minor (deferred): tree.addUsd skipped if budget.add throws; put it first.
Task 4: minor (deferred, design): in-flight delegates in one turn can exceed maxTreeUsd, bounded by maxChildRuns.
Task 4: minor (deferred): wire.ts roleOf builds AgentStore per call.
Task 4: minor (deferred): self_delegation test builds a second Gate.
Task 4: note: with spec role rules, self delegation always hits role_not_allowed first; self_delegation stays as a backstop.
Task 4: complete (commits 52a732d..15e2fe7, review clean)
Ruling: Tasks 5 and 6 go to one implementer as two commits and one review — both are org-only — if wrong, one review covers two tasks.
Task 5: minor (deferred): remember leaves a lone \r; newline replacement not reapplied after redactText.
Task 5: minor (deferred): MemoryStore.append is read-then-rewrite; concurrent appends can drop a line.
Task 5: minor (deferred): tail drops the first whole line when the slice starts on a line boundary (brief text).
Task 5: minor (deferred): no RED run captured.
Task 6: minor (deferred): persona excerpt can split a surrogate pair; newlines in persona break one-line team layout.
Task 5: complete (commits 15e2fe7..cf716cc, review clean)
Task 6: complete (commits cf716cc..c3686b3, review clean)
Task 7: Critical: per-run readline lets a "y" typed for a child approve a later parent request; parent prompt may hang after child rl.close pauses input.
Task 7: minor (deferred): wire.ts bare projectDirs call for validation needs a comment.
Task 7: minor (deferred): child ending no_provider/target_missing writes no run.started/run.stopped rows.
Task 7: cannot-verify resolved: target_missing branch in TreeRunner is a backstop; gate denies first.
Task 7: fix round 1/5 (1 addressed, 0 open — shared line reader for all approvers; commits 3f06dcb..4adfae3)
Task 7: Ruling: lines typed before a prompt waits are dropped, so piped approvals (printf 'y\ny' | agentcity run) no longer work in a tree — an approval must answer a prompt the user saw — if wrong, scripted approval needs a future --yes-file option.
Task 7: minor (deferred): no-hang test passes in both designs, so it guards nothing.
Task 7: complete (commits c3686b3..4adfae3, review clean)
Task 8: cannot-verify resolved: ActionLog.list has no row limit; clear writes "" via writeTextAtomic and agent memory checks the agent exists (memory/ made at create).
Task 8: minor (deferred): --clear accepts Y and padded y; brief says y.
Task 8: minor (deferred): child whose parent has no rows shows at depth 0, untested.
Task 8: minor (deferred): no test for redaction in agent memory output or EOF on --clear prompt.
Task 8: minor (deferred): unused `after` declared before --tree branch; fixup commit 8261e4b could be squashed; no RED run.
Task 8: complete (commits 4adfae3..8261e4b, review clean)
Task 9: minor (deferred): live test with AGENTCITY_LIVE=1 and LM Studio down fails instead of skipping (same as part 1).
Task 9: minor (deferred): live test checks "any file", not hello.txt content or boss/mgr/ada header order.
Task 9: minor (deferred): live personas tuned to qwen3-14b (/no_think, word-for-word copy); other models may fail.
Task 9: minor (deferred): README example personas differ from the tested ones and were not run as written.
Task 9: minor (deferred): README omits that --tree and --tail are exclusive.
Task 9: complete (commits 8261e4b..3d3c47d, review clean)
Final review: ready after one test. Important: no end-to-end test of depth passing parent -> startChild -> child gate.
Ruling (corrects Task 7 ruling): every run, single agent or tree, drops lines typed before a prompt waits, so piped approvals approve at most once — an approval must answer a prompt the user saw — if wrong, scripted approval needs a future --yes-file option.
Final review minor (fix now): delegate tool and team block offered even when allowedTools lacks delegate.
Final fix wave: 3 addressed, 0 open (commit 3d3c47d..b09fdd1).
Final: parked — README printf example is split across two lines and renders broken — Ruling: no second fix wave; one-line doc fix for part 3 — costs a confusing README line until then.
Final: minor (deferred): remember-gating test checks only the boss tool list.
