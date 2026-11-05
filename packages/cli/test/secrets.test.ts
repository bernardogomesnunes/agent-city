import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSecrets, removeSecret, restrictToOwner, setSecret } from "../src/secrets.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ac-sec-"));
const noRestrict = { platform: "linux" as const };

describe("secrets", () => {
  it("missing file gives {}", () => {
    expect(readSecrets(tmp())).toEqual({});
  });

  it("set then read round-trips", () => {
    const home = tmp();
    const calls: string[][] = [];
    setSecret(home, "anthropic", "sk-test-123", { platform: "win32", user: "me", exec: (_c, a) => void calls.push(a) });
    setSecret(home, "other", "k2", { platform: "win32", user: "me", exec: () => undefined });
    expect(readSecrets(home)).toEqual({ anthropic: "sk-test-123", other: "k2" });
    expect(calls).toHaveLength(1);
  });

  it("restrictToOwner on win32 calls icacls with /inheritance:r", () => {
    const calls: Array<[string, string[]]> = [];
    restrictToOwner("C:\\x\\secrets.json", { platform: "win32", user: "berna", exec: (c, a) => void calls.push([c, a]) });
    expect(calls).toEqual([["icacls", ["C:\\x\\secrets.json", "/inheritance:r", "/grant:r", "berna:F"]]]);
  });

  it("restrictToOwner elsewhere sets mode 600", () => {
    const home = tmp();
    const f = path.join(home, "s.json");
    fs.writeFileSync(f, "{}");
    restrictToOwner(f, { platform: "linux" });
    if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("removeSecret drops one key and keeps the rest", () => {
    const home = tmp();
    setSecret(home, "a", "1", noRestrict);
    setSecret(home, "b", "2", noRestrict);
    removeSecret(home, "a", noRestrict);
    expect(readSecrets(home)).toEqual({ b: "2" });
    removeSecret(home, "missing", noRestrict);
    expect(readSecrets(home)).toEqual({ b: "2" });
  });

  it("rejects bad provider names and invalid files", () => {
    const home = tmp();
    expect(() => setSecret(home, "../x", "k", noRestrict)).toThrow(/invalid provider/);
    fs.writeFileSync(path.join(home, "secrets.json"), "nope");
    expect(() => readSecrets(home)).toThrow(/invalid secrets.json/);
  });
});

describe("setSecret fail closed", () => {
  it("removes the file and throws when restrictToOwner fails", () => {
    const home = tmp();
    const exec = () => {
      throw new Error("icacls exploded");
    };
    expect(() => setSecret(home, "anthropic", "sk-test-123", { platform: "win32", user: "me", exec })).toThrow(
      "could not restrict secrets.json to the current user: icacls exploded",
    );
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("keeps earlier secrets when a later restrict fails", () => {
    const home = tmp();
    setSecret(home, "a", "key-one-111", { platform: "win32", user: "me", exec: () => undefined });
    expect(() =>
      setSecret(home, "b", "key-two-222", {
        platform: "win32",
        user: "me",
        exec: () => {
          throw new Error("x");
        },
      }),
    ).toThrow();
    expect(readSecrets(home)).toEqual({ a: "key-one-111" });
  });
});
