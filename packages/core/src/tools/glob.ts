/**
 * Turns a glob into a RegExp over "/"-separated relative paths.
 * `**` matches any number of folders, `*` matches inside one name, `?` one character.
 * A pattern with no "/" matches the last name at any depth, like .gitignore.
 */
export function globToRegExp(glob: string, ignoreCase = process.platform === "win32"): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const anchored = glob.includes("/") ? `^${re}$` : `^(?:.*/)?${re}$`;
  return new RegExp(anchored, ignoreCase ? "i" : "");
}

/** Normalizes a folder-relative path to "/" separators with no "./". Returns null when it leaves the folder. */
export function relPath(p: string): string | null {
  if (/^[a-z]:/i.test(p) || p.startsWith("/") || p.startsWith("\\")) return null;
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
