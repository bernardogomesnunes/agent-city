// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { markdown } from "../src/ui/markdown.js";

const html = (text: string) => {
  const d = document.createElement("div");
  markdown(text, d);
  return d.innerHTML;
};

describe("markdown", () => {
  it("renders bold, italic and inline code", () => {
    expect(html("Use **W/S** and *arrows* in `index.html`.")).toBe(
      "<p>Use <strong>W/S</strong> and <em>arrows</em> in <code>index.html</code>.</p>",
    );
  });
  it("renders paragraphs, lists and code blocks", () => {
    expect(html("Plan:\n\n1. menu\n2. game\n\n- a\n* b\n\n```js\nx < 1\n```")).toBe(
      "<p>Plan:</p><ol><li>menu</li><li>game</li></ol><ul><li>a</li><li>b</li></ul><pre><code>x &lt; 1</code></pre>",
    );
  });
  it("keeps line breaks inside a paragraph and renders headings as bold lines", () => {
    expect(html("## Done\nline one\nline two")).toBe("<p><strong>Done</strong></p><p>line one<br>line two</p>");
  });
  it("never turns text into HTML", () => {
    expect(html("<img src=x onerror=alert(1)> **<b>x</b>**")).toBe(
      "<p>&lt;img src=x onerror=alert(1)&gt; <strong>&lt;b&gt;x&lt;/b&gt;</strong></p>",
    );
  });
  it("leaves an unclosed marker as text", () => {
    expect(html("2 * 3 and **open")).toBe("<p>2 * 3 and **open</p>");
  });
});
