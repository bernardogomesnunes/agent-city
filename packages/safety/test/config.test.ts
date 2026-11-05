import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiBaseUrl, defaultProjectConfig, loadGlobalConfig, loadProjectConfig, saveConnections, saveLmStudioBaseUrl, saveProjectConfig, projectDirs } from "../src/index.js";
import { tempHome } from "./helpers.js";

describe("project config", () => {
  it("default config round-trips through save and load", () => {
    const home = tempHome();
    const cfg = defaultProjectConfig("demo");
    saveProjectConfig(home, cfg);
    expect(loadProjectConfig(home, "demo")).toEqual({ ok: true, config: cfg });
  });
  it("drops the removed tools delegate and report from an older config", () => {
    const home = tempHome();
    saveProjectConfig(home, { ...defaultProjectConfig("demo"), allowedTools: ["read_file", "delegate", "report"] });
    const r = loadProjectConfig(home, "demo");
    expect(r.ok && r.config.allowedTools).toEqual(["read_file"]);
  });
  it("keeps the board key through save and load, and rejects a bad maxConcurrent", () => {
    const home = tempHome();
    const cfg = { ...defaultProjectConfig("demo"), board: { maxConcurrent: 3, testCommand: "npm test" } };
    saveProjectConfig(home, cfg);
    expect(loadProjectConfig(home, "demo")).toEqual({ ok: true, config: cfg });
    expect(() => saveProjectConfig(home, { ...cfg, board: { maxConcurrent: 0 } })).toThrow();
    expect(() => saveProjectConfig(home, { ...cfg, board: { maxConcurrent: 9 } })).toThrow();
  });
  it("missing file returns ok:false", () => {
    expect(loadProjectConfig(tempHome(), "nope").ok).toBe(false);
  });
  it("invalid JSON returns ok:false", () => {
    const home = tempHome();
    saveProjectConfig(home, defaultProjectConfig("demo"));
    fs.writeFileSync(projectDirs(home, "demo").config, "{not json");
    expect(loadProjectConfig(home, "demo").ok).toBe(false);
  });
  it("negative jobTokens is config_invalid", () => {
    const home = tempHome();
    const cfg = defaultProjectConfig("demo");
    saveProjectConfig(home, cfg);
    cfg.budget.jobTokens = -1;
    fs.writeFileSync(projectDirs(home, "demo").config, JSON.stringify(cfg));
    expect(loadProjectConfig(home, "demo").ok).toBe(false);
  });
  it("old budget and perAgent load with the new defaults", () => {
    const home = tempHome();
    saveProjectConfig(home, defaultProjectConfig("demo"));
    const file = projectDirs(home, "demo").config;
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...json, budget: { maxTokens: 5, maxUsd: 9 }, perAgent: { maxUsd: 3 } }));
    const r = loadProjectConfig(home, "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.budget).toEqual({ jobTokens: 200000, dayUsd: 1 });
    expect("perAgent" in r.config).toBe(false);
  });
  it("an older config with no limits loads with the defaults", () => {
    const home = tempHome();
    saveProjectConfig(home, defaultProjectConfig("demo"));
    const file = projectDirs(home, "demo").config;
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete json.limits;
    fs.writeFileSync(file, JSON.stringify(json));
    const r = loadProjectConfig(home, "demo");
    expect(r.ok && r.config.limits).toEqual({ stepsPerJob: 0, parallelJobs: 1, reminders: 1, testFixes: 1, sendBacks: 2, conflicts: 1 });
  });
  it("limits save and load, and a negative limit is rejected", () => {
    const home = tempHome();
    const limits = { stepsPerJob: 5, parallelJobs: 0, reminders: 0, testFixes: 2, sendBacks: 3, conflicts: 0 };
    const cfg = { ...defaultProjectConfig("demo"), limits };
    saveProjectConfig(home, cfg);
    expect(loadProjectConfig(home, "demo")).toEqual({ ok: true, config: cfg });
    expect(() => saveProjectConfig(home, { ...cfg, limits: { ...limits, reminders: -1 } })).toThrow();
  });
  it("an older board.maxConcurrent becomes limits.parallelJobs", () => {
    const home = tempHome();
    saveProjectConfig(home, defaultProjectConfig("demo"));
    const file = projectDirs(home, "demo").config;
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete json.limits;
    fs.writeFileSync(file, JSON.stringify({ ...json, board: { maxConcurrent: 3 } }));
    const r = loadProjectConfig(home, "demo");
    expect(r.ok && r.config.limits.parallelJobs).toBe(3);
    expect(r.ok && r.config.limits.reminders).toBe(1);
  });
  it("save creates sandbox and outbox", () => {
    const home = tempHome();
    saveProjectConfig(home, defaultProjectConfig("demo"));
    const d = projectDirs(home, "demo");
    expect(fs.statSync(d.sandbox).isDirectory()).toBe(true);
    expect(fs.statSync(d.outbox).isDirectory()).toBe(true);
  });
});

