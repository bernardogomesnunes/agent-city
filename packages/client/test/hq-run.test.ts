import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hqRunner } from "../src/ui/hq-run.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("hqRunner", () => {
  it("resolves with the server answer", async () => {
    const send = vi.fn(() => true);
    const r = hqRunner(send);
    const p = r.run(["project", "remove", "site"]);
    expect(send).toHaveBeenCalledWith({ type: "hq.do", id: "hq-1", argv: ["project", "remove", "site"] });
    expect(r.done("hq-1", { code: 0, text: "removed" })).toBe(true);
    await expect(p).resolves.toEqual({ code: 0, text: "removed" });
    expect(r.done("hq-1", { code: 0, text: "again" })).toBe(false);
  });

  it("resolves with an error after 30 s without an answer", async () => {
    const r = hqRunner(() => true);
    const p = r.run(["project", "remove", "site"]);
    vi.advanceTimersByTime(29999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ code: 1, text: "no answer from the city, try again" });
    expect(r.done("hq-1", { code: 0, text: "late" })).toBe(false);
  });

  it("resolves at once with an error when the socket closes", async () => {
    const r = hqRunner(() => true);
    const a = r.run(["a"]);
    const b = r.run(["b"]);
    r.offline();
    await expect(a).resolves.toEqual({ code: 1, text: "offline" });
    await expect(b).resolves.toEqual({ code: 1, text: "offline" });
  });

  it("resolves with offline when the send is refused", async () => {
    const r = hqRunner(() => false);
    await expect(r.run(["a"])).resolves.toEqual({ code: 1, text: "offline" });
  });
});
