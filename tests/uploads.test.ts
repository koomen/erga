// The uploads' state machine (client/common/uploads.ts): each state and event, with no request and no page. And what
// it says the alerts and the page show; and where a file's element is in a page's HTML.

import { expect, test } from "bun:test";
import * as U from "../client/common/uploads";

const MB = 1_000_000;
const file = (id: string, size = 120_000) => ({ id, name: id.slice(id.lastIndexOf("/") + 1), size });
/** The state after `events`, and the effects of the last one. */
function run(events: U.Event[], from: U.State = U.initial(100)): [U.State, U.Effect[]] {
  let state = from,
    effects: U.Effect[] = [];
  for (const e of events) [state, effects] = U.step(state, e);
  return [state, effects];
}
const states = (s: U.State) => s.files.map((u) => u.state.t).join(" ");
const kinds = (effects: U.Effect[]) => effects.map((f) => ("id" in f ? `${f.t} ${f.id}` : f.t));
const add = (...files: ReturnType<typeof file>[]): U.Event => ({ t: "add", batch: 1, files });

test("a file is checked, waits, sends and is done; the server that has its bytes already takes none", () => {
  let [s, fx] = run([add(file("images/a.jpg"))]);
  expect([states(s), kinds(fx)]).toEqual(["checking", ["check images/a.jpg", "show"]]);
  [s, fx] = run([{ t: "checked", id: "images/a.jpg", have: false }], s);
  expect([states(s), kinds(fx)]).toEqual(["sending", ["send images/a.jpg", "show"]]);
  [s, fx] = run([{ t: "progress", id: "images/a.jpg", received: 60_000, now: 1000 }], s);
  expect([s.files[0].received, kinds(fx)]).toEqual([60_000, ["paint images/a.jpg"]]);
  [s, fx] = run([{ t: "sent", id: "images/a.jpg" }], s);
  expect([states(s), kinds(fx)]).toEqual(["done", ["landed images/a.jpg", "show"]]);
  // Erga keeps a file's bytes by their hash: one it has is done at the check.
  [s, fx] = run([add(file("images/b.jpg")), { t: "checked", id: "images/b.jpg", have: true }]);
  expect([states(s), kinds(fx)]).toEqual(["done", ["landed images/b.jpg", "show"]]);
});

test("three files send at a time; the others wait for a slot, the oldest first", () => {
  const five = ["a", "b", "c", "d", "e"].map((n) => file(`images/${n}.jpg`));
  let [s, fx] = run([add(...five), ...five.map((f): U.Event => ({ t: "checked", id: f.id, have: false }))]);
  expect(states(s)).toBe("sending sending sending waiting waiting");
  [s, fx] = run([{ t: "sent", id: "images/b.jpg" }], s);
  expect([states(s), kinds(fx)]).toEqual(["sending done sending sending waiting", ["landed images/b.jpg", "send images/d.jpg", "show"]]);
});

test("a file over the limit is refused at the drop, before the server is asked; an admin's new limit sends it", () => {
  let [s, fx] = run([add(file("files/film.mov", 120 * MB), file("files/small.pdf"))]);
  expect([states(s), kinds(fx)]).toEqual(["refused checking", ["check files/small.pdf", "show"]]);
  expect(s.files[0].state).toEqual({ t: "refused", why: { t: "size", limitMb: 100 } });
  // (A limit that is still under the file changes nothing for it.)
  expect(states(run([{ t: "fixed", maxMb: 110 }], s)[0])).toBe("refused checking");
  [s, fx] = run([{ t: "fixed", maxMb: 150 }], s);
  expect([states(s), s.maxMb, kinds(fx)]).toEqual(["checking checking", 150, ["check files/film.mov", "show"]]);
  // The server's own refusal (no space, a folder at the path) stays, with its reason.
  [s] = run([{ t: "refused", id: "files/film.mov", why: { t: "space", limitGb: 5, used: 4_980_000_000 } }], s);
  expect(U.problemOf(s.files[0], true)).toMatchObject({
    title: "“film.mov” does not fit",
    detail: "the files here have 4.98 GB. This file does not fit in the 5 GB.",
    actions: [{ id: "remove", label: "Remove" }],
  });
});

