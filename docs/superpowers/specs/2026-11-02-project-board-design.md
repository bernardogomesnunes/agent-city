# Project board in the software house

## Goal

The software house shows each project: its plan, how far the plan got, a preview, its files and its recent activity.
Today the house shows developers, branches to merge and a port scan. Plans exist only as chat lines, so the player cannot see what a team is doing or what it made.

## Decisions taken with the player

- Plan steps tick automatically from delegations. Agents get no new tool.
- The preview shows the project's own `index.html` first, then port buttons for running servers.
- Every view is read-only. Changes still go through chat with the agents.
- The data comes from the action log. No new table.

## 1. Board data (`packages/world/src/board.ts`)

`projectBoard(log rows, projectId, agents) -> ProjectBoard`, a pure function over action rows of one project.

### Plan

- The plan is the latest `tool.requested` row with tool `report` whose text starts with `Plan:` (any case).
- Steps come from the numbered items in that text: `1.` or `1)` followed by text, up to the next number or the end.
- A plan needs 2 to 8 steps. Text with fewer or more is not a plan. Each step text is cut to 120 characters.
- The plan author is the agent of that row. Its run id is the plan run.

### Step states

- Each later `tool.requested` row with tool `delegate` from the plan author, in the plan run's tree, fills the next open step in order.
- Delegations past the last step are ignored.
- A filled step is `working` until its child run logs `run.stopped`.
  - Reason `done` makes it `done`, any other reason makes it `failed`.
  - The step keeps the child agent id and the stop reason.
- A step is also `failed` when the plan run's tree stops and its child run logged no stop of its own.
- Steps with no delegation stay `open`.
- A new plan report replaces the old plan.

### Other board fields

- `busy`: `RunHost.busy(projectId)` in the city server. Runs a restart killed are never busy.
- `activity`: the last 20 `tool.requested` rows of the project, newest first.
  - Each row gives `ts`, agent id, tool name and main argument, through the same `mainArg` and redaction the feed uses.
- `summary`: `doneCount`, `stepCount`, `busy`, and the plan author.

The city server builds boards from `ActionLog` rows of that project. It reads at most the last 2000 rows per project.

## 2. Files (`packages/cli/src/project-files.ts`)

- The root is `workDir(home, config, project)`: the linked folder, or the sandbox.
- `listFiles(root, protectedPaths)` returns a sorted tree of relative paths with sizes.
  - It skips `.git` and `node_modules` and hides paths that match `isProtected`.
  - It stops at 500 entries and sets `truncated`.
- `readFile(root, rel, protectedPaths)` resolves the path with `resolveInSandbox`, so `..`, absolute paths and links that leave the root fail.
  - Protected paths fail.
  - Files over 200 KB return the first 200 KB with `truncated: true`.
  - A file with a NUL byte in its first 8 KB returns `binary: true` and no text.

## 3. Preview

- The city serves `GET /p/<previewKey>/<project>/<path>` from the project root. An empty path serves `index.html`.
- `previewKey` is a random 16-byte hex value per city process, separate from the websocket token, because the framed page can read its own address.
- The same `resolveInSandbox` and `isProtected` checks apply. A failure is 404.
- The request must carry the Host `127.0.0.1:<port>`, the same rule as the page.
- Response headers:
  - `Content-Security-Policy: default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'`
  - `X-Content-Type-Options: nosniff`
  - A content type from the file extension.
- The client shows it in `<iframe sandbox="allow-scripts">`, with no `allow-same-origin`.
  - The page in the frame runs as an opaque origin, so it cannot read the city page, its token or the websocket.
- `project.board` carries `previewKey`. `hasIndex` on the board tells the client whether `index.html` exists.
- The existing port buttons stay under the frame.

## 4. Protocol (`packages/world/src/shared/protocol.ts`)

Client to server:

- `project.boards`: a list of summaries for every project.
- `project.open {projectId}`: the full board and file tree of one project.
- `project.file {projectId, path}`: one file.

Server to client:

- `project.boards {boards: BoardSummary[]}`
- `project.board {projectId, board: ProjectBoard, files: FileTree}`
- `project.file {projectId, path, text?, binary, truncated, error?}`

The server sends `project.boards` again whenever a feed patch changes a run or a plan of any project.
The open board refreshes on the same signal while the panel shows it.

## 5. Interface (`packages/client/src/ui/projects.ts`)

- The software house panel gets a Projects section above Developers.
- Each project row shows the id, a bar "3 of 5 steps" (or "no plan yet"), and a dot while busy.
- Clicking a row opens the project view in the same panel, with four tabs and a back button.
  - **Plan**: numbered steps with state labels open, working, done and failed, plus the agent and reason.
  - **Preview**: the frame when `hasIndex`, else "no index.html", then the port buttons.
  - **Files**: the tree. Clicking a file shows its text in a scrolling `<pre>`, built with text nodes only.
  - **Activity**: the 20 rows as time, agent, tool and target.
- The open tab is kept per project with `fold.ts` local storage.

## 6. Tests

- `board.test.ts`:
  - plan parsing (2 to 8 steps, `1.` and `1)`, case, too few and too many);
  - delegation order;
  - done, failed and interrupted steps;
  - a newer plan replacing an older one;
  - extra delegations;
  - activity order and redaction.
- `project-files.test.ts`: `..`, absolute paths, a link out of the root, protected files, 500 entries, 200 KB, binary.
- City server tests:
  - preview route 200 for `index.html` and the CSP header;
  - 404 for a wrong token, `..`, a protected file and an unknown project;
  - the three messages.
- Hub UI tests:
  - the list with its bars;
  - opening a project;
  - each tab;
  - file text rendered as text.

## Out of scope

- Editing files or plans from the panel.
- Plans that do not come from a `Plan:` report.
- Previews of linked folders that need a build step. Their running server shows through the port buttons.
