# Agent City part 4: World (pixel village) design

Date: 2026-10-31. Source brief: `AGENT-CITY-BRIEF.md`, build order step 4. Builds on parts 1 and 2. Visual direction: `docs/superpowers/notes/part4-world-direction.md`.

## Goal

`agentcity city` opens a pixel village in the browser. Agents walk to the building that matches what they are doing. The user walks an avatar around, enters buildings, approves requests at HQ, starts runs and types `agentcity` commands in a terminal panel. Agents can ask to build new buildings on empty plots.

## Decisions

| Topic | Decision |
|---|---|
| Shell | Web app on localhost. `agentcity city` starts the server and opens the browser. |
| Renderer | Phaser 3 (`phaser@3.90.0`), bundled with Vite. |
| Art | Original pixel art drawn in code: each 16x16 tile or sprite is a text grid plus a palette, turned into textures at boot. No Nintendo or Game Freak assets, fonts, names or music. |
| Start buildings | 4: Director's house, HQ, software house, visual house. Plus 6 empty plots. |
| Entering | A walking avatar (arrows or WASD) moves one hidden 16 px grid step at a time, like GBA-era monster RPGs. Stepping onto a door fades to black and opens that building's room as its own map. Stepping onto the room's exit mat fades back to the town, in front of the door. |
| Roofs | Key `R` and a button hide every roof in the town, showing each building's inside and the agents at their desks from outside. |
| Growth | A tier 2 `build` tool. An agent asks for a plot and a kind, the user approves, the building appears. |
| Terminal panel | Runs `agentcity` subcommands only, in the server process. No system shell. |
| Data flow | Hybrid. The server reads new log rows every 250 ms, so runs from any terminal show up. Runs started in the city run inside the server and their approvals show at HQ. |
| Deferred | Chat with agents and talking to the Boss (part 5). Day and night, daily rhythm (part 5). Sound. Mobile layout. |

## Packages

| Package | Job | Imports |
|---|---|---|
| `world` (new) | Turns log rows, approvals and plots into city state. Pure functions plus a row poller. No UI. | core, safety |
| `client` (new) | Browser app: Phaser scenes, art, roofs, avatar, HUD, HQ panel, terminal panel. Built by Vite into `packages/client/dist`. | phaser only. Talks to the server over a websocket. Shares protocol types from `world` as type-only imports. |
| `cli` | New `city` command: HTTP server for static files, websocket, run host. | world, org, safety, core |
| `safety` | `city_plots` table, `build` tool gate rules. | core |
| `org` | `building` field on agent profiles, `build` tool factory. | core |

## The map

- 16x16 tiles drawn at 3x scale. Map is 40 x 30 tiles. Camera follows the avatar.
- Layers, bottom to top: ground (grass, path, water, plot dirt), floor (inside buildings), objects (walls, desks, trees, fences, signs), actors (agents, avatar), roofs.
- The map is a TypeScript module with a character grid per layer and a building table. Pure data, unit tested.
- Building table entry: `{ id, name, kind, x, y, w, h, door: {x, y}, slots: Array<{x, y}> }`. Slots are desk tiles where agents stand inside.

| Building | Id | Size (tiles) | Slots | Purpose |
|---|---|---|---|---|
| Director's house | `director` | 7 x 6 | 2 | Boss home. |
| Headquarters | `hq` | 11 x 8 | 6 | Approvals, delegation, planning. Opens the HQ panel when entered. |
| Software house | `software` | 8 x 6 | 4 | Code and file work. |
| Visual house | `visual` | 8 x 6 | 4 | Design and visual work. |
| Plots 1 to 6 | `plot-1` ... | 6 x 5 each | 3 once built | Fenced dirt until built. |

- Built kinds: `library`, `workshop`, `exchange`, `studio`, `house`. Each kind has its own wall color and sign.
- Pathing: A* on walkable tiles in the client. Walls block. Doors are walkable. Agents walk 4 tiles per second.

### Rooms

- Each building has a room map: `{ id, w, h, floor: string[], exit: {x, y}, slots: Array<{x, y}> }` in `shared/rooms.ts`. Sizes: `director` 10x8, `hq` 14x10, `software` 12x9, `visual` 12x9, each plot kind 10x8.
- Room floor chars: `.` floor, `#` wall, `D` desk (blocks), `P` plant (blocks), `R` rug, `E` exit mat. Slots are floor tiles next to a desk, same count as the town building's slots.
- Entering: town door tile, then fade out 250 ms, room scene with the avatar on the tile above `E` facing up, fade in 250 ms. Leaving: stepping on `E`, fade, town with the avatar one tile below the door facing down.
- Agents whose `buildingId` matches the room stand at room slots. Agents walking to or from the building are only drawn in the town.

