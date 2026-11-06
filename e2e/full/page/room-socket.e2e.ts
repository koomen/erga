// The page editor's room socket (libs/text/ui/collab.ts, room-phase.ts): out of the editor while the socket waits to
// reconnect, no socket opens later that nothing owns; a deleted document says so, and its socket stops trying.
import { writeFileSync } from "node:fs";
import { expect, servers, test, until, type Tab } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";
import { idOf, runTool } from "../../helpers/tools";

await servers.main();

/** Every socket each frame of the tab opens, with when it closed. */
async function watchSockets(tab: Tab) {
  await tab.page.addInitScript(() => {
    const sockets: (WebSocket & { closedAt?: number })[] = ((window as any).__sockets = []);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        this.addEventListener("close", () => ((this as any).closedAt = Date.now()));
      }
    } as typeof WebSocket;
  });
}

/** The room sockets the page editor's frame made: each one's state, and when the last one closed. */
const roomSockets = (ed: Editor) =>
  ed.frame<{ states: number[]; lastClosed: number }>(
    `(() => { const s = (window.__sockets ?? []).filter((w) => w.url.includes("/api/room")); return { states: s.map((w) => w.readyState), lastClosed: Math.max(0, ...s.map((w) => w.closedAt ?? 0)) }; })()`
  );

/** The note in the tab's corner, or null. */
const note = (ed: Editor) => ed.eval<string | null>(`document.querySelector(".erga-live-note")?.textContent ?? null`);

/** Out of the editor or back in, with the pencil. */
async function pencil(ed: Editor) {
  const was = await ed.eval<boolean>(`document.body.classList.contains("erga-editing")`);
  await ed.page.click(was ? "body.erga-editing #btn-edit" : ".erga-edit-button");
  await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("erga-editing")`)).toBe(!was);
}

test("edit, the server drops, view, edit: one room socket, and a change from elsewhere shows once", { timeout: 60_000 }, async ({
  tab,
}) => {
  await watchSockets(tab);
  const ed = await openEditor(tab, await servers.main(), "multi", { allowErrors: true });
  // (No edit before the drop: the viewer would load the page again for it, on the way out, and the old socket with it.)
  // The server drops: the socket fails to come back a few times, and waits longer each time (up to 2.5 s).
  await ed.page.context().setOffline(true);
  await until(
    async () => {
      const s = await roomSockets(ed);
      return s.states.length >= 6 && s.states.every((r) => r == WebSocket.CLOSED);
    },
    15_000,
    "the socket failed to come back five times"
  );
  await pencil(ed);
  const { lastClosed, states } = await roomSockets(ed);
  await ed.page.context().setOffline(false);
  await pencil(ed);
  await ed.loaded();
  // The old socket's wait (at most 2.5 s after its last failure) is over: a socket it opened would be here by now.
  await until(async () => Date.now() > lastClosed + 3000, 10_000, "the old socket's wait is over");
  await until(async () => (await roomSockets(ed)).states.at(-1) == WebSocket.OPEN, 10_000, "the editor's new socket opens");
  expect((await roomSockets(ed)).states.length - states.length, "the editor's own socket, and no other").toBe(1);

  writeFileSync(ed.file, ed.disk().replace("<h1>Field guide</h1>", "<h1>Field guide, revised</h1>"));
  await expect.poll(() => ed.textOf("h1"), { timeout: 10_000 }).toBe("Field guide, revised");
  await ed.settle();
  expect(await ed.textOf("h1")).toBe("Field guide, revised");
  expect((await ed.frame<string>("ergaFrame.page.state.doc.toString()")).split("revised").length, "the change came in once").toBe(2);
});

test("the document is deleted while it's open in the editor: the note says so, and the socket stops trying", async ({ tab }) => {
  await watchSockets(tab);
  const server = await servers.main();
  const ed = await openEditor(tab, server, "multi", { allowErrors: true });
  expect((await runTool(server.root, "delete_document", { document: await idOf(ed.address) })).status).toBe(200);
  await expect.poll(() => note(ed), { timeout: 10_000 }).toBe("This document was deleted.");
  const made = (await roomSockets(ed)).states.length;
  // Longer than the socket's longest wait (2.5 s): it would have tried again by now.
  const at = Date.now();
  await until(async () => Date.now() > at + 3000, 5000, "a while");
  expect((await roomSockets(ed)).states.length, "no new socket").toBe(made);
  expect(await note(ed)).toBe("This document was deleted.");
});
