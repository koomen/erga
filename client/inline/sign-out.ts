// The sign-out page (server/identity/sign-in.ts, signOut): the session's cookie is gone already. Before it goes on, it
// deletes every offline copy of the editor's in this browser: this origin's, and each pages origin's that the editor
// used (client/common/offline.ts), in a frame of that origin's /erga-clear (they wait at most a few seconds). It also
// deletes this tab's copy of the agent's panel (client/agent/person-agent.ts keeps it for the tab's next page).

import { savePanel } from "../common/agent-panel";
import { clearOffline } from "../common/offline";
import { CLEAR_PATH, ORIGINS_KEY } from "../../shared/offline";

export default function signOut(C: { to: string }): void {
  let origins: string[] = [];
  savePanel({ drawn: null });
  try {
    origins = (JSON.parse(localStorage.getItem(ORIGINS_KEY) ?? "[]") as unknown[]).filter(
      (o): o is string => typeof o == "string" && /^https?:\/\/[^/]+$/.test(o)
    );
  } catch {
    /* no storage */
  }
  const left = new Set(origins);
  const cleared = new Promise<void>((resolve) => {
    if (!left.size) return resolve();
    addEventListener("message", (e) => {
      if (e.data?.type != "erga-cleared" || !left.delete(e.origin)) return;
      if (!left.size) resolve();
    });
    setTimeout(resolve, 4000);
  });
  for (const o of origins) {
    const f = document.createElement("iframe");
    f.hidden = true;
    f.src = o + CLEAR_PATH;
    document.body.append(f);
  }
  void Promise.all([cleared, clearOffline()]).then(() => {
    try {
      localStorage.removeItem(ORIGINS_KEY);
    } catch {
      /* no storage */
    }
    location.replace(C.to);
  });
}
