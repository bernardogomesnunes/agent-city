/** Where a model id runs. */
export type ModelRef =
  | { source: "sub"; alias: string }
  | { source: "lmstudio"; id: string }
  | { source: "api"; connection: string; id: string }
  | { source: "anthropic"; id: string };

/** Short names the local `claude` binary takes for `--model`. */
export const SUB_ALIASES = ["sonnet", "opus", "haiku"] as const;

const SUB = "claude-sub/";
const LM = "lmstudio/";
const API = "api/";

/**
 * Reads a model id: `claude-sub/<alias>`, `lmstudio/<id>`, `api/<connection>/<model>` or a bare `claude-*` id.
 * `connections` are the names in config.json; an `api/` id must name one of them.
 */
export function parseModelId(model: string, connections: string[]): { ok: true; ref: ModelRef } | { ok: false; error: string } {
  if (model.startsWith(SUB)) {
    const alias = model.slice(SUB.length);
    if ((SUB_ALIASES as readonly string[]).includes(alias) || /^claude-[a-z0-9.-]+$/.test(alias)) {
      return { ok: true, ref: { source: "sub", alias } };
    }
    return { ok: false, error: `unknown subscription model ${alias}. Use sonnet, opus, haiku or a claude-* id` };
  }
  if (model.startsWith(LM)) {
    const id = model.slice(LM.length);
    return id ? { ok: true, ref: { source: "lmstudio", id } } : { ok: false, error: "missing LM Studio model id" };
  }
  if (model.startsWith(API)) {
    const rest = model.slice(API.length);
    const slash = rest.indexOf("/");
    const connection = slash < 0 ? rest : rest.slice(0, slash);
    const id = slash < 0 ? "" : rest.slice(slash + 1);
    if (!connections.includes(connection)) {
      return { ok: false, error: `No connection ${connection}. Run: agentcity connection add ${connection} <baseUrl>` };
    }
    if (!id) return { ok: false, error: `missing model id after api/${connection}/` };
    return { ok: true, ref: { source: "api", connection, id } };
  }
  if (/^claude-[a-z0-9.-]+$/.test(model)) return { ok: true, ref: { source: "anthropic", id: model } };
  return { ok: false, error: `unknown model ${model}. Use claude-sub/, lmstudio/, api/<connection>/ or a claude-* id` };
}
