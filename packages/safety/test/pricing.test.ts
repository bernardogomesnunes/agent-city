import { describe, expect, it } from "vitest";
import { costUsd, modelAllowed, priceFor } from "../src/index.js";

const prices = { "claude-test": { inputPerMTok: 3, outputPerMTok: 15 } };

describe("pricing", () => {
  it("modelAllowed matches exact and prefix/*", () => {
    expect(modelAllowed(["claude-test", "lmstudio/*"], "claude-test")).toBe(true);
    expect(modelAllowed(["lmstudio/*"], "lmstudio/qwen")).toBe(true);
    expect(modelAllowed(["lmstudio/*"], "lmstudiox/q")).toBe(false);
    expect(modelAllowed(["claude-test"], "other")).toBe(false);
  });
  it("priceFor returns zeros for lmstudio models", () => {
    expect(priceFor(prices, "lmstudio/qwen")).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });
  it("priceFor returns undefined for unknown hosted model", () => {
    expect(priceFor(prices, "claude-unknown")).toBeUndefined();
    expect(priceFor(prices, "claude-test")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });
  const conns = [
    { name: "groq", baseUrl: "https://g/v1", price: { inputPerMTok: 0.59, outputPerMTok: 0.79 } },
    { name: "free", baseUrl: "http://o/v1" },
  ];
  it("claude-sub costs 0", () => expect(priceFor({}, "claude-sub/sonnet", conns)).toEqual({ inputPerMTok: 0, outputPerMTok: 0 }));
  it("api uses the connection price", () => expect(priceFor({}, "api/groq/llama", conns)).toEqual({ inputPerMTok: 0.59, outputPerMTok: 0.79 }));
  it("a full-id price overrides the connection price", () =>
    expect(priceFor({ "api/groq/llama": { inputPerMTok: 1, outputPerMTok: 2 } }, "api/groq/llama", conns)).toEqual({ inputPerMTok: 1, outputPerMTok: 2 }));
  it("api with no price is unknown", () => expect(priceFor({}, "api/free/m", conns)).toBeUndefined());
  it("api with no such connection is unknown", () => expect(priceFor({}, "api/none/m", conns)).toBeUndefined());
  it("costUsd computes from per-million prices", () => {
    expect(costUsd({ inputPerMTok: 3, outputPerMTok: 15 }, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4.5);
  });
});
