// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView, DiffFileView, FileTree, GoalView, HqConfig, TaskView } from "@agentcity/world/shared";
import { ProjectsPanel, managerOf, type ChatRef, type PanelState } from "../src/ui/projects-panel.js";

const T = (n: number) => `2026-11-04T10:0${n}:00.000Z`;
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  id: "g1", projectId: "gamenew", text: "Have the game ready for release", status: "active", createdAt: T(0), updatedAt: T(0),
  done: 2, total: 5, planState: "approved", plan: null, ...over,
});
const task = (over: Partial<TaskView>): TaskView => ({
  id: "t1", goalId: "g1", parentId: "team", projectId: "gamenew", title: "Task", description: "", assignee: "ada", deps: [],
  status: "todo", branch: null, worktree: null, summary: null, blockedReason: null, ci: "none", testOutput: null, checkpoint: null,
  held: false, createdBy: "mgr", createdAt: T(0), updatedAt: T(0), ...over,
});
const team = task({ id: "team", parentId: null, title: "Team task", assignee: null, status: "doing", createdBy: "boss" });
const tasks: TaskView[] = [
  team,
  task({ id: "t1", title: "Fix broken index.html", status: "doing" }),
  task({ id: "t2", title: "Polish controls", status: "review", assignee: "zed", branch: "agent/zed/t2" }),
  task({ id: "t3", title: "Write the README", status: "todo" }),
  task({ id: "t4", title: "Blocked thing", status: "blocked", blockedReason: "why?" }),
  task({ id: "t5", title: "Needs OK", status: "approval" }),
  task({ id: "t6", title: "Older delivery", status: "done", updatedAt: T(1), branch: "agent/ada/t6" }),
  task({ id: "t7", title: "Newer delivery", status: "done", updatedAt: T(5), assignee: null }),
];
const decision = (id: string, projectId: string): DecisionView => ({
  id, kind: "blocked", projectId, agentId: "ada", title: "q", text: "q", since: T(0),
});
const LIMITS = { stepsPerJob: 0, parallelJobs: 1, reminders: 1, testFixes: 1, sendBacks: 2, conflicts: 1 };
const config = (): HqConfig => ({
  projects: [
    { id: "gamenew", agents: ["boss", "mgr", "ada"], workspace: "C:\\code\\gamenew", edits: "auto", mcp: [], budget: { jobTokens: 0, dayUsd: 0 }, limits: LIMITS, branches: [] },
    { id: "pong", agents: ["ada"], edits: "auto", mcp: [], budget: { jobTokens: 0, dayUsd: 0 }, limits: LIMITS, branches: [] },
    { id: "demo", agents: [], edits: "auto", mcp: [], budget: { jobTokens: 0, dayUsd: 0 }, limits: LIMITS, branches: [] },
  ],
  agents: [
    { id: "boss", name: "Bo", role: "boss", model: "", persona: "", building: "software", skills: [], version: 1 },
    { id: "mgr", name: "Max", role: "manager", model: "", persona: "", building: "software", skills: [], version: 1 },
    { id: "ada", name: "Ada", role: "worker", model: "", persona: "", building: "software", skills: ["testing"], version: 1 },
    { id: "zed", name: "Zed", role: "worker", model: "", persona: "", building: "software", skills: [], version: 1 },
  ],
  connections: [],
  lmStudio: { baseUrl: "http://localhost:1234/v1", hasKey: false },
  mcpServers: [{ name: "github", where: "x", allow: [], oauth: false, signedIn: false }],
  skills: [{ name: "game-design", description: "" }, { name: "testing", description: "" }],
  secrets: [],
  claude: { path: null, signedIn: false, text: "" },
});
const state = (over: Partial<PanelState> = {}): PanelState => ({
  config: config(),
  boards: new Map([
    ["gamenew", { goals: [goal()], tasks }],
    ["pong", { goals: [goal({ id: "g2", projectId: "pong", done: 3, total: 4 })], tasks: [task({ id: "p1", goalId: "g2", projectId: "pong", status: "doing" })] }],
    ["demo", { goals: [], tasks: [] }],
  ]),
  decisions: [decision("d1", "gamenew"), decision("d2", "gamenew")],
  paused: ["demo"],
  ...over,
});

let send: ReturnType<typeof vi.fn<(m: unknown) => boolean>>;
let chat: ReturnType<typeof vi.fn<(ref: ChatRef) => void>>;
let run: ReturnType<typeof vi.fn<(argv: string[], input?: string) => Promise<{ code: number; text: string }>>>;
let panel: ProjectsPanel;
let host: HTMLElement;
const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)!;
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((b) => b.textContent === label)!;
const sections = () => [...host.querySelectorAll<HTMLElement>(".pp-section")];
const section = (name: string) => sections().find((s) => s.querySelector(".ac-sec")!.textContent === name)!;
const titles = (name: string) => [...section(name).querySelectorAll(".pp-task-title")].map((e) => e.textContent);
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Lets the 100 ms redraw gate pass. */
const frame = () => void vi.advanceTimersByTime(100);

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  send = vi.fn(() => true);
  chat = vi.fn();
  run = vi.fn(async () => ({ code: 0, text: "ok" }));
  panel = new ProjectsPanel(host, send as never, { chat, run });
  panel.render(state());
});

