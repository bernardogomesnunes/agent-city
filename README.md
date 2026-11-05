# Agent City

Part 1: a CLI that runs one agent at a time inside a safety gate. Every tool call passes the gate, and every step lands in an action log.

## Setup

Needs Node 22 or newer.

    npm run setup

This installs, builds and links the `agentcity` command.

Anthropic models: store the key once. The prompt hides the input.

    agentcity secrets set anthropic

LM Studio models: start the LM Studio server on port 1234 (`http://localhost:1234/v1`) and load a model. Use the id `lmstudio/<model name>`.

Data lives in `~/.agentcity`. Set `AGENTCITY_HOME` to use another folder.

## Quick start

    agentcity init demo
    agentcity agent create ada --name Ada --role worker --model lmstudio/qwen/qwen3-14b --persona "You are Ada, a careful assistant."
    agentcity grant demo ada
    # put notes.txt in ~/.agentcity/projects/demo/sandbox
    agentcity run demo --agent ada "Read notes.txt, write a one-line summary to summary.txt, then send it to test@example.com with send_message."
    agentcity log demo

Reads run without a prompt. Writes inside the sandbox run without a prompt. `send_message` asks `Approve? [y/N]`. Answer `n` and the outbox stays empty.

## Commands

| Command | Effect |
|---|---|
| `agentcity init <project>` | Creates the project folder, sandbox, outbox and default config. |
| `agentcity agent create <id> --name <name> [--role boss\|manager\|worker] [--model <id>] --persona <text>` | Creates an agent profile, version 1. `--persona-file <path>` replaces `--persona`. Default model `claude-haiku-5-5`. |
| `agentcity agent edit <id> [--name] [--role] [--model] [--persona\|--persona-file]` | Saves a new version of the profile. |
| `agentcity agent list` | Lists agents. |
| `agentcity agent show <id> [--version <n>]` | Prints a profile, current or an old version. |
| `agentcity grant <project> <agent>` | Lets the agent work in the project. |
| `agentcity revoke <project> <agent>` | Removes that access. |
| `agentcity run <project> "<goal>" --agent <id> [--model <id>]` | Runs the agent. Ctrl-C denies pending approvals and logs `interrupted`. |
| `agentcity log <project> [--tail]` | Prints every logged step. `--tail` follows new rows. |
| `agentcity kill <project>` | Turns the kill switch on. Every gate check stops. |
| `agentcity unkill <project>` | Turns it off. |
| `agentcity secrets set <provider>` | Stores a provider key. |

## Teams

A boss delegates to a manager, the manager to a worker. Each hand-off is one `delegate` call and one nested run. `init` enables `delegate` and `remember` for new projects. Projects created before part 2 need `delegate` and `remember` added to `allowedTools` in `project.json` by hand. Only `init` adds them.

    agentcity init demo
    agentcity agent create boss --name Boss --role boss --model lmstudio/qwen/qwen3-14b --persona "Delegate the goal to mgr, then report its answer."
    agentcity agent create mgr --name Mgr --role manager --model lmstudio/qwen/qwen3-14b --persona "Delegate the task to ada, then report her answer."
    agentcity agent create ada --name Ada --role worker --model lmstudio/qwen/qwen3-14b --persona "Do the task with write_file, then reply done."
    agentcity grant demo boss
    agentcity grant demo mgr
    agentcity grant demo ada
    agentcity run demo --agent boss "Delegate to mgr: ada must call write_file with path hello.txt and content hello from the team."

Delegation limits default to depth 3, 0.5 USD per tree and 10 child runs. Each agent keeps notes in `agents/<id>/memory/notes.md`, written with the `remember` tool.

| Command | Effect |
|---|---|
| `agentcity agent memory <id> [--clear]` | Prints the agent notes. `--clear` asks, then empties them. |
| `agentcity log <project> --tree` | Groups rows by run. Each `run <runId> <agentId>` header is indented 2 spaces per delegation level. |

Approvals must answer a prompt that is on screen. Lines typed or piped before a prompt appears are dropped, so `printf 'y\ny' | agentcity run ...` does not pre-approve. `log --tree` and `--tail` cannot be combined.

## Your own projects

