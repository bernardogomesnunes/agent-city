import type Database from "better-sqlite3";

export interface CityPlot {
  plot: number;
  kind: string;
  projectId: string;
  agentId: string;
  ts: string;
}

interface Row {
  plot: number;
  kind: string;
  project_id: string;
  agent_id: string;
  ts: string;
}

export class CityPlots {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Returns false when the plot is already claimed. Throws on a plot outside 1..6.
  claim(e: { plot: number; kind: string; projectId: string; agentId: string }): boolean {
    try {
      this.db
        .prepare("INSERT INTO city_plots (plot, kind, project_id, agent_id, ts) VALUES (?, ?, ?, ?, ?)")
        .run(e.plot, e.kind, e.projectId, e.agentId, this.now().toISOString());
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
      throw err;
    }
  }

  taken(plot: number): boolean {
    return this.db.prepare("SELECT 1 FROM city_plots WHERE plot = ?").get(plot) !== undefined;
  }

  list(): CityPlot[] {
    const rows = this.db.prepare("SELECT plot, kind, project_id, agent_id, ts FROM city_plots ORDER BY plot").all() as Row[];
    return rows.map((r) => ({ plot: r.plot, kind: r.kind, projectId: r.project_id, agentId: r.agent_id, ts: r.ts }));
  }
}
