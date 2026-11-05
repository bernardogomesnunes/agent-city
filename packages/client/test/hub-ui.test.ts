// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CityState, HqConfig } from "@agentcity/world/shared";
import { placeInfo, signAt } from "../src/places.js";
import { HqPanel } from "../src/ui/hq-panel.js";
import { ProgressPanel, elapsed } from "../src/ui/progress.js";
import { normalUrl, renderMerge, renderWork, type WorkContext } from "../src/ui/work.js";
import { BuildingPanel } from "../src/ui/building-panel.js";
import { pairFlags, splitCommand, type HqDo } from "../src/ui/hq-settings.js";

const run = {
  runId: "r1", projectId: "site", agentId: "ada", goal: "fix the footer", startedAt: "2026-11-01T10:00:00.000Z",
  steps: 4, agents: ["ada", "bob"], lastTool: "edit_file footer.tsx", lastText: "ok: edited", usd: 0.25,
};
const state: CityState = {
  agents: [
    { id: "ada", name: "Ada", role: "worker", building: "software", activity: "writing", buildingId: "software", projectId: "site" },
    { id: "vic", name: "Vic", role: "worker", building: "visual", activity: "idle", buildingId: "visual" },
    { id: "boss", name: "Bo", role: "boss", building: "software", activity: "idle", buildingId: "hq" },
  ],
  plots: [{ id: "plot-1", kind: "library", builtBy: "ada" }],
  approvals: [],
  runs: [run],
};
const config: HqConfig = {
  projects: [{
    id: "site", agents: ["ada"], workspace: "C:\\code\\site", edits: "auto", mcp: [], base: "main", budget: { jobTokens: 200000, dayUsd: 1 },
    limits: { stepsPerJob: 0, parallelJobs: 1, reminders: 1, testFixes: 1, sendBacks: 2, conflicts: 1 },
    branches: [{ name: "agent/ada-1", ahead: 2, subject: "fix footer", date: "", stat: "1 file changed" }],
  }],
  agents: [{ id: "ada", name: "Ada", role: "worker", model: "lmstudio/x", persona: "p", building: "software", skills: ["cover-letter"], version: 1 }],
  connections: [{ name: "groq", baseUrl: "https://api.groq.com/openai/v1", hasKey: true }],
  lmStudio: { baseUrl: "http://localhost:1234/v1", hasKey: false },
  mcpServers: [{ name: "gmail", where: "https://example.com/mcp", allow: [], oauth: true, signedIn: false }],
  skills: [{ name: "cover-letter", description: "Write a cover letter" }],
  secrets: ["api-groq"],
  claude: { path: null, signedIn: false, text: "not installed" },
};

describe("signs", () => {
  it("shows the building the avatar faces, else one whose door is within 2 tiles", () => {
    expect(signAt(8, 23, "up")).toBe("software");
    expect(signAt(8, 24, "down")).toBe("software");
    expect(signAt(8, 26, "down")).toBeNull();
  });

  it("names plots by what was built", () => {
    expect(placeInfo("plot-1", "library").name).toBe("Library (plot 1)");
    expect(placeInfo("plot-2").purpose).toContain("Empty");
    expect(placeInfo("software").name).toBe("Software house");
  });
});

describe("progress panel", () => {
  it("formats elapsed time", () => {
    expect(elapsed(42_000)).toBe("42s");
    expect(elapsed(185_000)).toBe("3m 05s");
    expect(elapsed(3_720_000)).toBe("1h 02m");
  });

  it("shows one card per run and sends run.stop", () => {
    const send = vi.fn(() => true);
    const p = new ProgressPanel(document.body, send, () => Date.parse(run.startedAt) + 65_000);
    p.render([run]);
    expect(p.visible).toBe(true);
    expect(p.root.textContent).toContain("fix the footer");
    expect(p.root.textContent).toContain("ada → bob");
    expect(p.root.textContent).toContain("1m 05s");
    p.root.querySelector<HTMLButtonElement>(".run-stop")!.click();
    expect(send).toHaveBeenCalledWith({ type: "run.stop", projectId: "site" });
    p.render([]);
    expect(p.visible).toBe(false);
  });
});

