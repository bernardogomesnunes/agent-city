// A stdio MCP server for tests. Tools: echo, fail, env (prints FAKE_TOKEN).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));
server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "it broke" }],
  isError: true,
}));
server.registerTool("env", { description: "Show FAKE_TOKEN", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: `token=${process.env.FAKE_TOKEN ?? "none"} path=${process.env.PATH ? "set" : "none"} other=${process.env.OTHER_SECRET ?? "none"}` }],
}));
await server.connect(new StdioServerTransport());
