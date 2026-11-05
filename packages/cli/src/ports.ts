import http from "node:http";

/** Ports dev servers usually take: Next/React, Vite, Angular, Astro, Python, Flask, Live Server and friends. */
export const DEV_PORTS = [3000, 3001, 4000, 4173, 4200, 4321, 5000, 5173, 5174, 5500, 8000, 8080, 8081, 8888, 9000];
const PROBE_MS = 600;
const MAX_BODY = 64 * 1024;

function probe(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: PROBE_MS, headers: { Accept: "text/html" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        body += d;
        if (body.length > MAX_BODY) res.destroy();
      });
      const done = () => resolve(/<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? "");
      res.on("end", done);
      res.on("close", done);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/**
 * Local ports that answer HTTP, with the page title when there is one.
 * Tries IPv4 then IPv6, since some dev servers listen on ::1 only. `skip` leaves out the city's own port.
 */
export async function scanPorts(skip: number[] = [], ports = DEV_PORTS): Promise<Array<{ port: number; title: string }>> {
  const found = await Promise.all(
    ports.filter((p) => !skip.includes(p)).map(async (port) => {
      const title = (await probe("127.0.0.1", port)) ?? (await probe("::1", port));
      return title === null ? null : { port, title };
    }),
  );
  return found.filter((f): f is { port: number; title: string } => f !== null);
}
