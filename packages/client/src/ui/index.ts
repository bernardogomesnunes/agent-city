import type Phaser from "phaser";
import type { BuildingId, GoalView, HqConfig, TaskView } from "@agentcity/world/shared";
import { city, sendToCity } from "../city.js";
import { HQ_DESK_EVENT } from "../scenes/room.js";
import { AgentCard } from "./agent-card.js";
import { Alerts, bellOn, browserNotify, playTone, toast } from "./alerts.js";
import { BuildingPanel, SignBox } from "./building-panel.js";
import { Dock } from "./dock.js";
import { el } from "./dom.js";
import { AGENT_CLICK_EVENT, ROOM_ENTER_EVENT, ROOM_LEAVE_EVENT, SIGN_EVENT, TOGGLE_ROOFS_EVENT } from "./events.js";
import type { WorkContext } from "./work.js";
import { Hud, START_LINK } from "./hud.js";
import { Inbox } from "./inbox.js";
import { socketUrl } from "../net.js";
import { hqRunner } from "./hq-run.js";
import { HqPanel, type Send } from "./hq-panel.js";
import type { HqDo } from "./hq-settings.js";
import { OverlayStack, gameKeysEnabled } from "./keys.js";
import { ProgressPanel } from "./progress.js";
import { ProjectsPanel } from "./projects-panel.js";
import { Terminal } from "./terminal.js";

const STATS_MS = 5000;

