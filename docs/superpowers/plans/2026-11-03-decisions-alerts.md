# Decisions and Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One queue of everything that waits on the player, answered oldest first from a J panel, with notification, bell, podium walk, "!" and lamps.

**Architecture:** The server computes the queue every poll tick from pending approvals and blocked or approval tasks, and pushes it as a `decisions` message when it changes. The client keeps it in `CityModel`; the HUD, the panel, the alerts and both scenes read it from there. Answers reuse the existing `approve`, `task.answer` and `review.answer` messages.

**Tech Stack:** TypeScript, zod, better-sqlite3, ws, Phaser 3, vitest with jsdom.

**Spec:** docs/superpowers/specs/2026-11-03-decisions-alerts-design.md

## Global Constraints

- Answer messages stay `approve {id, decision}`, `task.answer {taskId, text}`, `review.answer {taskId, option, text?}`. No scheduler or approval code changes.
- Decision ids: `a:<approvalId>`, `q:<taskId>`, `m:<taskId>`. Sorted by `since` oldest first, ties by id. At most 200.
- Lamp colors: yellow `#e0b020`, red `#c03030`, green `#30a040`, grey `#808080`. Priority yellow > red > green > grey.
- Podium tile (23, 10), blocking. Spots in order: (22,11) (23,11) (24,11) (21,12) (22,12) (23,12) (24,12) (25,12). Max 8.
- Bell: one 880 Hz sine, 150 ms, Web Audio. `localStorage` key `agentcity.bell`, default on.
- Files are CRLF on disk. Edit with the Edit tool or normalize line endings in scripts.
- Every `localStorage`, `Notification` and `AudioContext` call sits in try/catch.

## Review Focus

- A decision answered in the dock or HQ pane while the panel shows it: the panel moves to the new oldest one (Task 4 test "a list without the shown decision moves to the oldest").
- An approval id that leaves and a new one with a higher id: the new one is not counted as already seen (Task 2 test "first-seen times drop with their id").
- The page loads with 3 decisions waiting: no bell, no notification (Task 5 test "the first list makes no alert").
- An agent with 2 decisions takes one podium spot (Task 6 test "one spot per agent").
- The server restarts with tasks in approval: the first `decisions` message on connect holds them (Task 2 test "connect gets the list").

## Ruling carried from the spec

- Agents have no nameplate. The lamp is a 4 by 4 square drawn just above the agent's head, left of the bubble anchor. The "!" is a text mark above the lamp.
- Red needs task data the client lacks for unwatched projects. The `decisions` message carries `failing: string[]`, the agent ids with a task in `doing` or `review` and `ci: "fail"`.

---

### Task 1: Decision list on the server

**Files:**
- Modify: `packages/world/src/shared/protocol.ts` (DecisionViewSchema, `decisions` server message)
- Modify: `packages/safety/src/board-store.ts` (`waitingTasks()`)
- Create: `packages/cli/src/decisions.ts`
- Test: `packages/cli/test/decisions.test.ts`, `packages/safety/test/board-store.test.ts`

