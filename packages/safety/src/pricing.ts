import type { Usage } from "@agentcity/core";
import type { Connection } from "./config.js";

export type Price = { inputPerMTok: number; outputPerMTok: number };
export type Prices = Record<string, Price>;

// Anthropic list price, USD per million tokens, prompts up to 100K tokens (claude-api skill model table, 2026-10-06).
export const DEFAULT_PRICES: Prices = {
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
};

export function modelAllowed(allowed: string[], model: string): boolean {
  return allowed.some((a) => (a.endsWith("/*") ? model.startsWith(a.slice(0, -1)) : a === model));
}

/**
 * Price of a model id. LM Studio and the Claude subscription cost 0.
 * `api/<connection>/<model>`: a full-id entry in `prices`, else the connection's price.
 */
export function priceFor(prices: Prices, model: string, connections: Connection[] = []): Price | undefined {
  if (unmetered(model)) return { inputPerMTok: 0, outputPerMTok: 0 };
  if (Object.hasOwn(prices, model)) return prices[model];
  if (!model.startsWith("api/")) return undefined;
  const name = model.slice("api/".length).split("/")[0];
  return connections.find((c) => c.name === name)?.price;
}

/** LM Studio and the Claude subscription are not billed per call, so the job and day caps skip them. */
export function unmetered(model: string): boolean {
  return model.startsWith("lmstudio/") || model.startsWith("claude-sub/");
}

export function costUsd(price: Price, usage: Usage): number {
  return (usage.inputTokens * price.inputPerMTok) / 1e6 + (usage.outputTokens * price.outputPerMTok) / 1e6;
}
