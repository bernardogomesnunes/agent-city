import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { TerminalApprover } from "../src/approver.js";

const req = { id: 1, projectId: "p", agentId: "ada", tool: "send_message", args: { to: "a", body: "b" }, tier: 2, estimatedUsd: 0.5 };

function setup(input: string) {
  const i = new PassThrough();
  const o = new PassThrough();
  let text = "";
  o.on("data", (d: Buffer) => (text += d.toString()));
  if (input !== "") i.write(input);
  return { approver: new TerminalApprover({ input: i, output: o }, "Ada"), text: () => text, i };
}

describe("TerminalApprover", () => {
  it("y approves", async () => {
    expect(await setup("y\n").approver.decide(req)).toBe("approved");
  });
  it("yes approves", async () => {
    expect(await setup("YES\n").approver.decide(req)).toBe("approved");
  });
  it("n denies", async () => {
    expect(await setup("n\n").approver.decide(req)).toBe("denied");
  });
  it("empty line denies", async () => {
    expect(await setup("\n").approver.decide(req)).toBe("denied");
  });
  it("closed input denies", async () => {
    const s = setup("");
    s.i.end();
    expect(await s.approver.decide(req)).toBe("denied");
  });
  it("prints agent, tool name, args, tier and cost", async () => {
    const s = setup("n\n");
    await s.approver.decide(req);
    const t = s.text();
    expect(t.startsWith("Ada")).toBe(true);
    expect(t).toContain("send_message");
    expect(t).toContain("tier 2");
    expect(t).toContain("$0.5000");
    expect(t).toContain('  "to": "a"');
  });
  it("answers two prompts from two lines", async () => {
    const s = setup("y\nn\n");
    expect(await s.approver.decide(req)).toBe("approved");
    expect(await s.approver.decide(req)).toBe("denied");
  });
  it("cancel denies a waiting prompt", async () => {
    const s = setup("");
    const p = s.approver.decide(req);
    s.approver.cancel();
    expect(await p).toBe("denied");
  });
  it("a prompt after cancel returns denied without reading input", async () => {
    const s = setup("y\n");
    s.approver.cancel();
    expect(await s.approver.decide(req)).toBe("denied");
    expect(s.text()).toBe("");
  });
});
