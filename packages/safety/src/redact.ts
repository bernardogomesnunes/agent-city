const MIN_SECRET_LENGTH = 8;

export function redact<T>(value: T, secrets: string[]): T {
  const active = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return active.reduce((acc, s) => acc.split(s).join("[secret]"), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k) as string, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
