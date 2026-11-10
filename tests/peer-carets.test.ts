// Whose caret a tab shows (libs/text/ui/collab.ts: Collab.shown, activate), from the presence of everyone in the
// room: someone with several tabs open shows by the tab that they used last, and a tab never shows its own person's
// other tabs. Each tab here is a real Collab on a socket that never opens; the presence that the room would pass on
// goes from each replica's awareness to the others'.

import { expect, test } from "bun:test";
import { Collab, type EarlySocket } from "../libs/text/ui/collab";
import type { Author } from "../document/content";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "../shared/yjs-protocol";

const person = (name: string): Author => ({ user: name.toLowerCase(), name, color: "#2f6fec", kind: "person" });

/** The tabs of one room: what each says of itself reaches all the others, as the room passes presence on. */
function room() {
  const tabs: Collab[] = [];
  /** A tab of `me`'s, with its presence in the room and its caret in `where`; no tab of theirs was used yet. */
  const open = (me: Author, where: string) => {
    const socket = { readyState: WebSocket.CONNECTING, send() {}, close() {} } as unknown as EarlySocket;
    const tab = new Collab({
      onEvent: () => {},
      onRemote: () => {},
      onFiles: () => {},
      onPresence: () => {},
      onStatus: () => {},
      onStale: () => {},
      url: () => "ws://never-opened/",
      early: socket,
    });
    tab.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin == "room") return;
        const update = encodeAwarenessUpdate(tab.awareness, [...added, ...updated, ...removed]);
        for (const other of tabs) if (other != tab) applyAwarenessUpdate(other.awareness, update, "room");
      }
    );
    tab.join(me, "index.html", null);
    tab.awareness.setLocalState({ user: me, cursor: { path: "index.html", anchor: where, head: null }, active: 0 });
    // What the others said before it came.
    for (const other of tabs) applyAwarenessUpdate(tab.awareness, encodeAwarenessUpdate(other.awareness, [other.doc.clientID]), "room");
    tabs.push(tab);
    return tab;
  };
  return { open };
}

/** Who a tab shows, each with the place of the caret it draws for them. */
const shown = (tab: Collab) => tab.shown().map((p) => `${p.user.name} in ${(p.cursor as { anchor: string }).anchor}`);

test("your other tabs' carets aren't drawn, and someone with several tabs shows one caret, from the tab they used last", () => {
  const { open } = room();
  const a1 = open(person("Ada"), "h1"),
    a2 = open(person("Ada"), "figcaption"),
    b = open(person("Bo"), "li");
  // Ada uses her first tab, then her second: Bo sees one Ada each time, from the tab she used last.
  a1.activate();
  expect(shown(b)).toEqual(["Ada in h1"]);
  a2.activate();
  expect(shown(b)).toEqual(["Ada in figcaption"]);
  // Each of her tabs shows Bo's caret, and not her own other tab's.
  expect(shown(a1)).toEqual(["Bo in li"]);
  expect(shown(a2)).toEqual(["Bo in li"]);
  // She types in her first tab again: her caret moves to the tab she uses now.
  a1.activate();
  expect(shown(b)).toEqual(["Ada in h1"]);
  // A tab already the newest sends nothing more.
  const active = a1.awareness.getLocalState()?.active;
  a1.activate();
  expect(a1.awareness.getLocalState()?.active).toBe(active);
});
