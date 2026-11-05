# Project Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The software house shows each project's plan, step progress, preview, files and recent activity.

**Architecture:** The board is a pure function over action log rows, in `@agentcity/world`. The CLI reads project files inside the project root and serves a framed preview under a per-process key. The client adds a Projects part to the software house panel. The part is built once per visit and updated in place, so the preview frame keeps running.

**Tech Stack:** TypeScript, vitest with jsdom, zod protocol, node http, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-11-02-project-board-design.md`

## Global Constraints

- Plans have 2 to 8 steps. Step text is cut to 120 characters. Activity holds the last 20 rows. Board input is at most the last 2000 rows of a project.
- File tree: skip `.git` and `node_modules`, hide `isProtected` paths, at most 500 entries. File text: at most 200 KB. Binary means a NUL byte in the first 8 KB.
- Preview CSP is exactly `default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'`, plus `X-Content-Type-Options: nosniff`.
- The frame is `<iframe sandbox="allow-scripts">`, never with `allow-same-origin`.
- Every user-facing text is built with text nodes, never `innerHTML`.
- Line endings: files are CRLF on disk; scripts normalize before matching.
- Every task ends with `npm run build` clean and `npx vitest run` green.

## Review Focus

- A plan report with steps on one line ("Plan: 1. a 2. b 3. c") parses to 3 steps. Test in Task 1.
- A child run that never logs a stop, under a top run that stopped, shows `failed`. Test in Task 1.
- A file path with `%2e%2e` or a backslash in the preview URL returns 404. Test in Task 3.
- A project whose linked folder was deleted returns an empty tree with an error, and the panel still renders. Test in Task 2 and Task 4.
- A project id that fails `projectDirs` validation returns an error message and does not throw in the socket handler. Test in Task 3.

---

### Task 1: Board data

**Files:**
- Create: `packages/world/src/board.ts`
- Modify: `packages/world/src/state.ts` (export `mainArg`), `packages/world/src/index.ts`, `packages/world/src/shared/protocol.ts` (board schemas)
- Test: `packages/world/test/board.test.ts`

**Interfaces:**
- Produces, in `shared/protocol.ts`:
  - `StepState = "open" | "working" | "done" | "failed"`
  - `PlanStep { text: string; state: StepState; agentId?: string; reason?: string }`
  - `ActivityRow { ts: string; agentId: string; tool: string; target?: string }`
  - `ProjectBoard { projectId: string; author?: string; steps: PlanStep[]; activity: ActivityRow[]; busy: boolean; hasIndex: boolean }`
  - `BoardSummary { projectId: string; author?: string; doneCount: number; stepCount: number; busy: boolean }`
  - Each has a zod schema named `<Name>Schema`.
- Produces, in `board.ts`:
  - `parsePlan(text: string): string[] | null`
  - `projectBoard(rows: ActionRow[], projectId: string, redactText: (s: string) => string): Omit<ProjectBoard, "busy" | "hasIndex">`
  - `summarize(board: ProjectBoard): BoardSummary`
- Produces `mainArg(name: string, args: unknown): string | undefined`, now exported from `state.ts`.

- [ ] **Step 1: Write the failing tests** in `board.test.ts`. Build rows with a helper `row(type, agentId, runId, payload, parentRunId?)` with ids counting up.
  - `parsePlan`:
    - `"Plan: 1. page 2) loop 3. score"` gives `["page", "loop", "score"]`.
    - `"plan:\n1. a\n2. b"` gives `["a", "b"]`.
    - `"Plan: 1. only"` gives `null`.
    - Nine steps give `null`.
    - `"Done: 1. a 2. b"` gives `null`.
    - A 200-character step is cut to 120.
  - Order: a plan report from `boss` in run `t`, then two delegates from `boss` in run `t`. Children `k1` (dev) and `k2` (mgr) have `parentRunId: "t"`.
    - `k1` stops `done`, `k2` has no stop.
    - The states are `["done", "working", "open"]`, with `agentId` `dev` then `mgr`.
  - Failure: `k2` stops with `max_steps`, so step 2 is `failed` with reason `max_steps`.
  - Interrupted: top run `t` stops `interrupted`, `k2` has no stop. Step 2 is `failed` with reason `interrupted`.
  - Newer plan: a second plan report replaces the first. Only delegations after it count.
  - Extra delegations past the last step leave the steps unchanged.
  - Grandchildren: a delegate from `mgr` in run `k2` never fills a plan step.
  - Activity: 25 `tool.requested` rows give 20, newest first. A `write_file` row gives `{ tool: "write_file", target: "a.ts" }`. `redactText` runs on the target.
  - No plan: `steps` is `[]` and `author` is undefined.

