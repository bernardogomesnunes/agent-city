// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CityState, SessionMessageView, SessionView } from "@agentcity/world/shared";
import { Dock } from "../src/ui/dock.js";

const state: CityState = {
  agents: [
    { id: "boss", name: "Bo", role: "boss", building: "software", activity: "idle", buildingId: "hq" },
    { id: "ada", name: "Ada", role: "worker", building: "software", activity: "writing", buildingId: "software" },
  ],
  plots: [],
  approvals: [{ id: 9, projectId: "game", agentId: "ada", tool: "run_command", argsPreview: "npm test", tier: 2, estimatedUsd: 0, local: true }],
  runs: [],
};
const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: 1, projectId: "game", agentId: "boss", title: "", status: "idle", queued: 0, last: "Bo: menu built", lastTs: "2026-11-01T10:00:00.000Z", ...over,
});
const msg = (id: number, kind: SessionMessageView["kind"], text: string, over: Partial<SessionMessageView> = {}): SessionMessageView => ({
  id, sessionId: 1, ts: "2026-11-01T10:00:00.000Z", kind, author: kind === "user" ? "you" : "boss", text, status: "done", ...over,
});

let send: ReturnType<typeof vi.fn<(m: unknown) => boolean>>;
let dock: Dock;
const q = <T extends Element>(sel: string) => dock.root.querySelector<T>(sel)!;
const button = (label: string) => [...dock.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  send = vi.fn(() => true);
  dock = new Dock(document.body, { send: send as never, projects: () => [{ id: "game", agents: ["boss", "ada"] }, { id: "site", agents: [] }] });
  dock.render(state);
});

