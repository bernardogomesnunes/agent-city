import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectDirs } from "../src/index.js";

it("project config path is projects/<id>/project.json", () => {
  const d = projectDirs("/h", "demo");
  expect(d.config).toBe(path.join("/h", "projects", "demo", "project.json"));
  expect(d.config.endsWith(path.join("projects", "demo", "project.json"))).toBe(true);
});

describe("projectDirs id validation", () => {
  it('projectDirs rejects "../x"', () => {
    expect(() => projectDirs("/h", "../x")).toThrow("invalid project id: ../x");
  });
  it('projectDirs rejects "Bad_Id"', () => {
    expect(() => projectDirs("/h", "Bad_Id")).toThrow("invalid project id: Bad_Id");
  });
});

describe("reserved ids", () => {
  it('projectDirs rejects "con" and "lpt1"', () => {
    expect(() => projectDirs("/h", "con")).toThrow("invalid project id: con");
    expect(() => projectDirs("/h", "lpt1")).toThrow("invalid project id: lpt1");
  });
  it('id "console" is allowed', () => {
    expect(() => projectDirs("/h", "console")).not.toThrow();
  });
});
