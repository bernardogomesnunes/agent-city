import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ActionLog, agentCityHome, openDb, projectDirs } from "@agentcity/safety";
import { readSecrets } from "../src/secrets.js";
import { runCli } from "../src/wire.js";

// The Anthropic key comes from the real data root, read before any test changes it.
const anthropicKey = process.env.AGENTCITY_LIVE === "1" ? readSecrets(agentCityHome()).anthropic : undefined;

let home: string;
let input: PassThrough;
let out: string;
let err: string;

const cli = (args: string[], secrets: Record<string, string> = {}) => {
  const o = new PassThrough();
  const e = new PassThrough();
  o.on("data", (d: Buffer) => (out += d.toString()));
  e.on("data", (d: Buffer) => (err += d.toString()));
  if (Object.keys(secrets).length > 0) {
    fs.writeFileSync(path.join(home, "secrets.json"), JSON.stringify(secrets));
  }
  return runCli(args, { home, io: { input, output: o, error: e } });
};

async function setup(model: string) {
  expect(await cli(["init", "demo"])).toBe(0);
  expect(
    await cli(["agent", "create", "ada", "--name", "Ada", "--role", "worker", "--model", model, "--persona", "You are Ada, a careful assistant."]),
  ).toBe(0);
  expect(await cli(["grant", "demo", "ada"])).toBe(0);
  fs.writeFileSync(path.join(projectDirs(home, "demo").sandbox, "notes.txt"), "Pineapples are tropical fruit grown in warm climates.");
}

const actions = () => {
  const db = openDb(home);
  try {
    return new ActionLog(db, []).list("demo");
  } finally {
    db.close();
  }
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-live-"));
  input = new PassThrough();
  out = "";
  err = "";
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.env.AGENTCITY_LIVE !== "1")("live providers", () => {
  it("lmstudio run reads, writes and waits for approval", { timeout: 300_000 }, async () => {
    const model = process.env.AGENTCITY_LMSTUDIO_MODEL;
    expect(model, "set AGENTCITY_LMSTUDIO_MODEL").toBeTruthy();
    await setup(`lmstudio/${model}`);
    input.write("n\n");
    const code = await cli([
      "run", "demo", "--agent", "ada",
      "Read notes.txt, write a one-line summary to summary.txt, then send it to test@example.com with send_message.",
    ]);
    const d = projectDirs(home, "demo");
    const rows = actions();
    const diag = `exit ${code}\nstdout:\n${out}\nstderr:\n${err}`;
    expect(fs.existsSync(path.join(d.sandbox, "summary.txt")), diag).toBe(true);
    expect(fs.readdirSync(d.outbox), diag).toHaveLength(0);
    expect(
      rows.some((r) => r.type === "gate.decision" && (r.payload as { rule?: string }).rule === "user_approval"),
      diag,
    ).toBe(true);
  });

  it.skipIf(!anthropicKey)("anthropic run completes one tool call", { timeout: 120_000 }, async () => {
    await setup("claude-haiku-5-5");
    const code = await cli(["run", "demo", "--agent", "ada", "Read notes.txt and reply with its first word."], { anthropic: anthropicKey ?? "" });
    expect(code, `stdout:\n${out}\nstderr:\n${err}`).toBe(0);
    expect(out).toMatch(/run\.stopped done/);
  });
});