- [ ] **Step 2: Run** `npx vitest run packages/world/test/board.test.ts`. Expected: FAIL, module `../src/board.js` not found.

- [ ] **Step 3: Implement.**
  - `parsePlan` strips a leading `plan:` (case-insensitive), then splits on `(?:^|\s)(\d+)[.)]\s+`.
  - The plan run tree is the set of run ids whose `parentRunId` chain reaches the plan row's `runId`. Build it from `run.started` rows.
  - Only `delegate` rows with `agentId === author` and `runId === plan runId` fill steps.
  - The child run id of a delegation is the next `run.started` row whose `parentRunId` is the plan run and whose agent equals `args.agent`.
  - Add the schemas to `protocol.ts` and export `board.ts` from `index.ts`.

- [ ] **Step 4: Run** `npx vitest run packages/world`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: project board data from the action log`.

### Task 2: Project files

**Files:**
- Create: `packages/cli/src/project-files.ts`
- Modify: `packages/world/src/shared/protocol.ts` (file schemas)
- Test: `packages/cli/test/project-files.test.ts`

**Interfaces:**
- Produces, in `protocol.ts`:
  - `FileEntry { path: string; size: number; dir: boolean }`
  - `FileTree { entries: FileEntry[]; truncated: boolean; error?: string }`
  - Both with schemas.
- Produces, in `project-files.ts`:
  - `listFiles(root: string, protectedPaths: string[]): Promise<FileTree>`
  - `readProjectFile(root: string, rel: string, protectedPaths: string[]): Promise<{ text?: string; binary: boolean; truncated: boolean; error?: string }>`
  - `FILE_MAX = 200 * 1024`
  - `TREE_MAX = 500`

- [ ] **Step 1: Write the failing tests** against a temp folder holding `index.html`, `src/a.ts`, `.env`, `.git/HEAD`, `node_modules/x/i.js`, a 300 KB file and a binary file.
  - `listFiles(root, [".env*"])` paths equal `["big.txt", "bin.dat", "index.html", "src", "src/a.ts"]`, sorted, with `dir` true for `src`.
  - 600 files give 500 entries and `truncated: true`.
  - A missing root gives `{ entries: [], truncated: false, error: "folder not found" }`.
  - `readProjectFile`:
    - `src/a.ts` returns its text.
    - `big.txt` returns 204800 characters and `truncated: true`.
    - `bin.dat` returns `binary: true` and no text.
    - `../x`, `C:/Windows/win.ini` and `.env` return `error` and no text.
  - Link escape: create a directory junction `out` pointing outside the root, with `fs.symlinkSync(target, link, "junction")`. Reading `out/f.txt` returns `error`.

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/project-files.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.**
  - Walk breadth-first with `fs.promises.readdir(withFileTypes)`. Never follow links when listing.
  - `readProjectFile` runs `isProtected({ protectedPaths }, rel)` first.
  - Then it calls `resolveInSandbox(root, rel)` from `@agentcity/core`.
  - Then it reads at most `FILE_MAX` bytes with a file handle.
  - Errors return the message, never throw.

- [ ] **Step 4: Run** `npx vitest run packages/cli/test/project-files.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: read-only project files inside the project root`.

### Task 3: Server messages and preview route

**Files:**
- Modify: `packages/world/src/shared/protocol.ts`, `packages/cli/src/city-server.ts`
- Test: `packages/cli/test/city-server.test.ts`

**Interfaces:**
- Consumes `projectBoard`, `summarize`, `listFiles`, `readProjectFile`, `workDir` (`packages/cli/src/workspace.ts`), `loadProjectConfig`, `projectIds` (move it from `hq.ts` to an export there).
- Produces client messages:
  - `{type:"project.boards"}`
  - `{type:"project.open", projectId}`
  - `{type:"project.file", projectId, path}`
  - Ids are capped at 100 characters and the path at 1000.
- Produces server messages:
  - `{type:"project.boards", boards: BoardSummary[]}`
  - `{type:"project.board", projectId, board: ProjectBoard, files: FileTree, previewKey: string}`
  - `{type:"project.file", projectId, path, text?, binary, truncated, error?}`
  - `{type:"error", message}` for a bad project id.
- Board input: `ActionLog.list(projectId)`, the last 2000 rows. Add `ActionLog.lastOf(projectId: string, n: number): ActionRow[]`, ascending, in `packages/safety/src/action-log.ts`.

- [ ] **Step 1: Write the failing tests** in `city-server.test.ts`, with the existing harness.
  - Seed a plan report and one finished delegate for project `site`. Write `sandbox/index.html`.
    - `project.boards` returns `site` with `doneCount: 1` and `stepCount: 2`.
    - `project.open` returns `steps[0].state === "done"`, `hasIndex: true`, a 32-hex `previewKey` that differs from the token, and `index.html` in `files.entries`.
  - `project.file` for `index.html` returns its text. For `../x` it returns `error`.
  - `project.open` for `"../bad"` returns `{type:"error"}`, and the socket stays open.
  - Preview, fetched with `Host: 127.0.0.1:<port>`:
    - `/p/<key>/site/` returns 200 with the CSP header from Global Constraints and `nosniff`.
    - A wrong key, `/p/<key>/site/%2e%2e/project.json`, `/p/<key>/site/..%5Cproject.json`, `/p/<key>/site/.env` and `/p/<key>/nope/` each return 404.
    - A Host of `localhost:<port>` returns 404.
  - Push: after a new `run.stopped` row, a client that sent `project.boards` gets a fresh `project.boards` within 2 s.

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/city-server.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - The `/p/` route runs before `resolveStatic`. It splits key, project and rest, and decodes once.
  - Then it checks `isProtected` and `resolveInSandbox` against `workDir`.
  - The content type comes from the existing `TYPES` table.
  - `previewKey = randomBytes(16).toString("hex")`.
  - In `tick`, when `changed.runs` is set or a polled row is a `report` tool row, broadcast `project.boards` to clients that asked for boards at least once. Keep that set as `boardWatchers`.

- [ ] **Step 4: Run** `npx vitest run packages/cli`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: project board messages and a locked preview route`.

