// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "../src/ui/terminal.js";

function make(sendResult = true) {
  document.body.innerHTML = "";
  const send = vi.fn(() => sendResult);
  const term = new Terminal(document.body, send as never);
  return { term, send, input: term.root.querySelector<HTMLInputElement>("input")! };
}
const enter = (input: HTMLInputElement) =>
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

describe("Terminal", () => {
  it("keeps the last 500 lines", () => {
    const { term } = make();
    for (let i = 0; i < 600; i++) term.out(`line ${i}\n`);
    expect(term.lineCount).toBe(500);
    expect(term.root.querySelector(".term-out")!.textContent).toContain("line 599");
    expect(term.root.querySelector(".term-out")!.textContent).not.toContain("line 0\n");
  });

  it("joins chunks that have no newline", () => {
    const { term } = make();
    term.out("ab");
    term.out("cd\nef");
    expect(term.root.querySelector(".term-out")!.textContent).toBe("abcd\nef");
  });

  it("sends term.in on Enter and shows running until term.done", () => {
    const { term, send, input } = make();
    term.open();
    input.value = "agent list";
    enter(input);
    expect(send).toHaveBeenCalledWith({ type: "term.in", line: "agent list" });
    expect(term.root.textContent).toContain("running...");
    term.done(0);
    expect(term.root.querySelector(".term-running")!.hasAttribute("hidden")).toBe(true);
  });

  it("sends nothing for an empty line, and does not enter running when the send is refused", () => {
    const a = make();
    enter(a.input);
    expect(a.send).not.toHaveBeenCalled();
    const b = make(false);
    b.input.value = "x";
    enter(b.input);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.term.root.querySelector(".term-running")!.hasAttribute("hidden")).toBe(true);
  });

  it("sends Enter lines as term.in while a command runs, shown as plain input", () => {
    const { term, send, input } = make();
    input.value = "agent memory ada --clear";
    enter(input);
    term.out("Clear memory? [y/N] ");
    input.value = "y";
    enter(input);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: "term.in", line: "y" });
    const text = term.root.querySelector(".term-out")!.textContent!;
    expect(text).toContain("Clear memory? [y/N] y");
    expect(text).not.toContain("> y");
    expect(input.value).toBe("");
    term.done(0);
    input.value = "two";
    enter(input);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("reset clears running and hides the running label", () => {
    const { term, send, input } = make();
    input.value = "one";
    enter(input);
    term.reset();
    expect(term.root.querySelector(".term-running")!.hasAttribute("hidden")).toBe(true);
    input.value = "two";
    enter(input);
    expect(send).toHaveBeenLastCalledWith({ type: "term.in", line: "two" });
    expect(term.root.querySelector(".term-out")!.textContent).toContain("> two");
  });
});
