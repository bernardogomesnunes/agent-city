# Decisions and alerts

Sub-project A of the agentcraft gap list. Sub-projects B (control and resume), C (library and world views) and D (safety and sim) get their own specs.

## Goal

Everything that waits on the player sits in one queue, answered oldest first from one panel. The city tells the player when something new waits: a desktop notification, a bell, an agent at a podium with a "!", and a lamp on each agent's nameplate.

## What waits on the player today

| Kind | Source | Answered with |
|---|---|---|
| approval | `WebApprovals` pending ids, sent as `CityState.approvals` | `approve {id, decision}` |
| question | a worker or team task with status `blocked` | `task.answer {taskId, text}` |
| merge | a task with status `approval` | `review.answer {taskId, option, text?}` |

These three stay the only sources. The answer messages stay as they are, so the scheduler and the approval code do not change.

## The queue (server)

- A new module `packages/cli/src/decisions.ts` exports `listDecisions(input): DecisionView[]`. It is a pure function: input is the pending approvals, every project's tasks and the agent names. Output is sorted by `since`, oldest first, ties by id.
- `DecisionView` (zod schema in `protocol.ts`):
  - `id: string`: `a:<approvalId>`, `q:<taskId>` or `m:<taskId>`.
  - `kind: "approval" | "question" | "merge"`.
  - `projectId`, `agentId` (the agent who waits: the approval's agent, the task's assignee), `taskId?`, `approvalId?`.
  - `title`: the tool and its args preview for an approval, the task title otherwise.
  - `text`: the blocked reason for a question, the task summary for a merge, empty for an approval.
  - `since`: ISO time. An approval uses the time the server first saw its id. A task uses its `updatedAt`.
- The server sends `{type: "decisions", list: DecisionView[]}` to every client on connect and whenever the list changes. Change is checked after every board change and every approval change. The server compares the new list's ids and order with the last one sent and sends only on a difference.
- Tasks of every project count, watched or not. The approval ids keep their own first-seen time in a map in `city-server.ts`, dropped when the id leaves.
- The list holds at most 200 entries. The rest wait outside it and enter as earlier ones leave.

## The panel (client)

- A new `packages/client/src/ui/decisions.ts` exports `DecisionsPanel`. It shows one decision, the oldest, and a line "1 of N".
- J opens it when game keys are enabled (the same rule as T, C and H). Esc closes it through the overlay stack. The HUD counter opens it on click.
- Each kind shows:
  - approval: agent name, project, tool, args preview, estimated cost. Buttons Approve and Deny.
  - question: agent name, task title, the question. A text box and Answer.
  - merge: agent name, task title, summary, the diff (sent with `diff.request`, drawn with the board's diff renderer). A text box, and Merge, Request changes, Reject.
- A button sends its existing message. The panel then shows the next decision as soon as the server's new list arrives. Until then the buttons are disabled and the line says "sending…".
- An error (`review.result` with `ok: false`, or `error`) shows under the buttons and re-enables them.
- With no decisions the panel says "Nothing waits on you" and J closes it.
- "Skip" moves to the next decision without answering. The skipped one stays in the server list.

## HUD

- The `approvals: N` and `reviews: N` counters become one `decisions: N`, highlighted above 0.
- A bell toggle sits next to it. Its state lives in `localStorage` under `agentcity.bell`, default on. Storage errors leave it on.

## Alerts

- Desktop notification: when the list gains an id the client has not seen and `document.hidden` is true, the client shows `new Notification("Agent City", {body: "<agent>: <title>"})`. The first J press or HUD click asks for permission with `Notification.requestPermission()`. A denied or missing API shows nothing.
- Bell: a new id plays a short tone made with the Web Audio API (one 880 Hz sine, 150 ms), when the bell is on. No audio file.
- At page load, ids already in the first list count as seen. They make no sound and no notification.

## Podium and "!"

- A podium prop stands at tile (23, 10), on the plaza right of the HQ door (20, 9). It blocks walking. Its art is a new 16 by 16 pixel tile in the existing GBA style, drawn in code like the other props.
- Spots in front of it: (22, 11), (23, 11), (24, 11), then (21, 12), (22, 12), (23, 12), (24, 12), (25, 12). Agents take them in decision order. An agent beyond 8 stays at its building.
- An agent with at least one decision walks to its spot, faces up, and shows a "!" sprite above its head. It walks back to its building slot when it has none left.
- An agent inside a room (the room scene) shows the "!" there and does not walk.
- The podium logic lives in a pure function `podiumSpots(decisions, agents): Map<agentId, Point>` in `packages/client/src/actors.ts`, so it is tested without Phaser.

## Lamps

- Each agent nameplate gets a 4 by 4 pixel lamp left of the name. Color by `lampOf(agent, decisions, tasks)`:
  - yellow `#e0b020`: the agent has a decision.
  - red `#c03030`: a task assigned to the agent is in `doing` or `review` with `ci: "fail"`. Every blocked task is already a question, so blocked shows yellow.
  - green `#30a040`: activity is anything but `idle` and `stopped`.
  - grey `#808080`: otherwise.
- Yellow wins over red, red over green.
- `lampOf` is a pure function in `actors.ts`.

## Error handling

- The panel never assumes the decision it shows still exists. A server list without it moves the panel to the new oldest one.
- An approval answered elsewhere (dock, HQ pane) leaves the list the same way.
- Notification and audio failures are caught and ignored.

## Testing

- `decisions.ts`: sort order, the three kinds, ids, the 200 cap, an approval's first-seen time kept across calls.
- city-server: a client gets `decisions` on connect and after a task enters approval; no second message when nothing changed.
- `DecisionsPanel` (jsdom): J opens it, each kind's buttons send the right message, "1 of N", Skip, the empty state, buttons disabled until the new list.
- HUD: one counter, bell toggle saved.
- Alerts: a new id with `document.hidden` calls a stubbed `Notification`; ids from the first list do not.
- `podiumSpots` and `lampOf`: spot order, the cap of 8, color priority.
- A browser check: a goal on the scratch pong project reaches approval, the agent walks to the podium, J opens the merge, Merge empties the queue.

## Out of scope

- Answering a decision from the podium by walking up to the agent.
- Decisions for chat turns without a project (their tools never ask for approval).
- A night view or building lamps.
