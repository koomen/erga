// The Analytics page's script (/admin, server/admin/analytics.ts): each list's Load more asks the operation `analytics`
// for the next people (client/common/load-more.ts decides when) and adds their rows in place.

import { runTool } from "../common/tools";
import { type LoadEffect, type LoadEvent, type LoadMore, step } from "../common/load-more";
import { type AnalyticsList, type AnalyticsPerson, LIST_PAGE, personRow } from "../../shared/analytics";
import times from "./times";

export default function adminAnalytics(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button.more[data-list]")) {
    const list = button.dataset.list as AnalyticsList;
    const rows = document.querySelector<HTMLElement>(`ol.people-rows[data-list="${list}"]`)!;
    const hint = button.parentElement!.querySelector<HTMLElement>(".hint")!;
    let state: LoadMore = { is: "idle", next: rows.children.length || LIST_PAGE };
    const send = (ev: LoadEvent) => {
      const [next, effects] = step(state, ev);
      state = next;
      show();
      for (const fx of effects) run(fx);
    };
    const show = () => {
      button.hidden = state.is == "done";
      button.disabled = state.is == "loading";
      button.textContent = state.is == "loading" ? "Loading…" : state.is == "failed" ? "Try again" : "Load more";
      hint.textContent = state.is == "failed" ? state.error : "";
      hint.classList.toggle("error", state.is == "failed");
    };
    const run = async (fx: LoadEffect) => {
      try {
        const page = (await runTool("analytics", { list, offset: fx.offset, limit: LIST_PAGE })) as {
          people: AnalyticsPerson[];
          more: boolean;
        };
        rows.insertAdjacentHTML("beforeend", page.people.map((p) => personRow(p, list)).join(""));
        times();
        send({ e: "loaded", count: page.people.length, more: page.more });
      } catch (err) {
        send({ e: "failed", error: (err as Error).message });
      }
    };
    button.addEventListener("click", () => send({ e: "click" }), { signal: window.ergaView?.signal });
  }
}