**Interfaces:**
- Produces: `DecisionViewSchema`, `type DecisionView = { id: string; kind: "approval" | "question" | "merge"; projectId: string; agentId: string; taskId?: string; approvalId?: number; title: string; text: string; since: string }`.
- Produces: server message `{ type: "decisions"; list: DecisionView[]; failing: string[] }`.
- Produces: `BoardStore.waitingTasks(): Task[]`, every task of any project with status `blocked` or `approval`, or status `doing`/`review` with `ci = 'fail'`.
- Produces: `listDecisions(input: { approvals: ApprovalView[]; seen: Map<number, string>; tasks: Task[] }): { list: DecisionView[]; failing: string[] }` and `DECISIONS_MAX = 200` in `packages/cli/src/decisions.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// decisions.test.ts
it("orders approvals, questions and merges oldest first, ties by id", () => {
  const seen = new Map([[7, "2026-11-03T10:00:02.000Z"]]);
  const r = listDecisions({ approvals: [approval(7, "ada")], seen, tasks: [
    task({ id: "t3", status: "blocked", blockedReason: "Which colour?", updatedAt: "2026-11-03T10:00:01.000Z" }),
    task({ id: "t4", status: "approval", summary: "added footer", updatedAt: "2026-11-03T10:00:01.000Z" }),
  ] });
  expect(r.list.map((d) => d.id)).toEqual(["q:t3", "m:t4", "a:7"]);
  expect(r.list[0]).toMatchObject({ kind: "question", text: "Which colour?", taskId: "t3" });
  expect(r.list[1]).toMatchObject({ kind: "merge", text: "added footer" });
  expect(r.list[2]).toMatchObject({ kind: "approval", approvalId: 7, agentId: "ada", text: "" });
});
it("an approval title is the tool and its args preview", () => { /* title "run_command: npm test" */ });
it("keeps at most 200, the oldest", () => { /* 205 merge tasks → 200, first is the oldest */ });
it("failing lists agents with a doing or review task whose ci failed", () => { /* ["ada"] */ });
// board-store.test.ts
it("waitingTasks returns blocked, approval and failing tasks of every project", () => { /* two projects */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/decisions.test.ts packages/safety/test/board-store.test.ts`. Expected: FAIL, module or method missing.
- [ ] **Step 3: Implement** the schema, `waitingTasks` (one SELECT), and `listDecisions`. A task without assignee uses `createdBy` as `agentId`. An approval missing from `seen` uses the epoch, so it sorts first.
- [ ] **Step 4: Run** the same command and `npm run build -w packages/world`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the server lists decisions oldest first`.

### Task 2: Push decisions from the city server

**Files:**
- Modify: `packages/cli/src/city-server.ts`
- Test: `packages/cli/test/city-server.test.ts`

**Interfaces:**
- Consumes: Task 1's `listDecisions`, `board.waitingTasks()`.
- Produces: every client receives `decisions` right after `snapshot` on connect, and on change.

- [ ] **Step 1: Write the failing tests**: "connect gets the list" (a seeded approval-status task appears as `m:<id>`); "a task entering approval sends a new list"; "no second message when nothing changed" (count `decisions` messages over 3 ticks after the first); "first-seen times drop with their id" (unit-test a helper `trackSeen(seen, ids, now)` exported from `decisions.ts`: removed ids leave the map, new ids get `now`).
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/city-server.test.ts -t decisions`. Expected: FAIL.
- [ ] **Step 3: Implement** in `tick`, after `feed.poll()`: `trackSeen(seen, current.approvals.map((a) => a.id), new Date().toISOString())`, then `listDecisions`. Keep `lastKey = JSON.stringify(list.map(d => d.id)) + "|" + failing.join(",")`. Broadcast when the key changes. On connect send the last computed message. Add `trackSeen` to `decisions.ts` with a test there.
- [ ] **Step 4: Run** the city-server and decisions tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the city pushes the decision queue`.

### Task 3: Client store and HUD

**Files:**
- Modify: `packages/client/src/net.ts` (CityModel keeps `decisions` and `failing`)
- Modify: `packages/client/src/ui/hud.ts`, `packages/client/src/ui/index.ts`, `packages/client/src/ui/style.css`
- Test: `packages/client/test/hud.test.ts` (create if absent), `packages/client/test/net.test.ts`

**Interfaces:**
- Produces: `CityModel.decisions: DecisionView[]` (default `[]`), `CityModel.failing: string[]`, both set by `apply({type: "decisions"})`, which notifies subscribers.
- Produces: `Hud.setDecisions(n: number)`, `Hud.onDecisionsClick(cb: () => void)`, `Hud.bellOn(): boolean`. `setPending` and `setReviews` are removed with their callers.

- [ ] **Step 1: Failing tests**: CityModel applies a `decisions` message and calls a subscriber; HUD shows `decisions: 2` with class `has-pending`, `decisions: 0` without; the bell button toggles text "bell on" / "bell off" and writes `agentcity.bell` = "off"; a throwing `localStorage` leaves the bell on.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/hud.test.ts packages/client/test/net.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `index.ts` refresh calls `hud.setDecisions(city.decisions.length)`; `BoardView` keeps its `onReviews` argument unused by index.
- [ ] **Step 4: Run** `npx vitest run packages/client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: one decisions counter and a bell toggle on the HUD`.

### Task 4: Decisions panel

**Files:**
- Create: `packages/client/src/ui/decisions.ts`
- Modify: `packages/client/src/ui/board.ts` (export `diffLines` renderer if not exported), `packages/client/src/ui/index.ts` (J key, HUD click, `diff` and `review.result` routing), `packages/client/src/ui/style.css`
- Test: `packages/client/test/decisions.test.ts`

**Interfaces:**
- Consumes: Task 3's `city.decisions`; `diffLines(parent, file)` from `board.ts`.
- Produces: `class DecisionsPanel { constructor(parent: HTMLElement, send: Send, names: (id: string) => string, onOpenChange: (open: boolean) => void); root; isOpen; open(); close(); setList(list: DecisionView[]): void; setDiff(taskId: string, files: DiffFileView[]): void; setResult(taskId: string, ok: boolean, error?: string): void }`.

- [ ] **Step 1: Failing tests (jsdom)**:
  - "shows the oldest and 1 of N".
  - "approval Approve sends approve approved; Deny sends denied".
  - "question Answer sends task.answer with the text; empty text sends nothing".
  - "merge asks for the diff, draws it, and Merge, Request changes, Reject send review.answer".
  - "buttons stay disabled with sending… until a new list arrives".
  - "a list without the shown decision moves to the oldest".
  - "Skip shows the next and leaves the list as it is".
  - "an error result re-enables the buttons and shows the error".
  - "empty list shows Nothing waits on you".
- [ ] **Step 2: Run** `npx vitest run packages/client/test/decisions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The panel tracks the shown id; on `setList` it keeps that id when present and not answered, else shows `list[0]`. Skip keeps a local skipped set, cleared when the list empties. J in `index.ts` opens or closes it under `gameKeysEnabled`, tracked by the `OverlayStack`.
- [ ] **Step 4: Run** `npx vitest run packages/client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the J panel answers decisions oldest first`.

