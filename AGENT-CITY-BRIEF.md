# Agent City: project brief

Starting brief for a new, standalone project. Copy this file into an empty folder, run `git init`, and start a Claude Code session there. First step in that session: run the brainstorming flow against this brief, then write a spec, then a plan. Do not write code before the spec is approved.

## Vision

A game-like city where AI agents live and work. The user has an avatar in the city, talks to agents, and watches what they do. Buildings and districts match the work being done. The agents do real work: build tools, start businesses, sell products, research, and trade stocks, configured per project.

## Hierarchy

- Boss: the agent the user talks to most. Plans, splits goals into projects, assigns and supervises Managers.
- Managers: one per project or life area. Own the goals, budget and tool set of that project. Hire and direct workers.
- Workers: specialist agents that execute tasks with tools and MCP servers.
- The hierarchy can be more than two levels deep. Any agent may delegate down, within limits set by its project.

## Decisions already made

1. New repo, fully standalone. It does not depend on AX Studio as a service. AX Studio is a separate project and stays untouched.
2. The new repo owns model connections, the agent loop, tools, MCP handling and the world simulation.
3. Code from AX Studio (MIT, same author) may be copied as a starting point, then evolves independently. Candidates: MCP client, tool-call parsing for models that write tool calls as text, context trimming to the model window, agent versioning.
4. Agents work on anything, not only code: businesses, tools, selling, trading, research, personal areas. Capabilities are configured per project.

## Model providers

One provider interface, several backends:

- Claude Code subscription, via the `claude` CLI or the Claude Agent SDK. Check Anthropic's terms for third-party apps driving a subscription before relying on this.
- Hosted APIs (Anthropic, OpenAI-compatible).
- Local models: LM Studio and Ollama, both reachable through the OpenAI-compatible HTTP format.
- Each agent chooses its model. A Boss may use a strong model while workers use cheap or local ones.

## Tools and MCP

- MCP servers are registered globally and granted per project, then per agent.
- Secrets are stored locally in a file only the user can read and are never shown to a model.
- Each tool has a risk tier:
  - Tier 0: read-only. Runs freely.
  - Tier 1: reversible writes inside a project sandbox (files, git branches). Runs freely.
  - Tier 2: outward-facing or irreversible (send email, publish, post). Needs approval.
  - Tier 3: spends money or places trades. Needs approval or an explicit budget rule.

## Safety layer (core of the design)

- Limits are enforced in code outside the model's reach. Prompts never serve as the only guard.
- Per-project config: allowed tools, allowed models, budget caps (tokens and money), per-agent spending limits, kill switch.
- Trading and purchasing start in paper or sandbox mode (for example Alpaca paper trading). Live mode is a per-project switch only the user can flip.
- Append-only action log. Every tool call, approval and spend is recorded. The log also feeds the city's event stream.
- Approval queue shown in the city as a "town hall" where the Boss brings requests to the user.
- Open decision: approve every risky action, or auto-approve below a spending limit set per project.

## The city

- Event stream: every agent action becomes an event (`reading file`, `calling MCP X`, `waiting for approval`, `idle`).
- A renderer maps events to world state: an agent walks to the building that matches its activity, and buildings appear as projects grow.
- Example mapping: coding goes to a workshop, research to a library, trading to an exchange, approvals to the town hall, idle agents to homes.
- Version 1 is 2D top-down. Reason: it tests the idea at a fraction of the cost of 3D.
- The user's avatar can walk to an agent and open a chat, or talk to the Boss from anywhere.
- Agents have persistent memory, a home, and a visible daily rhythm so the city feels lived in.

## Suggested architecture (to validate in the spec)

- `core`: provider interface, agent loop, tool runner, MCP client. No UI imports.
- `org`: Boss, Manager and Worker roles, delegation rules, project config.
- `safety`: risk tiers, budgets, approval queue, action log.
- `world`: event bus and the mapping from events to city state.
- `client`: renderer and UI (web or desktop shell, to decide).
- Persistence: local SQLite plus plain files, under a user-owned data folder.

## Open questions for the brainstorm

1. Web app on localhost, or desktop shell (Electron or Tauri)?
2. Approval default: every risky action, or auto-approve under a limit?
3. Does the Boss plan with a fixed loop, or can it rewrite the org chart itself?
4. Renderer: Phaser, PixiJS, or plain canvas for version 1?
5. How do agents keep memory across sessions, and who may edit it?
6. Legal and compliance for agents that sell products or trade: what stays manual by design?

## Suggested build order

1. Core: provider interface with one local model and one API model, a single agent running one tool.
2. Safety: risk tiers, action log and approval queue before any tool with side effects.
3. Org: Boss delegating to one Manager and one Worker.
4. World: event stream shown as a simple 2D map with one building per activity.
5. Avatar and chat with the Boss.
6. More providers, MCP grants per project, paper trading as the first real "business".

## Out of scope for version 1

3D graphics, multiplayer, live-money trading, a plugin marketplace.
