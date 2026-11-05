import { git } from "./workspace.js";

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number };

export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: DiffLine[][];
  truncated: boolean;
};

const MAX_FILES = 200;
const MAX_LINES_PER_FILE = 2000;

/** Parses unified git diff text. Keeps at most 200 files and 2000 lines per file. Counts stay complete. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false;
  let hunk: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let kept = 0;

  const keep = (line: DiffLine) => {
    if (kept < MAX_LINES_PER_FILE) {
      hunk.push(line);
      kept++;
    } else {
      file!.truncated = true;
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      file = { path: head[2]!, status: "modified", additions: 0, deletions: 0, hunks: [], truncated: false };
      files.push(file);
      inHunk = false;
      kept = 0;
      continue;
    }
    if (!file) continue;

    if (!inHunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) file.status = "renamed";
      else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.status = "binary";
      const hunkHead = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunkHead) {
        inHunk = true;
        oldNo = Number(hunkHead[1]);
        newNo = Number(hunkHead[2]);
        hunk = [];
        file.hunks.push(hunk);
      }
      continue;
    }

    if (line.startsWith("\\")) continue;
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "+") {
      file.additions++;
      keep({ kind: "add", text: body, newNo });
      newNo++;
    } else if (mark === "-") {
      file.deletions++;
      keep({ kind: "del", text: body, oldNo });
      oldNo++;
    } else {
      keep({ kind: "ctx", text: line.startsWith(" ") ? body : line, oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }

  for (const f of files) f.hunks = f.hunks.filter((h) => h.length > 0);
  return files.slice(0, MAX_FILES);
}

/** The diff of branch against base, from `git diff base...branch` in root. */
export function taskDiff(root: string, base: string, branch: string): DiffFile[] {
  return parseDiff(git(root, ["diff", "--no-color", `${base}...${branch}`]));
}

/** Plain text of the files for a review prompt. Cut to max characters. */
export function diffText(files: DiffFile[], max = 12_000): string {
  const out: string[] = [];
  for (const f of files) {
    const cut = f.truncated ? ", cut" : "";
    out.push(`# ${f.path} (${f.status}, +${f.additions} -${f.deletions}${cut})`);
    for (const hunk of f.hunks) {
      for (const l of hunk) out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
    }
  }
  const text = out.join("\n");
  if (text.length <= max) return text;
  const note = "\n[diff cut]";
  return text.slice(0, max - note.length) + note;
}
