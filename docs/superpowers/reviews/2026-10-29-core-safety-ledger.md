# SDD ledger — plan: docs/superpowers/plans/2026-10-29-core-safety.md

Spec: docs/superpowers/specs/2026-10-29-core-safety-design.md. Branch: part1-core-safety (from master 767729f).

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| 2 -> 3 | ToolCall, Usage, GateDecision, ToolSpec | match |
| 2,3 -> 4 | Message, ToolSpec, ToolCall | match |
| 2,3,4 -> 5 | Provider, ToolGate.checkTool(call, AnyTool), parseTextToolCalls, trimMessages, AgentEvent incl agentName/agentVersion | match; unknown tool handled before gate in 5, consistent with checkTool taking AnyTool |
| 2 -> 6, 7 | Provider, ChatRequest/Response | match |
| 8 -> 10, 11, 12 | openDb schema tables actions/approvals/usage | match |
| 9 -> 12, 14 | ProjectConfig incl agents, Prices, priceFor, modelAllowed, costUsd | match |
| 11 -> 12, 14 | Approver, ApprovalQueue.denyAllPending | match |
| 13 -> 14 | AgentStore, buildSystemPrompt | match; org takes home as param, cli passes agentCityHome() from safety |
| 5,12,13 -> 14 | runAgent opts, Gate deps | match |
| 14 -> 15 | buildProgram | match |
| Task 1 self | typecheck = tsc -b over src only | tests never type-checked (see ruling 1) |
| Task 1 self | vitest imports @agentcity/* across packages | resolves to dist, needs build first (see ruling 2) |
| Task 7, 9 self | need current Anthropic API shape and Haiku price | subagent may lack claude-api skill (see ruling 3) |
| Tasks 2-6, 8, 10-13, 15 self | tests vs code vs files | consistent |

Ruling: add root `tsconfig.test.json` (noEmit, includes packages/*/test) and make `typecheck` = `tsc -b && tsc -p tsconfig.test.json` — test files otherwise escape type checks — cost if wrong: one extra config file.
Ruling: vitest config aliases `@agentcity/<pkg>` to `packages/<pkg>/src/index.ts` — tests run without a prior build — cost if wrong: alias removal later.
Ruling: Tasks 7 and 9 use the claude-api skill if the subagent has it, else WebFetch of Anthropic's docs pricing and Messages API pages; the source URL goes in the report — cost if wrong: one wrong price constant, tests do not depend on it.

