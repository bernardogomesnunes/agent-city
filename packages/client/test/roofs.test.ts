import { describe, expect, it } from "vitest";
import { RoofState } from "../src/roofs.js";

describe("RoofState", () => {
  it("starts with every roof shown", () => {
    const r = new RoofState();
    expect(r.allHidden).toBe(false);
    expect(r.hidden("hq")).toBe(false);
    expect(r.hidden("plot-3")).toBe(false);
  });
  it("toggleAll hides every roof, a second toggle shows them again", () => {
    const r = new RoofState();
    r.toggleAll();
    expect(r.allHidden).toBe(true);
    expect(r.hidden("director")).toBe(true);
    expect(r.hidden("plot-6")).toBe(true);
    r.toggleAll();
    expect(r.hidden("director")).toBe(false);
  });
});
