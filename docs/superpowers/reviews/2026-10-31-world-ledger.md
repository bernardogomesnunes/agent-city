# SDD ledger — plan: docs/superpowers/plans/2026-10-31-world.md
Spec: docs/superpowers/specs/2026-10-31-world-design.md. Branch part4-world, start dc530f0.

## Preflight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T4, T5 | CityPlots, pendingAll, plotTaken | consistent |
| T2 -> T5 | makeBuildTool(claim) | consistent |
| T2 vs T3 | PlotKind in org and in world/shared | duplicate literal union; world may not import org. Ruling below |
| T3 -> T4, T9 | shared map, protocol, AgentView.building | consistent |
| T5 -> T6, T7 | WebApprovals, RunHost, ClosableApprover | consistent; T6 stubs term until T7 |
| T6 vs T8 | cli dep on @agentcity/client before T8 exists | breaks npm install in T6. Ruling below |
| T6 vs T8 | root build script --if-present | npm -w on missing workspace errors. Ruling below |
| T5 self | "CliDeps.buildPlots wiring" undefined | Ruling below |
| T8 self | client tests with DOM types vs tsconfig.test.json lib ES2023 | Ruling below |
| T9, T10 | client pure modules tested by vitest | must not import phaser. Carry in dispatch |
| T1,T2,T3,T4,T7,T10,T11 self | tests match code | consistent |