describe("level 1", () => {
  it("level 1 lists projects with dot, done count, working count, inbox count and paused tag", () => {
    expect(panel.level).toBe(1);
    const rows = [...host.querySelectorAll<HTMLElement>(".pp-row")];
    expect(rows.map((r) => r.querySelector(".pp-name")!.textContent)).toEqual(["gamenew", "pong", "demo"]);
    const [game, pong, demo] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(game.querySelector(".st-dot")!.classList.contains("ask")).toBe(true);
    expect(game.textContent).toContain("2 of 7 done");
    expect(game.textContent).toContain("1 working");
    expect(game.querySelector(".pp-inbox")!.textContent).toBe("2");
    expect(pong.querySelector(".st-dot")!.classList.contains("run")).toBe(true);
    expect(pong.textContent).toContain("0 of 1 done");
    expect(pong.textContent).toContain("1 working");
    expect(pong.querySelector(".pp-inbox")).toBeNull();
    expect(demo.querySelector(".st-dot")!.classList.contains("idle")).toBe(true);
    expect(demo.textContent).toContain("0 of 0 done");
    expect(demo.querySelector(".pp-paused")!.textContent).toBe("paused");
    expect(game.querySelector(".pp-paused")).toBeNull();
  });

  it("counts come from the task views when the goal says 0 of 0", () => {
    const blocked = [1, 2, 3, 4, 5].map((n) => task({ id: `b${n}`, status: "blocked" }));
    panel.render(state({ decisions: [], boards: new Map([["gamenew", { goals: [goal({ done: 0, total: 0 })], tasks: [team, ...blocked, task({ id: "x", status: "cancelled" })] }]]) }));
    expect(host.querySelector(".pp-row")!.textContent).toContain("0 of 5 done");
    host.querySelector<HTMLButtonElement>(".pp-row")!.click();
    expect(host.querySelector(".pp-head .pp-sub")!.textContent).toBe("0 of 5 done");
    expect(host.querySelector(".pp-goal .pp-sub")!.textContent).toBe("0 of 5 done");
  });

  it("a project with a blocked task and no inbox item shows a red dot", () => {
    panel.render(state({ decisions: [] }));
    expect(host.querySelector(".pp-row .st-dot")!.classList.contains("block")).toBe(true);
  });

  it("no projects shows Start your first project and New project", () => {
    panel.render(state({ config: { ...config(), projects: [] } }));
    expect(host.textContent).toContain("Start your first project");
    expect(button("New project")).toBeDefined();
    expect(host.querySelector(".pp-row")).toBeNull();
  });

  it("a second panel on the same connection sends no second board.watch", () => {
    const other = new ProjectsPanel(document.createElement("div"), send as never, { chat, run });
    other.render(state());
    expect(send.mock.calls.filter((c) => (c[0] as { type: string }).type === "board.watch")).toHaveLength(3);
  });

  it("sends board.watch once per project, and again after watchAll", () => {
    const watched = () => send.mock.calls.map((c) => c[0]).filter((m) => (m as { type: string }).type === "board.watch");
    expect(watched()).toEqual([
      { type: "board.watch", projectId: "gamenew" }, { type: "board.watch", projectId: "pong" }, { type: "board.watch", projectId: "demo" },
    ]);
    panel.render(state());
    expect(watched()).toHaveLength(3);
    panel.watchAll();
    expect(watched()).toHaveLength(6);
  });
});

const goalRow = (text: string) => [...host.querySelectorAll<HTMLElement>(".pp-goal-open")].find((r) => r.textContent!.includes(text))!;
const taskRow = (title: string) => [...host.querySelectorAll<HTMLElement>(".pp-task-open")].find((r) => r.textContent!.includes(title))!;
const openProject = () => host.querySelector<HTMLButtonElement>(".pp-row")!.click();
const openGoal = (text = "Have the game ready for release") => {
  openProject();
  goalRow(text).click();
};
const openTask = (title: string) => {
  openGoal();
  taskRow(title).click();
};

