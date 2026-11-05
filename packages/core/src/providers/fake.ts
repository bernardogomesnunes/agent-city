import type { ChatRequest, ChatResponse, Provider } from "../types.js";

export class FakeProvider implements Provider {
  id = "fake";
  requests: ChatRequest[] = [];
  private script: Array<ChatResponse | Error>;

  constructor(script: Array<ChatResponse | Error>) {
    this.script = [...script];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new Error("FakeProvider script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}
