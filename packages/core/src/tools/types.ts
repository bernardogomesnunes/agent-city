import { z } from "zod";
import type { GateDecision, ToolCall, ToolSpec, Usage } from "../types.js";

export interface ToolContext {
  projectId: string; agentId: string; sandboxDir: string; outboxDir: string; runId?: string; depth?: number; signal?: AbortSignal;
  /** Set by run-agent. A tool calls it after a success that ends the run: the run stops after this tool's result and makes no further model call. */
  endRun?(): void;
}

export interface Tool<A> {
  name: string;
  description: string;
  tier: 0 | 1 | 2 | 3;
  schema: z.ZodType<A>;
  estimateUsd?(args: A): number;
  /** JSON schema sent to the model in place of one built from `schema`. Tools from MCP servers set it. */
  inputSchema?: Record<string, unknown>;
  run(args: A, ctx: ToolContext): Promise<string>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

export interface ToolGate {
  checkModelCall(req: { model: string; estimatedInputTokens: number }): Promise<GateDecision>;
  recordUsage(model: string, usage: Usage): Promise<void>;
  checkTool(call: ToolCall, tool: AnyTool): Promise<GateDecision>;
}

export function toolSpec(t: AnyTool): ToolSpec {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? (z.toJSONSchema(t.schema) as Record<string, unknown>),
  };
}