describe("level 2", () => {
  it("a row opens level 2; Back returns to level 1; a redraw keeps the level", () => {
    openProject();
    expect(panel.level).toBe(2);
    expect(q(".pp-title").textContent).toBe("gamenew");
    panel.render(state());
    expect(panel.level).toBe(2);
    button("‹ Projects").click();
    expect(panel.level).toBe(1);
    expect(host.querySelector(".pp-row")).not.toBeNull();
  });

  it("level 2 shows the project progress bar and the goal box, and no task sections", () => {
    openProject();
    expect(q<HTMLElement>(".pp-bar-fill").style.width).toBe("29%");
    expect(q(".pp-sub").textContent).toBe("2 of 7 done");
    expect(sections().map((s) => s.querySelector(".ac-sec")!.textContent)).toEqual(["Goals"]);
    expect(host.textContent).not.toContain("Working now");
    expect(host.textContent).not.toContain("Backlog");
    expect(host.textContent).not.toContain("Delivered");
    expect(q(".pp-goal-box")).not.toBeNull();
  });

  it("level 2 lists active goals (planning and active) as one-line rows with done counts counted from tasks", () => {
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal(), goal({ id: "g8", text: "Early plan", status: "planning" })], tasks }]]) }));
    openProject();
    const rows = [...host.querySelectorAll<HTMLElement>(".pp-goal")];
    expect(rows.map((r) => r.querySelector(".pp-goal-text")!.textContent)).toEqual(["Have the game ready for release", "Early plan"]);
    expect(rows[0]!.querySelector(".pp-sub")!.textContent).toBe("2 of 7 done");
    expect(rows[0]!.querySelector(".st-dot")!.classList.contains("run")).toBe(true);
  });

  it("the goal Chat button calls chat with the Manager from managerOf", () => {
    openProject();
    const goalChat = [...host.querySelectorAll<HTMLButtonElement>(".pp-goal .pp-chat")][0]!;
    expect(goalChat.textContent).toBe("Chat · Max");
    goalChat.click();
    expect(chat).toHaveBeenCalledWith({ agentId: "mgr", projectId: "gamenew", goalId: "g1" });
  });

  it("past goals fold: closed by default, holds done, cancelled and failed goals; opening the fold lists them", () => {
    panel.render(state({
      boards: new Map([["gamenew", {
        goals: [goal(), goal({ id: "g3", text: "Old idea", status: "done" }), goal({ id: "g4", text: "Dropped plan", status: "cancelled" }), goal({ id: "g5", text: "Broke", status: "failed" })],
        tasks,
      }]]),
    }));
    openProject();
    expect(host.querySelectorAll(".pp-goal")).toHaveLength(1);
    const fold = button("Past goals (3)");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("Old idea");
    fold.click();
    expect(button("Past goals (3)").getAttribute("aria-expanded")).toBe("true");
    const past = [...host.querySelectorAll<HTMLElement>(".pp-goal")].slice(1).map((r) => r.querySelector(".pp-goal-text")!.textContent);
    expect(past).toEqual(["Old idea", "Dropped plan", "Broke"]);
    expect(host.querySelectorAll(".pp-goal")[1]!.querySelector(".st-dot")!.classList.contains("done")).toBe(true);
  });

  it("the goal box sends goal.submit and keeps its text across a redraw", () => {
    openProject();
    const input = q<HTMLInputElement>(".pp-goal-input");
    expect(input.placeholder).toBe("A goal for the team");
    input.value = "make a menu";
    input.dispatchEvent(new Event("input"));
    panel.render(state({ decisions: [] }));
    expect(q<HTMLInputElement>(".pp-goal-input").value).toBe("make a menu");
    button("Submit goal").click();
    expect(send).toHaveBeenLastCalledWith({ type: "goal.submit", projectId: "gamenew", text: "make a menu" });
    expect(q<HTMLInputElement>(".pp-goal-input").value).toBe("");
  });

  it("Pause sends project.pause; a paused project shows Resume", () => {
    openProject();
    button("Pause").click();
    expect(send).toHaveBeenLastCalledWith({ type: "project.pause", projectId: "gamenew", paused: true });
    panel.render(state({ paused: ["gamenew"] }));
    button("Resume").click();
    expect(send).toHaveBeenLastCalledWith({ type: "project.pause", projectId: "gamenew", paused: false });
  });

  it("Delete shows the verbatim confirm and Delete runs project remove", async () => {
    openProject();
    button("Delete").click();
    expect(host.textContent).toContain("Delete gamenew? Runs stop. Goals, tasks and agent branches leave the city. The folder stays on disk.");
    expect(host.textContent).toContain("C:\\code\\gamenew");
    expect(run).not.toHaveBeenCalled();
    button("Keep").click();
    expect(host.textContent).not.toContain("Runs stop.");
    button("Delete").click();
    button("Delete").click();
    expect(run).toHaveBeenCalledWith(["project", "remove", "gamenew"]);
    await flush();
    expect(panel.level).toBe(1);
  });

  it("a failed Delete keeps the confirm and shows the reason", async () => {
    run.mockResolvedValueOnce({ code: 1, text: "stop the runs first" });
    openProject();
    button("Delete").click();
    button("Delete").click();
    await flush();
    expect(host.textContent).toContain("stop the runs first");
    expect(panel.level).toBe(2);
    expect(button("Delete").disabled).toBe(false);
  });

  it("the open project disappears: panel returns to level 1", () => {
    openProject();
    button("Delete").click();
    const rest = config();
    rest.projects = rest.projects.filter((p) => p.id !== "gamenew");
    panel.render(state({ config: rest }));
    expect(panel.level).toBe(1);
    expect(host.textContent).not.toContain("Runs stop.");
    expect([...host.querySelectorAll(".pp-name")].map((e) => e.textContent)).toEqual(["pong", "demo"]);
  });

  it("open(projectId) goes to level 2 and open() of an unknown project stays on level 1", () => {
    panel.open("pong");
    expect(panel.level).toBe(2);
    expect(q(".pp-title").textContent).toBe("pong");
    panel.open("nope");
    expect(panel.level).toBe(1);
  });
});

