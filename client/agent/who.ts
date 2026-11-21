// Who answers in the panel: its head names the agent (a button: server/pages/agent.ts), and its menu lists Erga's own
// agent, each session that the person attached (agents/link.ts) and each hosted agent of this server (the setting
// agents). The server keeps the person's choice (POST /api/agent/agent), so each of their tabs shows the same agent. The menu's last row, "Connect an agent…", says how a session attaches (the plugin's two
// commands: agents/plugin.ts).

import { esc } from "../../shared/html";
import type { HostedAgent } from "./agui-http";

/** An attached session, as its helper names it; `on`: its link is open. */
export interface Session {
  id: string;
  agent: string;
  where: string;
  model: string;
  on: boolean;
}

export interface Who {
  agents: HostedAgent[];
  sessions: Session[];
  /** A hosted agent's name, or "link:" and a session's id; null: Erga's own agent. */
  agent: string | null;
}

/** The attached session that the panel shows, if it shows one. */
export const sessionOf = (who: Who): Session | null => who.sessions.find((s) => `link:${s.id}` == who.agent) ?? null;

const CARET = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>`;

export interface WhoMenu {
  /** Draws the head for `who`; `erga`: Erga's own agent's line in the menu (its model, or that it is off). */
  render(who: Who, erga: string): void;
}

export function mountWho(o: { button: HTMLElement; card: HTMLElement; pick(agent: string | null): void; connect(): void }): WhoMenu {
  const { button } = o;
  const menu = document.createElement("div");
  menu.className = "agent-menu";
  menu.id = "agent-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "The agent that answers");
  o.card.append(menu);

  const rows = () => [...menu.querySelectorAll<HTMLButtonElement>("button")];
  function open(on: boolean) {
    menu.hidden = !on;
    button.setAttribute("aria-expanded", String(on));
    if (on) (menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? rows()[0])?.focus();
  }
  button.addEventListener("click", () => open(menu.hidden === true));
  menu.addEventListener("click", (e) => {
    const row = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!row) return;
    open(false);
    button.focus();
    if (row.classList.contains("more")) o.connect();
    else if (row.getAttribute("aria-checked") != "true") o.pick(row.dataset.agent || null);
  });
  menu.addEventListener("keydown", (e) => {
    const all = rows(),
      at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key == "Escape") {
      e.stopPropagation();
      open(false);
      button.focus();
    } else if (e.key == "ArrowDown" || e.key == "ArrowUp") {
      e.preventDefault();
      all[(at + (e.key == "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !button.contains(e.target as Node)) open(false);
  });

  return {
    render(who, erga) {
      // A session that left stays in the menu only while the panel shows it.
      const sessions = who.sessions.filter((s) => s.on || `link:${s.id}` == who.agent);
      button.innerHTML = `${esc(sessionOf(who)?.agent ?? who.agent ?? "Agent")}${CARET}`;
      const row = (agent: string | null, name: string, sub: string, on: boolean) =>
        `<button type="button" role="menuitemradio" class="row" aria-checked="${agent == who.agent}" data-agent="${esc(agent ?? "")}"><i${on ? ' class="on"' : ""}></i><span><b>${esc(name)}</b><small>${esc(sub)}</small></span><em aria-hidden="true">${agent == who.agent ? "✓" : ""}</em></button>`;
      menu.innerHTML =
        row(null, "Erga's agent", erga, !/\boff$/.test(erga)) +
        sessions
          .map((s) => row(`link:${s.id}`, s.agent, `${s.where ? `${s.where} · ` : ""}${s.on ? "attached" : "not attached"}`, s.on))
          .join("") +
        who.agents.map((a) => row(a.name, a.name, new URL(a.url).host, false)).join("") +
        `<hr><button type="button" role="menuitem" class="row more"><i></i><span><b>Connect an agent…</b></span><em></em></button>`;
    },
  };
}