### Movement

- Hidden grid of 16 px tiles. Every step moves exactly one tile with a tween (avatar 8 tiles per second walking, 16 running with Shift).
- 4 facing directions. A tap shorter than 100 ms turns in place without stepping.
- The walk frame alternates on each step. A blocked step plays the walk frame without moving.
- Agents move the same way along their A* route, 4 tiles per second. Idle agents inside a room step to a free slot every 4 to 8 s.

## World state (package `world`)

```ts
export type BuildingId = "director" | "hq" | "software" | "visual" | `plot-${1|2|3|4|5|6}`;
export type AgentActivity = "idle" | "thinking" | "reading" | "writing" | "messaging" | "delegating" | "remembering" | "building" | "waiting_approval" | "stopped";

export interface AgentView { id: string; name: string; role: "boss" | "manager" | "worker"; building: "software" | "visual"; activity: AgentActivity; buildingId: BuildingId; projectId?: string; runId?: string; lastText?: string }
export interface PlotView { id: `plot-${number}`; kind?: "library" | "workshop" | "exchange" | "studio" | "house"; builtBy?: string }
export interface ApprovalView { id: number; projectId: string; agentId: string; tool: string; argsPreview: string; tier: number; estimatedUsd: number; local: boolean }
export interface CityState { agents: AgentView[]; plots: PlotView[]; approvals: ApprovalView[] }

export function applyRow(state: CityState, row: ActionRow, ctx: MapCtx): CityState;  // pure
export class RowPoller { constructor(db, onRows: (rows: ActionRow[]) => void, intervalMs = 250); start(): void; stop(): void }
```

### Event to activity and building

| Log row | Activity | Building |
|---|---|---|
| `run.started` | thinking | work building |
| `model.call` | thinking | stays |
| `tool.requested` `read_file` | reading | work building |
| `tool.requested` `write_file` | writing | work building |
| `tool.requested` `send_message` | messaging | hq |
| `tool.requested` `delegate` | delegating | hq |
| `tool.requested` `remember` | remembering | home |
| `tool.requested` `build` | building | hq |
| pending approval for the agent | waiting_approval | hq |
| `run.stopped` | idle (stopped for 5 s first) | home |

- Home: `director` for the boss, `hq` for managers, the work building for workers.
- Work building: the profile `building` field (`software` default, or `visual`). When a built plot matches the activity, the agent goes there first: `library` for reading, `workshop` for writing, `studio` for visual agents.
- `lastText`: the first 60 chars of the tool name and main argument (file path, target agent), redacted. Shown in a bubble over the agent.
- Agents with no rows yet stand idle at home. All agents in `AgentStore` appear.

## Server (`agentcity city`)

- Options: `--port <n>` (default 4321), `--no-open`.
- Binds `127.0.0.1` only. Prints the URL with a random 32-hex-char token: `http://127.0.0.1:4321/?t=<token>`.
- Serves files from `packages/client/dist` only. Path traversal is rejected.
- Websocket at `/ws`. The upgrade is refused unless the `t` query param matches the token and `Origin` equals `http://127.0.0.1:<port>`.
- On connect, sends `snapshot`. Then sends `patch` messages as rows arrive.

### Protocol (JSON over websocket)

Server to client:
- `{ type: "snapshot", state: CityState }`
- `{ type: "patch", agents?: AgentView[], plots?: PlotView[], approvals?: ApprovalView[] }`, changed entries only.
- `{ type: "term.out", text: string }`, `{ type: "term.done", code: number }`
- `{ type: "error", message: string }`

Client to server:
- `{ type: "approve", id: number, decision: "approved" | "denied" }`: only for approvals with `local: true`.
- `{ type: "run", projectId: string, agentId: string, goal: string }`: starts a run in the server with a `TreeRunner`.
- `{ type: "term.in", line: string }`: one terminal line.
- Messages are validated with zod. Invalid ones get an `error` reply.

### Runs inside the server

- Same `TreeRunner` as `agentcity run`, with a web approver in place of the line approver.
- The web approver marks requests `local: true` and waits for an `approve` message. No timeout. Ctrl+C on the server denies all waiting ones and aborts runs.
- One run at a time per project. A second `run` for a busy project gets `error: project busy`.