describe("level 3", () => {
  it("a goal row opens level 3: goal text, status, progress bar, and Back to the project", () => {
    openGoal();
    expect(panel.level).toBe(3);
    expect(q(".pp-title").textContent).toBe("Have the game ready for release");
    expect(host.querySelector(".pp-head")!.textContent).toContain("active");
    expect(q<HTMLElement>(".pp-bar-fill").style.width).toBe("29%");
    panel.render(state());
    expect(panel.level).toBe(3);
    button("‹ gamenew").click();
    expect(panel.level).toBe(2);
    expect(host.querySelector(".pp-goal-box")).not.toBeNull();
  });

  it("shows only this goal's tasks in Working now, Backlog and Delivered, Delivered newest first", () => {
    const other = task({ id: "x1", goalId: "g6", title: "Other goal task", status: "doing" });
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal(), goal({ id: "g6", text: "Second goal" })], tasks: [...tasks, other] }]]) }));
    openGoal();
    expect(titles("Working now")).toEqual(["Fix broken index.html", "Polish controls"]);
    expect(titles("Backlog")).toEqual(["Write the README", "Blocked thing", "Needs OK"]);
    expect(titles("Delivered")).toEqual(["Newer delivery", "Older delivery"]);
    expect(host.textContent).not.toContain("Other goal task");
  });

  it("a section with no tasks is hidden", () => {
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal()], tasks: [team, task({ id: "w", title: "Only todo", status: "todo" })] }]]) }));
    openGoal();
    expect(sections().map((s) => s.querySelector(".ac-sec")!.textContent)).toEqual(["Backlog"]);
  });

  it("workers are indented under their team; a team with no workers is one row with its status", () => {
    const solo = task({ id: "solo", parentId: null, title: "Solo team", status: "blocked", blockedReason: "why?", assignee: null });
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal()], tasks: [team, task({ id: "w1", title: "Worker A", status: "todo" }), solo] }]]) }));
    openGoal();
    const backlog = section("Backlog");
    const team1 = backlog.querySelector<HTMLElement>(".pp-team")!;
    expect(team1.textContent).toBe("Team task");
    const worker = [...backlog.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent!.includes("Worker A"))!;
    expect(worker.classList.contains("pp-worker")).toBe(true);
    const soloRow = [...backlog.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent!.includes("Solo team"))!;
    expect(soloRow.classList.contains("pp-worker")).toBe(false);
    expect(soloRow.querySelector(".st-dot")!.classList.contains("block")).toBe(true);
    expect(soloRow.textContent).toContain("Solo team");
  });

  it("the team label appears once per section that holds its workers", () => {
    openGoal();
    expect(section("Working now").querySelectorAll(".pp-team")).toHaveLength(1);
    expect(section("Backlog").querySelectorAll(".pp-team")).toHaveLength(1);
    expect(section("Delivered").querySelectorAll(".pp-team")).toHaveLength(1);
  });

  it("merge state comes from the task: merged, waiting to merge, or nothing when unknown", () => {
    openGoal();
    const row = (title: string) => [...host.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent?.includes(title))!;
    expect(row("Older delivery").textContent).toContain("merged");
    // A done task with no branch has no merge record: nothing is claimed.
    expect(row("Newer delivery").textContent).not.toContain("merged");
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal()], tasks: tasks.map((t) => (t.id === "t7" ? { ...t, assignee: "zed" } : t)) }]]) }));
    expect(row("Newer delivery").textContent).toContain("Zed");
    expect(row("Newer delivery").textContent).not.toContain("merged");
    expect(row("Polish controls").textContent).toContain("Zed");
    expect(row("Polish controls").textContent).not.toContain("merge");
    expect(row("Fix broken index.html").textContent).toContain("Ada");
    expect(row("Needs OK").textContent).toContain("Ada");
    expect(row("Needs OK").textContent).not.toContain("merge");
  });

  it("a todo task with a blocked dependency reads waiting on the dependency in place of the agent", () => {
    const dep = task({ id: "d1", title: "Build the base", status: "blocked", blockedReason: "why?" });
    const waiting = task({ id: "w1", title: "Wire the menu", status: "todo", deps: ["d1"] });
    panel.render(state({ decisions: [], boards: new Map([["gamenew", { goals: [goal()], tasks: [team, dep, waiting] }]]) }));
    openGoal();
    const row = [...host.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent!.includes("Wire the menu"))!;
    expect(row.textContent).toContain("waiting on Build the base");
    expect(row.textContent).not.toContain("Ada");
  });

  it("a row dot follows the status: working blue, needs you amber, blocked red, backlog gray, done green", () => {
    openGoal();
    const dot = (title: string) => [...host.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent!.includes(title))!.querySelector(".st-dot")!.className;
    expect(dot("Fix broken")).toContain("run");
    expect(dot("Needs OK")).toContain("ask");
    expect(dot("Blocked thing")).toContain("block");
    expect(dot("README")).toContain("idle");
    expect(dot("Older")).toContain("done");
  });

  it("task Chat calls chat with the assignee, or the Manager when unassigned", () => {
    openGoal();
    const chatOf = (title: string) =>
      [...host.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent!.includes(title))!.querySelector<HTMLButtonElement>(".pp-chat")!;
    chatOf("Polish controls").click();
    expect(chat).toHaveBeenLastCalledWith({ agentId: "zed", projectId: "gamenew", taskId: "t2" });
    chatOf("Newer delivery").click();
    expect(chat).toHaveBeenLastCalledWith({ agentId: "mgr", projectId: "gamenew", taskId: "t7" });
  });

  it("a held task shows the paused tag", () => {
    const held = tasks.map((t) => (t.id === "t3" ? { ...t, held: true } : t));
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal()], tasks: held }]]) }));
    openGoal();
    const row = [...host.querySelectorAll<HTMLElement>(".pp-task")].find((r) => r.textContent!.includes("README"))!;
    expect(row.querySelector(".pp-paused")!.textContent).toBe("paused");
  });

  it("a plan that waits: the plan sits in a fold, and Approve sends plan.answer", () => {
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal({ planState: "proposed", plan: "Build the menu first" })], tasks }]]) }));
    openGoal();
    expect(host.textContent).toContain("waiting for your OK");
    expect(host.textContent).not.toContain("Build the menu first");
    button("Plan").click();
    expect(host.textContent).toContain("Build the menu first");
    button("Approve").click();
    expect(send).toHaveBeenLastCalledWith({ type: "plan.answer", goalId: "g1", option: "approve" });
  });

  it("no plan answer buttons when no plan waits", () => {
    openGoal();
    expect(host.textContent).not.toContain("Approve");
  });

  it("a goal removed while open returns to level 2", () => {
    openGoal();
    panel.render(state({ boards: new Map([["gamenew", { goals: [], tasks: [] }]]) }));
    expect(panel.level).toBe(2);
    expect(q(".pp-title").textContent).toBe("gamenew");
  });

  it("a goal removed while a task is open returns to level 2", () => {
    openTask("Fix broken index.html");
    panel.render(state({ boards: new Map([["gamenew", { goals: [], tasks: [] }]]) }));
    expect(panel.level).toBe(2);
  });

  it("a goal not yet on the board keeps level 3 until the board arrives", () => {
    panel.open("gamenew");
    panel.render(state({ boards: new Map() }));
    panel.openGoal("gamenew", "g1");
    panel.render(state({ boards: new Map() }));
    expect(panel.level).toBe(3);
    expect(host.textContent).toContain("loading…");
  });
});

