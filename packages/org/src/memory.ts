import fs from "node:fs";
import path from "node:path";
import { safeId, writeTextAtomic } from "./store.js";

/** Notes at `<home>/agents/<id>/memory/notes.md`. */
export class MemoryStore {
  constructor(private home: string) {}

  private file(agentId: string): string {
    return path.join(this.home, "agents", safeId(agentId), "memory", "notes.md");
  }

  read(agentId: string): string {
    try {
      return fs.readFileSync(this.file(agentId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  tail(agentId: string, maxChars: number): string {
    const text = this.read(agentId);
    if (text.length <= maxChars) return text;
    const slice = text.slice(-maxChars);
    const nl = slice.indexOf("\n");
    return nl === -1 ? slice : slice.slice(nl + 1);
  }

  append(agentId: string, line: string): void {
    const text = this.read(agentId);
    writeTextAtomic(this.file(agentId), text === "" ? line : `${text}\n${line}`);
  }

  clear(agentId: string): void {
    writeTextAtomic(this.file(agentId), "");
  }
}
