// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CityState, HqConfig, ModelGroup } from "@agentcity/world/shared";
import { HqPanel } from "../src/ui/hq-panel.js";

const approval = (id: number, local: boolean) => ({
  id, projectId: "p1", agentId: "ada", tool: "build", argsPreview: `plot ${id}`, tier: 3, estimatedUsd: 0, local,
});
const state: CityState = {
  agents: [
    { id: "ada", name: "Ada", role: "worker", building: "software", activity: "writing", buildingId: "software" },
    { id: "mgr", name: "Max", role: "manager", building: "software", activity: "idle", buildingId: "hq" },
  ],
  plots: [],
  approvals: [approval(7, true), approval(8, false)],
  runs: [],
};

let send: ReturnType<typeof vi.fn<(m: unknown) => boolean>>;
let panel: HqPanel;
const q = <T extends Element>(sel: string) => panel.root.querySelector<T>(sel)!;

beforeEach(() => {
  document.body.innerHTML = "";
  send = vi.fn(() => true);
  panel = new HqPanel(document.body, send as never);
  panel.render(state);
  panel.open();
});

describe("HqPanel work view", () => {
  it("Work shows Projects left and Activity, Performance, City right; no Buildings box", () => {
    const titles = (col: string) => [...panel.root.querySelectorAll<HTMLElement>(`.${col} .hq-box`)].filter((b) => !b.hidden).map((b) => b.querySelector(".hq-box-title")!.textContent);
    expect(titles("hq-left")).toEqual(["Projects"]);
    expect(titles("hq-right")).toEqual(["Activity", "Performance · 7 days", "City · 7 days"]);
    expect(panel.root.querySelector(".box-projects-panel")).not.toBeNull();
    expect(panel.root.querySelector(".box-buildings")).toBeNull();
    expect(panel.root.textContent).not.toContain("Buildings");
  });

  it("mountProjects gets the Work Projects body", () => {
    const mount = vi.fn();
    const p = new HqPanel(document.body, send as never, undefined, { mountProjects: mount });
    expect(mount).toHaveBeenCalledWith(p.root.querySelector(".box-projects-panel .hq-box-body"));
  });

  it("onClose runs when HQ closes", () => {
    const onClose = vi.fn();
    const p = new HqPanel(document.body, send as never, undefined, { onClose });
    p.open();
    p.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Work has no Approvals box", () => {
    expect(panel.root.querySelector(".box-approvals")).toBeNull();
    expect(panel.root.querySelector(".approval")).toBeNull();
    expect(panel.root.textContent).not.toContain("Approvals");
  });

  it("HQ bar has no Terminal button and no error line", () => {
    expect(q(".hq-bar").textContent).not.toContain("Terminal");
    expect(panel.root.querySelector(".hq-term")).toBeNull();
    expect(panel.root.querySelector(".hq-error")).toBeNull();
  });
});

describe("HqPanel agents", () => {
  it("lists id, name, role and activity", () => {
    const text = panel.root.querySelector(".pane-agents")!.textContent!;
    for (const s of ["ada", "Ada", "worker", "writing", "mgr", "manager", "idle"]) expect(text).toContain(s);
  });

  it("closes on close() and reports open state", () => {
    const seen: boolean[] = [];
    const p = new HqPanel(document.body, send as never, (o) => seen.push(o));
    p.open();
    p.close();
    expect(seen).toEqual([true, false]);
    expect(p.isOpen).toBe(false);
  });
});

