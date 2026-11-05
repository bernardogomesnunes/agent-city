import type Database from "better-sqlite3";

/** The local date as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Budget {
  constructor(private readonly db: Database.Database) {}

  add(projectId: string, agentId: string, tokens: number, usd: number, day: string = dayKey(new Date())): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO usage (project_id, agent_id, tokens, usd) VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id, agent_id) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd`,
        )
        .run(projectId, agentId, tokens, usd);
      this.db
        .prepare(
          `INSERT INTO usage_days (project_id, day, tokens, usd) VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id, day) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd`,
        )
        .run(projectId, day, tokens, usd);
    })();
  }

  day(projectId: string, day: string): { tokens: number; usd: number } {
    const row = this.db
      .prepare("SELECT tokens, usd FROM usage_days WHERE project_id = ? AND day = ?")
      .get(projectId, day) as { tokens: number; usd: number } | undefined;
    return row ?? { tokens: 0, usd: 0 };
  }

  project(projectId: string): { tokens: number; usd: number } {
    return this.db
      .prepare("SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(usd), 0) AS usd FROM usage WHERE project_id = ?")
      .get(projectId) as { tokens: number; usd: number };
  }

  agent(projectId: string, agentId: string): { tokens: number; usd: number } {
    const row = this.db
      .prepare("SELECT tokens, usd FROM usage WHERE project_id = ? AND agent_id = ?")
      .get(projectId, agentId) as { tokens: number; usd: number } | undefined;
    return row ?? { tokens: 0, usd: 0 };
  }
}