A project can work in an existing folder in place of its sandbox. Agents then list, search, read, write, edit and delete files there, and run commands in it.

    agentcity init site --path C:\code\my-site
    agentcity grant site ada
    agentcity run site --agent ada "Fix the broken link in index.html, run npm test, then commit."

In a git repo, each run first switches to a new branch `agent/<agent>-<date>-<time>`, so `main` changes only when you merge. A run refuses to start while the folder has uncommitted changes. A folder without git gets no branch.

What asks you first:

| Action | Asks when |
|---|---|
| `write_file`, `edit_file` | The project's edit mode is `ask` (default for folders without git), the run has `--ask-edits`, or the path matches a protected pattern (default `.env*`, `.git/**`, `.github/**`). |
| `delete_file` | Always. |
| `run_command` | The command is not on the safe list, holds a shell operator (`; & \| < > $ ( )` and others), or is `git push`. Default safe list: `npm test`, `npm run test`, `npm run build`, `npm run lint`, `npm run typecheck`, `git status`, `git diff`, `git log`, `git show`, `git add`, `git commit`. A safe entry also covers the same command with more arguments. |
| `list_files`, `search_files`, `read_file` | Never. |

Commands run in the folder through cmd.exe on Windows and sh elsewhere, stop after 120 s by default, return the last 20000 characters of output, and never see environment variables whose names hold KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL.

| Command | Effect |
|---|---|
| `agentcity init <project> --path <folder>` | Creates a project that works in the folder. |
| `agentcity project link <project> <folder>` | Links an existing project to a folder and adds any missing built-in tools. |
| `agentcity project unlink <project>` | Goes back to the sandbox. |
| `agentcity project show <project>` | Prints the folder, edit mode, protected patterns and safe commands. |
| `agentcity project edits <project> auto\|ask` | Sets the edit mode. |
| `agentcity project safe <project> add\|remove "<command>"` | Changes the safe list. |
| `agentcity project protect <project> add\|remove "<pattern>"` | Changes the protected patterns. |
| `agentcity project branches <project>` | Lists agent branches with work main lacks. |
| `agentcity project merge <project> <branch>` | Merges an agent branch into main (or master) with a merge commit. Refuses uncommitted changes; a conflict aborts and changes nothing. |
| `agentcity run ... --ask-edits` | Every write and edit asks in this run. |

## MCP servers

Agents can use the tools of any MCP server: Gmail, Google Drive, GitHub, Notion, YouTube and others. Add a server once, then grant it to a project.

    agentcity secrets set github
    agentcity mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=secret:github -- npx -y @modelcontextprotocol/server-github
    agentcity mcp tools github
    agentcity mcp allow github search_repositories
    agentcity mcp grant site github

Every MCP tool asks you first. `mcp allow` lets one tool run without asking; use it for tools that only read. Tools reach the agent as `mcp__<server>__<tool>`. A run starts only the servers its project is granted and stops them when it ends. A server that fails to start is skipped with a warning line.

Keys never go in `config.json`. An `--env` or `--header` value whose name holds KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL or AUTH must be `secret:<name>`, filled from `agentcity secrets set <name>` when the server starts. A stdio server sees only the basic system environment plus its own `--env` values.

| Command | Effect |
|---|---|
| `agentcity mcp add <name> [--env NAME=VALUE]... -- <command> [args]` | Adds a server that runs as a local program. |
| `agentcity mcp add <name> --url <url> [--header NAME=VALUE]...` | Adds a Streamable HTTP server. |
| `agentcity mcp list` / `remove <name>` | Lists or removes servers. |
| `agentcity mcp tools <name>` | Starts the server and lists its tools, with `runs` or `asks`. |
| `agentcity mcp allow\|ask <name> <tool>` | Lets a tool run without asking, or makes it ask again. |
| `agentcity mcp grant\|revoke <project> <name>` | Gives a project's agents the server's tools, or takes them away. |

A web MCP server that uses OAuth (Gmail, Drive and most hosted servers) signs in from HQ: MCP tab, Sign in. The service's own login page opens in a new tab and sends you back to the city. No password passes through Agent City. Tokens stay in `~/.agentcity/mcp-auth/<name>.json`, readable by your user only, and refresh on their own.

## Skills

