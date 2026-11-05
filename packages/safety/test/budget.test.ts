import { describe, expect, it } from "vitest";
import { Budget, dayKey, openDb } from "../src/index.js";
import { tempHome } from "./helpers.js";

describe("Budget", () => {
  it("starts at zero", () => {
    const db = openDb(tempHome());
    const b = new Budget(db);
    expect(b.project("p")).toEqual({ tokens: 0, usd: 0 });
    expect(b.agent("p", "a")).toEqual({ tokens: 0, usd: 0 });
    db.close();
  });

  it("adds per agent", () => {
    const db = openDb(tempHome());
    const b = new Budget(db);
    b.add("p", "a", 100, 0.25);
    b.add("p", "a", 50, 0.5);
    expect(b.agent("p", "a")).toEqual({ tokens: 150, usd: 0.75 });
    db.close();
  });

  it("project sums all agents", () => {
    const db = openDb(tempHome());
    const b = new Budget(db);
    b.add("p", "a", 100, 0.25);
    b.add("p", "b", 200, 0.5);
    b.add("q", "a", 999, 9);
    expect(b.project("p")).toEqual({ tokens: 300, usd: 0.75 });
    db.close();
  });

  it("add counts per day; day() reads one day", () => {
    const db = openDb(tempHome());
    const b = new Budget(db);
    b.add("p", "a", 100, 0.25, "2026-11-03");
    b.add("p", "b", 50, 0.5, "2026-11-03");
    b.add("p", "a", 7, 0.1, "2026-11-04");
    b.add("q", "a", 999, 9, "2026-11-03");
    expect(b.day("p", "2026-11-03")).toEqual({ tokens: 150, usd: 0.75 });
    expect(b.day("p", "2026-11-04")).toEqual({ tokens: 7, usd: 0.1 });
    expect(b.day("p", "2026-11-05")).toEqual({ tokens: 0, usd: 0 });
    expect(b.project("p")).toEqual({ tokens: 157, usd: 0.85 });
    db.close();
  });

  it("add without a day counts under today", () => {
    const db = openDb(tempHome());
    const b = new Budget(db);
    b.add("p", "a", 3, 0.5);
    expect(b.day("p", dayKey(new Date()))).toEqual({ tokens: 3, usd: 0.5 });
    db.close();
  });

  it("dayKey uses local date", () => {
    expect(dayKey(new Date(2026, 10, 4, 23, 59))).toBe("2026-11-04");
    expect(dayKey(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });

  it("survives reopening the db", () => {
    const home = tempHome();
    const db1 = openDb(home);
    new Budget(db1).add("p", "a", 10, 0.5);
    db1.close();
    const db2 = openDb(home);
    expect(new Budget(db2).agent("p", "a")).toEqual({ tokens: 10, usd: 0.5 });
    db2.close();
  });
});
