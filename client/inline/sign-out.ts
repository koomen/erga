// The sign-out page (server/identity/sign-in.ts, signOut): the sign-in's cookies on this site are gone already. Before
// it goes on, it deletes every offline copy of the editor's in this browser: this origin's, and each pages origin's
// that the editor used (client/common/offline.ts), in a frame of that origin's /erga-clear (they wait at most a few
// seconds). Then, where the documents are on another site, it loads the gate's sign-out there in a hidden frame
// (`gate`: gate/core.ts, the accept host), which ends that site's cookie in this site's partition: after the frames
// above, which need it. Last it goes on to `to`: behind Cloudflare Access that is Access's own sign-out, which ends the
// sign-in that this page and its frames came with (gate/core.ts, signOutAt). It also deletes this tab's copy of the
// agent's panel (client/agent/person-agent.ts keeps it for the tab's next page), and the quick search's record of the
// person's documents (client/common/quick-search.ts).

import { savePanel } from "../common/agent-panel";
import { clearOffline } from "../common/offline";
import { KEPT } from "../common/quick-search";
import { CLEAR_PATH, ORIGINS_KEY } from "../../shared/offline";

export default function signOut(C: { to: string; gate: string | null }): void {
  let origins: string[] = [];
  savePanel({ drawn: null });
  try {
    localStorage.removeItem(KEPT);
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
  const frame = (src: string) => {
    const f = document.createElement("iframe");
    f.hidden = true;
    f.src = src;
    document.body.append(f);
    return f;
  };
  for (const o of origins) frame(o + CLEAR_PATH);
  /** The documents' site signed out: its frame loaded, or two seconds passed. */
  const gateOut = () =>
    new Promise<void>((resolve) => {
      if (!C.gate) return resolve();
      frame(C.gate).addEventListener("load", () => resolve());
      setTimeout(resolve, 2000);
    });
  void Promise.all([cleared, clearOffline()])
    .then(gateOut)
    .then(() => {
      try {
        localStorage.removeItem(ORIGINS_KEY);
      } catch {
        /* no storage */
      }
      location.replace(C.to);
    });
}