describe("level 4", () => {
  it("a task row click opens the task through openTask and shows level 4", () => {
    openGoal();
    const spy = vi.spyOn(panel, "openTask");
    taskRow("Fix broken").click();
    expect(spy).toHaveBeenCalledWith("gamenew", "t1");
    expect(panel.level).toBe(4);
    expect(send).toHaveBeenCalledWith({ type: "task.open", taskId: "t1" });
  });

  it("level 4 shows the thread from task.detail, follows task.log, and Back returns to the goal", () => {
    openTask("Fix broken index.html");
    expect(q(".tt-title").textContent).toBe("Fix broken index.html");
    expect(q(".tt-sub").textContent).toContain("Ada · worker");
    const row = (text: string) => ({ ts: T(0), agentId: "ada", kind: "text" as const, text });
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [row("first")]);
    expect(send).toHaveBeenCalledWith({ type: "diff.request", taskId: "t1" });
    expect(host.querySelectorAll(".tt-think")).toHaveLength(1);
    panel.appendLog("t1", [row("second")]);
    frame();
    expect(host.querySelectorAll(".tt-think")).toHaveLength(2);
    panel.appendLog("t2", [row("other task")]);
    frame();
    expect(host.querySelectorAll(".tt-think")).toHaveLength(2);
    panel.render(state());
    expect(host.querySelectorAll(".tt-think")).toHaveLength(2);
    button("‹ Have the game ready for release").click();
    expect(panel.level).toBe(3);
  });

  it("level 4 keeps the reader's scroll through a redraw, and follows when at the bottom", () => {
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 200 });
    try {
      openTask("Fix broken index.html");
      const t1 = tasks.find((t) => t.id === "t1")!;
      const row = (text: string) => ({ ts: T(0), agentId: "ada", kind: "text" as const, text });
      panel.setDetail(t1, [row("a")]);
      const progress = () => q<HTMLElement>(".tt-progress");
      progress().scrollTop = 800;
      panel.appendLog("t1", [row("b")]);
      frame();
      expect(progress().scrollTop).toBe(1000);
      progress().scrollTop = 100;
      panel.appendLog("t1", [row("c")]);
      frame();
      expect(progress().scrollTop).toBe(100);
      panel.setDetail(t1, [row("a"), row("b"), row("c"), row("d")]);
      expect(progress().scrollTop).toBe(100);
      panel.render(state());
      expect(progress().scrollTop).toBe(100);
    } finally {
      delete (proto as { scrollHeight?: number }).scrollHeight;
      delete (proto as { clientHeight?: number }).clientHeight;
    }
  });

  it("level 4 keeps the last 500 log rows, and rows that arrive together draw once per frame", () => {
    openTask("Fix broken index.html");
    const t1 = tasks.find((t) => t.id === "t1")!;
    const row = (text: string) => ({ ts: T(0), agentId: "ada", kind: "text" as const, text });
    panel.setDetail(t1, Array.from({ length: 450 }, (_, i) => row(`r${i}`)));
    const box = q(".task-thread");
    const before = box.querySelector(".tt-progress");
    for (let i = 0; i < 100; i++) panel.appendLog("t1", [row(`n${i}`)]);
    expect(q(".tt-progress")).toBe(before);
    frame();
    expect(q(".tt-progress")).not.toBe(before);
    const log = (panel as unknown as { detail: { log: Array<{ text: string }> } }).detail.log;
    expect(log).toHaveLength(500);
    expect(log[0]!.text).toBe("r50");
    expect(log[499]!.text).toBe("n99");
  });

  it("a steady row stream rebuilds the panel at most once per 100 ms", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, []);
    const draw = vi.spyOn(panel as unknown as { draw(force: boolean): void }, "draw");
    const row = { ts: T(0), agentId: "ada", kind: "text" as const, text: "x" };
    for (let ms = 0; ms < 1000; ms += 10) {
      panel.appendLog("t1", [row]);
      vi.advanceTimersByTime(10);
    }
    expect(draw.mock.calls.length).toBeGreaterThan(0);
    expect(draw.mock.calls.length).toBeLessThanOrEqual(10);
    vi.advanceTimersByTime(100);
    expect(host.querySelectorAll(".tt-think")).toHaveLength(100);
  });

  it("level 4: a task missing from the loaded board says it is gone, with Back to the project", () => {
    openProject();
    panel.openTask("gamenew", "nope");
    expect(host.textContent).toContain("This task is gone");
    expect(host.textContent).not.toContain("loading…");
    button("‹ gamenew").click();
    expect(panel.level).toBe(2);
  });

  it("level 4: a task deleted from the loaded board leaves the task view for its goal", () => {
    openTask("Fix broken index.html");
    expect(panel.level).toBe(4);
    panel.render(state({ boards: new Map([["gamenew", { goals: [goal()], tasks: tasks.filter((t) => t.id !== "t1") }]]) }));
    expect(panel.level).toBe(3);
    expect(host.querySelector(".pp-tabs")).toBeNull();
  });

  it("level 4: a detail that arrives for a task missing from the loaded board shows no thread", () => {
    openTask("Fix broken index.html");
    const gone = state({ boards: new Map([["gamenew", { goals: [goal()], tasks: tasks.filter((t) => t.id !== "t1") }]]) });
    panel.render(gone);
    panel.openTask("gamenew", "t1");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, []);
    expect(host.querySelector(".tt-head")).toBeNull();
    expect(host.textContent).toContain("This task is gone");
  });

  it("level 4: before the board loads it says loading…", () => {
    panel.render(state({ boards: new Map() }));
    panel.openTask("gamenew", "t1");
    expect(host.textContent).toContain("loading…");
    expect(host.textContent).not.toContain("This task is gone");
  });

  it("level 4: a task on the board says loading… until its detail arrives, then nothing yet when the log is empty", () => {
    openTask("Fix broken index.html");
    expect(q(".tt-progress").textContent).toBe("loading…");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, []);
    expect(q(".tt-progress").textContent).toBe("nothing yet");
  });

  it("a waiting redraw is cancelled on every level change and on close", () => {
    const draw = vi.spyOn(panel as unknown as { draw(force: boolean): void }, "draw");
    const row = { ts: T(0), agentId: "ada", kind: "text" as const, text: "x" };
    const after = (act: () => void) => {
      panel.open("gamenew", "t1");
      panel.appendLog("t1", [row]);
      act();
      draw.mockClear();
      frame();
      expect(draw).not.toHaveBeenCalled();
    };
    after(() => button("‹ Have the game ready for release").click());
    after(() => panel.open("pong"));
    after(() => panel.close());
    after(() => panel.render(state({ config: { ...config(), projects: config().projects.filter((p) => p.id !== "gamenew") } })));
    expect(panel.level).toBe(1);
  });

  it("level 4 Open chat opens a chat about the task with its assignee", () => {
    openTask("Fix broken index.html");
    button("Open chat").click();
    expect(chat).toHaveBeenLastCalledWith({ agentId: "ada", projectId: "gamenew", taskId: "t1" });
  });

  it("open(projectId, taskId) goes straight to level 4", () => {
    panel.open("gamenew", "t3");
    expect(panel.level).toBe(4);
    expect(q(".tt-title").textContent).toBe("Write the README");
  });

  it("Pause on the task sends task.action", () => {
    openTask("Fix broken index.html");
    button("Pause").click();
    expect(send).toHaveBeenLastCalledWith({ type: "task.action", taskId: "t1", action: "pause" });
  });

  it("a log text with markup renders as text: no img element exists", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [{ ts: T(0), agentId: "ada", kind: "text", text: "<img src=x onerror=alert(1)>" }]);
    expect(host.querySelector("img")).toBeNull();
    expect(q(".task-thread").textContent).toContain("<img src=x onerror=alert(1)>");
  });

});

