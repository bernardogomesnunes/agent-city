// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hud, START_WAIT_MS } from "../src/ui/hud.js";

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const goButton = () => document.querySelector<HTMLButtonElement>(".hud-go");

describe("Hud", () => {
  it("offline shows Go online, which opens the start link and waits; online hides it", () => {
    const start = vi.fn();
    const hud = new Hud(document.body, () => undefined, start);
    hud.setOnline(false);
    expect(goButton()!.hidden).toBe(false);
    expect(goButton()!.title).toContain("agentcity link install");
    goButton()!.click();
    expect(start).toHaveBeenCalledTimes(1);
    expect(goButton()!.textContent).toBe("starting…");
    expect(goButton()!.disabled).toBe(true);
    hud.setOnline(true);
    expect(goButton()!.hidden).toBe(true);
    expect(document.querySelector(".hud-status")!.textContent).toBe("online");
    hud.setOnline(false);
    expect(goButton()!.textContent).toBe("Go online");
    expect(goButton()!.disabled).toBe(false);
  });

  it("a start that never comes online gives the button back with the setup hint", () => {
    const hud = new Hud(document.body, () => undefined, vi.fn());
    hud.setOnline(false);
    goButton()!.click();
    vi.advanceTimersByTime(START_WAIT_MS);
    expect(goButton()!.textContent).toBe("Go online");
    expect(goButton()!.disabled).toBe(false);
    expect(document.querySelector(".hud-status")!.textContent).toBe("offline: run agentcity link install once");
  });

  it("without a start hook (the demo) there is no button", () => {
    const hud = new Hud(document.body, () => undefined);
    hud.setOnline(false);
    expect(goButton()).toBeNull();
  });

  it("Inbox button shows the count in amber", () => {
    const hud = new Hud(document.body, () => undefined);
    const inbox = document.querySelector<HTMLElement>(".hud-inbox")!;
    hud.setInbox(4);
    expect(inbox.textContent).toBe("Inbox 4");
    expect(inbox.classList.contains("has-pending")).toBe(true);
  });

  it("count 0 reads Inbox in the plain style", () => {
    const hud = new Hud(document.body, () => undefined);
    const inbox = document.querySelector<HTMLElement>(".hud-inbox")!;
    hud.setInbox(2);
    hud.setInbox(0);
    expect(inbox.textContent).toBe("Inbox");
    expect(inbox.classList.contains("has-pending")).toBe(false);
    expect(inbox.classList.contains("ac-button")).toBe(true);
  });

  it("the buttons call their handlers", () => {
    const roofs = vi.fn();
    const hud = new Hud(document.body, roofs);
    const on = { inbox: vi.fn(), hq: vi.fn() };
    hud.onInbox(on.inbox);
    hud.onHq(on.hq);
    for (const cls of ["inbox", "roofs", "hq"]) document.querySelector<HTMLElement>(`.hud-${cls}`)!.click();
    expect(on.inbox).toHaveBeenCalledTimes(1);
    expect(on.hq).toHaveBeenCalledTimes(1);
    expect(roofs).toHaveBeenCalledTimes(1);
  });

  it("two separate boxes: the city status at left, Inbox, Stop all, Roofs and HQ at right; no Chat or Terminal button", () => {
    new Hud(document.body, () => undefined);
    const boxes = [...document.querySelectorAll(".hud > .ac-box")];
    expect(boxes.map((b) => b.className)).toEqual(["ac-box hud-box hud-city", "ac-box hud-box hud-controls"]);
    expect(boxes[0]!.textContent).toBe("offline");
    expect([...boxes[1]!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Inbox", "Stop all", "Roofs (R)", "HQ (H)"]);
    expect(document.querySelector(".hud-chat")).toBeNull();
    expect(document.querySelector(".hud-terminal")).toBeNull();
  });

  it("Go online sits in the status box", () => {
    new Hud(document.body, () => undefined, () => undefined);
    expect(document.querySelector(".hud-city .hud-go")).not.toBeNull();
  });

  it("no bell button", () => {
    new Hud(document.body, () => undefined);
    expect(document.querySelector(".hud-bell")).toBeNull();
    expect([...document.querySelectorAll(".hud button")].some((b) => /bell/i.test(b.textContent ?? ""))).toBe(false);
  });

  it("Stop all sends city.pause true; it reads Resume all while a project is paused and sends false", () => {
    const hud = new Hud(document.body, () => undefined);
    const onStop = vi.fn();
    hud.onStopAll(onStop);
    const stop = document.querySelector<HTMLButtonElement>(".hud-stop")!;
    expect(stop.textContent).toBe("Stop all");
    stop.click();
    expect(onStop).toHaveBeenLastCalledWith(true);
    hud.setPaused(true);
    expect(stop.textContent).toBe("Resume all");
    stop.click();
    expect(onStop).toHaveBeenLastCalledWith(false);
    hud.setPaused(false);
    expect(stop.textContent).toBe("Stop all");
  });
});

describe("style tokens", () => {
  const css = readFileSync(join(__dirname, "../src/ui/style.css"), "utf8");
  it("the HQ bar sits at the top centre and the HQ columns just below the top boxes", () => {
    expect(css).toMatch(/\.hq-bar\s*\{[^}]*top:\s*8px/);
    expect(css).toMatch(/\.hq-screen\s*\{[^}]*--hq-top:\s*52px/);
    expect(css).toMatch(/\.hq-col\s*\{[^}]*top:\s*var\(--hq-top\)/);
    expect(css).toMatch(/\.hud-controls\s*\{[^}]*flex-wrap:\s*wrap/);
  });
  it("style tokens exist", () => {
    const want: Record<string, string> = {
      "--box-fill": "#f8f4e6", "--box-line": "#3a3f5c", "--box-rule": "#8a90b8", "--btn-fill": "#fff",
      "--st-run": "#3fb7ff", "--st-ask": "#ffb020", "--st-block": "#e24b4a", "--st-idle": "#8a8f9e", "--st-done": "#48b048",
    };
    for (const [name, value] of Object.entries(want)) {
      expect(css).toMatch(new RegExp(name + ":\\s*" + value + "\\s*;"));
    }
    expect(css).toMatch(/--font-pixel:\s*Silkscreen,/);
    expect(css).toMatch(/\.ac-box\s*\{[^}]*background:\s*var\(--box-fill\)/);
  });
});
