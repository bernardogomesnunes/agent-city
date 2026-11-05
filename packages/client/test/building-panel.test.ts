// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CityState, ClientMsg, HqConfig } from "@agentcity/world/shared";
import { BuildingPanel } from "../src/ui/building-panel.js";
import { ProjectsPanel } from "../src/ui/projects-panel.js";
import type { WorkContext } from "../src/ui/work.js";

const config = {
  projects: [
    { id: "site", agents: ["ada"], workspace: "C:\\code\\site", edits: "auto", mcp: [], base: "main", branches: [] },
    { id: "plain", agents: [], edits: "auto", mcp: [], branches: [] },
  ],
  agents: [], connections: [], mcpServers: [], skills: [], secrets: [],
  claude: { path: null, signedIn: false, text: "not installed" },
} as unknown as HqConfig;
const state: CityState = { agents: [], plots: [], approvals: [], runs: [] };

let send: ReturnType<typeof vi.fn<(m: ClientMsg) => boolean>>;
let projects: ProjectsPanel;
const sent = () => send.mock.calls.map((c) => c[0]);
const ctx = (): WorkContext => ({ state, config, run: vi.fn(async () => ({ code: 0, text: "" })), notify: vi.fn() });

beforeEach(() => {
  document.body.innerHTML = "";
  send = vi.fn(() => true);
  projects = new ProjectsPanel(document.createElement("div"), send as never, { chat: vi.fn(), run: vi.fn(async () => ({ code: 0, text: "" })) });
  projects.render({ config, boards: new Map(), decisions: [], paused: [] });
  send.mockClear();
});

describe("the software house", () => {
  it("shows the projects panel in its box and sends board.watch for every project, sandbox ones too", () => {
    const left = document.createElement("div");
    const right = document.createElement("div");
    const panel = new BuildingPanel({ projects: left, main: left, merge: left, preview: right }, ctx, vi.fn(), true, projects);
    panel.show("software");
    expect(sent()).toContainEqual({ type: "board.watch", projectId: "site" });
    expect(sent()).toContainEqual({ type: "board.watch", projectId: "plain" });
    expect((left.querySelector(".projects-box") as HTMLElement).hidden).toBe(false);
    expect(left.querySelector(".projects-box")!.contains(projects.root)).toBe(true);
    panel.show("visual");
    expect((left.querySelector(".projects-box") as HTMLElement).hidden).toBe(true);
  });

  it("the HQ Buildings view, unboxed, shows the projects panel for the software house", () => {
    const holder = document.createElement("div");
    const panel = new BuildingPanel({ projects: holder, main: holder, merge: holder, preview: holder }, ctx, vi.fn(), false, projects);
    panel.show("software");
    expect(holder.contains(projects.root)).toBe(true);
    expect(sent()).toContainEqual({ type: "board.watch", projectId: "site" });
  });

  it("leaving the software house returns the projects panel to level 1", () => {
    const left = document.createElement("div");
    const panel = new BuildingPanel({ projects: left, main: left, merge: left, preview: left }, ctx, vi.fn(), true, projects);
    panel.show("software");
    projects.open("site");
    expect(projects.level).toBe(2);
    panel.hide();
    expect(projects.level).toBe(1);
  });

  it("each visit asks again for the board of every project", () => {
    const left = document.createElement("div");
    const panel = new BuildingPanel({ projects: left, main: left, merge: left, preview: left }, ctx, vi.fn(), true, projects);
    panel.show("software");
    send.mockClear();
    panel.hide();
    panel.show("software");
    expect(sent().filter((m) => m.type === "board.watch")).toHaveLength(2);
  });
});
