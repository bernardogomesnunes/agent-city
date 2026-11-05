import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS actions_no_update BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'actions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS actions_no_delete BEFORE DELETE ON actions BEGIN SELECT RAISE(ABORT, 'actions is append-only'); END;
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL, tier INTEGER NOT NULL, estimated_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')), decided_at TEXT, decided_by TEXT);
CREATE TABLE IF NOT EXISTS usage (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (project_id, agent_id));
CREATE TABLE IF NOT EXISTS usage_days (project_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (project_id, day));
CREATE TABLE IF NOT EXISTS city_plots (plot INTEGER PRIMARY KEY CHECK (plot BETWEEN 1 AND 6), kind TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS city_plots_no_update BEFORE UPDATE ON city_plots BEGIN SELECT RAISE(ABORT, 'city_plots is insert-only'); END;
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, branch TEXT, title TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS sessions_by_agent ON sessions (agent_id);
CREATE TABLE IF NOT EXISTS session_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), ts TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('user','agent','report','system')), author TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','done')), run_id TEXT);
CREATE INDEX IF NOT EXISTS session_messages_by_session ON session_messages (session_id, id);
CREATE TRIGGER IF NOT EXISTS city_plots_no_delete BEFORE DELETE ON city_plots BEGIN SELECT RAISE(ABORT, 'city_plots is insert-only'); END;
CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('planning','active','done','cancelled','failed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS goals_by_project ON goals (project_id);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), parent_id TEXT, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, assignee TEXT, deps_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK (status IN ('todo','doing','review','approval','done','blocked','cancelled')), branch TEXT, worktree TEXT, summary TEXT, blocked_reason TEXT, checkpoint TEXT, ci TEXT NOT NULL DEFAULT 'none' CHECK (ci IN ('none','running','pass','fail')), test_output TEXT, send_backs INTEGER NOT NULL DEFAULT 0, nudges INTEGER NOT NULL DEFAULT 0, test_fixes INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_by_goal ON tasks (goal_id);
CREATE INDEX IF NOT EXISTS tasks_by_parent ON tasks (parent_id);
CREATE TABLE IF NOT EXISTS task_runs (task_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (task_id, run_id));
CREATE TABLE IF NOT EXISTS task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('answer','held','rollback')), text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_notes_by_task ON task_notes (task_id, kind);
CREATE TABLE IF NOT EXISTS goal_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS goal_notes_by_goal ON goal_notes (goal_id, id);
CREATE TABLE IF NOT EXISTS paused_projects (project_id TEXT PRIMARY KEY, since TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS id_counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
`;

/** Schema version of the sessions table. 1: no UNIQUE (project_id, agent_id), a title column. */
const SESSIONS_VERSION = 1;

/**
 * Moves an old sessions table (one session per project and agent) to the new shape.
 * Ids, messages and branches stay. Foreign keys are off so session_messages keeps pointing at the name `sessions`.
 */
function migrateSessions(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      db.exec("ALTER TABLE sessions RENAME TO sessions_old");
      db.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, branch TEXT, title TEXT NOT NULL DEFAULT '')");
      db.exec(`INSERT INTO sessions (id, project_id, agent_id, created_at, branch, title)
        SELECT o.id, o.project_id, o.agent_id, o.created_at, o.branch,
          COALESCE((SELECT substr(m.text, 1, 40) FROM session_messages m WHERE m.session_id = o.id AND m.kind = 'user' ORDER BY m.id LIMIT 1), '')
        FROM sessions_old o`);
      db.exec("DROP TABLE sessions_old");
      db.exec("CREATE INDEX IF NOT EXISTS sessions_by_agent ON sessions (agent_id)");
      db.pragma(`user_version = ${SESSIONS_VERSION}`);
    })();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Rebuilds an old task_notes table whose kind CHECK lacks `rollback`. SQLite cannot change a CHECK in place.
 * Ids and rows stay. The index is made again on the new table.
 */
function migrateTaskNotes(db: Database.Database): void {
  db.transaction(() => {
    db.exec("ALTER TABLE task_notes RENAME TO task_notes_old");
    db.exec("CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('answer','held','rollback')), text TEXT NOT NULL)");
    db.exec("INSERT INTO task_notes (id, task_id, kind, text) SELECT id, task_id, kind, text FROM task_notes_old");
    db.exec("DROP TABLE task_notes_old");
    db.exec("CREATE INDEX IF NOT EXISTS task_notes_by_task ON task_notes (task_id, kind)");
  })();
}

export function openDb(home: string): Database.Database {
  fs.mkdirSync(home, { recursive: true });
  const db = new Database(path.join(home, "agentcity.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const hadSessions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() !== undefined;
  const version = db.pragma("user_version", { simple: true }) as number;
  db.exec(SCHEMA);
  // The stored DDL decides. A task_notes table made before rollback notes lacks 'rollback' in its CHECK.
  const notesDdl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_notes'").get() as { sql: string } | undefined;
  if (notesDdl && !notesDdl.sql.includes("'rollback'")) migrateTaskNotes(db);
  if (version < SESSIONS_VERSION) {
    if (hadSessions) migrateSessions(db);
    else db.pragma(`user_version = ${SESSIONS_VERSION}`);
  }
  // Part 1 databases lack the run id columns. Old rows keep NULL.
  const cols = (db.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("run_id")) db.exec("ALTER TABLE actions ADD COLUMN run_id TEXT");
  if (!cols.includes("parent_run_id")) db.exec("ALTER TABLE actions ADD COLUMN parent_run_id TEXT");
  // Older databases do not record which process waits for an approval. Their pending rows count as orphans.
  const acols = (db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!acols.includes("owner_pid")) db.exec("ALTER TABLE approvals ADD COLUMN owner_pid INTEGER");
  // Tasks made before checkpoints existed have none. Their rows keep NULL.
  const tcols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!tcols.includes("checkpoint")) db.exec("ALTER TABLE tasks ADD COLUMN checkpoint TEXT");
  // Chats made before task chats carry no task or goal.
  const scols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!scols.includes("task_id")) db.exec("ALTER TABLE sessions ADD COLUMN task_id TEXT");
  if (!scols.includes("goal_id")) db.exec("ALTER TABLE sessions ADD COLUMN goal_id TEXT");
  // Tasks made before per-task pause are not held.
  if (!tcols.includes("held")) db.exec("ALTER TABLE tasks ADD COLUMN held INTEGER NOT NULL DEFAULT 0");
  // Which held tasks the pause of their team task held, so resuming the team task releases only those.
  if (!tcols.includes("held_by_parent")) db.exec("ALTER TABLE tasks ADD COLUMN held_by_parent INTEGER NOT NULL DEFAULT 0");
  // Goals made before plans existed were already worked on. Goals with a task read as approved.
  const gcols = (db.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!gcols.includes("plan_state")) {
    db.transaction(() => {
      db.exec("ALTER TABLE goals ADD COLUMN plan TEXT");
      db.exec("ALTER TABLE goals ADD COLUMN plan_state TEXT NOT NULL DEFAULT 'none'");
      db.exec("ALTER TABLE goals ADD COLUMN plan_by TEXT");
      db.exec("UPDATE goals SET plan_state = 'approved' WHERE id IN (SELECT goal_id FROM tasks)");
    })();
  }
  // Goal and task ids come from a counter that never goes down. Older databases start it at the current highest id.
  db.exec(`INSERT OR IGNORE INTO id_counters (name, n) SELECT 'goals', COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) FROM goals;
    INSERT OR IGNORE INTO id_counters (name, n) SELECT 'tasks', COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) FROM tasks;`);
  return db;
}
