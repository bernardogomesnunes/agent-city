import type { ChatRequest } from "../types.js";

const TOOL_HELP = [
  "TOOLS",
  "You can call one or more tools. To call a tool, write exactly:",
  '<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>',
  "When the task is done, answer in plain text with no tool call.",
].join("\n");

const callText = (name: string, args: unknown): string => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

/**
 * Turns a chat request into text for `claude -p`: the system text (system message plus the tool list)
 * and the transcript. Earlier tool calls appear in the same `<tool_call>` form the model is told to write.
 */
export function renderClaudePrompt(req: ChatRequest): { system: string; prompt: string } {
  const systemParts = req.messages.filter((m) => m.role === "system").map((m) => m.content);
  if (req.tools.length > 0) {
    const list = req.tools.map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`);
    systemParts.push(`${TOOL_HELP}\n\n${list.join("\n")}`);
  }
  const blocks: string[] = [];
  for (const m of req.messages) {
    if (m.role === "user") blocks.push(`USER:\n${m.content}`);
    else if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c) => `\n${callText(c.name, c.args)}`).join("");
      blocks.push(`ASSISTANT:\n${m.content}${calls}`);
    } else if (m.role === "tool") blocks.push(`TOOL RESULT (${m.name}, ${m.toolCallId}):\n${m.content}`);
  }
  return { system: systemParts.join("\n\n"), prompt: blocks.join("\n\n") };
}
