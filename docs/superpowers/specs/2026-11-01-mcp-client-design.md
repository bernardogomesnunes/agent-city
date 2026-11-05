# MCP client design

## Goal

Agents use the tools of any MCP server the user adds, so one client covers email, files, video platforms, code hosts and the rest. Part 1 of the personal agents plan: MCP client, web tools, generic API tool, media and documents, money.

## Config

`config.json` gains `mcpServers`, a list of:

| Field | Meaning |
|---|---|
| `name` | `a-z 0-9 -`, up to 24 characters |
| `command`, `args` | stdio server |
| `url` | Streamable HTTP server. Exactly one of `command` and `url`. |
| `env`, `headers` | Values may hold `secret:<name>`, filled from `secrets.json` at start |
| `allow` | Tool names that run without asking |

`mcp add` refuses a literal value for any env or header name matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH`.

## Granting

A project grants a server with the allowlist entry `mcp__<server>__*`. The gate's allowlist now accepts entries ending in `*` as a prefix match.

## Runtime

- `McpHub.connect(servers, secrets, warn)` in `cli/src/mcp.ts` starts every granted server in parallel with a 20 s limit. A server that fails or misses a secret is skipped with one warning line.
- stdio servers get the SDK's default environment (PATH, HOME and similar) plus their own `env`. Other secrets in the user's environment stay out.
- Each MCP tool becomes an `AnyTool` named `mcp__<server>__<tool>` (unsafe characters become `_`, names over 64 characters are cut and get an 8-character hash). Its JSON schema goes to the model unchanged through the new optional `Tool.inputSchema`.
- Tier 2 (asks) by default, tier 1 when the tool is in the server's `allow` list.
- A call has a 120 s limit and stops on the run's abort signal. Text content is joined. Images, audio and binary resources become placeholders. Output is cut at 20000 characters. `isError` results come back to the agent as tool errors.
- `TreeRunner.run` connects the hub before the top run, shares its tools with child runs, and closes every server when the run ends.
- Tool output passes through the action log's secret redaction like every other tool.

## CLI

`mcp add | list | remove | tools | allow | ask | grant | revoke`.

## SDK

`@modelcontextprotocol/sdk` 1.32.1, exact, released 2026-10-05.

## Testing

`cli/test/mcp.test.ts` with `fixtures/fake-mcp.mjs`, a stdio server with `echo`, `fail` and `env` tools: naming, secret fill, literal key refusal, content to text, wildcard allowlist, tool calls, env isolation, skipped servers, the CLI commands, an agent run where the allowed tool runs and another asks, and a project without the grant.