### Terminal panel

- Each line is split into argv with double-quote support. A leading `agentcity` is optional.
- Runs the same commander program in-process with output sent as `term.out`. One command at a time.
- Refused: `city` (no nesting) and anything that is not a known subcommand.
- y/n prompts from commands (`agent memory --clear`) read the next `term.in` line.
- `run` from the terminal panel uses the web approver, so approvals show at HQ.

## Build tool

- Tool `build`, tier 2, in `org`: args `{ plot: 1..6, kind: "library" | "workshop" | "exchange" | "studio" | "house" }`.
- Gate checks in order: plot taken gives deny `plot_taken`. Then the normal tier 2 approval.
- On success it writes `city_plots(plot INTEGER PRIMARY KEY, kind TEXT, project_id TEXT, agent_id TEXT, ts TEXT)`. Rows are insert-only.
- The result text is `built <kind> on plot <n>`. The city shows a short build animation (dust, then the building).
- `init` does not add `build` to `allowedTools`. The user adds it per project.

## Client

- Scenes: `Boot` (makes textures from art grids), `Village` (map, actors, input), `Hud` (roof button, status line).
- HTML overlays on top of the canvas, styled as GBA dialog boxes (white box, dark blue border, monospace font):
  - HQ panel (opens on stepping onto the HQ room's front desk tile, or key `H` anywhere): tabs Approvals, Agents, Start run.
  - Terminal panel (key backtick): output area and one input line.
  - Agent card (click an agent): name, role, activity, last text, project.
- Approvals tab: a list with Approve and Deny buttons for `local` ones. Non-local ones say "answer in your terminal".
- Agents tab: list from the snapshot. Agent creation stays a terminal command (`agent create`) in the terminal panel.
- Start run tab: project select, agent select, goal text box, Start button.
- Keyboard focus: while a text box has focus, game keys are off.
- Reconnect: on socket close, retry every 2 s and show "offline" in the HUD.

## Art

- Palette of at most 32 colors close to the GBA look: bright greens, warm path tan, red and blue roofs, soft dark outlines.
- Each sprite is a `string[]` of 16 rows, 16 chars, one char per palette index, `.` for transparent.
- Tiles: grass (2 variants), tall grass, path (straight, corner, cross), water (2 frames), tree (2x2), flower, fence, plot dirt, sign, wall, door, floor, desk, roof pieces (edge, middle, ridge).
- Characters: 4 directions x 2 walk frames, with palette swaps for the avatar, boss, managers and workers.
- A test checks every grid is 16x16 and uses only palette chars.

## Errors and edge cases

- Port in use: print `port <n> in use, try --port` and exit 1.
- Missing `client/dist`: print `client not built, run npm run build` and exit 1.
- An agent deleted from the store keeps no sprite. Rows for unknown agents are ignored.
- Rows are read in id order from the last seen id. The first poll reads only the last 500 rows, to set current activity.
- A browser tab with a wrong token sees an error page and no state.

## Testing

- `world`: `applyRow` for every row in the mapping table, home and work rules, built plot preference, stopped then idle after 5 s (fake clock), unknown agent ignored, redaction of `lastText`.
- `world`: `RowPoller` with a temp db reads only new rows in order.
- `cli` server: wrong token refused, wrong origin refused, snapshot on connect, patch after an appended row, `approve` for local approval resolves the run, `approve` for non-local is refused, `run` on busy project gives error, path traversal gives 404, terminal runs `agent list` and refuses `city`.
- `safety`/`org`: `build` denied `plot_taken`, approved build writes one row, `city_plots` insert-only.
- `client`: map grids sized right, every building door reachable from the avatar start by A*, art grids valid, roof toggle state logic, argv split.
- Manual check in the browser pane: village renders, avatar walks through the HQ door and the HQ room fades in, walking out returns to the town, `R` hides all roofs, a FakeProvider run makes an agent walk to the software house.

## Done when

- All tests, typecheck and lint pass.
- `agentcity city` opens the village. A live LM Studio run started from the HQ panel shows the boss, manager and worker walking to their buildings, and a `build` request approved at HQ adds a building to a plot.

## Out of scope

Chat, avatar conversations, day and night, sound, multiplayer, mobile, system shell, agents creating agents, saving camera or avatar position.
