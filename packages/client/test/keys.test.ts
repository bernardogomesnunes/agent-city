// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { gameKeysEnabled } from "../src/ui/keys.js";

describe("gameKeysEnabled", () => {
  it("is false for input, textarea and contenteditable", () => {
    expect(gameKeysEnabled(document.createElement("input"))).toBe(false);
    expect(gameKeysEnabled(document.createElement("textarea"))).toBe(false);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(gameKeysEnabled(editable)).toBe(false);
  });

  it("is true for a div, a button, the body and null", () => {
    expect(gameKeysEnabled(document.createElement("div"))).toBe(true);
    expect(gameKeysEnabled(document.createElement("button"))).toBe(true);
    expect(gameKeysEnabled(document.body)).toBe(true);
    expect(gameKeysEnabled(null)).toBe(true);
  });
});