A skill is a named set of instructions, stored in `~/.agentcity/skills/<name>/SKILL.md`. Attach skills to an agent; its prompt lists them by name and description, and the agent loads one with the `use_skill` tool when a task needs it.

    agentcity skill add cover-letter --description "Write a cover letter for a job" --file cover-letter.md
    agentcity agent edit ada --skills cover-letter

| Command | Effect |
|---|---|
| `agentcity skill add <name> --description <text> --text <text>\|--file <path>` | Adds or replaces a skill. |
| `agentcity skill list` / `show <name>` / `remove <name>` | Lists, prints or removes skills. |

## City

A pixel village in the browser shows the agents at work. Each agent walks to the building for what it does: HQ for delegating, messaging, building and approvals, the software or visual house for work, plots for what the team builds.

    npm run build
    agentcity city

`city` prints a URL such as `http://127.0.0.1:4321/?t=<32 hex chars>` and opens it. Plain `http://127.0.0.1:4321` also works as a bookmark: the server puts the token in the page it serves, only to requests for that exact host. The server binds 127.0.0.1 only. The websocket rejects any request without the token or from another origin. Default port 4321.

The token lives in `<home>/city-token` and stays the same across restarts, so a page left open reconnects on its own once the city runs again. Agents, projects, sessions and the log live in the home folder too, so a restart keeps them. A message that was running when the city stopped gets the line "stopped: city restarted"; queued messages run after the restart.

The Claude subscription (`claude-sub/` models) runs the local `claude` program on your own Claude sign-in, so it needs no API key. HQ, Configure, APIs shows its state: not installed, not signed in, or ready. Install opens a console window that runs `npm i -g @anthropic-ai/claude-code`; Sign in opens one that runs `claude`, where your browser asks you to approve once. The city finds `claude` on PATH, in `~/.local/bin` (the official installer) and in the npm global folder, so a city started before the install finds it too. Until it is ready, the model dropdown marks the group, and a run says what to click. `agentcity claude status`, `install` and `signin` do the same from a terminal.

On Windows the page can start the city itself. Run once:

    agentcity link install

This registers `agentcity://start` for your Windows user only (no admin rights). While the page is offline, the top bar shows Go online: the browser asks to open Agent City, then the city starts on the home and port `link install` saw, in its own console window. Closing that window stops the city. The link takes no settings, so a web page cannot change what it starts. `agentcity link status` shows what the link runs and names any path that no longer exists (after moving the repo or reinstalling Node, run `link install` again). `agentcity link remove` unregisters it.

| Key | Effect |
|---|---|
| Arrows or WASD | Step the avatar one tile. |
| Shift | Run. |
| Door tile | Walk onto it to enter a building. |
| Exit mat | Walk onto it inside a room to leave. |
| `R` | Show or hide roofs. |
| `H` | Open or close HQ. |
| `C` | Open or fold the chat in the bottom dock. |
| `T` or backtick | Open or fold the terminal in the bottom dock. HQ has a Terminal button too. |
| `Esc` | Close the open panel. |

HQ opens when the avatar walks into the HQ building, at its front desk, or on `H` anywhere. `H` or `Esc` closes it. A switch at top centre picks one of two modes. Each mode fills a left and a right column with containers. Each column scrolls on its own. A click on a container's header folds it, and the fold and the mode survive a reload. While HQ is open the run panel and the preview step aside.

| Mode | Left column | Right column |
|---|---|---|
| Work | Approvals (approve or deny pending tool calls), Projects (runs going on, agent branches with a Merge button) | Activity (the last 30 actions), Performance (runs, share finished, tool calls and spend per agent over 7 days), City (7-day totals and runs per day), Buildings (the view of any building) |
| Configure | Agents (create or edit: name, role, house, model, persona, skills, projects), Projects (create, link folders, edits auto or ask), Skills (add or remove) | APIs (OpenAI-compatible connections; a key typed here is stored as the secret `api-<name>` and never shown again), MCP servers (add, sign in, allow or ask per tool, give to a project) |

Agents, APIs and MCP servers each show a list of what exists. Its Add button turns the container into the form, and Back or Cancel returns to the list. A save also returns to the list, with the result on top. Work numbers come from the action log and refresh every 5 s while HQ is open. Activity text goes through the same secret redaction as the log. An approval answered from any open tab resolves for all tabs.

