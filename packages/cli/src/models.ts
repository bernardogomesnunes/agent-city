import type { GlobalConfig } from "@agentcity/safety";
import { SUB_ALIASES } from "@agentcity/org";
import type { ModelGroup } from "@agentcity/world/shared";
import { claudeStatus, describeClaude, type ClaudeStatus } from "./claude-setup.js";

export const MODELS_FETCH_MS = 3000;

/** GET `<baseUrl>/models` from an OpenAI-compatible server. Ids come back with `prefix` added. */
async function fetchIds(baseUrl: string, prefix: string, key: string | undefined, fetchFn: typeof fetch): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(MODELS_FETCH_MS),
    });
  } catch {
    return { models: [], error: `cannot reach ${baseUrl}` };
  }
  if (res.status === 401 || res.status === 403) return { models: [], error: key ? "key rejected" : "needs a key" };
  if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
  let body: { data?: unknown; error?: unknown };
  try {
    body = (await res.json()) as { data?: unknown; error?: unknown };
  } catch {
    return { models: [], error: "invalid models list" };
  }
  // Some servers answer 200 with an error body and no list. The error text says why.
  if (!Array.isArray(body.data)) {
    const reply = typeof body.error === "string" ? body.error.trim() : "";
    return { models: [], error: (reply || "invalid models list").slice(0, 100) };
  }
  const ids = (body.data as Array<{ id?: unknown }>).map((m) => m?.id).filter((id): id is string => typeof id === "string");
  return { models: ids.map((id) => prefix + id) };
}

const group = (label: string, r: { models: string[]; error?: string }): ModelGroup =>
  r.error ? { label, models: r.models, error: r.error } : { label, models: r.models };

/**
 * The models the agent card offers, one group per source: subscription aliases, LM Studio,
 * each connection, and the Anthropic ids that have a price. Keys go in headers only.
 */
export async function listModels(
  global: GlobalConfig,
  secrets: Record<string, string>,
  fetchFn: typeof fetch = fetch,
  claude: ClaudeStatus = claudeStatus(global.claudePath),
): Promise<ModelGroup[]> {
  const subReady = claude.path !== null && claude.signedIn !== false;
  const [lm, ...conns] = await Promise.all([
    fetchIds(global.lmStudioBaseUrl, "lmstudio/", secrets.lmstudio, fetchFn),
    ...global.connections.map((c) => fetchIds(c.baseUrl, `api/${c.name}/`, secrets[`api-${c.name}`], fetchFn)),
  ]);
  return [
    group("Claude subscription", {
      models: SUB_ALIASES.map((a) => `claude-sub/${a}`),
      ...(subReady ? {} : { error: `${describeClaude(claude)}: set up in HQ, APIs` }),
    }),
    group("LM Studio", lm!),
    ...global.connections.map((c, i) => group(`API: ${c.name}`, conns[i]!)),
    { label: "Anthropic API", models: Object.keys(global.prices).filter((k) => /^claude-[a-z0-9.-]+$/.test(k)) },
  ];
}
