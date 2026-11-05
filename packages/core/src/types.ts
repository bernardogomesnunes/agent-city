export interface ToolCall { id: string; name: string; args: unknown }
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface Usage { inputTokens: number; outputTokens: number }
export interface ChatRequest { model: string; messages: Message[]; tools: ToolSpec[]; maxTokens: number; signal?: AbortSignal }
export interface ChatResponse { text: string; toolCalls: ToolCall[]; usage: Usage }
export interface Provider { id: string; chat(req: ChatRequest): Promise<ChatResponse> }
export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "stop"; reason: string };