The bottom dock is always there as a bar, folded at first. Its Chat tab holds the conversations with agents: one session per agent and project, for example Boss on Game New. New run picks a project and an agent and opens that session. A message starts a turn. A message sent while the agent works waits as queued and starts the next turn. A project runs one agent tree at a time, so a session on a busy project shows "waiting for project" until it is free. Each turn the agent sees your earlier messages and its earlier answers, without tool calls. Its answer lands in the thread. Agents post progress with the `report` tool, and handing work to another agent adds a line when it starts and ends. Approvals for the project show in the thread too. Enter sends, Shift+Enter adds a line. In a linked git repo a session keeps one branch across its turns until that branch is merged. The agent card has a Message button that opens the agent's session. The Terminal tab holds the terminal.

The top right shows each run in progress: goal, agents, steps, the tool in use, the last result, time and cost. Stop aborts the run and denies its waiting approvals.

Walk up to a building, or face it, and a sign names it and says what it is for. Inside, a panel shows the building's work. The software house lists its developers, their runs, the agent branches waiting to merge with a Merge button, and a preview frame for local web servers: Find servers checks the usual dev ports (3000, 5173, 8080 and others). The director's house shows the team by role. Plots show what they hold: skills in the library, projects in the workshop, costs in the exchange, MCP servers in the studio.

The terminal panel runs `agentcity` commands only, for example `agent list` or `log demo`. `city` is refused inside the terminal.

Agents build with the `build` tool, args `{plot, kind}`. Plots are 1 to 6. Kinds: library, workshop, exchange, studio, house. `build` is tier 2 and asks for approval. Add `build` to `allowedTools` in the project's `project.json`, alongside `delegate`, `remember` and `write_file`. Choose an agent's house with `agentcity agent create <id> --building visual`. Default `software`.

## Models

Each agent has one model. Set it with `agent create --model`, `agent edit --model`, or the model list on the agent card in the city.

| Source | Model id | Example | Cost in the budget |
|---|---|---|---|
| Claude subscription | `claude-sub/<sonnet\|opus\|haiku\|claude-*>` | `claude-sub/sonnet` | 0 USD, tokens still count |
| LM Studio | `lmstudio/<id>` | `lmstudio/qwen/qwen3-14b` | 0 USD |
| OpenAI-compatible URL | `api/<connection>/<model>` | `api/groq/llama-3.3-70b` | The connection price |
| Anthropic API | a `claude-*` id | `claude-haiku-5-5` | `prices` in `config.json` |

Add an OpenAI-compatible connection (OpenAI, Groq, Together, Ollama and others):

    agentcity connection add groq https://api.groq.com/openai/v1 --input-price 0.59 --output-price 0.79
    agentcity secrets set api-groq

A connection with no price stops every run with `unknown_model_price`. A connection with no key sends no `Authorization` header. `connection list` and `connection remove <name>` manage the list.

The Claude subscription runs your own `claude` program. Install it with `npm i -g @anthropic-ai/claude-code`, then run `claude` once and log in. Each agent step runs `claude -p` with Claude Code's own tools, MCP servers and settings turned off. Agent City never reads or stores your Claude login. Use it only with your own plan on your own machine: Anthropic does not allow apps to route other people's use through a subscription ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). These terms may change. Set `claudePath` in `config.json` if `claude` is not on your PATH.

New projects allow `claude-haiku-5-5`, `lmstudio/*`, `claude-sub/*` and `api/*`. For a project made before this, add `"claude-sub/*"` and `"api/*"` to `allowedModels` in its `project.json`.

## Safety defaults

- `maxSteps` 20 per run.
- Provider retries: 2, with waits of 1000 ms and 4000 ms.
- Auto-approve is off.
- Budget: 1.0 USD and 200000 tokens per project, 0.5 USD per agent.
- A missing or invalid project config stops every gate check with `config_invalid`.
- Secrets never enter messages or events. Logged payloads show `[secret]`.

## Tests

    npm run typecheck
    npm run lint
    npm test

Unit tests make no network calls. Live tests need a running provider:

    AGENTCITY_LIVE=1 AGENTCITY_LMSTUDIO_MODEL=<loaded model> npx vitest run packages/cli/test/live.live.test.ts

The Anthropic live test skips when no key is stored.