describe("level 4 tabs", () => {
  const files: FileTree = { entries: [{ path: "src", size: 0, dir: true }, { path: "src/a.ts", size: 10, dir: false }], truncated: false };
  const diffFile = (path: string, text: string): DiffFileView => ({
    path, status: "modified", additions: 1, deletions: 1, truncated: false,
    hunks: [[{ kind: "del", text: `old ${text}`, oldNo: 3 }, { kind: "add", text: `new ${text}`, newNo: 3 }]],
  });
  const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".pp-tab")].find((b) => b.textContent === label)!;
  const pane = (name: "thread" | "diff" | "files" | "preview") => host.querySelector<HTMLElement>(`[data-pane="${name}"]`)!;
  const shownPanes = () => ["thread", "diff", "files", "preview"].filter((n) => !pane(n as never).hidden);

  it("the Thread tab leaves out the Changes list, which the Diff tab shows", () => {
    openTask("Fix broken index.html");
    panel.setDiff("t1", [diffFile("src/a.ts", "x")]);
    expect(pane("thread").querySelector(".tt-diff")).toBeNull();
    expect([...pane("thread").querySelectorAll(".ac-sec")].map((s) => s.textContent)).not.toContain("Changes");
    tab("Diff").click();
    expect(pane("diff").textContent).toContain("src/a.ts");
  });

  it("level 4 has the tabs Thread, Diff, Files and Preview; Thread shows first", () => {
    openTask("Fix broken index.html");
    expect([...host.querySelectorAll(".pp-tab")].map((b) => b.textContent)).toEqual(["Thread", "Diff", "Files", "Preview"]);
    expect(tab("Thread").classList.contains("active")).toBe(true);
    expect(shownPanes()).toEqual(["thread"]);
    expect(q(".tt-title").textContent).toBe("Fix broken index.html");
  });

  it("a tab click shows its pane; the Back button stays in place on every tab", () => {
    openTask("Fix broken index.html");
    tab("Files").click();
    expect(shownPanes()).toEqual(["files"]);
    expect(tab("Files").classList.contains("active")).toBe(true);
    button("‹ Have the game ready for release").click();
    expect(panel.level).toBe(3);
  });

  it("the Diff tab asks for the diff, lists its files with counts, and shows the chosen file's lines", () => {
    openTask("Fix broken index.html");
    tab("Diff").click();
    expect(send).toHaveBeenCalledWith({ type: "diff.request", taskId: "t1" });
    expect(pane("diff").textContent).toContain("loading diff…");
    panel.setDiff("t1", [diffFile("src/a.ts", "a"), diffFile("src/b.ts", "b")]);
    const names = [...pane("diff").querySelectorAll<HTMLButtonElement>(".diff-file")].map((b) => b.textContent);
    expect(names).toEqual(["src/a.ts +1 -1", "src/b.ts +1 -1"]);
    expect(pane("diff").querySelector(".diff-add")!.textContent).toContain("new a");
    [...pane("diff").querySelectorAll<HTMLButtonElement>(".diff-file")][1]!.click();
    expect(pane("diff").querySelector(".diff-add")!.textContent).toContain("new b");
    expect(pane("diff").querySelector(".diff-add .diff-no-new")!.textContent).toBe("3");
  });

  it("the Diff tab says no file changes for an empty diff", () => {
    openTask("Fix broken index.html");
    tab("Diff").click();
    panel.setDiff("t1", []);
    expect(pane("diff").textContent).toContain("no file changes");
  });

  it("the Files tab lists the tree, and a file click sends file.request and shows its text as text", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [], files, "k1", false);
    tab("Files").click();
    const rows = [...host.querySelectorAll<HTMLElement>(".pp-file")];
    expect(rows.map((r) => r.textContent)).toEqual(["src/", "a.ts"]);
    rows[0]!.click();
    expect(send.mock.calls.filter((c) => (c[0] as { type: string }).type === "file.request")).toHaveLength(0);
    rows[1]!.click();
    expect(send).toHaveBeenCalledWith({ type: "file.request", taskId: "t1", path: "src/a.ts" });
    panel.setFile("t1", "src/a.ts", { text: "<b>x</b>", binary: false, truncated: false });
    expect(host.querySelector(".pp-file-view")!.textContent).toContain("<b>x</b>");
    expect(host.querySelector(".pp-file-view b")).toBeNull();
    panel.setFile("t1", "src/a.ts", { binary: false, truncated: false, error: "protected path" });
    expect(host.querySelector(".pp-file-view")!.textContent).toContain("protected path");
  });

  it("the Files tab says no files when the tree is empty", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [], { entries: [], truncated: false }, "k1", false);
    tab("Files").click();
    expect(pane("files").textContent).toContain("no files");
  });

  it("the Preview tab builds the frame on first show at /p/<key>/<task>/ with sandbox allow-scripts and no allow-same-origin", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [], files, "k1", true);
    expect(host.querySelector("iframe")).toBeNull();
    tab("Preview").click();
    const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
    expect(frame.getAttribute("src")).toBe("/p/k1/t1/");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("a task without index.html says so in the Preview tab", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [], files, "k1", false);
    tab("Preview").click();
    expect(pane("preview").textContent).toContain("no index.html in this task");
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("the preview frame is the same element through log rows, redraws and tab changes", () => {
    openTask("Fix broken index.html");
    panel.setDetail(tasks.find((t) => t.id === "t1")!, [], files, "k1", true);
    tab("Preview").click();
    const iframe = host.querySelector("iframe");
    const row = { ts: T(0), agentId: "ada", kind: "text" as const, text: "x" };
    panel.appendLog("t1", [row]);
    frame();
    panel.render(state());
    tab("Thread").click();
    tab("Preview").click();
    expect(host.querySelector("iframe")).toBe(iframe);
  });

});

