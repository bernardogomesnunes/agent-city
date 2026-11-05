import type { BuildingId } from "@agentcity/world/shared";
import { placeInfo } from "../places.js";
import { el } from "./dom.js";
import { loadFolded, saveFolded } from "./fold.js";
import type { ProjectsPanel } from "./projects-panel.js";
import { mountPreview, renderMerge, renderWork, type WorkContext } from "./work.js";

/** The sign that opens when the avatar reaches or faces a building: its name and what it is for. */
export class SignBox {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement, private readonly kindOf: (id: BuildingId) => Parameters<typeof placeInfo>[1]) {
    this.root = el("div", "ac-box sign-box", "", parent);
    this.root.hidden = true;
  }

  show(id: BuildingId | null): void {
    this.root.replaceChildren();
    this.root.hidden = id === null;
    if (id === null) return;
    const info = placeInfo(id, this.kindOf(id));
    el("div", "ac-title", info.name, this.root);
    el("div", "", info.purpose, this.root);
    if (!id.startsWith("plot-") || this.kindOf(id)) el("div", "sign-hint", "walk in for its work", this.root);
  }
}

/** Where each part of a building view goes. In HQ all three share one container. */
export interface PanelSlots {
  /** Above the main part: the projects of the software house. */
  projects?: HTMLElement;
  main: HTMLElement;
  merge: HTMLElement;
  preview: HTMLElement;
}

/**
 * A building's work as separate panels: the overview, the branches waiting to merge (software house)
 * and the preview of local web servers (software house). The overview and merge list redraw on every
 * state change; the preview is built once per visit so the page in its frame keeps running.
 */
export class BuildingPanel {
  private readonly main: HTMLElement;
  private readonly mainTitle: HTMLElement;
  private readonly mainBody: HTMLElement;
  private readonly merge: HTMLElement;
  private readonly mergeBody: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly previewBody: HTMLElement;
  private id: BuildingId | null = null;
  private frame: ReturnType<typeof mountPreview> | null = null;
  private readonly projects: ProjectsPanel | null;
  private readonly projectsBox: HTMLElement | null = null;

  /**
   * `boxed`: each part is its own dialog box. Off in HQ, where the parts stack inside the HQ panel.
   * `projects`: the projects panel, shown above the overview in the software house only. It sends board.watch itself.
   */
  constructor(slots: PanelSlots, private readonly ctx: () => WorkContext, private readonly scanPorts: () => void, boxed = true, projects?: ProjectsPanel) {
    const part = (parent: HTMLElement, cls: string, title: string) => {
      const root = el("div", boxed ? `ac-box ${cls}` : `${cls}-inline`, "", parent);
      root.hidden = true;
      if (!boxed) {
        const t = el("div", "ac-title hq-sub", title, root);
        return { root, title: t, body: el("div", "", "", root) };
      }
      // A header that stays put while the body scrolls; its button folds the panel down to the header.
      const head = el("div", "panel-head", "", root);
      const t = el("span", "ac-title", title, head);
      const fold = el("button", "panel-fold", "", head);
      fold.type = "button";
      const body = el("div", "panel-body", "", root);
      const setFolded = (folded: boolean) => {
        root.classList.toggle("folded", folded);
        body.hidden = folded;
        fold.textContent = folded ? "▸" : "▾";
        fold.title = folded ? "Show" : "Fold";
        fold.setAttribute("aria-expanded", String(!folded));
        saveFolded(cls, folded);
      };
      fold.addEventListener("click", () => setFolded(!root.classList.contains("folded")));
      setFolded(loadFolded(cls));
      return { root, title: t, body };
    };
    this.projects = projects ?? null;
    if (projects && slots.projects) {
      const b = part(slots.projects, "projects-box", "Projects");
      b.body.append(projects.root);
      this.projectsBox = b.root;
    }
    const m = part(slots.main, "building-panel", "");
    this.main = m.root;
    this.mainTitle = m.title;
    this.mainBody = m.body;
    const g = part(slots.merge, "merge-panel", "Waiting to merge");
    this.merge = g.root;
    this.mergeBody = g.body;
    const p = part(slots.preview, "preview-panel", "Preview");
    this.preview = p.root;
    this.previewBody = p.body;
  }

  get building(): BuildingId | null {
    return this.id;
  }

  /** True while the preview panel shows. */
  get previewing(): boolean {
    return !this.preview.hidden;
  }

  show(id: BuildingId): void {
    this.id = id;
    const software = id === "software";
    this.previewBody.replaceChildren();
    this.frame = software ? mountPreview(this.previewBody, this.scanPorts) : null;
    this.main.hidden = false;
    this.merge.hidden = !software;
    this.preview.hidden = !software;
    if (this.projectsBox) this.projectsBox.hidden = !software;
    // A visit starts with level 1 and asks for every linked project again.
    if (this.projects) {
      if (software) this.projects.watchAll();
      else this.projects.leave();
    }
    this.refresh();
  }

  hide(): void {
    this.id = null;
    this.frame = null;
    this.previewBody.replaceChildren();
    this.main.hidden = this.merge.hidden = this.preview.hidden = true;
    if (this.projectsBox) this.projectsBox.hidden = true;
    this.projects?.leave();
  }

  refresh(): void {
    if (this.id === null) return;
    const c = this.ctx();
    this.mainTitle.textContent = placeInfo(this.id, c.state?.plots.find((p) => p.id === this.id)?.kind).name;
    renderWork(this.mainBody, this.id, c);
    if (this.id === "software") renderMerge(this.mergeBody, c);
  }

  setPorts(ports: Array<{ port: number; title: string }>): void {
    this.frame?.setPorts(ports);
  }
}