describe("id and global config validation", () => {
  it('loadProjectConfig with "../x" returns ok:false', () => {
    expect(loadProjectConfig(tempHome(), "../x").ok).toBe(false);
  });
  it("loadGlobalConfig throws on invalid JSON", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "config.json"), "{nope");
    expect(() => loadGlobalConfig(home)).toThrow(/invalid config\.json/);
  });
  it("loadGlobalConfig throws on schema error", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ lmStudioBaseUrl: 5 }));
    expect(() => loadGlobalConfig(home)).toThrow(/invalid config\.json/);
  });
  it("loadGlobalConfig returns defaults when file is missing", () => {
    expect(loadGlobalConfig(tempHome()).lmStudioBaseUrl).toBe("http://localhost:1234/v1");
  });
});

describe("connections config", () => {
  const write = (home: string, data: unknown) => fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(data));
  it("defaults connections to [] and claudePath to claude", () => {
    expect(loadGlobalConfig(tempHome())).toMatchObject({ connections: [], claudePath: "claude" });
  });
  it("rejects a duplicate connection name", () => {
    const home = tempHome();
    write(home, { connections: [{ name: "groq", baseUrl: "https://a/v1" }, { name: "groq", baseUrl: "https://b/v1" }] });
    expect(() => loadGlobalConfig(home)).toThrow("duplicate connection groq");
  });
  it("rejects a non-http baseUrl and a bad name", () => {
    const home = tempHome();
    write(home, { connections: [{ name: "x", baseUrl: "file:///etc" }] });
    expect(() => loadGlobalConfig(home)).toThrow(/invalid config\.json/);
    write(home, { connections: [{ name: "Bad Name", baseUrl: "https://a/v1" }] });
    expect(() => loadGlobalConfig(home)).toThrow(/invalid config\.json/);
  });
  it("saveConnections keeps other keys", () => {
    const home = tempHome();
    write(home, { lmStudioBaseUrl: "http://h:1/v1" });
    saveConnections(home, [{ name: "groq", baseUrl: "https://api.groq.com/openai/v1" }]);
    expect(loadGlobalConfig(home)).toMatchObject({ lmStudioBaseUrl: "http://h:1/v1", connections: [{ name: "groq" }] });
  });
  it("new projects allow claude-sub and api models", () => {
    expect(defaultProjectConfig("p").allowedModels).toEqual(["claude-haiku-5-5", "lmstudio/*", "claude-sub/*", "api/*"]);
  });
});

describe("delegation config", () => {
  it("old project.json without delegation loads with defaults 3, 0.5, 10", () => {
    const home = tempHome();
    const old: Partial<ReturnType<typeof defaultProjectConfig>> = defaultProjectConfig("demo");
    delete old.delegation;
    fs.mkdirSync(path.dirname(projectDirs(home, "demo").config), { recursive: true });
    fs.writeFileSync(projectDirs(home, "demo").config, JSON.stringify(old));
    const r = loadProjectConfig(home, "demo");
    expect(r.ok && r.config.delegation).toEqual({ maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 });
  });
  it("delegation with negative maxTreeUsd is config_invalid", () => {
    const home = tempHome();
    const cfg = defaultProjectConfig("demo");
    saveProjectConfig(home, cfg);
    cfg.delegation.maxTreeUsd = -1;
    fs.writeFileSync(projectDirs(home, "demo").config, JSON.stringify(cfg));
    expect(loadProjectConfig(home, "demo").ok).toBe(false);
  });
});

describe("API base URLs", () => {
  it("adds /v1 to a bare host", () => {
    expect(apiBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
  });
  it("drops trailing slashes, then adds /v1 to a bare host", () => {
    expect(apiBaseUrl("http://127.0.0.1:1234/")).toBe("http://127.0.0.1:1234/v1");
    expect(apiBaseUrl("http://127.0.0.1:1234///")).toBe("http://127.0.0.1:1234/v1");
  });
  it("keeps a path as written", () => {
    expect(apiBaseUrl("https://api.groq.com/openai/v1")).toBe("https://api.groq.com/openai/v1");
    expect(apiBaseUrl("https://api.groq.com/openai/v1/")).toBe("https://api.groq.com/openai/v1");
  });
  it("adds /v1 before the query of a bare host", () => {
    expect(apiBaseUrl("https://h.com?key=1")).toBe("https://h.com/v1?key=1");
  });
  it("strips trailing slashes from the path only, and keeps the query", () => {
    expect(apiBaseUrl("https://h.com/openai/v1/?key=a/")).toBe("https://h.com/openai/v1?key=a/");
  });
  it("returns an unparsable string trimmed, without throwing", () => {
    expect(apiBaseUrl("  not a url/  ")).toBe("not a url/");
  });
  it("loadGlobalConfig applies it to a saved bare connection and to the LM Studio base", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      lmStudioBaseUrl: "http://127.0.0.1:1234",
      connections: [{ name: "lm-studio", baseUrl: "http://127.0.0.1:1234" }],
    }));
    const g = loadGlobalConfig(home);
    expect(g.lmStudioBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(g.connections[0]!.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });
  it("saveLmStudioBaseUrl stores the base with /v1 and keeps the other keys", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ claudePath: "claude-x" }));
    saveLmStudioBaseUrl(home, "http://127.0.0.1:1234/");
    expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({
      claudePath: "claude-x",
      lmStudioBaseUrl: "http://127.0.0.1:1234/v1",
    });
  });
  it("saveLmStudioBaseUrl rejects a URL that is not http or https", () => {
    expect(() => saveLmStudioBaseUrl(tempHome(), "ftp://127.0.0.1:1234")).toThrow("http or https");
  });
});
