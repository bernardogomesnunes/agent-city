// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg, DecisionView, DiffFileView } from "@agentcity/world/shared";
import { Inbox } from "../src/ui/inbox.js";

const base = { projectId: "site", agentId: "ada", since: "2026-11-03T10:00:00.000Z" };
const approval: DecisionView = { ...base, id: "a1", kind: "approval", approvalId: 7, title: "bash: npm test", text: "" };
const question: DecisionView = { ...base, id: "q1", kind: "blocked", taskId: "t1", title: "Footer", text: "Which color?", since: "2026-11-03T10:01:00.000Z" };
const merge: DecisionView = { ...base, id: "m1", kind: "merge", taskId: "t2", title: "Header", text: "Added a header", since: "2026-11-03T10:02:00.000Z" };
const plan: DecisionView = { ...base, id: "p1", kind: "plan", goalId: "g1", title: "add a footer", text: "1. Markup 2. Style", since: "2026-11-03T10:03:00.000Z" };
const file: DiffFileView = { path: "a.ts", status: "modified", truncated: false, hunks: [[{ kind: "add", newNo: 1, text: "const x = 1;" }]] } as DiffFileView;

let send: ReturnType<typeof vi.fn<(m: ClientMsg) => boolean>>;
let inbox: Inbox;
let onOpen: ReturnType<typeof vi.fn<(o: boolean) => void>>;
let checkpoints: Record<string, string | null>;
let nonLocal: number[];
const text = () => inbox.root.textContent ?? "";
const cards = () => [...inbox.root.querySelectorAll<HTMLElement>(".inbox-card")];
const labels = (root: ParentNode = inbox.root) => [...root.querySelectorAll<HTMLButtonElement>(".inbox-buttons button")].map((b) => b.textContent);
const button = (label: string) => [...inbox.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const box = () => inbox.root.querySelector<HTMLTextAreaElement>("textarea")!;
const typeIn = (value: string) => {
  box().value = value;
  box().dispatchEvent(new Event("input"));
};
const sent = () => send.mock.calls.map((c) => c[0]);

beforeEach(() => {
  document.body.innerHTML = "";
  send = vi.fn(() => true);
  onOpen = vi.fn();
  checkpoints = { t1: "abc123" };
  nonLocal = [];
  inbox = new Inbox(document.body, send as never, {
    names: (id) => (id === "ada" ? "Ada" : id),
    checkpoint: (id) => checkpoints[id] ?? null,
    approvalLocal: (id) => !nonLocal.includes(id),
    onOpenChange: onOpen,
  });
  inbox.open();
});

describe("Inbox", () => {
  it("one card per decision, oldest first", () => {
    inbox.render([plan, merge, approval, question]);
    expect(cards()).toHaveLength(4);
    expect(cards().map((c) => c.dataset.id)).toEqual(["a1", "q1", "m1", "p1"]);
    expect(text()).toContain("4 waiting");
    expect(text()).toContain("site · Ada · tool approval");
    expect(inbox.count).toBe(4);
    expect(onOpen).toHaveBeenCalledWith(true);
    inbox.close();
    expect(onOpen).toHaveBeenCalledWith(false);
    expect(inbox.isOpen).toBe(false);
  });

  it("blocked card shows the title, the reason, an answer box, Answer, Retry, Cancel and Skip, and Roll back only with a checkpoint", () => {
    inbox.render([question]);
    expect(box().placeholder).toBe("Your answer");
    expect(cards()[0]!.textContent).toContain("Footer");
    expect(cards()[0]!.textContent).toContain("Which color?");
    expect(cards()[0]!.classList).toContain("block");
    expect(labels()).toEqual(["Answer", "Retry", "Cancel", "Skip", "Roll back"]);
    checkpoints.t1 = null;
    inbox.render([{ ...question }, approval]);
    expect(labels(cards()[1]!)).toEqual(["Answer", "Retry", "Cancel", "Skip"]);
    expect(text()).not.toContain("Roll back");
  });

  it("Retry and Cancel send task.action with the task id", () => {
    inbox.render([question]);
    button("Retry").click();
    expect(sent()).toEqual([{ type: "task.action", taskId: "t1", action: "retry" }]);
    inbox.render([]);
    inbox.render([question]);
    button("Cancel").click();
    expect(sent()[1]).toEqual({ type: "task.action", taskId: "t1", action: "cancel" });
  });

  it("the count includes a blocked card", () => {
    inbox.render([approval, question]);
    expect(text()).toContain("2 waiting");
    expect(inbox.count).toBe(2);
  });

  it("Answer sends task.answer with the text; empty text sends nothing", () => {
    inbox.render([question]);
    button("Answer").click();
    expect(send).not.toHaveBeenCalled();
    typeIn("blue");
    button("Answer").click();
    expect(sent()).toEqual([{ type: "task.answer", taskId: "t1", text: "blue" }]);
  });

  it("Roll back asks first and then sends the rollback", () => {
    inbox.render([question]);
    const line = inbox.root.querySelector<HTMLElement>(".inbox-confirm")!;
    expect(line.hidden).toBe(true);
    button("Roll back").click();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain("Undo the last run's changes?");
    expect(send).not.toHaveBeenCalled();
    button("No").click();
    expect(line.hidden).toBe(true);
    button("Roll back").click();
    button("Yes").click();
    expect(sent()).toEqual([{ type: "task.action", taskId: "t1", action: "rollback" }]);
  });

  it("Skip hides the card until the Inbox opens again and sends nothing", () => {
    inbox.render([approval, question]);
    button("Skip").click();
    expect(cards().map((c) => c.dataset.id)).toEqual(["a1"]);
    expect(inbox.count).toBe(2);
    expect(send).not.toHaveBeenCalled();
    inbox.close();
    inbox.open();
    expect(cards()).toHaveLength(2);
  });

  it("approval card sends Allow and Deny", () => {
    inbox.render([approval]);
    expect(labels()).toEqual(["Allow", "Deny"]);
    button("Allow").click();
    expect(sent()).toEqual([{ type: "approve", id: 7, decision: "approved" }]);
    // The card leaves and comes back: its sending mark is gone, so Deny works.
    inbox.render([]);
    inbox.render([approval]);
    button("Deny").click();
    expect(sent()[1]).toEqual({ type: "approve", id: 7, decision: "denied" });
  });

  it("a non-local approval says answer in your terminal and has no buttons", () => {
    nonLocal = [7];
    inbox.render([approval, { ...approval, id: "a2", approvalId: 8, since: "2026-11-03T10:05:00.000Z" }]);
    const [first, second] = cards();
    expect(first!.textContent).toContain("answer in your terminal");
    expect(labels(first!)).toEqual([]);
    expect(first!.querySelector("button")).toBeNull();
    expect(labels(second!)).toEqual(["Allow", "Deny"]);
    expect(second!.textContent).not.toContain("answer in your terminal");
  });

  it("a second card arriving keeps the first card sending and its error", () => {
    inbox.render([approval, question]);
    button("Allow").click();
    inbox.render([approval, question, merge]);
    expect(button("Allow").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    button("Allow").click();
    expect(sent().filter((m) => m.type === "approve")).toHaveLength(1);
    inbox.setError("boom");
    inbox.render([approval, question, merge, plan]);
    expect(text()).toContain("boom");
    expect(button("Allow").disabled).toBe(false);
  });

  it("plan card sends Approve and Send back", () => {
    inbox.render([plan]);
    expect(text()).toContain("1. Markup 2. Style");
    expect(box().placeholder).toBe("What should change?");
    button("Send back").click();
    expect(send).not.toHaveBeenCalled();
    button("Approve").click();
    expect(sent()).toEqual([{ type: "plan.answer", goalId: "g1", option: "approve" }]);
    inbox.render([]);
    inbox.render([plan]);
    typeIn("add tests");
    button("Send back").click();
    expect(sent()[1]).toEqual({ type: "plan.answer", goalId: "g1", option: "changes", text: "add tests" });
    inbox.render([]);
    inbox.render([plan]);
    button("Reject").click();
    expect(sent()[2]).toEqual({ type: "plan.answer", goalId: "g1", option: "reject" });
  });

  it("merge card asks for the diff once, draws it, sends Merge and hides on Later", () => {
    inbox.render([merge]);
    expect(sent()).toEqual([{ type: "diff.request", taskId: "t2" }]);
    inbox.render([{ ...merge, text: "Added a header v2" }]);
    expect(sent()).toHaveLength(1);
    inbox.setDiff("t2", [file]);
    expect(text()).toContain("const x = 1;");
    expect(labels()).toEqual(["Merge", "Send back", "Reject", "Later"]);
    button("Merge").click();
    expect(sent()[1]).toEqual({ type: "review.answer", taskId: "t2", option: "merge" });
    inbox.render([{ ...merge, text: "again" }]);
    button("Later").click();
    expect(cards()).toHaveLength(0);
    expect(inbox.count).toBe(1);
  });

  it("a merge that leaves the list and comes back asks for its diff again", () => {
    inbox.render([merge]);
    inbox.setDiff("t2", [file]);
    inbox.render([]);
    inbox.render([merge]);
    expect(sent()[1]).toEqual({ type: "diff.request", taskId: "t2" });
    expect(text()).not.toContain("const x = 1;");
  });

  it("merge Send back needs notes and carries them", () => {
    inbox.render([merge]);
    button("Send back").click();
    expect(sent()).toHaveLength(1);
    typeIn("rename it");
    button("Send back").click();
    expect(sent()[1]).toEqual({ type: "review.answer", taskId: "t2", option: "changes", text: "rename it" });
  });

  it("merge Reject sends review.answer reject", () => {
    inbox.render([merge]);
    button("Reject").click();
    expect(sent()[1]).toEqual({ type: "review.answer", taskId: "t2", option: "reject" });
  });

  it("answering removes the card", () => {
    inbox.render([approval, question]);
    button("Allow").click();
    expect(button("Allow").disabled).toBe(true);
    expect(text()).toContain("sending…");
    inbox.render([question]);
    expect(cards()).toHaveLength(1);
    expect(text()).not.toContain("sending…");
    expect(inbox.count).toBe(1);
    inbox.render([]);
    expect(text()).toContain("Nothing waits on you");
    expect(inbox.count).toBe(0);
  });

  it("a server error while sending re-enables the buttons and shows the message", () => {
    inbox.render([question]);
    typeIn("blue");
    button("Answer").click();
    expect(button("Answer").disabled).toBe(true);
    inbox.setError("invalid message");
    expect(button("Answer").disabled).toBe(false);
    expect(text()).toContain("invalid message");
  });

  it("a send the server ignores re-enables the card after 10 s and says so", () => {
    vi.useFakeTimers();
    try {
      inbox.render([question]);
      typeIn("blue");
      button("Answer").click();
      expect(button("Answer").disabled).toBe(true);
      vi.advanceTimersByTime(9999);
      expect(button("Answer").disabled).toBe(true);
      vi.advanceTimersByTime(1);
      expect(button("Answer").disabled).toBe(false);
      expect(text()).toContain("no answer from the city, try again");
      expect(text()).not.toContain("sending…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answered send does not time out later", () => {
    vi.useFakeTimers();
    try {
      inbox.render([approval, question]);
      button("Allow").click();
      inbox.render([question]);
      vi.advanceTimersByTime(20000);
      expect(text()).not.toContain("no answer from the city");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error while nothing is sending changes nothing", () => {
    inbox.render([question]);
    inbox.setError("unrelated");
    expect(text()).not.toContain("unrelated");
  });

  it("an error result re-enables the buttons and shows the error, for a task and for a plan", () => {
    inbox.render([merge, plan]);
    button("Merge").click();
    expect(button("Merge").disabled).toBe(true);
    inbox.setResult("t2", false, "conflict in a.ts");
    expect(button("Merge").disabled).toBe(false);
    expect(text()).toContain("conflict in a.ts");
    button("Approve").click();
    expect(button("Approve").disabled).toBe(true);
    inbox.setResult("g1", false, "plan is not waiting");
    expect(button("Approve").disabled).toBe(false);
    expect(text()).toContain("plan is not waiting");
  });

  it("a changed list keeps focus, the cursor and the typed text", () => {
    inbox.render([question]);
    box().focus();
    typeIn("blu");
    inbox.render([question, merge]);
    const mine = inbox.root.querySelector<HTMLTextAreaElement>('[data-id="q1"] textarea')!;
    expect(document.activeElement).toBe(mine);
    expect(mine.value).toBe("blu");
    expect(mine.selectionStart).toBe(3);
  });

  it("the same list again keeps the text box and its focus", () => {
    inbox.render([question]);
    const before = box();
    before.focus();
    before.value = "blu";
    inbox.render([{ ...question }]);
    expect(box()).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("the answer box allows at most 4000 characters", () => {
    inbox.render([question]);
    expect(box().maxLength).toBe(4000);
  });

  it("an empty list shows Nothing waits on you", () => {
    inbox.render([]);
    expect(text()).toContain("Nothing waits on you");
    expect(text()).toContain("0 waiting");
  });
});