describe("HqPanel APIs", () => {
  const apis = (over: Record<string, unknown> = {}): HqConfig => ({
    projects: [], agents: [], skills: [], mcpServers: [], secrets: [],
    connections: [{ name: "groq", baseUrl: "https://api.groq.com/openai/v1", hasKey: true }],
    lmStudio: { baseUrl: "http://localhost:1234/v1", hasKey: false },
    claude: { path: "/opt/claude", signedIn: true, text: "Claude ready" },
    ...over,
  }) as unknown as HqConfig;
  const kind = (c: unknown) => (c as { type: string }).type;
  const asks = () => send.mock.calls.filter((c) => kind(c[0]) === "models.list").length;
  const card = (name: string) => [...panel.root.querySelectorAll<HTMLElement>(".pane-connections .hq-agent-head")]
    .find((h) => h.querySelector(".hq-row-head")?.textContent === name)!.parentElement!;
  const tag = (name: string) => card(name).querySelector<HTMLElement>(".hw-tag")!;
  const button = (name: string, text: string) => [...card(name).querySelectorAll("button")].find((b) => b.textContent === text)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let run: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    send = vi.fn(() => true);
    run = vi.fn(async () => ({ code: 0, text: "done" }));
    panel = new HqPanel(document.body, send as never, undefined, { run: run as never });
    panel.setConfig(apis());
    panel.open("configure");
  });

  it("asks for models once when the APIs pane shows", () => {
    expect(asks()).toBe(1);
  });

  it("a config redraw and a models answer do not ask again", () => {
    const before = asks();
    panel.setConfig(apis());
    panel.setModels([]);
    expect(asks()).toBe(before);
  });

  it("shows checking, error, connected with models, and connected with no models", () => {
    expect(tag("LM Studio").textContent).toBe("checking");
    expect(tag("LM Studio").classList.contains("warn")).toBe(true);
    expect(tag("groq").textContent).toBe("checking");

    const answer = (groups: ModelGroup[]) => panel.setModels(groups);
    answer([
      { label: "LM Studio", models: [], error: "cannot reach http://localhost:1234/v1" },
      { label: "API: groq", models: ["api/groq/llama"] },
    ]);
    expect(tag("LM Studio").textContent).toBe("cannot reach http://localhost:1234/v1");
    expect(tag("LM Studio").classList.contains("warn")).toBe(true);
    expect(tag("groq").textContent).toBe("connected, 1 models");
    expect(tag("groq").classList.contains("live")).toBe(true);

    answer([
      { label: "LM Studio", models: ["lmstudio/qwen/qwen3-14b", "lmstudio/llama"] },
      { label: "API: groq", models: [] },
    ]);
    expect(tag("LM Studio").textContent).toBe("connected, 2 models");
    expect(tag("LM Studio").classList.contains("live")).toBe(true);
    expect(tag("groq").textContent).toBe("connected, no models");
    expect(tag("groq").classList.contains("warn")).toBe(true);
  });

  it("lists the model ids in a fold that starts closed", () => {
    panel.setModels([{ label: "LM Studio", models: ["lmstudio/qwen/qwen3-14b"] }]);
    const fold = card("LM Studio").querySelector<HTMLDetailsElement>("details")!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain("lmstudio/qwen/qwen3-14b");
  });

  it("saving a key runs secrets set and asks for models again", async () => {
    const before = asks();
    const input = card("LM Studio").querySelector<HTMLInputElement>("input[type=password]")!;
    input.value = "k-fake";
    button("LM Studio", "Save key").click();
    await vi.waitFor(() => expect(asks()).toBe(before + 1));
    expect(run).toHaveBeenCalledWith(["secrets", "set", "lmstudio"], "k-fake");
  });

  it("Check again asks for models without running a command", async () => {
    const before = asks();
    button("LM Studio", "Check again").click();
    await flush();
    expect(asks()).toBe(before + 1);
    expect(run).not.toHaveBeenCalled();
  });

  it("Save on the Base URL runs lmstudio url with the typed address", async () => {
    const url = card("LM Studio").querySelector<HTMLInputElement>("input:not([type=password])")!;
    url.value = "http://127.0.0.1:1234";
    button("LM Studio", "Save").click();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(["lmstudio", "url", "http://127.0.0.1:1234"], undefined));
  });

  it("the empty list says No other APIs yet, and the New API note names local servers", () => {
    panel.setConfig(apis({ connections: [] }));
    const pane = panel.root.querySelector<HTMLElement>(".pane-connections")!;
    expect(pane.textContent).toContain("No other APIs yet.");
    [...pane.querySelectorAll("button")].find((b) => b.textContent === "Add")!.click();
    expect(pane.textContent).toContain("Local servers usually need a key too, if their token setting is on.");
  });
});
