// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentView, ModelGroup } from "@agentcity/world/shared";
import { AgentCard } from "../src/ui/agent-card.js";
import { gameKeysEnabled } from "../src/ui/keys.js";

const groups: ModelGroup[] = [
  { label: "Claude subscription", models: ["claude-sub/sonnet", "claude-sub/opus", "claude-sub/haiku"] },
  { label: "LM Studio", models: ["lmstudio/qwen/qwen3-14b"] },
  { label: "API: groq", models: [], error: "cannot reach https://g/v1" },
];

let ada: AgentView;
let send: ReturnType<typeof vi.fn<(m: unknown) => boolean>>;
let card: AgentCard;
const q = <T extends Element>(sel: string) => card.root.querySelector<T>(sel)!;
const select = () => q<HTMLSelectElement>("select.model-select");
const choose = (value: string) => {
  select().value = value;
  select().dispatchEvent(new Event("change"));
};

beforeEach(() => {
  document.body.innerHTML = "";
  ada = { id: "ada", name: "Ada", role: "worker", building: "software", model: "lmstudio/qwen/qwen3-14b", activity: "idle", buildingId: "software" };
  send = vi.fn(() => true);
  card = new AgentCard(document.body, send as never, (id) => (id === "ada" ? ada : undefined));
});

describe("AgentCard model picker", () => {
  it("sends models.list once per open", () => {
    card.show("ada");
    card.show("ada");
    expect(send.mock.calls.filter((c) => (c[0] as { type: string }).type === "models.list")).toHaveLength(1);
    card.close();
    card.show("ada");
    expect(send.mock.calls.filter((c) => (c[0] as { type: string }).type === "models.list")).toHaveLength(2);
  });

  it("renders optgroups with the current model selected", () => {
    card.show("ada");
    card.setModels(groups);
    expect([...select().querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Claude subscription", "LM Studio", "API: groq"]);
    expect(select().value).toBe("lmstudio/qwen/qwen3-14b");
  });

  it("keeps an unlisted current model as an option", () => {
    ada.model = "api/groq/x";
    card.show("ada");
    card.setModels(groups);
    expect(select().value).toBe("api/groq/x");
  });

  it("shows a group error as one disabled option", () => {
    card.show("ada");
    card.setModels(groups);
    const opt = [...select().querySelectorAll("option")].find((o) => o.textContent === "cannot reach https://g/v1")!;
    expect(opt.disabled).toBe(true);
  });

  it("other... reveals a text input and Save sends that id", () => {
    card.show("ada");
    card.setModels(groups);
    const input = q<HTMLInputElement>("input.model-other");
    expect(input.hidden).toBe(true);
    choose("__other__");
    expect(input.hidden).toBe(false);
    input.value = " api/groq/llama-3.3-70b ";
    q<HTMLButtonElement>("button.model-save").click();
    expect(send).toHaveBeenLastCalledWith({ type: "agent.model", agentId: "ada", model: "api/groq/llama-3.3-70b" });
  });

  it("Save sends the selected model", () => {
    card.show("ada");
    card.setModels(groups);
    choose("claude-sub/haiku");
    q<HTMLButtonElement>("button.model-save").click();
    expect(send).toHaveBeenLastCalledWith({ type: "agent.model", agentId: "ada", model: "claude-sub/haiku" });
  });

  it("shows saved v2 for this agent only", () => {
    card.show("ada");
    card.saved("bob", 5);
    expect(card.root.textContent).not.toContain("saved v5");
    card.saved("ada", 2);
    expect(card.root.textContent).toContain("saved v2");
  });

  it("refresh shows a model changed elsewhere, and keeps an unsaved pick", () => {
    card.show("ada");
    card.setModels(groups);
    ada = { ...ada, model: "claude-sub/opus" };
    card.refresh();
    expect(select().value).toBe("claude-sub/opus");
    choose("claude-sub/haiku");
    ada = { ...ada, activity: "thinking" };
    card.refresh();
    expect(select().value).toBe("claude-sub/haiku");
  });

  it("game keys stay off while the model input has focus", () => {
    card.show("ada");
    expect(gameKeysEnabled(q("input.model-other"))).toBe(false);
  });

  it("New chat calls onNewChat with the agent, and closes the card", () => {
    const onNewChat = vi.fn();
    const chatCard = new AgentCard(document.body, send as never, (id) => (id === "ada" ? ada : undefined), undefined, undefined, onNewChat);
    chatCard.show("ada");
    const button = [...chatCard.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "New chat")!;
    button.click();
    expect(onNewChat).toHaveBeenCalledWith("ada");
    expect(chatCard.isOpen).toBe(false);
  });
});