Ruling: PlotKind duplicated in org and world/shared — import rule forbids world->org — cost if wrong: a drift; T3 adds a test comparing to a literal list.
Ruling: T6 resolves staticDir as <cli dist>/../../client/dist and adds no cli dep on @agentcity/client — package does not exist until T8 — cost if wrong: path breaks for a published install, fine for this repo.
Ruling: T6 leaves root build script; T8 changes it to `tsc -b && npm run build -w @agentcity/client` — workspace missing in T6 — cost if wrong: none.
Ruling: T5 drops CliDeps.buildPlots; TreeRunner makes CityPlots from its own db — plan line named nothing — cost if wrong: tests inject via db anyway.
Ruling: T8 client tsconfig includes src and test with DOM lib; tsconfig.test.json excludes packages/client/test — keeps node tests free of DOM types — cost if wrong: one config tweak.
Ruling: overlay font is CSS monospace (spec amended in dc530f0) — code-drawn pixel font is extra scope for v1 — cost if wrong: a later font task.
Task 1: dispatched (sonnet), BASE dc530f0
Task 1: complete (commits dc530f0..e617a59, review clean)
Task 1: minor (deferred): CityPlots.taken has no NaN/out-of-range test; dense inline cast at gate.ts:170.
Task 1: warning resolved: NaN plot passes the gate check, and the build tool's zod schema (plot 1..6, Task 2) rejects it before claim.
Task 2: dispatched (sonnet), BASE e617a59
Task 2: complete (commits e617a59..4ec0445, review clean)
Task 2: minor (deferred): enums spelled twice (TS union and zod) in profile.ts and tools.ts; cli.test.ts:151 out not reset before edit; no separate RED run.
Task 2: warning resolved: CityPlots.claim (Task 1) returns false on PK conflict and rethrows other errors, so the race gives "plot n is taken".
Task 3: dispatched (sonnet), BASE 4ec0445
Task 3: review: 1 Important (tautology PlotKind test at map.test.ts:455). Ruling: my preflight ruling asked for that test; replace it with a cli test comparing org's build schema and AgentProfileSchema against world's exported lists — cli may import both — cost if wrong: one test file.
Task 3: minor (deferred): linear open list in path.ts; confusing wall predicate in path.test.ts; PlotId extra export.
Task 3: warning resolved: client eslint rule belongs to Task 8 (package absent now).
Task 4: dispatched (sonnet), BASE 4f95589
Task 3: fix round 1/5 (1 addressed, 0 open; commits fbb021b..4f95589)
Task 3: complete (commits 4ec0445..4f95589, review clean)
Task 3: minor (deferred): world-sync test is one-way (only "castle" rejected); cli package.json lacks @agentcity/world dep until Task 6 adds it (tests typecheck via tsconfig.test.json).
Task 4: complete (commits 4f95589..7a4ebfa, review clean)
Task 4: minor (deferred): stoppedAt uses poll time (5 s stopped on server start); model.call moves idle agent to work (untested); redundant plots reassign; poller test for approvals -> [] missing; no RED evidence.
Task 4: Ruling: agent removal not in patch — Task 6 server sends a fresh snapshot to every client when the agent id set changes between polls — no protocol change needed — cost if wrong: one extra snapshot per agent delete.
Task 4: carry to Task 6: call Ticker.stop() on close (no unref).
Task 5: dispatched (sonnet), BASE 7a4ebfa
Ruling: Task 5 tests use send_message (tier 2) for approval waits — write_file is tier 1 in part 1, plan text was wrong — cost if wrong: none.
Task 5: review: spec gap (tree.test.ts not extended). Fix round 1 dispatched to implementer.
Task 5: minor (deferred): run-host.test.ts:546 accepts 3 stop reasons (pin interrupted); :568 plot_taken by substring; no RED evidence.
Task 5: warning resolved: ApprovalView.local is derived from WebApprovals.waiting() in CityFeed (Task 4), which meets the spec intent.
Task 6: dispatched (sonnet), BASE 4557555
Task 5: fix round 1/5 (1 addressed, 0 open; commits 3d67077..4557555)
Task 5: complete (commits 7a4ebfa..4557555, review clean)
Task 6: complete (commits 4557555..f72fe37, review clean)
Task 6: minor (deferred): token === not constant time; symlinks in staticDir not realpath-checked; @types/ws in root devDeps; no RED evidence.
Task 6: Ruling: carry 3 Task 6 minors into Task 7 (it edits city-server.ts): try/catch around tick (SQLITE_BUSY would crash the server), ws maxPayload 64 KiB, keep a server error listener after listen — cheap and the crash is real — cost if wrong: a few lines.
Task 6: warning resolved: parseClientMsg uses zod object schemas (Task 3); maxPayload cap bounds size.
Task 7: dispatched (sonnet), BASE f72fe37
Task 8: dispatched (opus, art quality), BASE ada0110
Task 7: complete (commits f72fe37..ada0110, review clean)
Task 7: minor (deferred): silent catch on poll error (log first occurrence); literal newline in template string city-server.ts:184; chunk.toString may split multibyte chars (StringDecoder).
Task 7: Ruling: closing a browser tab interrupts that tab's running terminal command, including a run — otherwise `log --tail` runs forever with no reader — cost if wrong: a run started from the terminal stops when its tab closes; HQ "Start run" is unaffected.
User instruction (2026-10-31): no Fable subagents; reviews and test runs use haiku from Task 8 review on; Task 8 implementer stays opus.
Task 8: controller visual check (vite preview, browser pane): art renders well (trees, grass, water, path, walls in 4 colors, sign, door, desk, 4 character tints). Bug: "Framebuffer status: Incomplete Attachment" thrown at boot on every load; first load in a 0-size pane left a 0x0 canvas. Cause probable: scale width/height "100%" resolve to 0 before layout. Carry fix into Task 9 (it edits main.ts): numeric fallback size from window.innerWidth/innerHeight, and no console error on load.
Task 8: review (haiku): Needs fixes. Important: path straight/corner/cross variants missing (spec Art). Warning confirmed as gap: per-kind wall color and sign (spec Map).
Task 8: Ruling: spec over brief tile list — add path variants, 9 wall tints, 5 kind signs; fold the framebuffer boot bug into this round (Task 8 owns main.ts) — cost if wrong: extra art grids.
Task 8: minor (deferred): unused zod dep in client; eslint client block reads restrict() internals; report lock-diff count off.
Task 8: fix round 1 dispatched (opus, same implementer).
User direction (2026-10-31): art "more like" a DS-era city screenshot: cobblestone plaza, cliffs, flower beds, whole-building prefabs with base and roof layers, distinct silhouettes. Sent to the Task 8 implementer as a scope addition to fix round 1. Direction note updated.
User direction (2026-10-31): keep Phaser and original art; Pokémon is style inspiration only. Movement must feel like those games: grid steps for avatar and agents. Carry into Task 9: tile-to-tile tweened steps, 4-direction facing, tap to turn in place, walk cycle synced to steps, Shift to run (2x), blocked step plays a short bump, agents idle-wander between slots inside their building.
Spec and plan amended (rooms with fade, StepMover grid movement, HQ panel on front desk tile); user chose 'Fade into a room'.
Task 8: fix round 1/5 plus user style additions (commits db7b7a0..e66561e; prefabs, cobble, cliffs, rooms, depth). Controller browser check: village mock renders, no console errors, style close to user reference.
Task 8: complete (commits ada0110..e66561e, review clean after fix round 1)
Task 8: minor (deferred): 3 near-identical cream walls (director, library, house); workshop/exchange/house prefabs not in Boot mock; buildSheet ignores resize; unused zod dep; eslint client block reads restrict() internals.
Task 9: dispatched (opus, design-heavy), BASE e66561e. Carries: LAYERS codes for cobble, cliffs, flower beds, signposts; drop shadows drawn under objects.
Task 9: implementer done (4028233). Controller browser check: town renders at 3x, avatar walks into HQ door, fade to HQ room, agents at desks with bubbles, exit mat returns to town below door, R hides roofs showing interiors. No errors.
Task 10: dispatched (sonnet), BASE 4028233
Task 10: implementer done (4ee4853). Controller browser check: H opens HQ panel, tabs switch, Agents list shows 3 agents, typing 'wasd sss' in Goal does not move the avatar, HUD shows offline and approvals count. One early tab click did not register; a repeat click worked (not reproduced).
Task 9: review (haiku): Needs fixes. Important: dirOf and walk loop duplicated in village.ts and room.ts. Fix round 1 dispatched (opus, same implementer).
Task 9: Ruling: signposts block walking — solid objects, all 10 on grass, no route breaks — cost if wrong: one char in map.ts.
Task 9: Ruling: roof as one image with alpha replaces the brief's container — same behavior — cost if wrong: none.
Task 9: warning resolved: working-tree files were Task 10's in-progress edits (now 4ee4853); trailer Opus 5.5 matches the implementer model.
Task 9: minor (deferred): plot walkable before dust ends (village.ts:210); unused Character.setVisible; bubble cuts lastText at 24 chars.
Task 9: fix round 1/5 (1 addressed, 0 open; commits 4ee4853..70c9fdb)
Task 9: complete (commits e66561e..4028233 plus 70c9fdb, review clean)
Task 10: review (haiku): Needs fixes. Important: hq-away fires on every non-desk step, closing an H-opened panel. Fix round 1 dispatched (sonnet, same implementer).
Task 10: minor (deferred): terminal `running` stuck after disconnect (reset on offline); backtick matched by e.code on non-US layouts; no RED run.
Task 11: dispatched (sonnet), BASE ea3f10b. LM Studio up with qwen/qwen3-14b.
Task 10: fix round 1/5 (1 addressed, 0 open; commits 70c9fdb..ea3f10b)
Task 10: complete (commits 4028233..4ee4853 plus ea3f10b, review clean)
Task 10: minor (deferred): no test drives Room.arrive wiring.
Task 11: Ruling: live test accepts ada at software with writing OR lastText starting write_file — a 250 ms poll collapses write_file then build into one state, the log shows the write — cost if wrong: a fast activity can be missed in the city view (deferred minor).
Task 11: complete (commits ea3f10b..db2f16d, review clean)
Task 11: minor (deferred): live test uses pollMs 100; retry gate ignores delegatingAtHq; retry does not wait for the first run to end.
Controller end-to-end check: real `agentcity city` on 127.0.0.1:4321 with token; HUD online; terminal panel runs `agent list` ("No agents." in the user's real home, nothing created there). The pane's own backtick key did not reach the page; a dispatched backtick keydown opened the terminal.
Final review (haiku): With fixes. 1 Critical (client terminal locks while running), 5 Important (offline lock, shutdown race, terminal run skips busy guard, keys read once, poll drops rows on error). All rulings accepted.
Ruling: refuse `secrets` in the city terminal — a key typed in the browser would show on screen and cross the socket — cost if wrong: user sets keys in a normal terminal.
Final fix wave dispatched (sonnet) with final-findings.md, FIX_BASE db2f16d.
Final fix wave: 7 addressed, 0 open (commits db2f16d..9e99e1f). Residual minor: literal newlines in template strings in client terminal.ts; refreshKeys never removes deleted keys.
Final verification by controller: 472/472 tests, typecheck ok, lint ok.
