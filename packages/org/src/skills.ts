import fs from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "./store.js";

export const SKILL_NAME = /^[a-z0-9-]{1,40}$/;
const DESCRIPTION_MAX = 300;
const BODY_MAX = 50_000;

export interface Skill { name: string; description: string; body: string }

function parse(name: string, text: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { name, description: "", body: text };
  const desc = /^description:\s*(.*)$/m.exec(m[1]!)?.[1]?.trim() ?? "";
  return { name, description: desc, body: m[2]! };
}

/**
 * Skills at `<home>/skills/<name>/SKILL.md`: a `description:` line in front matter, then the instructions.
 * Agents see the names and descriptions and load a body with the use_skill tool.
 */
export class SkillStore {
  constructor(private readonly home: string) {}

  private file(name: string): string {
    if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
    return path.join(this.home, "skills", name, "SKILL.md");
  }

  list(): Array<{ name: string; description: string }> {
    const dir = path.join(this.home, "skills");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => SKILL_NAME.test(n))
      .sort()
      .flatMap((n) => {
        const s = this.get(n);
        return s ? [{ name: s.name, description: s.description }] : [];
      });
  }

  get(name: string): Skill | undefined {
    if (!SKILL_NAME.test(name)) return undefined;
    try {
      return parse(name, fs.readFileSync(this.file(name), "utf8"));
    } catch {
      return undefined;
    }
  }

  save(name: string, description: string, body: string): Skill {
    const d = description.replace(/\s+/g, " ").trim();
    if (d === "") throw new Error("a skill needs a description");
    if (d.length > DESCRIPTION_MAX) throw new Error(`description is over ${DESCRIPTION_MAX} characters`);
    if (body.trim() === "") throw new Error("a skill needs instructions");
    if (body.length > BODY_MAX) throw new Error(`instructions are over ${BODY_MAX} characters`);
    writeTextAtomic(this.file(name), `---\nname: ${name}\ndescription: ${d}\n---\n${body.trim()}\n`);
    return { name, description: d, body: body.trim() + "\n" };
  }

  remove(name: string): boolean {
    const f = this.file(name);
    if (!fs.existsSync(f)) return false;
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
    return true;
  }
}
