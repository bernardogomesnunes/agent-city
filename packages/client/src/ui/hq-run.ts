import type { HqDo } from "./hq-settings.js";

export const HQ_TIMEOUT_MS = 30000;

type Result = { code: number; text: string };

/**
 * Runs agentcity commands on the server. Each answer comes back as hq.done with the same id.
 * A command that gets no answer in 30 s, or whose socket closes, resolves with an error so its caller can show it.
 */
export function hqRunner(send: (m: { type: "hq.do"; id: string; argv: string[]; input?: string }) => boolean, timeoutMs = HQ_TIMEOUT_MS) {
  const pending = new Map<string, { resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  const run: HqDo = (argv, input) =>
    new Promise((resolve) => {
      const id = `hq-${nextId++}`;
      if (!send({ type: "hq.do", id, argv, ...(input !== undefined ? { input } : {}) })) return resolve({ code: 1, text: "offline" });
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ code: 1, text: "no answer from the city, try again" });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
    });
  /** The answer for an id. False when nothing waits on it. */
  const done = (id: string, r: Result): boolean => {
    const p = pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(r);
    return true;
  };
  /** The socket closed: every waiting command ends at once. */
  const offline = (): void => {
    for (const id of [...pending.keys()]) done(id, { code: 1, text: "offline" });
  };
  return { run, done, offline };
}
