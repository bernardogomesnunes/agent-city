// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFileView, LogRow, TaskView } from "@agentcity/world/shared";
import { MAX_ROWS, renderThread, since } from "../src/ui/task-thread.js";

const T = "2026-11-04T10:00:00.000Z";
const NOW = Date.parse("2026-11-04T10:06:30.000Z");
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: "t1", goalId: "g1", parentId: "team", projectId: "gamenew", title: "Fix broken index.html", description: "", assignee: "ada", deps: [],
  status: "doing", branch: "agent/ada-fix-index", worktree: null, summary: null, blockedReason: null, ci: "none", testOutput: null,
  checkpoint: null, held: false, createdBy: "mgr", createdAt: T, updatedAt: T, ...over,
});
const row = (kind: LogRow["kind"], text: string): LogRow => ({ ts: T, agentId: "ada", kind, text });

let box: HTMLElement;
let send: ReturnType<typeof vi.fn<(m: unknown) => boolean>>;
const q = <E extends Element>(sel: string) => box.querySelector<E>(sel)!;
const button = (label: string) => [...box.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const draw = (t: TaskView, log: LogRow[], opts = {}) => renderThread(box, t, log, send as never, { agentName: "Ada", role: "worker", now: NOW, ...opts });

beforeEach(() => {
  document.body.innerHTML = "";
  box = document.createElement("div");
  document.body.append(box);
  send = vi.fn(() => true);
});

describe("renderThread", () => {
  it("text rows render as reasoning blocks, tool rows as boxed blocks with name and one-line result, error rows red", () => {
    draw(task(), [
      row("text", "Checking which file the build outputs."),
      row("tool", "read_file src/index.html"),
      row("result", "42 lines"),
      row("tool", "run"),
      row("error", "npm test failed"),
    ]);
    expect(q(".tt-think").textContent).toContain("Ada thinks");
    expect(q(".tt-think").textContent).toContain("Checking which file");
    const tools = [...box.querySelectorAll(".tt-tool")];
    expect(tools).toHaveLength(2);
    expect(tools[0]!.querySelector(".tt-who")!.textContent).toBe("read_file");
    expect(tools[0]!.querySelector(".tt-result")!.textContent).toBe("src/index.html · 42 lines");
    expect(tools[1]!.querySelector(".tt-who")!.textContent).toBe("run");
    expect(q(".tt-error").textContent).toContain("npm test failed");
  });

  it("a blocked task's question renders an amber block with an answer box that sends task.answer", () => {
    draw(task({ status: "blocked", blockedReason: "Open the preview?" }), []);
    expect(q(".tt-ask").textContent).toContain("Ada asks you");
    expect(q(".tt-ask").textContent).toContain("Open the preview?");
    q<HTMLInputElement>(".tt-answer-input").value = "yes";
    button("Answer").click();
    expect(send).toHaveBeenCalledWith({ type: "task.answer", taskId: "t1", text: "yes" });
    expect(q<HTMLInputElement>(".tt-answer-input").value).toBe("");
  });

  it("no question block when the task is not blocked", () => {
    draw(task(), []);
    expect(box.querySelector(".tt-ask")).toBeNull();
  });

  it("a half-typed answer survives a redraw", () => {
    const t = task({ status: "blocked", blockedReason: "why?" });
    draw(t, []);
    q<HTMLInputElement>(".tt-answer-input").value = "half";
    draw(t, [row("text", "more")]);
    expect(q<HTMLInputElement>(".tt-answer-input").value).toBe("half");
  });

  it("more than 200 rows renders the last 200", () => {
    const log = Array.from({ length: 250 }, (_, i) => row("text", `step-${i};`));
    draw(task(), log);
    expect(box.querySelectorAll(".tt-think")).toHaveLength(MAX_ROWS);
    expect(box.textContent).not.toContain("step-49;");
    expect(box.textContent).toContain("step-50;");
    expect(box.textContent).toContain("step-249;");
    expect(q(".tt-cut").textContent).toContain("250");
  });

  it("header shows title, agent, branch and step count", () => {
    draw(task(), [row("tool", "read_file a"), row("tool", "run")]);
    expect(q(".tt-title").textContent).toBe("Fix broken index.html");
    expect(q(".tt-sub").textContent).toContain("Ada · worker");
    expect(q(".tt-sub").textContent).toContain("branch agent/ada-fix-index");
    expect(q(".tt-steps").textContent).toBe("step 2 · 6 min");
  });

  it("started: and stopped: text rows render as a gray city line, not as reasoning", () => {
    draw(task(), [row("text", "started: fix the page"), row("text", "thinking"), row("text", "stopped: done, 3 steps")]);
    const city = [...box.querySelectorAll(".tt-city")].map((c) => c.textContent);
    expect(city).toEqual(["city: started: fix the page", "city: stopped: done, 3 steps"]);
    expect(box.querySelectorAll(".tt-think")).toHaveLength(1);
    expect(box.querySelector(".tt-error")).toBeNull();
  });

  it("a failed stop (error row starting with stopped:) stays a red error block", () => {
    draw(task(), [row("error", "stopped: budget, 3 steps")]);
    expect(q(".tt-error").textContent).toContain("stopped: budget, 3 steps");
    expect(box.querySelector(".tt-city")).toBeNull();
  });

  it("the header age and step count start at the last run's first row, not at createdAt", () => {
    const at = (iso: string, kind: LogRow["kind"], text: string): LogRow => ({ ts: iso, agentId: "ada", kind, text });
    draw(task(), [
      at("2026-11-04T10:00:10.000Z", "text", "started: first run"),
      at("2026-11-04T10:00:20.000Z", "tool", "run a"),
      at("2026-11-04T10:05:30.000Z", "text", "started: second run"),
      at("2026-11-04T10:05:40.000Z", "tool", "run b"),
    ]);
    expect(q(".tt-steps").textContent).toBe("step 1 · 1 min");
  });

  it("the actions:false option leaves out Retry, Cancel and the diff; answerBox:false leaves out the answer input", () => {
    draw(task({ status: "blocked", blockedReason: "why?" }), [], { actions: false, answerBox: false });
    expect(box.querySelector(".tt-actions")).toBeNull();
    expect(box.querySelector(".tt-diff")).toBeNull();
    expect(box.querySelector(".tt-answer-input")).toBeNull();
    expect(q(".tt-ask").textContent).toContain("why?");
  });

  it("the back link calls its handler", () => {
    const go = vi.fn();
    draw(task(), [], { back: { label: "‹ gamenew", go } });
    button("‹ gamenew").click();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("Pause sends task.action pause; a held task shows Resume", () => {
    draw(task(), []);
    button("Pause").click();
    expect(send).toHaveBeenCalledWith({ type: "task.action", taskId: "t1", action: "pause" });
    draw(task({ held: true }), []);
    expect(box.textContent).not.toContain("Pause");
    button("Resume").click();
    expect(send).toHaveBeenLastCalledWith({ type: "task.action", taskId: "t1", action: "resume" });
  });

  it("Open chat calls the chat hook with the assignee and taskId", () => {
    const chat = vi.fn();
    draw(task(), [], { chat });
    button("Open chat").click();
    expect(chat).toHaveBeenCalledWith({ agentId: "ada", projectId: "gamenew", taskId: "t1" });
  });

  it("Open chat uses chatAgent when the task has no assignee", () => {
    const chat = vi.fn();
    draw(task({ assignee: null }), [], { chat, chatAgent: "mgr" });
    button("Open chat").click();
    expect(chat).toHaveBeenCalledWith({ agentId: "mgr", projectId: "gamenew", taskId: "t1" });
  });

  it("Retry, Cancel, Roll back and the diff stay under the thread", () => {
    const file: DiffFileView = {
      path: "src/a.ts", status: "modified", additions: 1, deletions: 0, truncated: false,
      hunks: [[{ kind: "add", text: "new line", newNo: 1 }]],
    };
    draw(task({ status: "blocked", blockedReason: "stuck", checkpoint: "abc" }), [], { diff: [file] });
    const order = [...box.children].map((c) => c.className.split(" ")[0]);
    expect(order.indexOf("tt-foot")).toBeLessThan(order.indexOf("tt-actions"));
    expect(order.indexOf("tt-actions")).toBeLessThan(order.indexOf("tt-diff"));
    button("Retry").click();
    expect(send).toHaveBeenLastCalledWith({ type: "task.action", taskId: "t1", action: "retry" });
    button("Cancel").click();
    expect(send).toHaveBeenLastCalledWith({ type: "task.action", taskId: "t1", action: "cancel" });
    send.mockClear();
    button("Roll back").click();
    expect(send).not.toHaveBeenCalled();
    expect(q(".tt-confirm").textContent).toContain("Undo the last run's changes?");
    button("Yes").click();
    expect(send).toHaveBeenCalledWith({ type: "task.action", taskId: "t1", action: "rollback" });
    expect(q(".tt-diff .diff-add").textContent).toContain("new line");
  });

  it("no Roll back without a checkpoint; a done task has no Pause", () => {
    draw(task({ status: "done" }), []);
    expect(box.querySelector(".tt-rollback")).toBeNull();
    expect(box.textContent).not.toContain("Pause");
  });

  it("the progress stays at the bottom when it was at the bottom, and keeps its place when scrolled up", () => {
    const t = task();
    const geometry = (el: HTMLElement, top: number): void => {
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
      el.scrollTop = top;
    };
    draw(t, [row("text", "a")]);
    geometry(q<HTMLElement>(".tt-progress"), 800);
    draw(t, [row("text", "a"), row("text", "b")]);
    const p = q<HTMLElement>(".tt-progress");
    expect(p.scrollTop).toBe(p.scrollHeight);
    geometry(p, 100);
    draw(t, [row("text", "a"), row("text", "b"), row("text", "c")]);
    expect(q<HTMLElement>(".tt-progress").scrollTop).toBe(100);
  });
});

describe("an approval task's actions", () => {
  const approval = () => task({ status: "approval", checkpoint: null });
  const note = (text: string) => {
    q<HTMLInputElement>(".tt-review-input").value = text;
  };

  it("Merge sends review.answer with option merge", () => {
    draw(approval(), []);
    button("Merge").click();
    expect(send).toHaveBeenCalledWith({ type: "review.answer", taskId: "t1", option: "merge" });
  });

  it("Merge sends the typed note as text", () => {
    draw(approval(), []);
    note("looks right");
    button("Merge").click();
    expect(send).toHaveBeenCalledWith({ type: "review.answer", taskId: "t1", option: "merge", text: "looks right" });
  });

  it("Send back sends review.answer with option changes and the typed note", () => {
    draw(approval(), []);
    note("make it blue");
    button("Send back").click();
    expect(send).toHaveBeenCalledWith({ type: "review.answer", taskId: "t1", option: "changes", text: "make it blue" });
  });

  it("Send back with no note sends nothing, as in the Inbox", () => {
    draw(approval(), []);
    button("Send back").click();
    expect(send).not.toHaveBeenCalled();
  });

  it("Reject sends review.answer with option reject", () => {
    draw(approval(), []);
    button("Reject").click();
    expect(send).toHaveBeenCalledWith({ type: "review.answer", taskId: "t1", option: "reject" });
  });

  it("the note survives a redraw", () => {
    draw(approval(), []);
    note("keep me");
    draw(approval(), []);
    expect(q<HTMLInputElement>(".tt-review-input").value).toBe("keep me");
  });

  it("a doing task has no merge buttons", () => {
    draw(task({ status: "doing" }), []);
    expect(box.querySelector(".tt-review-input")).toBeNull();
    expect([...box.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Merge");
  });
});

describe("since", () => {
  it("formats minutes, hours and days", () => {
    expect(since(T, NOW)).toBe("6 min");
    expect(since(T, Date.parse(T) + 5_000)).toBe("just now");
    expect(since(T, Date.parse(T) + 3 * 3_600_000)).toBe("3 h");
    expect(since(T, Date.parse(T) + 50 * 3_600_000)).toBe("2 d");
  });
});
