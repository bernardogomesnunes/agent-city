import type { ToolCall, Usage } from "./types.js";

type Base = { ts: string; projectId: string; agentId: string; runId: string; parentRunId?: string };

export type AgentEvent = Base & (
  | { type: "run.started"; goal: string; model: string; agentName: string; agentVersion: number }
  | { type: "model.call"; model: string; messageCount: number }
  | { type: "model.result"; usage: Usage; toolCallCount: number; preview?: string }
  | { type: "tool.requested"; call: ToolCall }
  | { type: "tool.result"; callId: string; name: string; outcome: "ok" | "denied" | "error"; result: string }
  | { type: "inbox"; count: number }
  | { type: "run.stopped"; reason: string; steps: number; detail?: string });

export interface EventSink { emit(e: AgentEvent): void }

export class MemorySink implements EventSink {
  events: AgentEvent[] = [];
  emit(e: AgentEvent): void {
    this.events.push(e);
  }
}
