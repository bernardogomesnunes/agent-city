import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import fs from "node:fs";
import { FileAuthProvider, mcpAuthFile } from "./mcp-auth.js";
import { z } from "zod";
import type { AnyTool } from "@agentcity/core";
import type { McpServer } from "@agentcity/safety";

export const MCP_OUTPUT_CHARS = 20_000;
const CONNECT_MS = 20_000;
const CALL_MS = 120_000;
const MAX_NAME = 64;
const SECRET_REF = /secret:([a-z0-9-]{1,32})/g;
/** Env and header names that must hold a secret: reference, never a literal value. */
export const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/** The project allowlist entry that grants every tool of a server. */
export const mcpGrant = (server: string): string => `mcp__${server}__*`;

/** mcp__<server>__<tool>, with characters models refuse replaced, cut to 64 characters with a hash when longer. */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${server}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (name.length <= MAX_NAME) return name;
  const hash = createHash("sha256").update(tool).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_NAME - 9)}_${hash}`;
}

/** Replaces every secret:<name> in the value. Throws when a named secret is not stored. */
export function fillSecrets(value: string, secrets: Record<string, string>, where: string): string {
  return value.replace(SECRET_REF, (_m, name: string) => {
    const v = secrets[name];
    if (v === undefined) throw new Error(`${where} needs secret ${name}. Run: agentcity secrets set ${name}`);
    return v;
  });
}

/** Names in env or headers that hold a literal value where a secret: reference belongs. */
export function literalSecrets(s: Pick<McpServer, "env" | "headers">): string[] {
  return Object.entries({ ...s.env, ...s.headers })
    .filter(([k, v]) => SENSITIVE_NAME.test(k) && !/secret:[a-z0-9-]/.test(v))
    .map(([k]) => k);
}

interface ContentItem { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }

/** Turns an MCP tool result into text. Images and binary resources become short placeholders. */
export function resultText(content: ContentItem[]): string {
  const parts = content.map((c) => {
    if (c.type === "text") return c.text ?? "";
    if (c.type === "image" || c.type === "audio") return `[${c.type} ${c.mimeType ?? ""}]`.replace(" ]", "]");
    if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
    if (c.type === "resource_link") return `[resource ${(c as { uri?: string }).uri ?? ""}]`;
    return JSON.stringify(c);
  });
  const text = parts.join("\n");
  return text.length > MCP_OUTPUT_CHARS ? text.slice(0, MCP_OUTPUT_CHARS) + `\n[output cut at ${MCP_OUTPUT_CHARS} characters]` : text;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_r, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms))),
  ]);
};

function httpHeaders(server: McpServer, secrets: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.headers)) headers[k] = fillSecrets(v, secrets, `MCP server ${server.name}`);
  return headers;
}

async function open(server: McpServer, secrets: Record<string, string>, home?: string): Promise<Client> {
  const where = `MCP server ${server.name}`;
  const client = new Client({ name: "agentcity", version: "0.1.0" });
  if (server.command !== undefined) {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [k, v] of Object.entries(server.env)) env[k] = fillSecrets(v, secrets, where);
    await withTimeout(client.connect(new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "ignore" })), CONNECT_MS, `${where} start`);
  } else {
    // A server signed in from HQ uses its stored tokens, refreshed as needed.
    const authProvider = home !== undefined && fs.existsSync(mcpAuthFile(home, server.name)) ? new FileAuthProvider(home, server.name, undefined) : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: httpHeaders(server, secrets) }, authProvider });
    try {
      await withTimeout(client.connect(transport), CONNECT_MS, `${where} connect`);
    } catch (e) {
      if (e instanceof UnauthorizedError || /\b401\b/.test(String(e))) throw new Error(`${where} needs a sign-in. Open HQ, MCP tab, and press Sign in.`);
      throw e;
    }
  }
  return client;
}

/** Connected MCP servers and their tools, wrapped for the agent loop. Tier 2 (asks) unless the server allows the tool. */
export class McpHub {
  private constructor(
    private readonly clients: Client[],
    readonly tools: AnyTool[],
  ) {}

  /** Connects every server. A server that fails is skipped and reported through `warn`. */
  static async connect(servers: McpServer[], secrets: Record<string, string>, warn: (line: string) => void, home?: string): Promise<McpHub> {
    const clients: Client[] = [];
    const tools: AnyTool[] = [];
    await Promise.all(
      servers.map(async (server) => {
        let client: Client | undefined;
        try {
          client = await open(server, secrets, home);
          const listed = await withTimeout(client.listTools(), CONNECT_MS, `MCP server ${server.name} tool list`);
          clients.push(client);
          for (const t of listed.tools) tools.push(wrap(server, client, t));
        } catch (e) {
          await client?.close().catch(() => undefined);
          warn(`MCP server ${server.name} skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return new McpHub(clients, tools);
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close().catch(() => undefined)));
  }
}

/**
 * Starts the sign-in for an HTTP MCP server. `signedIn: true` when stored tokens already work.
 * Otherwise `onUrl` got the server's sign-in address, and `finish(code)` completes it with the code the callback receives.
 */
export async function startMcpSignIn(
  home: string,
  server: McpServer,
  secrets: Record<string, string>,
  redirectUrl: string,
  onUrl: (url: URL) => void,
): Promise<{ signedIn: true } | { signedIn: false; state: string; finish(code: string): Promise<void> }> {
  if (server.url === undefined) throw new Error(`MCP server ${server.name} runs locally; it has no sign-in.`);
  const provider = new FileAuthProvider(home, server.name, redirectUrl, onUrl);
  const make = () => new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: httpHeaders(server, secrets) }, authProvider: provider });
  const transport = make();
  const client = new Client({ name: "agentcity", version: "0.1.0" });
  try {
    await withTimeout(client.connect(transport), CONNECT_MS, `MCP server ${server.name} connect`);
    await client.close();
    return { signedIn: true };
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
  }
  return {
    signedIn: false,
    state: provider.stateValue,
    async finish(code: string) {
      await transport.finishAuth(code);
      const check = new Client({ name: "agentcity", version: "0.1.0" });
      await withTimeout(check.connect(make()), CONNECT_MS, `MCP server ${server.name} connect`);
      await check.close();
    },
  };
}

function wrap(server: McpServer, client: Client, t: { name: string; description?: string; inputSchema: Record<string, unknown> }): AnyTool {
  return {
    name: mcpToolName(server.name, t.name),
    description: `[${server.name}] ${t.description ?? t.name}`.slice(0, 1024),
    tier: server.allow.includes(t.name) ? 1 : 2,
    schema: z.record(z.string(), z.unknown()),
    inputSchema: t.inputSchema,
    async run(args: Record<string, unknown>, ctx) {
      const res = (await client.callTool({ name: t.name, arguments: args }, undefined, { timeout: CALL_MS, signal: ctx.signal })) as {
        content?: ContentItem[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      const text = res.content?.length ? resultText(res.content) : JSON.stringify(res.structuredContent ?? {});
      if (res.isError) throw new Error(text);
      return text;
    },
  };
}
