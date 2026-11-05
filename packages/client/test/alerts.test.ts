// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView } from "@agentcity/world/shared";
import { Alerts, bellOn, browserNotify, playTone, setBell, toast } from "../src/ui/alerts.js";

const at = (id: string, title: string, agentId = "ada"): DecisionView => ({
  id,
  kind: "blocked",
  projectId: "site",
  agentId,
  title,
  text: "",
  since: "2026-11-03T10:00:00.000Z",
});

let bell: boolean;
let hidden: boolean;
let notify: ReturnType<typeof vi.fn<(body: string) => void>>;
let tone: ReturnType<typeof vi.fn<() => void>>;
let alerts: Alerts;

beforeEach(() => {
  bell = true;
  hidden = false;
  notify = vi.fn<(body: string) => void>();
  tone = vi.fn<() => void>();
  alerts = new Alerts({
    bellOn: () => bell,
    hidden: () => hidden,
    notify,
    tone,
    names: (id) => id,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Alerts", () => {
  it("the first list makes no alert", () => {
    hidden = true;
    alerts.update([at("a", "Footer"), at("b", "Header")]);
    expect(tone).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a new id plays the tone when the bell is on", () => {
    alerts.update([at("a", "Footer")]);
    alerts.update([at("a", "Footer"), at("b", "Header")]);
    expect(tone).toHaveBeenCalledTimes(1);
  });

  it("a new id while hidden notifies 'ada: Merge footer'", () => {
    alerts.update([at("a", "Footer")]);
    hidden = true;
    alerts.update([at("a", "Footer"), at("m", "Merge footer")]);
    expect(notify).toHaveBeenCalledWith("ada: Merge footer");
  });

  it("visible page: tone, no notification", () => {
    alerts.update([at("a", "Footer")]);
    alerts.update([at("a", "Footer"), at("b", "Header")]);
    expect(tone).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("bell off: no tone", () => {
    bell = false;
    hidden = true;
    alerts.update([at("a", "Footer")]);
    alerts.update([at("a", "Footer"), at("b", "Header")]);
    expect(tone).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an id seen before and back again alerts once only", () => {
    alerts.update([at("a", "Footer")]);
    alerts.update([at("a", "Footer"), at("b", "Header")]);
    alerts.update([at("b", "Header")]);
    hidden = true;
    alerts.update([at("a", "Footer"), at("b", "Header")]);
    expect(tone).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("several new ids in one update alert once, naming the first new one", () => {
    alerts.update([at("a", "Footer")]);
    hidden = true;
    alerts.update([at("a", "Footer"), at("b", "Header", "lin"), at("c", "Logo")]);
    expect(tone).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("lin: Header");
  });
});

describe("browser notification and tone", () => {
  const shown: Array<{ title: string; body: string }> = [];
  const oscillators: Array<{ type: string; frequency: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];

  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>("granted"));
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, body: options?.body ?? "" });
    }
  }

  class FakeAudioContext {
    destination = {};
    currentTime = 0;
    createOscillator() {
      const osc = { type: "", frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), onended: null };
      oscillators.push(osc);
      return osc;
    }
  }

  beforeEach(() => {
    shown.length = 0;
    oscillators.length = 0;
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission.mockClear();
  });

  it("browserNotify shows 'Agent City' with the body when permission is granted", () => {
    vi.stubGlobal("Notification", FakeNotification);
    browserNotify("ada: Footer");
    expect(shown).toEqual([{ title: "Agent City", body: "ada: Footer" }]);
  });

  it("browserNotify shows nothing when permission is denied", () => {
    vi.stubGlobal("Notification", FakeNotification);
    FakeNotification.permission = "denied";
    browserNotify("ada: Footer");
    expect(shown).toEqual([]);
  });

  it("askPermission requests permission once while it is still undecided", () => {
    vi.stubGlobal("Notification", FakeNotification);
    FakeNotification.permission = "default";
    alerts.askPermission();
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("playTone makes one 880 Hz sine lasting 0.15 s", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    playTone();
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].type).toBe("sine");
    expect(oscillators[0].frequency.value).toBe(880);
    expect(oscillators[0].start).toHaveBeenCalledTimes(1);
    expect(oscillators[0].stop).toHaveBeenCalledWith(0.15);
  });

  it("browserNotify, askPermission and playTone do not throw without the APIs", () => {
    expect(() => browserNotify("ada: Footer")).not.toThrow();
    expect(() => alerts.askPermission()).not.toThrow();
    expect(() => playTone()).not.toThrow();
  });
});

describe("bell setting", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts on, and setBell stores agentcity.bell", () => {
    localStorage.clear();
    expect(bellOn()).toBe(true);
    setBell(false);
    expect(localStorage.getItem("agentcity.bell")).toBe("off");
    expect(bellOn()).toBe(false);
    setBell(true);
    expect(localStorage.getItem("agentcity.bell")).toBe("on");
    expect(bellOn()).toBe(true);
  });

  it("reads the stored state", () => {
    localStorage.setItem("agentcity.bell", "off");
    expect(bellOn()).toBe(false);
  });

  it("a throwing storage counts as on and does not throw on save", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(bellOn()).toBe(true);
    expect(() => setBell(false)).not.toThrow();
  });
});

describe("toast", () => {
  it("shows the text, then removes it after 6000 ms by default", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    toast("project busy");
    expect(document.querySelector(".toast")!.textContent).toBe("project busy");
    vi.advanceTimersByTime(5999);
    expect(document.querySelector(".toast")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector(".toast")).toBeNull();
    toast("short", 100);
    vi.advanceTimersByTime(100);
    expect(document.querySelector(".toast")).toBeNull();
    vi.useRealTimers();
  });
});