### Task 5: Notification and bell

**Files:**
- Create: `packages/client/src/ui/alerts.ts`
- Modify: `packages/client/src/ui/index.ts`
- Test: `packages/client/test/alerts.test.ts`

**Interfaces:**
- Produces: `class Alerts { constructor(deps: { bellOn: () => boolean; hidden: () => boolean; notify: (body: string) => void; tone: () => void; names: (id: string) => string }); update(list: DecisionView[]): void; askPermission(): void }`, plus `browserNotify(body)` and `playTone()` default implementations in the same file.

- [ ] **Step 1: Failing tests**: "the first list makes no alert"; "a new id plays the tone when the bell is on"; "a new id while hidden notifies 'ada: Merge footer'"; "visible page: tone, no notification"; "bell off: no tone"; "an id seen before and back again alerts once only".
- [ ] **Step 2: Run** `npx vitest run packages/client/test/alerts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `browserNotify` uses `new Notification("Agent City", { body })` when `Notification.permission === "granted"`. `playTone` builds an `AudioContext`, one oscillator `sine` 880 Hz for 0.15 s. `askPermission` runs on the first J press or HUD click.
- [ ] **Step 4: Run** `npx vitest run packages/client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: a bell and a desktop notification for new decisions`.

### Task 6: Podium, "!" and lamps

**Files:**
- Modify: `packages/client/src/actors.ts` (`PODIUM`, `PODIUM_SPOTS`, `podiumSpots`, `lampOf`)
- Modify: `packages/world/src/shared/map.ts` (podium tile blocks walking)
- Modify: `packages/client/src/scenes/character.ts` (`setLamp(color: number | null)`, `setAlert(on: boolean)`)
- Modify: `packages/client/src/scenes/village.ts` (podium prop, targets), `packages/client/src/scenes/room.ts` ("!" and lamp only), `packages/client/src/scenes/boot.ts` (podium texture drawn in code)
- Test: `packages/client/test/actors.test.ts`, `packages/world/test/map.test.ts`

**Interfaces:**
- Consumes: `city.decisions`, `city.failing`.
- Produces: `podiumSpots(decisions: DecisionView[], agentIds: string[]): Map<string, Point>`; `lampOf(agent: AgentView, decisions: DecisionView[], failing: string[]): number` returning `0xe0b020`, `0xc03030`, `0x30a040` or `0x808080`.

- [ ] **Step 1: Failing tests**: "spots follow decision order"; "one spot per agent"; "a ninth agent gets no spot"; "an agent not in the city gets no spot"; "lamp yellow beats red beats green, idle and stopped are grey"; map: "(23, 10) is not walkable, (23, 11) is".
- [ ] **Step 2: Run** `npx vitest run packages/client/test/actors.test.ts packages/world/test/map.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Village `sync` uses the podium spot as the target when present, else the slot; it subscribes to decision changes too. An agent at a podium spot faces up. `Character.setAlert` draws a "!" text above the lamp; `setLamp` a 4 by 4 filled rectangle. The room scene calls only `setLamp` and `setAlert`.
- [ ] **Step 4: Run** `npx vitest run` (whole suite) and `npm run build`. Expected: PASS, build clean.
- [ ] **Step 5: Commit** `feat: agents with a decision walk to the podium, with a lamp and a "!"`.

### Task 7: Browser check

- [ ] **Step 1:** Restart the `city` preview. Submit a goal on the scratch `pong` project ("Add a CONTRIBUTING.md with 2 lines").
- [ ] **Step 2:** When the task reaches approval: screenshot the agent at the podium with "!" and a yellow lamp, and the HUD `decisions: 1`.
- [ ] **Step 3:** Press J, check the merge with its diff, press Merge. Expected: the panel shows "Nothing waits on you", the agent walks back, the lamp turns grey.
- [ ] **Step 4:** Record results in the ledger.