describe("managerOf", () => {
  const agents = config().agents;
  const project = agents.filter((a) => ["boss", "mgr", "ada"].includes(a.id));
  it("is the createdBy of the goal's first task whose author is a manager", () => {
    const mixed = [task({ id: "w", createdBy: "ada" }), task({ id: "b", createdBy: "boss" }), task({ id: "m", createdBy: "mgr" })];
    expect(managerOf(goal(), mixed, project)).toBe("mgr");
  });
  it("falls back to the first manager among the project's agents", () => {
    expect(managerOf(goal(), [task({ createdBy: "ada" })], project)).toBe("mgr");
    expect(managerOf(goal(), [], project)).toBe("mgr");
  });
  it("falls back to the first project agent when none is a manager", () => {
    expect(managerOf(goal(), [], project.filter((a) => a.role !== "manager"))).toBe("boss");
  });
  it("a project with no agents uses the first manager of the city, else empty", () => {
    expect(managerOf(goal(), [], [], agents)).toBe("mgr");
    expect(managerOf(goal(), [], [], agents.filter((a) => a.role !== "manager"))).toBe("");
    expect(managerOf(goal(), [], [])).toBe("");
  });
});

describe("New project form", () => {
  const form = () => {
    host.querySelector<HTMLButtonElement>(".pp-new")!.click();
  };
  const type = (sel: string, value: string) => {
    const i = q<HTMLInputElement | HTMLTextAreaElement>(sel);
    i.value = value;
    i.dispatchEvent(new Event("input"));
  };
  const check = (label: string, on: boolean) => {
    const box = [...host.querySelectorAll<HTMLLabelElement>(".pp-agent")].find((l) => l.textContent!.includes(label))!.querySelector("input")!;
    box.checked = on;
    box.dispatchEvent(new Event("change"));
  };

  it("New project form runs project create, then submits the goal", async () => {
    form();
    expect(host.textContent).toContain("New project");
    check("Zed", false);
    type(".pp-name-input", "Snake");
    type(".pp-folder-input", "C:\\code\\snake");
    type(".pp-first-goal", "A snake game");
    button("Create").click();
    await flush();
    // The existing create step is `init`; a folder rides along as --path.
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      ["init", "snake", "--path", "C:\\code\\snake"],
      ["grant", "snake", "boss"], ["grant", "snake", "mgr"], ["grant", "snake", "ada"],
    ]);
    expect(send).toHaveBeenLastCalledWith({ type: "goal.submit", projectId: "snake", text: "A snake game" });
    expect(panel.level).toBe(1);
    expect(host.textContent).not.toContain("First goal");
  });

  it("an empty folder makes a sandbox, and an empty goal sends no goal", async () => {
    form();
    type(".pp-name-input", "snake");
    button("Create").click();
    await flush();
    expect(run.mock.calls[0]![0]).toEqual(["init", "snake"]);
    expect(send.mock.calls.some((c) => (c[0] as { type: string }).type === "goal.submit")).toBe(false);
  });

  it("a bad name runs nothing; a failing step stops, keeps the form and does not repeat init on retry", async () => {
    form();
    type(".pp-name-input", "my site");
    button("Create").click();
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(q(".pp-status").textContent).toContain("a-z, 0-9 and -");
    type(".pp-name-input", "site");
    run.mockResolvedValueOnce({ code: 0, text: "Created" }).mockResolvedValueOnce({ code: 1, text: "No agent boss" });
    button("Create").click();
    await flush();
    expect(q(".pp-status").textContent).toContain("No agent boss");
    expect(panel.level).toBe(1);
    expect(host.querySelector(".pp-name-input")).not.toBeNull();
    expect(send.mock.calls.some((c) => (c[0] as { type: string }).type === "goal.submit")).toBe(false);
    run.mockClear();
    button("Create").click();
    await flush();
    expect(run.mock.calls[0]![0]).toEqual(["grant", "site", "boss"]);
  });

  it("init ok, config redraw, grant fails: the visible status shows the error and Create is enabled", async () => {
    form();
    type(".pp-name-input", "snake");
    let fail!: (r: { code: number; text: string }) => void;
    run.mockResolvedValueOnce({ code: 0, text: "Created" }).mockImplementationOnce(() => new Promise((r) => (fail = r)));
    button("Create").click();
    await flush();
    // The server pushes the new project: the form key changes and the form is rebuilt.
    const withSnake = config();
    withSnake.projects.push({ ...withSnake.projects[0]!, id: "snake" });
    panel.render(state({ config: withSnake }));
    expect(button("Create").disabled).toBe(true);
    fail({ code: 1, text: "No agent boss" });
    await flush();
    expect(q(".pp-status").textContent).toContain("No agent boss");
    expect(button("Create").disabled).toBe(false);
  });

  it("the form names skills and MCP servers the chosen agents lack", () => {
    form();
    type(".pp-first-goal", "Use game-design and the GitHub server, and testing");
    const warn = q<HTMLElement>(".pp-warn");
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain("game-design");
    expect(warn.textContent).toContain("github");
    // Ada has testing; the chosen agents include her.
    expect(warn.textContent).not.toContain("testing");
    check("Ada", false);
    expect(q(".pp-warn").textContent).toContain("testing");
    type(".pp-first-goal", "A snake game");
    expect(q<HTMLElement>(".pp-warn").hidden).toBe(true);
  });

  it("Cancel and Back return to the list; a redraw keeps typed text", () => {
    form();
    type(".pp-name-input", "snake");
    panel.render(state());
    expect(q<HTMLInputElement>(".pp-name-input").value).toBe("snake");
    button("Cancel").click();
    expect(host.querySelector(".pp-name-input")).toBeNull();
    form();
    button("‹ Projects").click();
    expect(host.querySelector(".pp-name-input")).toBeNull();
  });
});
