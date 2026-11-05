import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { CityPlots, openDb } from "../src/index.js";
import { tempHome } from "./helpers.js";

const dbs: Database.Database[] = [];
const open = () => { const d = openDb(tempHome()); dbs.push(d); return d; };
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

const e = (over: Partial<{ plot: number; kind: string; projectId: string; agentId: string }> = {}) =>
  ({ plot: 2, kind: "library", projectId: "p", agentId: "a", ...over });

describe("CityPlots", () => {
  it("claim twice on plot 2 gives true then false, list has 1 row", () => {
    const c = new CityPlots(open());
    expect(c.claim(e())).toBe(true);
    expect(c.claim(e({ agentId: "b" }))).toBe(false);
    expect(c.taken(2)).toBe(true);
    expect(c.taken(3)).toBe(false);
    const rows = c.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plot: 2, kind: "library", projectId: "p", agentId: "a" });
    expect(typeof rows[0]!.ts).toBe("string");
  });

  it("raw UPDATE and DELETE throw insert-only", () => {
    const db = open();
    new CityPlots(db).claim(e());
    expect(() => db.prepare("UPDATE city_plots SET kind = 'house'").run()).toThrow(/insert-only/);
    expect(() => db.prepare("DELETE FROM city_plots").run()).toThrow(/insert-only/);
  });

  it("plot 7 insert throws", () => {
    const c = new CityPlots(open());
    expect(() => c.claim(e({ plot: 7 }))).toThrow();
  });
});
