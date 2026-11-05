import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cityToken, installLink, isLinkUrl, linkCommand, linkStatus, missingPaths, removeLink, type RegRunner } from "../src/link.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-link-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A stand-in for reg.exe that keeps keys in a map. */
function fakeReg(): { reg: RegRunner; keys: Map<string, string>; calls: string[][] } {
  const keys = new Map<string, string>();
  const calls: string[][] = [];
  const reg: RegRunner = (args) => {
    calls.push(args);
    const [verb, key] = args;
    if (verb === "add") {
      const name = args.includes("/ve") ? "" : args[args.indexOf("/v") + 1]!;
      keys.set(`${key}|${name}`, args[args.indexOf("/d") + 1]!);
      return { code: 0, out: "" };
    }
    if (verb === "delete") {
      for (const k of [...keys.keys()]) if (k.startsWith(key!)) keys.delete(k);
      return { code: 0, out: "" };
    }
    const v = keys.get(`${key}|`);
    return v === undefined ? { code: 1, out: "ERROR" } : { code: 0, out: `\r\n${key}\r\n    (Default)    REG_SZ    ${v}\r\n` };
  };
  return { reg, keys, calls };
}

describe("agentcity link", () => {
  it("accepts only the start link", () => {
    expect(isLinkUrl("agentcity://start")).toBe(true);
    expect(isLinkUrl("agentcity://start/")).toBe(true);
    expect(isLinkUrl("AGENTCITY://START")).toBe(true);
    for (const u of ["agentcity://start?home=x", "agentcity://stop", "agentcity://start/../x", "http://start", ""]) expect(isLinkUrl(u)).toBe(false);
  });

  it("builds the command with this node, CLI, home and port, and refuses a quote in a path", () => {
    expect(linkCommand({ node: "C:\\n\\node.exe", main: "C:\\a\\main.js", home: "C:\\h", port: 4321 })).toBe(
      '"C:\\n\\node.exe" "C:\\a\\main.js" link open --home "C:\\h" --port 4321 "%1"',
    );
    expect(() => linkCommand({ node: 'C:\\"x', main: "m", home: "h", port: 1 })).toThrow(/quote/);
  });

  it("installs under the user's classes, reads the command back, and removes it", () => {
    const { reg, keys } = fakeReg();
    expect(linkStatus(reg)).toBeUndefined();
    expect(installLink('"n" "m" link open "%1"', reg).ok).toBe(true);
    expect(keys.get("HKCU\\Software\\Classes\\agentcity|")).toBe("URL:Agent City");
    expect(keys.get("HKCU\\Software\\Classes\\agentcity|URL Protocol")).toBe("");
    expect(linkStatus(reg)).toBe('"n" "m" link open "%1"');
    expect(removeLink(reg).ok).toBe(true);
    expect(linkStatus(reg)).toBeUndefined();
  });

  it("stops at the first failing reg step", () => {
    const calls: string[][] = [];
    const r = installLink("c", (a) => (calls.push(a), { code: 1, out: "ERROR: Access is denied.\n" }));
    expect(r).toEqual({ ok: false, out: "ERROR: Access is denied." });
    expect(calls).toHaveLength(1);
  });

  it("lists the quoted paths that no longer exist", () => {
    const main = path.join(home, "main.js");
    fs.writeFileSync(main, "");
    const gone = path.join(home, "gone", "node.exe");
    expect(missingPaths(`"${gone}" "${main}" link open --home "${home}" --port 1 "%1"`)).toEqual([gone]);
  });

  it("keeps the city token across starts and replaces a damaged one", () => {
    const t = cityToken(home);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(cityToken(home)).toBe(t);
    fs.writeFileSync(path.join(home, "city-token"), "junk");
    expect(cityToken(home)).not.toBe(t);
  });
});