## Progress
Task 1: dispatched (BASE 767729f, sonnet)
Task 1: minor (deferred): package.json template residue (blank lines, empty dependencies)
Task 1: minor (deferred): eslint relative-path patterns stop at 4 levels
Task 1: minor (deferred): @types/node ^26 vs engines >=22
Task 1: minor (deferred): eslint not type-aware
Task 1: minor (deferred): LF to CRLF warnings, no .gitattributes
Task 1: complete (commits 767729f..e967fb6, review clean)
Task 2: dispatched (BASE e967fb6, sonnet)
Task 2: minor (deferred): no test that exhausted FakeProvider still records request; MemorySink untested
Task 2: complete (commits e967fb6..e24726e, review clean; controller re-ran typecheck/lint/test)
Task 3: dispatched (BASE e24726e, sonnet)
Ruling: subagent commits carry a Co-Authored-By trailer naming the model that wrote them — accurate attribution — cost if wrong: trailer text on some commits
Task 3: minor (deferred): write_file check-then-write gap (TOCTOU) narrowed, not closed
Task 3: minor (deferred): read_file reads whole file before cutting at 100000
Task 3: minor (deferred): send_message no wx flag, same-ms name collision overwrites
Task 3: minor (deferred): ENOTDIR treated as missing path; isWin formatting; no test for path "."
Task 3: fix round 1/5 dispatched (Important: dangling symlink to outside passes sandbox check)
Task 3: fix round 1/5 (1 addressed, 0 open; commits c014904..677fb27)
Task 3: minor (deferred): fix also rejects dangling links pointing inside the sandbox (stricter, safe)
Task 3: complete (commits e24726e..677fb27, review clean)
Task 4: dispatched (BASE 677fb27, sonnet)
Task 4: minor (deferred): trim redundant cast; O(n^2) re-stringify per loop; no test for oversize latest group
Task 4: fix round 1/5 dispatched (Important: 8 AX Studio parser test cases missing)
Task 4: fix round 1/5 (1 addressed, 0 open; commits faef4dd..afd577e)
Task 4: complete (commits 677fb27..afd577e, review clean)
Ruling: when the latest assistant group alone exceeds the window, the loop sends it as is and a provider rejection ends the run as provider_error — the spec names no other reason — cost if wrong: one unclear stop reason on huge tool outputs, already capped at 100000 chars
Task 5: dispatched (BASE afd577e, sonnet)
Task 5: minor (deferred): gate throw rejects runAgent with no run.stopped event (fails closed)
Task 5: minor (deferred): provider_error drops the cause; retry sleep ignores abort signal (up to 5 s)
Task 5: minor (deferred): tests: stop/deny do not assert tool never ran; "; " join, outcome values, estimatedInputTokens untested
Task 5: minor (deferred): steps counts gate-stopped and provider_error steps (brief silent)
Task 5: fix round 1/5 dispatched (Important: tool runs on any decision kind other than stop/deny)
Task 5: fix round 1/5 (1 addressed, 0 open; commits 6bb29d3..6a101ad)
Task 5: complete (commits afd577e..6a101ad, review clean)
Ruling: Tasks 6 and 7 (two provider adapters, same shape, no shared files) go to one implementer and one review — saves a dispatch and a review — cost if wrong: one larger review diff
Tasks 6+7: dispatched (BASE 6a101ad, sonnet)
Task 6-7: minor (deferred): no Authorization header test; openai-compat header comment not in AX form
Ruling: raised 3 Task 6-7 minors to the fix round (server-body key redaction, empty assistant content, raw-string args to Anthropic) — each breaks or leaks on a live run, which Task 15 depends on — cost if wrong: one larger fix diff
Task 6-7: fix round 1/5 dispatched (Important: key in plain instance fields; plus 3 raised minors)
Task 6-7: fix round 1/5 (4 addressed, 0 open; commits 5cd8a27..cb59684)
Task 6-7: minor (deferred): array args pass through as Anthropic input; dropped empty assistant message can leave two user messages in a row
Task 6: complete (commits 6a101ad..577e186, review clean after fix round)
Task 7: complete (commits 577e186..cb59684, review clean)
Task 8: dispatched (BASE cb59684, sonnet)
Task 8: minor (deferred): WAL set before busy_timeout; two-connection test is sequential; redact loses Date/Map and loops on cycles; type/projectId/agentId not redacted; @types/better-sqlite3 v9 vs runtime v13
Task 8: fix round 1/5 dispatched (Important: project file named config.json, spec says project.json)
Task 9: dispatched (BASE fdd8a4c, sonnet), parallel with Task 8 re-review
Task 8: fix round 1/5 (1 addressed, 0 open; commits fce3d84..fdd8a4c)
Task 8: complete (commits cb59684..fdd8a4c, review clean)
Ruling: project ids must match ^[a-z0-9-]{1,32}$ (same rule as agent ids); projectDirs throws on others — blocks ../ paths from CLI input — cost if wrong: users pick simpler project names
Ruling: an invalid global config.json throws a clear error and is not silently replaced by defaults — a typo in prices should not pass unnoticed — cost if wrong: CLI refuses to start until the file is fixed
Task 9: pre-review fix dispatched (implementer concerns: id path traversal, silent bad global config)
Ruling: Tasks 10 and 11 (budget ledger, approval queue: small, separate files, same db) go to one implementer and one review — cost if wrong: one larger review diff
Tasks 10+11: dispatched (BASE 6c5bcbc, sonnet), parallel with Task 9 review
Task 9: minor (deferred): costUsd ignores the >100K-token price tier (5x undercount above it)
Task 9: minor (deferred): saveProjectConfig not atomic (concurrent read can see partial file; fails closed as config_invalid)
Task 9: minor (deferred): maxTokens not .int(); lmStudioBaseUrl not URL-validated; duplicated default URL literal; no tests for prices merge or save rejecting invalid config; ac772a5 has no RED run
Task 9: unverified: claude-haiku-5-5 price 0.10/0.50 per MTok taken from claude-api skill table; user should confirm against Anthropic pricing
Task 9: complete (commits fdd8a4c..6c5bcbc, review clean)
Task 12: dispatched (BASE 5f061d7, sonnet), parallel with Tasks 10+11 review
Task 10-11: minor (deferred): no test for late approval after denyAllPending (guard untested); autoTotalToday filters all auto rows in JS; approver error cause dropped; Task 10 RED produced after implementation
Task 10: complete (commits 6c5bcbc..992e1db, review clean)
Task 11: complete (commits 992e1db..5f061d7, review clean)
Task 12: concern (deferred): budget check and tier 3 auto-approve not atomic; parallel agents (part 2) could overshoot
Task 13: dispatched (BASE 7294d54, sonnet), parallel with Task 12 review
Task 12: minor (deferred): estimateUsd throw rejects checkTool with no gate.decision row (fails closed); recordUsage records 0 usd for unpriced model; every-decision test checks 3 of 10 rules; tier 3 ask tests do not assert autoTotalToday unchanged; no RED on record
Task 12: ToolGate conformance verified by `class Gate implements ToolGate` and clean typecheck (controller re-runs typecheck after Task 13)
Task 12: complete (commits 5f061d7..7294d54, review clean)
Task 14: dispatched (BASE a629c1e, sonnet), parallel with Task 13 review
Task 13: minor (deferred): traversal tested for get only; no role-only version bump test; id regex allows Windows reserved names (con, nul, aux), also affects project ids; agent.json written before snapshot; temp file name collision on same-ms writes
Task 13: complete (commits 7294d54..a629c1e, review clean)
Ruling: `init` grants the 3 built-in tools (spec example lists them; tier rules still gate send_message) — cost if wrong: one-line change in wire.ts
Ruling: the gate sees the full `lmstudio/<name>` model id and the prefix is stripped only in the request to LM Studio — the allowlist and price lookup need the full id — cost if wrong: none for users
Ruling: runs that stop for any reason other than done exit 1; interrupt exits 130 — scripts can detect failures — cost if wrong: exit code change
Task 14: minor (deferred): denyAllPending unscoped (denies other runs, fails closed); fallback run.stopped logs steps 0; init test does not assert allowedTools; log --tail untested; 2 s interrupt timer not cleared; secrets set Ctrl-C may hang on TTY
Task 14: unverified: real icacls ACL on Windows and live LM Studio run (Task 15 manual check covers the run)
Ruling: raised 3 Task 14 minors into the fix round (stdout event redaction, providerFor tests, setSecret fails loudly when icacls fails) — each touches secrets or model routing — cost if wrong: one larger fix diff
Task 14: fix round 1/5 dispatched (Important: no RED evidence; mutation checks requested; plus 3 raised minors)
Task 15: dispatched (BASE c6b91e1, sonnet), parallel with Task 14 re-review
Task 14: fix round 1/5 (4 addressed, 0 open; commits 88d80bd..c6b91e1)
Task 14: minor (deferred): stdout-redaction mutation has no recorded run output; restricted tmp file left on disk if rename throws
Task 14: complete (commits a629c1e..c6b91e1, review clean)
Task 15: minor (deferred): Anthropic live test does not assert a tool call; live tests copy real key into temp secrets.json (left behind on crash); README shows --role optional vs spec required
Task 15: unverified: Anthropic live test never ran (no key); Done-when 2 and 3 rest on implementer's manual run log in task-15-report.md
Task 15: complete (commits c6b91e1..131768d, review clean; controller re-ran typecheck/lint/test)
Final review: dispatched (767729f..131768d, opus)
Final review: merge after fixes; 0 Critical, 1 Important (Ctrl+C does not stop the rest of the current turn), 8 Minor
Ruling: READ_LIMIT lowered from 100000 to 60000 characters in the final fix wave — 100000 chars (~33k tokens) fills the 32000-token default window, defeating Review Focus 3 — cost if wrong: agents read large files in more calls
Final fix wave: dispatched (Important abort fix, Task 5 stop-assertion must-fix, READ_LIMIT)
Final fix wave: 3 addressed, 0 open (commits 131768d..4994482); final review clean