/** Builds the HTML overlays on top of the canvas and wires them to the game events, the city state and the keyboard. */
export function mountUi(events: Phaser.Events.EventEmitter): void {
  const layer = el("div", "ui-layer", "", document.body);
  const stack = new OverlayStack();
  const track = (get: () => { isOpen: boolean; close(): void }) => (open: boolean) => {
    if (open) stack.opened(get());
    else stack.closed(get());
  };

  // A page the city served (it has a token) can start the city again through the agentcity link; the demo cannot.
  const token = document.querySelector<HTMLMetaElement>("meta[name=agentcity-token]")?.content ?? null;
  const live = socketUrl(location, token) !== null;
  const hud = new Hud(layer, () => events.emit(TOGGLE_ROOFS_EVENT), live ? () => location.assign(START_LINK) : undefined);
  // Offline (no server, or the demo): nothing is sent and the HUD status flashes.
  const send: Send = (m) => {
    if (!city.online) {
      hud.flashOffline();
      return false;
    }
    sendToCity(m);
    return true;
  };

  // HQ forms run agentcity commands on the server; each answer comes back as hq.done with the same id.
  const hqRun = hqRunner(send);
  const runHq: HqDo = hqRun.run;

  const right = el("div", "ui-right", "", layer);
  const progress = new ProgressPanel(right, send);
  // The bottom dock holds the chat and the terminal. Opening the terminal tab opens the terminal, and back.
  const dockTrack = track(() => dock);
  const dock: Dock = new Dock(layer, {
    send,
    projects: () => config?.projects.map((p) => ({ id: p.id, agents: p.agents })) ?? [],
    onOpenChange: (open) => {
      dockTrack(open);
      layer.classList.toggle("dock-open", open);
      // The project list feeds New run.
      if (open) send({ type: "hq.config" });
    },
    onTerminal: (shown) => (shown ? term.open() : term.close()),
  });
  if (dock.isOpen) {
    dockTrack(true);
    layer.classList.add("dock-open");
  }
  const termTrack = track(() => term);
  const term: Terminal = new Terminal(dock.terminalPane, send, (open) => {
    termTrack(open);
    // Esc on the terminal folds the dock with it.
    if (!open && dock.isOpen && dock.tab === "terminal") dock.fold();
  });
  const openTerminal = (): void => {
    if (term.isOpen) dock.fold();
    else dock.open("terminal");
  };
  const projectOf = (id: string): string | undefined => city.state?.agents.find((a) => a.id === id)?.projectId;
  const card: AgentCard = new AgentCard(
    right, send, (id) => city.state?.agents.find((a) => a.id === id), track(() => card),
    (id) => dock.openAgent(id, projectOf(id)),
    (id) => dock.openNew(id, projectOf(id)),
  );
  // The tone and the desktop notification for new decisions. The first list only records what is already waiting.
  const alerts = new Alerts({
    bellOn,
    hidden: () => document.hidden,
    notify: browserNotify,
    tone: playTone,
    names: (id) => city.state?.agents.find((a) => a.id === id)?.name ?? id,
  });
  const inboxTrack = track(() => inbox);
  const inbox: Inbox = new Inbox(layer, send, {
    names: (id) => city.state?.agents.find((a) => a.id === id)?.name ?? id,
    checkpoint: (taskId) => checkpointOf(taskId),
    approvalLocal: (id) => city.state?.approvals.find((a) => a.id === id)?.local !== false,
    onOpenChange: inboxTrack,
  });
  const toggleInbox = (): void => {
    alerts.askPermission();
    if (inbox.isOpen) inbox.close();
    else inbox.open();
  };
  const toggleChat = (): void => {
    if (dock.isOpen && dock.tab === "chat") dock.fold();
    else dock.open("chat");
  };
  const toggleHq = (): void => {
    if (hq.isOpen) hq.close();
    else hq.open();
  };
  hud.onInbox(toggleInbox);
  hud.onHq(() => toggleHq());
  hud.onStopAll((paused) => send({ type: "city.pause", paused }));
  const notice = el("div", "ac-box hq-notice", "", layer);
  notice.hidden = true;

  let config: HqConfig | null = null;
  let ports: Array<{ port: number; title: string }> = [];
  const scan = (): void => void send({ type: "ports.scan" });
  const work = (): WorkContext => ({ state: city.state, config, run: runHq, notify: (t) => showNotice(t) });
  const kindOf = (id: BuildingId) => city.state?.plots.find((p) => p.id === id)?.kind;
  const sign = new SignBox(layer, kindOf);
  // Inside a building: overview and merge list on the left, the preview on the right.
  const left = el("div", "ui-left", "", layer);
  // The software house shows the same projects panel as HQ Work: a second instance above its overview.
  const software = new ProjectsPanel(left, send, { chat: (ref) => dock.openRef(ref), run: runHq });
  const inside = new BuildingPanel({ projects: left, main: left, merge: left, preview: right }, work, scan, true, software);
  // HQ Work, left column: the projects. Board, paused and decision data feed it; its Chat buttons open the dock.
  let projects: ProjectsPanel | null = null;
  const boardData = new Map<string, { goals: GoalView[]; tasks: TaskView[] }>();
  let pausedIds: string[] = [];
  /** The checkpoint of a task, from the boards the client holds. Null when none or unknown. */
  const checkpointOf = (taskId: string): string | null => {
    for (const b of boardData.values()) {
      const t = b.tasks.find((x) => x.id === taskId);
      if (t) return t.checkpoint;
    }
    return null;
  };
  const refreshProjects = (): void => {
    const state = { config, boards: boardData, decisions: city.decisions, paused: pausedIds };
    projects?.render(state);
    software.render(state);
  };

  // While HQ is open its columns take both sides: the progress and preview panels step aside,
  // and the stats refresh every 5 s.
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  const hqTrack = track(() => hq);
  const hq: HqPanel = new HqPanel(layer, send, (open) => {
    hqTrack(open);
    layer.classList.toggle("hq-open", open);
    clearInterval(statsTimer);
    if (open) statsTimer = setInterval(() => send({ type: "hq.stats" }), STATS_MS);
  }, {
    run: runHq,
    onOpen: () => {
      send({ type: "hq.config" });
      send({ type: "hq.stats" });
      // A reconnect may have dropped the board watches.
      projects?.watchAll();
    },
    onClose: () => projects?.close(),
    mountProjects: (pane) => {
      projects = new ProjectsPanel(pane, send, { chat: (ref) => dock.openRef(ref), run: runHq });
      refreshProjects();
    },
  });

  const refresh = (): void => {
    hq.render(city.state);
    dock.render(city.state);
    inbox.render(city.decisions);
    hud.setInbox(inbox.count);
    progress.render(city.state?.runs ?? []);
    card.refresh();
    inside.refresh();
    refreshProjects();
  };
  city.subscribe(refresh);
  refresh();
  setInterval(() => progress.tick(), 1000);
  hud.setOnline(city.online);
  city.onStatus((online) => {
    hud.setOnline(online);
    if (!online) {
      term.reset();
      hqRun.offline();
    }
  });
  city.onMessage((m) => {
    if (m.type === "term.out") term.out(m.text);
    else if (m.type === "models") {
      card.setModels(m.groups);
      hq.setModels(m.groups);
    }
    else if (m.type === "agent.saved") card.saved(m.agentId, m.version);
    else if (m.type === "term.done") term.done(m.code);
    else if (m.type === "hq.config") {
      config = m.config;
      hq.setConfig(m.config);
      inside.refresh();
      refreshProjects();
    } else if (m.type === "session.list") {
      dock.setSessions(m.sessions);
    } else if (m.type === "session.thread") {
      dock.setThread(m.sessionId, m.messages);
    } else if (m.type === "session.msg") {
      dock.onMessage(m.message);
    } else if (m.type === "paused") {
      pausedIds = m.projectIds;
      refreshProjects();
      hud.setPaused(m.projectIds.length > 0);
    } else if (m.type === "board") {
      boardData.set(m.projectId, { goals: m.goals, tasks: m.tasks });
      refreshProjects();
    } else if (m.type === "task.detail") {
      projects?.setDetail(m.task, m.log, m.files, m.previewKey, m.hasIndex);
      software.setDetail(m.task, m.log, m.files, m.previewKey, m.hasIndex);
    } else if (m.type === "task.log") {
      projects?.appendLog(m.taskId, m.rows);
      software.appendLog(m.taskId, m.rows);
    } else if (m.type === "diff") {
      projects?.setDiff(m.taskId, m.files);
      software.setDiff(m.taskId, m.files);
      inbox.setDiff(m.taskId, m.files);
    } else if (m.type === "file") {
      projects?.setFile(m.taskId, m.path, m);
      software.setFile(m.taskId, m.path, m);
    } else if (m.type === "review.result") {
      inbox.setResult(m.taskId, m.ok, m.error);
    } else if (m.type === "plan.result") {
      inbox.setResult(m.goalId, m.ok, m.error);
    } else if (m.type === "hq.stats") {
      hq.setStats(m.stats);
    } else if (m.type === "ports") {
      ports = m.list;
      inside.setPorts(ports);
    }
    else if (m.type === "decisions") alerts.update(m.list);
    else if (m.type === "hq.done") {
      if (!hqRun.done(m.id, { code: m.code, text: m.text })) showNotice(m.text);
    } else if (m.type === "hq.signin") {
      // The service's own sign-in page; a blocked pop-up leaves the link in a notice.
      const w = window.open(m.url, "_blank", "noopener");
      if (!w) showNotice(`Sign in to ${m.server}:`, m.url);
    } else if (m.type === "error") {
      toast(m.message);
      inbox.setError(m.message);
      if (term.isOpen) term.out(`error: ${m.message}\n`);
    }
  });

  function showNotice(text: string, url?: string): void {
    notice.replaceChildren();
    el("span", "", text, notice);
    if (url) {
      const a = el("a", "", " open the sign-in page", notice);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
    }
    const close = el("button", "ac-button", "OK", notice);
    close.type = "button";
    close.addEventListener("click", () => (notice.hidden = true));
    notice.hidden = false;
  }

  events.on(HQ_DESK_EVENT, () => hq.open());
  events.on(AGENT_CLICK_EVENT, (id: string) => card.show(id));
  events.on(SIGN_EVENT, (id: BuildingId | null) => sign.show(id));
  events.on(ROOM_ENTER_EVENT, (id: BuildingId) => {
    sign.show(null);
    // HQ opens its own screen on the way in.
    if (id === "hq") return hq.open();
    inside.show(id);
    send({ type: "hq.config" });
  });
  events.on(ROOM_LEAVE_EVENT, (id: BuildingId) => {
    if (id === "hq") hq.close();
    inside.hide();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (stack.closeTop()) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement;
    // e.code covers layouts where the backtick is a dead key.
    if (e.key === "`" || e.code === "Backquote") {
      // A backtick typed in another text box stays a backtick.
      if (active !== term.input && !gameKeysEnabled(active)) return;
      e.preventDefault();
      openTerminal();
    } else if (!gameKeysEnabled(active)) {
      return;
    } else if (e.key.toLowerCase() === "t") {
      // Opening focuses the input; the T itself must not land there.
      e.preventDefault();
      openTerminal();
    } else if (e.key.toLowerCase() === "c") {
      e.preventDefault();
      toggleChat();
    } else if (e.key.toLowerCase() === "j") {
      e.preventDefault();
      toggleInbox();
    } else if (e.key.toLowerCase() === "h") {
      toggleHq();
    }
  });
}