### Task 4: Projects part in the software house

**Files:**
- Create: `packages/client/src/ui/projects.ts`
- Modify:
  - `packages/client/src/ui/building-panel.ts`: a fourth slot `projects`, shown only for `software`, built once per `show`.
  - `packages/client/src/ui/index.ts`: route the three server messages, and send `project.boards` when the software house opens.
  - `packages/client/src/ui/style.css`
- Test: `packages/client/test/hub-ui.test.ts`

**Interfaces:**
- Consumes the Task 1 to Task 3 message shapes.
- Produces `class ProjectsView`:
  - `constructor(parent: HTMLElement, send: (m: ClientMsg) => void, scanPorts: () => void)`
  - `setBoards(b: BoardSummary[])`
  - `setBoard(m: ProjectBoardMsg)`
  - `setFile(m: ProjectFileMsg)`
  - `setPorts(p: Array<{port: number; title: string}>)`
- Tabs are `Plan`, `Preview`, `Files`, `Activity`. The last tab per project is stored with `saveFolded("project-tab-<id>", …)`. If `fold.ts` holds booleans only, add `loadText` and `saveText` next to them.

- [ ] **Step 1: Write the failing tests** in a new `describe("projects view")`.
  - `setBoards` with `site` (1 of 2, busy) and `pong` (0 of 0) shows rows with "1 of 2 steps" plus a busy dot, and "no plan yet".
  - Clicking `site` sends `{type:"project.open", projectId:"site"}`.
  - `setBoard`:
    - The Plan tab lists 2 steps with labels `done` and `open`.
    - The Preview tab holds one iframe with `sandbox === "allow-scripts"` and `src` ending `/p/<key>/site/`.
    - The Files tab lists entries. Clicking `index.html` sends `project.file`.
    - `setFile` with text `<b>x</b>` puts it in a `pre` as text, with no `b` element.
  - With `hasIndex: false`, the Preview tab shows "no index.html" and the port buttons.
  - `files.error` "folder not found" shows as text, and the other tabs still work.
  - A second `setBoard` for the same project keeps the same iframe element.
  - Back returns to the list.
  - `setBoards` while `site` is open sends `project.open` for `site` again, so the open board refreshes.

- [ ] **Step 2: Run** `npx vitest run packages/client`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `ProjectsView` with the `el` helper from `dom.ts`, and wire it into `BuildingPanel` and `index.ts`.

- [ ] **Step 4: Run** `npm run build`, then `npx vitest run`. Expected: clean build, all tests pass.

- [ ] **Step 5: Browser check.** Restart the `city` preview server. Open `http://127.0.0.1:4321/` and walk into the software house.
  - The `pong` project shows its Breakout page in the frame.
  - The Files tab lists `index.html`.

- [ ] **Step 6: Commit** `feat: projects in the software house`.