describe("building views", () => {
  let box: HTMLElement;
  let ctx: WorkContext;
  beforeEach(() => {
    document.body.innerHTML = "";
    box = document.createElement("div");
    ctx = { state, config, run: vi.fn(async () => ({ code: 0, text: "Merged" })), notify: vi.fn(), now: () => Date.parse(run.startedAt) };
  });

  it("software house: developers without the boss, and the run; the merge list has a button that runs project merge", () => {
    renderWork(box, "software", ctx);
    const text = box.textContent!;
    expect(text).toContain("Ada");
    expect(text).toContain("fix the footer");
    expect(text).not.toContain("Vic");
    // The boss lives in the software house in this state but is not a developer.
    expect(text).not.toContain("Bo · boss");
    renderMerge(box, ctx);
    expect(box.textContent).toContain("agent/ada-1");
    box.querySelector<HTMLButtonElement>(".work-branch button")!.click();
    expect(ctx.run).toHaveBeenCalledWith(["project", "merge", "site", "agent/ada-1"]);
  });

  it("director lists people by role; the library lists skills and who uses them", () => {
    renderWork(box, "director", ctx);
    expect(box.textContent).toContain("1 running");
    expect(box.textContent).toContain("Bo");
    renderWork(box, "plot-1", ctx);
    expect(box.textContent).toContain("cover-letter");
    expect(box.textContent).toContain("used by Ada");
  });

  it("puts the overview, merge list and preview in their own panels, and only the overview for other houses", () => {
    const left = document.createElement("div");
    const right = document.createElement("div");
    const scan = vi.fn();
    const panel = new BuildingPanel({ main: left, merge: left, preview: right }, () => ctx, scan);
    panel.show("software");
    const boxes = [...left.children].filter((c) => !(c as HTMLElement).hidden);
    expect(boxes.map((b) => b.className)).toEqual(["ac-box building-panel", "ac-box merge-panel"]);
    expect(right.querySelector(".preview-panel iframe")).not.toBeNull();
    expect(panel.previewing).toBe(true);
    expect(scan).toHaveBeenCalledOnce();
    panel.show("visual");
    expect(panel.previewing).toBe(false);
    expect((left.querySelector(".merge-panel") as HTMLElement).hidden).toBe(true);
    panel.hide();
    expect((left.querySelector(".building-panel") as HTMLElement).hidden).toBe(true);
  });

  it("folds a panel down to its header and remembers it", () => {
    localStorage.clear();
    const left = document.createElement("div");
    const right = document.createElement("div");
    const panel = new BuildingPanel({ main: left, merge: left, preview: right }, () => ctx, vi.fn());
    panel.show("software");
    const preview = right.querySelector<HTMLElement>(".preview-panel")!;
    preview.querySelector<HTMLButtonElement>(".panel-fold")!.click();
    expect(preview.classList.contains("folded")).toBe(true);
    expect(preview.querySelector<HTMLElement>(".panel-body")!.hidden).toBe(true);
    expect(preview.querySelector(".panel-head")!.textContent).toContain("Preview");
    // the frame stays in the page, so the site in it keeps running
    expect(preview.querySelector("iframe")).not.toBeNull();
    const again = document.createElement("div");
    new BuildingPanel({ main: again, merge: again, preview: again }, () => ctx, vi.fn()).show("software");
    expect(again.querySelector(".preview-panel")!.classList.contains("folded")).toBe(true);
    preview.querySelector<HTMLButtonElement>(".panel-fold")!.click();
    expect(preview.classList.contains("folded")).toBe(false);
  });

  it("preview addresses stay local", () => {
    expect(normalUrl("5173")).toBe("http://localhost:5173/");
    expect(normalUrl("127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000/app");
    expect(normalUrl("https://example.com")).toBe("about:blank");
  });
});

describe("HQ settings", () => {
  it("splits commands and NAME=VALUE lines", () => {
    expect(splitCommand('npx -y "@scope/server x"')).toEqual(["npx", "-y", "@scope/server x"]);
    expect(pairFlags("--env", "A=1\n\nB=secret:b")).toEqual(["--env", "A=1", "--env", "B=secret:b"]);
  });

  it("creates an agent through hq.do commands and asks for config on open", async () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Created" }));
    const onOpen = vi.fn();
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq, onOpen });
    panel.open();
    expect(onOpen).toHaveBeenCalled();
    panel.setConfig(config);

    const pane = panel.root.querySelector(".pane-agents")!;
    const click = (label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();
    expect(pane.querySelector("input")).toBeNull();
    click("Add");
    const inputs = pane.querySelectorAll<HTMLInputElement>(".hq-settings input:not([type=checkbox])");
    inputs[0]!.value = "max";
    inputs[1]!.value = "Max";
    const create = [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Create agent")!;
    create.click();
    await Promise.resolve();
    expect(runHq).toHaveBeenCalledWith(expect.arrayContaining(["agent", "create", "max", "--name", "Max"]), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Saved: back to the list, with the result on top.
    expect(pane.querySelector("input")).toBeNull();
    expect(pane.textContent).toContain("Created");
  });

  it("project row shows its budget; Limits opens eight number fields and Save runs budget, then the six limits", async () => {
    const runHq = vi.fn<HqDo>(async () => ({ code: 0, text: "Saved" }));
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq, onOpen: vi.fn() });
    panel.setConfig(config);
    const pane = panel.root.querySelector(".pane-projects")!;
    expect(pane.querySelector(".hq-agent-head")!.textContent).toContain("job 200k tokens · $1/day");
    const click = (label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();
    expect(pane.querySelector(".hq-row input")).toBeNull();
    click("Limits");
    const fields = pane.querySelectorAll<HTMLInputElement>(".hq-row input[type=number]");
    expect([...fields].map((f) => f.value)).toEqual(["200000", "1", "0", "1", "1", "1", "2", "1"]);
    expect(pane.querySelector(".hq-note")!.textContent).toContain("0 means no limit");
    [...fields].forEach((f, i) => (f.value = String(i === 0 ? 300000 : i === 1 ? 2 : i + 1)));
    click("Save");
    await new Promise((r) => setTimeout(r, 0));
    expect(runHq.mock.calls.map((c) => c[0])).toEqual([
      ["project", "budget", "site", "300000", "2"],
      ["project", "limits", "site", "stepsPerJob", "3"],
      ["project", "limits", "site", "parallelJobs", "4"],
      ["project", "limits", "site", "reminders", "5"],
      ["project", "limits", "site", "testFixes", "6"],
      ["project", "limits", "site", "sendBacks", "7"],
      ["project", "limits", "site", "conflicts", "8"],
    ]);
    // Saved: the form closes and the result shows on top.
    expect(pane.querySelector(".hq-row input")).toBeNull();
    expect(pane.textContent).toContain("Saved");
  });

  it("Limits save with a bad number shows the message and runs nothing", async () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Saved" }));
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq, onOpen: vi.fn() });
    panel.setConfig(config);
    const pane = panel.root.querySelector(".pane-projects")!;
    const click = (label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();
    click("Limits");
    const fields = pane.querySelectorAll<HTMLInputElement>(".hq-row input[type=number]");
    fields[0]!.value = "";
    click("Save");
    expect(pane.textContent).toContain("Budget must be two numbers of 0 or more.");
    fields[0]!.value = "1000";
    fields[2]!.value = "1.5";
    click("Save");
    expect(pane.textContent).toContain("Limits must be whole numbers of 0 or more.");
    fields[2]!.value = "0";
    fields[4]!.value = "-1";
    click("Save");
    expect(pane.textContent).toContain("Limits must be whole numbers of 0 or more.");
    expect(runHq).not.toHaveBeenCalled();
  });

  it("Remove asks first, then runs agent remove; a no sends nothing", async () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Removed agent ada" }));
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq, onOpen: vi.fn() });
    panel.setConfig(config);
    const pane = panel.root.querySelector(".pane-agents")!;
    const remove = () => [...pane.querySelectorAll<HTMLButtonElement>(".hq-agent button")].find((b) => b.textContent === "Remove")!.click();
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    remove();
    expect(ask).toHaveBeenCalledWith("Delete Ada? This removes the profile, versions and notes.");
    expect(runHq).not.toHaveBeenCalled();
    remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(runHq).toHaveBeenCalledWith(["agent", "remove", "ada"], undefined);
    expect(pane.textContent).toContain("Removed agent ada");
    ask.mockRestore();
  });

  it("agents list shows each agent and what it does; Edit, Back and Cancel move between list and form", () => {
    const panel = new HqPanel(document.body, vi.fn(() => true));
    panel.render(state);
    panel.setConfig(config);
    const pane = panel.root.querySelector(".pane-agents")!;
    const click = (label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();
    expect(pane.querySelector(".hq-agent")!.textContent).toContain("Ada (ada)");
    expect(pane.querySelector(".hq-agent .hw-tag.live")!.textContent).toBe("writing");
    click("Edit");
    expect(pane.textContent).toContain("Edit Ada");
    expect(pane.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    click("‹ Back");
    expect(pane.querySelector(".hq-agent")).not.toBeNull();
    click("Add");
    pane.querySelectorAll<HTMLInputElement>("input")[1]!.value = "Draft";
    // A city update while the form is open keeps the draft.
    panel.render(state);
    panel.setConfig(config);
    expect(pane.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe("Draft");
    click("Cancel");
    expect(pane.querySelector("input")).toBeNull();
    click("Add");
    expect(pane.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe("");
  });

  it("switches between Work and Configure, each with its own containers, and remembers the mode", () => {
    localStorage.clear();
    const panel = new HqPanel(document.body, vi.fn(() => true));
    panel.open();
    const shown = () => [...panel.root.querySelectorAll<HTMLElement>(".hq-box")].filter((b) => !b.hidden).map((b) => b.querySelector(".hq-box-title")!.textContent);
    expect(panel.mode).toBe("work");
    expect(shown()).toEqual(["Projects", "Activity", "Performance · 7 days", "City · 7 days"]);
    [...panel.root.querySelectorAll<HTMLButtonElement>(".hq-mode")].find((b) => b.textContent === "Configure")!.click();
    expect(shown()).toEqual(["Agents", "Projects", "Skills", "APIs", "MCP servers"]);
    expect(new HqPanel(document.body, vi.fn(() => true)).mode).toBe("configure");
    panel.root.querySelector<HTMLButtonElement>(".hq-close")!.click();
    expect(panel.isOpen).toBe(false);
  });

  it("folds a container from its header and keeps the fold", () => {
    localStorage.clear();
    const panel = new HqPanel(document.body, vi.fn(() => true));
    const box = panel.root.querySelector<HTMLElement>(".box-activity")!;
    box.querySelector<HTMLElement>(".hq-box-head")!.click();
    expect(box.classList.contains("folded")).toBe(true);
    expect(box.querySelector<HTMLElement>(".hq-box-body")!.hidden).toBe(true);
    const again = new HqPanel(document.body, vi.fn(() => true));
    expect(again.root.querySelector(".box-activity")!.classList.contains("folded")).toBe(true);
  });

  it("work view: stats in activity, performance and city", () => {
    localStorage.clear();
    const panel = new HqPanel(document.body, vi.fn(() => true));
    panel.render(state);
    panel.setConfig(config);
    panel.setStats({
      days: [{ day: "2026-10-31", runs: 1, usd: 0.1 }, { day: "2026-11-01", runs: 3, usd: 0.4 }],
      runs: 4, done: 3, usd: 0.5, tools: 12, approvals: { approved: 3, denied: 1, pending: 0 },
      perAgent: [{ agentId: "ada", runs: 4, done: 3, usd: 0.5, tools: 12 }],
      activity: [{ ts: "2026-11-01T10:05:00.000Z", agentId: "ada", projectId: "site", kind: "done", text: "stopped: done, 4 steps" }],
    });
    expect(panel.root.querySelector(".hw-act.done .hw-what")!.textContent).toBe("stopped: done, 4 steps");
    expect([...panel.root.querySelectorAll(".pane-performance td")].map((td) => td.textContent)).toEqual(["Ada", "4", "75%", "12", "$0.50"]);
    expect([...panel.root.querySelectorAll(".hw-tile-value")].map((t) => t.textContent)).toEqual(["4", "75%", "$0.50", "75%"]);
    expect(panel.root.querySelectorAll(".hw-bar").length).toBe(2);
  });

  it("the Claude subscription row shows its state and the button for the next step", async () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Installing in a new window." }));
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq });
    const row = () => panel.root.querySelector(".pane-connections .hq-claude")!;
    const buttons = () => [...row().querySelectorAll("button")].map((b) => b.textContent);
    panel.setConfig(config);
    expect(row().textContent).toContain("Claude subscription");
    expect(row().textContent).toContain("not installed");
    expect(buttons()).toEqual(["Install", "Check again"]);
    row().querySelector("button")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(runHq).toHaveBeenCalledWith(["claude", "install"], undefined);
    panel.setConfig({ ...config, claude: { path: "C:\c\claude.exe", signedIn: false, text: "not signed in" } });
    expect(buttons()).toEqual(["Sign in", "Check again"]);
    panel.setConfig({ ...config, claude: { path: "C:\c\claude.exe", signedIn: true, text: "ready" } });
    expect(buttons()).toEqual(["Check again"]);
    expect(row().querySelector(".hw-tag")!.className).toContain("live");
  });

  it("APIs, MCP, projects and skills list what exists; Add opens the form, Cancel and a save go back", async () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Added" }));
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq });
    panel.setConfig(config);
    for (const [sel, row, add, done] of [[".pane-connections", "groq", "Add", "Add API"], [".pane-mcp", "gmail", "Add", "Add server"], [".pane-projects", "site", "Add", "Create project"], [".pane-skills", "cover-letter", "Add", "Save skill"]] as const) {
      const pane = panel.root.querySelector(sel)!;
      const click = (label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();
      expect(pane.querySelector(".hq-row .hq-row-head")!.textContent).toBe(row);
      expect(pane.querySelector(".hq-row input:not([type=password])")).toBeNull();
      click(add);
      expect(pane.querySelector(".hq-row")).toBeNull();
      click("Cancel");
      expect(pane.querySelector(".hq-row .hq-row-head")!.textContent).toBe(row);
      click(add);
      pane.querySelector<HTMLInputElement>("input")!.value = "x";
      click(done);
      await new Promise((r) => setTimeout(r, 0));
      expect(pane.querySelector(".hq-row .hq-row-head")!.textContent).toBe(row);
      expect(pane.textContent).toContain("Added");
    }
    panel.setConfig({ ...config, connections: [], mcpServers: [], projects: [], skills: [] });
    expect(panel.root.querySelector(".pane-projects")!.textContent).toContain("No projects yet");
    expect(panel.root.querySelector(".pane-skills")!.textContent).toContain("No skills yet");
    expect(panel.root.querySelector(".pane-connections")!.textContent).toContain("No other APIs yet");
    expect(panel.root.querySelector(".pane-mcp")!.textContent).toContain("No MCP servers yet");
  });

  it("agent form picks the model from a dropdown of each source's models, or a typed id under other", async () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Created" }));
    const send = vi.fn(() => true);
    const panel = new HqPanel(document.body, send, undefined, { run: runHq });
    panel.render(state);
    panel.setConfig(config);
    const pane = panel.root.querySelector(".pane-agents")!;
    const click = (label: string) => [...pane.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!.click();
    click("Add");
    expect(send).toHaveBeenCalledWith({ type: "models.list" });
    panel.setModels([
      { label: "LM Studio", models: ["lmstudio/qwen3"] },
      { label: "API: groq", models: [], error: "cannot reach https://x" },
    ]);
    const field = (label: string) => [...pane.querySelectorAll(".ac-field")].find((f) => f.querySelector(".ac-label")!.textContent === label)!;
    const select = field("Model").querySelector("select")!;
    expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["LM Studio", "API: groq"]);
    expect(select.querySelector("option:disabled")!.textContent).toBe("cannot reach https://x");
    expect((field("Model id") as HTMLElement).hidden).toBe(true);
    const inputs = pane.querySelectorAll<HTMLInputElement>("input:not([type=checkbox])");
    inputs[0]!.value = "max";
    inputs[1]!.value = "Max";
    select.value = "lmstudio/qwen3";
    click("Create agent");
    await Promise.resolve();
    expect(runHq).toHaveBeenCalledWith(expect.arrayContaining(["--model", "lmstudio/qwen3"]), undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Other: a typed id, kept through a redraw.
    click("Add");
    const other = field("Model").querySelector("select")!;
    other.value = [...other.options].at(-1)!.value;
    other.dispatchEvent(new Event("change"));
    expect((field("Model id") as HTMLElement).hidden).toBe(false);
    field("Model id").querySelector("input")!.value = "api/groq/llama";
    panel.setConfig(config);
    expect((field("Model id") as HTMLElement).hidden).toBe(false);
    expect(field("Model id").querySelector("input")!.value).toBe("api/groq/llama");
  });

  it("a key goes as hidden input to secrets set and the field clears", () => {
    const runHq = vi.fn(async () => ({ code: 0, text: "Saved" }));
    const panel = new HqPanel(document.body, vi.fn(() => true), undefined, { run: runHq });
    panel.setConfig(config);
    const row = panel.root.querySelector(".pane-connections .hq-row")!;
    const key = row.querySelector<HTMLInputElement>("input[type=password]")!;
    key.value = "sk-abc";
    [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save key")!.click();
    expect(runHq).toHaveBeenCalledWith(["secrets", "set", "api-groq"], "sk-abc");
    expect(key.value).toBe("");
  });
});
