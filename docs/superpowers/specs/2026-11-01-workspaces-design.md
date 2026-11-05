# Workspaces design

## Goal

Agents work on the user's real projects: an existing folder or git repo, with tools to find, read and change files and to run commands. Web access is a later spec.

## Decisions (from the user)

- Commands: a per-project safe list runs without asking. Every other command asks. `git push` always asks.
- Edits: each project has `edits: "auto" | "ask"`. A linked git repo starts on `auto`, a folder without git on `ask`. Protected patterns always ask. Deletes always ask. `run --ask-edits` makes one run ask for every edit.
- Git: each top run in a linked git repo switches to a new branch `agent/<agent>-YYYYMMDD-HHMMSS` (suffix `-2`, `-3` when the name exists). A folder with uncommitted changes refuses the run with `workspace_dirty`.

## Config

`ProjectConfig` gains four fields. Old `project.json` files parse with the defaults.

| Field | Default |
|---|---|
| `workspace?: string` | unset: tools work in the sandbox |
| `edits` | `"auto"` |
| `protectedPaths` | `.env*`, `.git/**`, `.github/**` |
| `safeCommands` | `npm test`, `npm run test`, `npm run build`, `npm run lint`, `npm run typecheck`, `git status`, `git diff`, `git log`, `git show`, `git add`, `git commit` |

## Tools (core)

| Tool | Tier | Behavior |
|---|---|---|
| `list_files` | 0 | Recursive, sorted, folders end in `/`, skips `.git`, `node_modules` and links, 1000 lines max. |
| `search_files` | 0 | JS regex per line, optional glob, skips binary and files over 1 MB, 200 matches max. |
| `edit_file` | 1 | Literal replace. `old` must appear once unless `replaceAll`. |
| `delete_file` | 2 | One file, never a folder. |
| `run_command` | 2 | Shell in the folder, timeout 120 s (max 600), last 20000 characters of output, kills the process tree on timeout or abort, drops credential env names. |

All path tools go through `resolveInSandbox` with the folder as the root, so paths outside it, links out of it and UNC paths fail.

## Gate

`effectiveTier(config, name, args, baseTier, askEdits)` in `safety/src/policy.ts` sets the tier the gate uses:

- `write_file`, `edit_file`: tier 2 when edits are `ask`, the run asks, or `isProtected(path)`. A path that leaves the folder counts as protected.
- `run_command`: tier 1 when `isSafeCommand`: no shell operator from `; & | < > \` $ ( ) ^ % !` or a line break, not `git push`, and equal to a safe entry or the entry plus a space and more arguments.

## Runner and CLI

- `TreeRunner` uses `workspace ?? sandbox` as the tool folder, passes the run signal to tools, prepares the branch before the top run, logs `workspace.branch`, and tells the agent its folder and branch in the system prompt.
- CLI: `init --path`, `project link|unlink|show|edits|safe|protect`, `run --ask-edits`. `workspace_dirty` and `workspace_git` print their detail and exit 1. The city reports them on the run's terminal line.

## Limits

- A safe command such as `npm test` runs the project's own scripts, which can do anything the user can do. The safe list trusts the project.
- `git commit` runs the repo's hooks.
- Commands run with the user's permissions. There is no OS sandbox.

## Testing

`core/test/workspace-tools.test.ts`, `safety/test/policy.test.ts`, `cli/test/workspace.test.ts`: glob and path rules, each tool, timeouts and abort, the env filter, every ask rule, branch per run, the dirty-folder refusal and the project commands.
