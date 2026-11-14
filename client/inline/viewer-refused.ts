// The frame's page was refused: its pass ended (server/documents/pages-origin.ts tells this page, "erga-refused"). This
// page is an old one: the browser's copy (client/inline/offline-sw.ts), or a tab that stayed open. It gets the page
// from the server, one time, and says so here when the server gives none (client/common/pass-refused.ts).
//
// Trap: a reload alone may give the same copy again (a worker that thinks the browser is offline answers from its
// copy). So the request has X-Erga-Check, which the worker leaves to the network, and the old copy goes before the
// reload.

import { keptAddress, OFFLINE_CACHE } from "../../shared/offline";
import { type Refused, type RefusedEffect, type RefusedEvent, step } from "../common/pass-refused";

export default function viewerRefused(): void {
  /** When this tab last loaded a new page for a refusal (sessionStorage): one that is refused too is not loaded again. */
  const KEY = "erga:refused",
    AGAIN_MS = 30_000;
  let state: Refused = "ok";
  const run: Record<RefusedEffect, () => void> = {
    ask: () => {
      document.querySelector(".erga-refused")?.remove();
      void fetch(location.href, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
        headers: { "X-Erga-Check": "page" },
      }).then(
        // (A redirect: the server sends this person elsewhere now, to sign in. The reload goes there.)
        (r) => act({ type: r.ok || r.type == "opaqueredirect" ? "fresh" : "none" }),
        () => act({ type: "none" })
      );
    },
    load: () => {
      void (async () => {
        try {
          // (A read never makes the copy: caches.open would, after sign-out.)
          if (await caches.has(OFFLINE_CACHE)) await (await caches.open(OFFLINE_CACHE)).delete(keptAddress(location.href));
        } catch {
          /* no copy */
        }
        try {
          sessionStorage.setItem(KEY, String(Date.now()));
        } catch {
          /* private mode */
        }
        location.reload();
      })();
    },
    say: () => {
      const note = Object.assign(document.createElement("div"), { className: "erga-refused" });
      note.setAttribute("role", "alert");
      const again = Object.assign(document.createElement("button"), { type: "button", textContent: "Try again" });
      again.addEventListener("click", () => act({ type: "retry" }));
      note.append(
        Object.assign(document.createElement("p"), {
          textContent: "This page is an old copy, and Erga could not get a new one from the server.",
        }),
        again
      );
      document.body.append(note);
    },
  };
  function act(e: RefusedEvent) {
    const next = step(state, e);
    state = next.state;
    for (const effect of next.effects) run[effect]();
  }
  addEventListener("message", (e) => {
    if (!window.ergaFrames.from(e) || e.data?.type != "erga-refused") return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
    } catch {
      /* private mode */
    }
    act({ type: "refused", again: Date.now() - last < AGAIN_MS });
  });
}
