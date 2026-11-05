import { el } from "./dom.js";

// **bold**, *italic* or _italic_, `code`. Markers must close on the same line.
const INLINE = /\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|_([^_\s][^_\n]*)_|`([^`\n]+)`/g;

function inline(text: string, parent: HTMLElement): void {
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) parent.append(text.slice(at, m.index));
    if (m[1] !== undefined) el("strong", "", m[1], parent);
    else if (m[4] !== undefined) el("code", "", m[4], parent);
    else el("em", "", m[2] ?? m[3], parent);
    at = m.index + m[0].length;
  }
  if (at < text.length) parent.append(text.slice(at));
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

/**
 * Renders the small part of markdown agents use: paragraphs, lists, headings, code blocks,
 * bold, italic and inline code. Every piece of text goes in as a text node, never as HTML.
 */
export function markdown(text: string, parent: HTMLElement): void {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith("```"); i++) body.push(lines[i]);
      i++;
      el("code", "", body.join("\n"), el("pre", "", "", parent));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { el("strong", "", heading[1], el("p", "", "", parent)); i++; continue; }
    const kind = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : undefined;
    if (kind) {
      const list = el(kind === BULLET ? "ul" : "ol", "", "", parent);
      for (; i < lines.length && kind.test(lines[i]); i++) inline(kind.exec(lines[i])![1], el("li", "", "", list));
      continue;
    }
    const p = el("p", "", "", parent);
    for (let first = true; i < lines.length; i++, first = false) {
      const l = lines[i];
      if (l.trim() === "" || l.trimStart().startsWith("```") || HEADING.test(l) || BULLET.test(l) || NUMBER.test(l)) break;
      if (!first) p.append(document.createElement("br"));
      inline(l, p);
    }
  }
}
