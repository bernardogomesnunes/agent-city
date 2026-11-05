import type { AgentView, CityState, ClientMsg } from "@agentcity/world/shared";
import { CityClient, CityModel, socketUrl } from "./net.js";

/** The one city state the scenes read. */
export const city = new CityModel();
let client: CityClient | null = null;

/** Sends to the server. Dropped while offline or in the demo. */
export function sendToCity(m: ClientMsg): void {
  client?.send(m);
}

const demoAgent = (id: string, role: AgentView["role"], buildingId: AgentView["buildingId"]): AgentView => ({
  id, name: id, role, building: "software", activity: "idle", buildingId,
});

export const DEMO_STATE: CityState = {
  agents: [demoAgent("boss", "boss", "director"), demoAgent("mgr", "manager", "hq"), demoAgent("ada", "worker", "software")],
  plots: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `plot-${n}` as const })),
  approvals: [],
  runs: [],
};

/**
 * With a token (the page URL `t`, or the meta tag the city server adds), connects to the city server. Without one (opened from `vite preview`),
 * runs offline: the demo state, ada walking between the software house and HQ every 8 s, and plot 3 built after 5 s.
 */
export function startCity(loc: Location): void {
  const meta = document.querySelector<HTMLMetaElement>("meta[name=agentcity-token]")?.content ?? null;
  const url = socketUrl(loc, meta);
  if (url) {
    client = new CityClient(url, (m) => city.apply(m), undefined, (online) => city.setOnline(online));
    return;
  }
  city.apply({ type: "snapshot", state: DEMO_STATE });
  let atHq = false;
  setInterval(() => {
    atHq = !atHq;
    const ada = city.state!.agents.find((a) => a.id === "ada")!;
    city.apply({
      type: "patch",
      agents: [{
        ...ada,
        buildingId: atHq ? "hq" : "software",
        activity: atHq ? "messaging" : "writing",
        lastText: atHq ? "send_message mgr" : "write_file src/app.ts",
      }],
    });
  }, 8000);
  setTimeout(() => city.apply({ type: "patch", plots: [{ id: "plot-3", kind: "library", builtBy: "ada" }] }), 5000);
}