describe("Dock", () => {
  it("starts folded, opens on the bar and remembers it", () => {
    expect(dock.isOpen).toBe(false);
    expect(dock.root.classList.contains("folded")).toBe(true);
    q<HTMLElement>(".dock-bar").click();
    expect(dock.isOpen).toBe(true);
    const again = new Dock(document.body, { send: send as never, projects: () => [] });
    expect(again.isOpen).toBe(true);
  });

  it("lists every chat with its title and agent, and the latest in the folded bar", () => {
    dock.setSessions([
      session({ title: "build the menu" }),
      session({ id: 2, agentId: "ada", title: "tests", status: "waiting", queued: 1, last: "you: tests", lastTs: "2026-11-01T11:00:00.000Z" }),
    ]);
    expect(q(".dock-summary").textContent).toContain("Ada · game: waiting for project");
    const rows = [...dock.root.querySelectorAll(".dock-session")].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("tests");
    expect(rows[0]).toContain("Ada · game");
    expect(rows[0]).toContain("waiting for project");
    expect(rows[1]).toContain("build the menu");
    expect(rows[1]).toContain("Bo · game");
  });

  it("two chats of one agent are two rows; a chat without a title says New chat; no project says so", () => {
    dock.setSessions([
      session({ title: "menu" }),
      session({ id: 2, title: "colours", lastTs: "2026-11-01T11:00:00.000Z" }),
      session({ id: 3, projectId: undefined, title: "", lastTs: "2026-11-01T09:00:00.000Z" }),
    ]);
    const rows = [...dock.root.querySelectorAll(".dock-session")];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("colours");
    expect(rows[1].textContent).toContain("menu");
    expect(rows[2].textContent).toContain("New chat");
    expect(rows[2].textContent).toContain("Bo · no project");
  });

  it("New chat picks a project or none, Cancel returns to the list, Start sends session.new", () => {
    dock.open("chat");
    button("+ New chat").click();
    expect([...q<HTMLSelectElement>(".new-project").options].map((o) => o.value)).toEqual(["", "game", "site"]);
    button("Cancel").click();
    expect(dock.root.querySelector(".new-project")).toBeNull();
    button("+ New chat").click();
    button("‹ Back").click();
    expect(dock.root.querySelector(".new-project")).toBeNull();
    button("+ New chat").click();
    q<HTMLSelectElement>(".new-agent").value = "ada";
    button("Start").click();
    expect(send).toHaveBeenCalledWith({ type: "session.new", agentId: "ada" });
    button("+ New chat").click();
    q<HTMLSelectElement>(".new-project").value = "game";
    q<HTMLSelectElement>(".new-agent").value = "boss";
    button("Start").click();
    expect(send).toHaveBeenLastCalledWith({ type: "session.new", agentId: "boss", projectId: "game" });
  });

  it("openNew sends session.new and shows the chat once the server answers with its id", () => {
    dock.openNew("ada", "game");
    expect(send).toHaveBeenCalledWith({ type: "session.new", agentId: "ada", projectId: "game" });
    expect(dock.openChatId).toBeNull();
    dock.setThread(7, [{ id: 1, sessionId: 7, ts: "2026-11-01T10:00:00.000Z", kind: "user", author: "you", text: "hello ada", status: "done" }]);
    expect(dock.openChatId).toBe(7);
    expect(q(".dock-log").textContent).toContain("hello ada");
  });

  it("openRef sends session.new with taskId and shows the new chat", () => {
    dock.openRef({ agentId: "ada", projectId: "game", taskId: "t1" });
    expect(send).toHaveBeenCalledWith({ type: "session.new", agentId: "ada", projectId: "game", taskId: "t1" });
    expect(dock.isOpen).toBe(true);
    expect(dock.openChatId).toBeNull();
    dock.setThread(8, []);
    expect(dock.openChatId).toBe(8);
    dock.openRef({ agentId: "boss", projectId: "game", goalId: "g1" });
    expect(send).toHaveBeenLastCalledWith({ type: "session.new", agentId: "boss", projectId: "game", goalId: "g1" });
  });

  it("openSession sends session.open with the id; Message opens the newest chat of the agent, or starts one", () => {
    dock.setSessions([
      session({ id: 4, agentId: "ada", title: "old", lastTs: "2026-11-01T08:00:00.000Z" }),
      session({ id: 5, agentId: "ada", title: "newer", lastTs: "2026-11-01T12:00:00.000Z" }),
    ]);
    dock.openAgent("ada", "game");
    expect(send).toHaveBeenLastCalledWith({ type: "session.open", sessionId: 5 });
    expect(dock.openChatId).toBe(5);
    dock.openAgent("site-bot", "site");
    expect(send).toHaveBeenLastCalledWith({ type: "session.new", agentId: "site-bot", projectId: "site" });
    dock.openSession(4);
    expect(send).toHaveBeenLastCalledWith({ type: "session.open", sessionId: 4 });
    expect(dock.openChatId).toBe(4);
  });

  it("shows the thread by kind, queued messages, and the project's approvals", () => {
    dock.setSessions([session({ status: "working", queued: 1 })]);
    dock.openSession(1);
    dock.setThread(1, [
      msg(1, "user", "build the menu"),
      msg(2, "system", "Bo handed 'menu' to Ada"),
      msg(3, "report", "half way"),
      msg(4, "agent", "menu built"),
      msg(5, "user", "now colours", { status: "queued" }),
    ]);
    const kinds = [...dock.root.querySelectorAll(".dock-log .dock-msg")].map((m) => m.className.replace("dock-msg ", ""));
    expect(kinds).toEqual(["user", "system", "report", "agent", "user", "approval-line"]);
    expect(q(".dock-msg.report").textContent).toBe("Bo: half way");
    dock.onMessage(msg(7, "agent", "use **W/S**"));
    expect([...dock.root.querySelectorAll(".dock-msg.agent strong")].map((b) => b.textContent)).toEqual(["W/S"]);
    expect([...dock.root.querySelectorAll(".dock-msg.user .dock-meta")].map((m) => m.textContent)).toEqual(["queued"]);
    expect(q(".dock-thread-status").textContent).toBe("working, 1 queued");
    expect(q<HTMLElement>(".dock-stop").hidden).toBe(false);
    button("Approve").click();
    expect(send).toHaveBeenCalledWith({ type: "approve", id: 9, decision: "approved" });
    button("Stop").click();
    expect(send).toHaveBeenCalledWith({ type: "run.stop", projectId: "game" });
    // A new message for the open thread shows at once.
    dock.onMessage(msg(6, "agent", "colours changed"));
    expect(dock.root.querySelectorAll(".dock-msg.agent")).toHaveLength(3);
  });

  it("Enter sends and clears, Shift+Enter does not send, a state tick keeps the draft", () => {
    dock.setSessions([session({ id: 4 })]);
    dock.openSession(4);
    const box = q<HTMLTextAreaElement>(".dock-input");
    box.value = "draft";
    dock.render({ ...state, runs: [] });
    expect(q<HTMLTextAreaElement>(".dock-input").value).toBe("draft");
    q<HTMLTextAreaElement>(".dock-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session.send" }));
    q<HTMLTextAreaElement>(".dock-input").value = "build the menu";
    q<HTMLTextAreaElement>(".dock-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(send).toHaveBeenCalledWith({ type: "session.send", sessionId: 4, text: "build the menu" });
    expect(q<HTMLTextAreaElement>(".dock-input").value).toBe("");
  });

  it("the terminal tab tells its owner, and folding hides it again", () => {
    const shown: boolean[] = [];
    const d = new Dock(document.body, { send: send as never, projects: () => [], onTerminal: (s) => shown.push(s) });
    d.open("terminal");
    expect(d.terminalPane.hidden).toBe(false);
    d.fold();
    expect(shown).toEqual([true, false]);
  });
});