test("with no connection the files wait, and start again by themselves when it is back", () => {
  let [s, fx] = run([
    add(file("images/a.jpg"), file("images/b.jpg"), file("images/c.jpg")),
    { t: "checked", id: "images/a.jpg", have: false },
    { t: "checked", id: "images/b.jpg", have: false },
    { t: "progress", id: "images/a.jpg", received: 40_000, now: 500 },
  ]);
  [s, fx] = run([{ t: "lost", id: "images/a.jpg" }], s);
  // The file that lost its answer waits, with what it had to show; the other request stops; the connection is tried again.
  expect([states(s), s.online, s.files[0].received]).toEqual(["waiting waiting checking", false, 40_000]);
  expect(kinds(fx)).toEqual(["abort images/b.jpg", "again", "show"]);
  expect(fx).toContainEqual({ t: "again", ms: U.AGAIN_MS });
  // (A second request with no answer asks for no second timer.)
  expect(kinds(run([{ t: "lost", id: "images/c.jpg" }], s)[1])).toEqual(["show"]);
  // No file starts while it is down.
  expect(states(run([{ t: "checked", id: "images/c.jpg", have: false }], s)[0])).toBe("waiting waiting waiting");
  [s, fx] = run([{ t: "online" }], s);
  expect([states(s), s.files[0].received]).toEqual(["sending sending checking", 0]);
  expect(kinds(fx)).toEqual(["check images/c.jpg", "send images/a.jpg", "send images/b.jpg", "show"]);
});

test("a file the server fails goes again, three times in all; then it says so, and Try again starts it afresh", () => {
  let [s, fx] = run([add(file("files/map.pdf")), { t: "checked", id: "files/map.pdf", have: false }]);
  [s, fx] = run([{ t: "failed", id: "files/map.pdf", why: "The server answered 500." }], s);
  expect([states(s), s.files[0].tries, kinds(fx)]).toEqual(["sending", 1, ["send files/map.pdf", "show"]]);
  // Its write waits no more there (it took too long): it is written again.
  [s, fx] = run([{ t: "failed", id: "files/map.pdf", why: "No write waits.", gone: true }], s);
  expect([states(s), kinds(fx)]).toEqual(["checking", ["check files/map.pdf", "show"]]);
  [s, fx] = run(
    [
      { t: "checked", id: "files/map.pdf", have: false },
      { t: "failed", id: "files/map.pdf", why: "The server answered 500." },
    ],
    s
  );
  expect(s.files[0].state).toEqual({ t: "failed", why: "The server answered 500." });
  expect(U.problemOf(s.files[0], false)).toMatchObject({
    title: "The server did not take “map.pdf”",
    actions: [
      { id: "retry", label: "Try again", primary: true },
      { id: "remove", label: "Remove" },
    ],
  });
  [s, fx] = run([{ t: "retry", id: "files/map.pdf" }], s);
  expect([states(s), s.files[0].tries, kinds(fx)]).toEqual(["checking", 0, ["check files/map.pdf", "show"]]);
});

test("cancel in each state before done: the request stops, and the element leaves the document", () => {
  const start = run([
    add(file("images/a.jpg"), file("images/b.jpg"), file("files/c.mov", 120 * MB)),
    { t: "checked", id: "images/a.jpg", have: false },
  ])[0];
  expect(states(start)).toBe("sending checking refused");
  // Sending: its request stops too.
  expect(kinds(run([{ t: "cancel", id: "images/a.jpg" }], start)[1])).toEqual(["abort images/a.jpg", "remove images/a.jpg", "show"]);
  // Checking: the answer that comes after takes the write back again.
  let [s, fx] = run([{ t: "cancel", id: "images/b.jpg" }], start);
  expect(kinds(fx)).toEqual(["remove images/b.jpg", "show"]);
  [s, fx] = run([{ t: "checked", id: "images/b.jpg", have: false }], s);
  expect([states(s), kinds(fx)]).toEqual(["sending cancelled refused", ["remove images/b.jpg"]]);
  // Refused: Remove is a cancel.
  expect(kinds(run([{ t: "cancel", id: "files/c.mov" }], start)[1])).toEqual(["remove files/c.mov", "show"]);
  // Done: nothing to cancel.
  expect(
    run(
      [
        { t: "sent", id: "images/a.jpg" },
        { t: "cancel", id: "images/a.jpg" },
      ],
      start
    )[1]
  ).toEqual([]);
  // Cancel all: each file of the batch that is on its way, not the one that was refused.
  [s, fx] = run([{ t: "cancel-batch", batch: 1 }], start);
  expect([states(s), kinds(fx)]).toEqual([
    "cancelled cancelled refused",
    ["abort images/a.jpg", "remove images/a.jpg", "remove images/b.jpg", "show"],
  ]);
});

