import { describe, expect, it } from "vitest";
import { RunTree } from "../src/index.js";

const limits = { maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 };

describe("RunTree", () => {
  it("reserveChild(4) with maxDepth 3 is depth_limit", () => {
    const t = new RunTree(limits);
    expect(t.reserveChild(4)).toEqual({ ok: false, reason: "depth_limit" });
    expect(t.childRuns).toBe(0);
    expect(t.reserveChild(3)).toEqual({ ok: true });
  });

  it("11th reserve with maxChildRuns 10 is child_run_limit", () => {
    const t = new RunTree(limits);
    for (let i = 0; i < 10; i++) expect(t.reserveChild(1)).toEqual({ ok: true });
    expect(t.reserveChild(1)).toEqual({ ok: false, reason: "child_run_limit" });
    expect(t.childRuns).toBe(10);
  });

  it("adds up dollars and tokens", () => {
    const t = new RunTree(limits);
    expect(t.tokens).toBe(0);
    t.addUsd(0.25);
    t.addUsd(0.25);
    t.addTokens(100);
    t.addTokens(50);
    expect(t.usd).toBe(0.5);
    expect(t.tokens).toBe(150);
  });
});
