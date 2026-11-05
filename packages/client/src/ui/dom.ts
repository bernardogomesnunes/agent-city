/** Element with a class and optional text. Text goes in as textContent, never as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = "", text = "", parent?: Element,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.append(e);
  return e;
}