test("the alerts: one for a batch, with a row for each file, the time left from the last three seconds; a file that can't go in is a problem of its own", () => {
  let [s] = run([
    add(file("images/harbor.jpg", 86_000), file("images/sunrise.jpg", 120_000), file("files/film.mov", 120 * MB)),
    { t: "checked", id: "images/harbor.jpg", have: false },
    { t: "checked", id: "images/sunrise.jpg", have: false },
    { t: "progress", id: "images/sunrise.jpg", received: 0, now: 0 },
    { t: "progress", id: "images/sunrise.jpg", received: 60_000, now: 2000 },
    { t: "sent", id: "images/harbor.jpg" },
  ]);
  const { alerts, ended } = U.alertsOf(s, 2000, true);
  expect(ended).toEqual([]);
  expect(alerts.map((a) => a.key)).toEqual(["upload:1", "upload-file:files/film.mov"]);
  expect(alerts[0]).toMatchObject({
    kind: "progress",
    title: "Uploading 2 files",
    line: "2 files · 2 s left",
    head: "2 files · 2 s left",
    by: { name: "you" },
    actions: [{ id: "cancel-all", label: "Cancel all" }],
    rows: [
      { id: "images/harbor.jpg", title: "harbor.jpg", detail: "86 KB · uploaded", state: "done", p: 1, actions: [] },
      {
        id: "images/sunrise.jpg",
        title: "sunrise.jpg",
        detail: "120 KB · 2 s left",
        state: "running",
        p: 0.5,
        actions: [{ id: "cancel", label: "×" }],
      },
    ],
  });
  expect(alerts[1]).toMatchObject({
    kind: "error",
    title: "“film.mov” is too large",
    detail: "it has 120 MB. The limit here is 100 MB.",
    actions: [
      { id: "raise", label: "Raise the limit to 150 MB", primary: true },
      { id: "remove", label: "Remove" },
    ],
  });
  // Someone who is no admin can only remove it. A file over the most a limit can be has no "Raise".
  expect(U.problemOf(s.files[2], false)!.actions).toEqual([{ id: "remove", label: "Remove" }]);
  expect([U.raiseTo(120 * MB), U.raiseTo(150 * MB), U.raiseTo(501 * MB)]).toEqual([150, 150, null]);
  // On the page: each file that is not there yet, by its path.
  expect(U.pageOf(s, 2000, true)).toEqual([
    { path: "images/sunrise.jpg", p: 0.5, text: "2 s left" },
    {
      path: "files/film.mov",
      p: 0,
      text: "",
      problem: { lead: "Too large.", text: "film.mov has 120 MB. The limit here is 100 MB.", actions: alerts[1].actions! },
    },
  ]);
  // One file alone: the line has its name. With no connection, it says so.
  [s] = run([add(file("files/demo.mov", 64 * MB)), { t: "checked", id: "files/demo.mov", have: false }]);
  expect(U.alertsOf(s, 0, false).alerts[0]).toMatchObject({ title: "Uploading demo.mov", line: "demo.mov", head: "1 file", actions: [] });
  [s] = run([{ t: "lost", id: "files/demo.mov" }], s);
  expect(U.alertsOf(s, 0, false).alerts[0]).toMatchObject({ line: "1 file · waiting for the connection" });
  expect(U.pageOf(s, 0, false)[0].text).toBe("waiting for the connection");
  // The batch is over when no file of it is on its way: the line says how many went in, and its files leave the state.
  [s] = run([{ t: "online" }, { t: "sent", id: "files/demo.mov" }], s);
  expect(U.alertsOf(s, 0, false)).toEqual({ alerts: [], ended: [{ key: "upload:1", title: "1 file uploaded" }] });
  expect(U.swept(s).files).toEqual([]);
  [s] = run([add(file("images/a.jpg")), { t: "cancel", id: "images/a.jpg" }]);
  expect(U.alertsOf(s, 0, false).ended).toEqual([{ key: "upload:1" }]);
});

