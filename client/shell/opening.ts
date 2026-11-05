// The shell's wait for the room's hello (main.ts). A document can be slow to open: the server can wait seconds on its
// database before it answers. The welcome then says that the document is still opening, and after a minute it also
// offers a reload, but the wait goes on. Only the server's word that there's no such document ends it: the start's
// 404 (GET /api/start). A socket that never gets in says nothing either way (the browser gives no status for it).

import type { Hello } from "../../document/api";
import { ms } from "../../libs/text/ui/timescale";
import { $ } from "./shell";

/** How long the hello may take before the welcome says the document is still opening, and before it offers a reload. */
const SLOW_MS = 3000,
  STUCK_MS = 60_000;

/**
 * The welcome, over the page, with these paragraphs; and a Reload button, if `reload`. The editor's layer shows from
 * now on (ergaShell.ready): until then the viewer's pencil only pulses, and the welcome can't be seen.
 */
function say(lines: string[], reload = false): void {
  const w = $("welcome");
  w.hidden = false;
  w.classList.add("blocking");
  window.ergaShell?.ready();
  w.innerHTML = `<div>${lines.map((l) => `<p>${l}</p>`).join("")}${reload ? `<p><button type="button" id="open-reload">Reload</button></p>` : ""}</div>`;
  if (reload) $("open-reload").addEventListener("click", () => location.reload());
}

/**
 * The room's first hello, however long it takes; null if there's none to wait for (the welcome says why):
 * `missing`, the host said there's no such document; or the room refused the socket, and the host didn't say that.
 */
export async function awaitHello(hello: Promise<Hello>, missing: Promise<boolean>): Promise<Hello | null> {
  const opening = "The document is still opening.";
  const slow = setTimeout(() => say([opening, "The server is slow to answer. This page waits for it."]), ms(SLOW_MS));
  const stuck = setTimeout(() => say([opening, "The server hasn't answered for a minute."], true), ms(STUCK_MS));
  const first = await new Promise<Hello | "missing" | "refused">((resolve) => {
    hello.then(resolve, () => void missing.then((m) => resolve(m ? "missing" : "refused")));
    void missing.then((m) => m && resolve("missing"));
  });
  clearTimeout(slow);
  clearTimeout(stuck);
  if (first == "missing") say(["Nothing to edit here.", `Open one from <a href="/docs">your documents</a>.`]);
  else if (first == "refused") say(["The document didn't open: the server refused the connection."], true);
  else {
    $("welcome").hidden = true;
    $("welcome").classList.remove("blocking");
    $("welcome").textContent = "";
    return first;
  }
  return null;
}