test("sizes and an agent's file in a few words", () => {
  expect([86_093, 606_962, 1_500_000, 64 * MB, 4_980_000_000].map(U.sizeText)).toEqual(["86 KB", "607 KB", "1.5 MB", "64 MB", "4.98 GB"]);
  const f = { size: 607_000, login: "ada", name: "Ada", via: "a shared agent (Claude (laptop))", until: 0, got: 212_450 };
  expect(U.agentAlert("images/growth-chart.png", f, 78_910, true)).toMatchObject({
    key: "upload-agent:images/growth-chart.png",
    title: "Uploading growth-chart.png",
    line: "growth-chart.png · 5 s left",
    head: "1 file · 5 s left",
    by: { name: "Claude, your agent", agent: true },
    actions: [{ id: "cancel", label: "Cancel" }],
    rows: [{ title: "growth-chart.png", detail: "607 KB · 5 s left", state: "running" }],
  });
  expect(U.agentAlert("a.png", { ...f, via: "their agent", got: undefined }, 0, false)).toMatchObject({
    line: "a.png",
    by: { name: "Ada’s agent" },
    rows: [{ state: "waiting", p: 0 }],
  });
});

test("a file with no place on the page: a problem that names where the file is, with the agent's help and its address", () => {
  expect(U.noPlace("images/sunrise.jpg", "", "index.html", { x: 660, y: 420 })).toEqual({
    key: "upload-place:images/sunrise.jpg",
    kind: "error",
    source: "upload",
    title: "“sunrise.jpg” has no place on this page",
    detail: "it is in this document’s files: images/sunrise.jpg",
    fix: "The file images/sunrise.jpg of this document was dropped on the page index.html, at the point (660, 420) of its window, which has no place of its own for it. Put it on the page where it fits.",
    fixLabel: "Ask the agent to place it",
    actions: [{ id: "copy", label: "Copy its address" }],
  });
  // The page's own edit refused it: its reason shows to the person. It is not in the agent's request (the page wrote it).
  const refused = U.noPlace("images/a.png", "There's no slide 9: the deck has slides 1 to 2.", "deck.html");
  expect(refused.detail).toBe(
    "it is in this document’s files: images/a.png. The page gave this reason: There's no slide 9: the deck has slides 1 to 2."
  );
  expect(refused.fix).toBe(
    "The file images/a.png of this document was dropped on the page deck.html, which has no place of its own for it. Put it on the page where it fits."
  );
});

test("a file's element in a page's HTML: an image in a paragraph of its own goes with it, an image in a line and a link alone", () => {
  const IMG = `<img style="max-width: 100%; height: auto" src="images/a%20b.jpg" width="2400" height="1600" alt="a b.jpg">`;
  const cut = (html: string, href: string) => {
    const at = U.elementOf(html, href);
    return at ? html.slice(0, at.from) + html.slice(at.to) : null;
  };
  expect(cut(`<p>One.</p>\n  <p style="text-align: center">${IMG}</p>\n  <p>Two.</p>`, "images/a%20b.jpg")).toBe(
    `<p>One.</p>\n  <p>Two.</p>`
  );
  expect(cut(`<p>One ${IMG} two.</p>`, "images/a%20b.jpg")).toBe(`<p>One  two.</p>`);
  expect(cut(`<p>See <a href="../files/q&amp;a.pdf">q&amp;a.pdf</a>.</p>`, "../files/q&a.pdf")).toBe(`<p>See .</p>`);
  // (Another file's element stays; one the person took out is not there.)
  expect(cut(`<p>${IMG}</p>`, "images/a.jpg")).toBeNull();
});
