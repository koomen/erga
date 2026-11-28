// Undo of the changes of a user's agents in a document (document/api/host.ts, /api/undo; document/room/participants.ts): each
// call of an agent is one step, taken back last first, and nobody else's edit goes with it. Each agent of the user is
// a participant with a history of its own, and Undo takes back the newest step of them all. One document on memory
// (tests/helpers/files-fixture.ts); the agents' calls come as the server sends them.

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { authorOf, files, introduce } from "../document/model/content";
import type { Author } from "../shared/author";
import type { Room } from "../document/room/room";
import { joinLocal } from "./helpers/join-local";
import { VIA } from "../shared/attribution";
import { Awareness } from "../shared/yjs-protocol";
import { setup } from "./helpers/files-fixture";
import { until } from "./helpers/until";

const PAGE = "<h1>Launch notes</h1>\n<p>Where the leads go.</p>\n";

test("undo takes back exactly the agent's last change, then the one before", async () => {
  const { doc } = await setup();
  await doc.write({ "index.html": PAGE }, [], { login: "ada" });
  /** A request of Ada's to the document: from her page, or (agent) from her own agent, as the server sends its tool calls. */
  const asAda = async <T>(path: string, init: { method?: string; body?: unknown; agent?: boolean; via?: string } = {}) => {
    const via = init.via ?? VIA.agent;
    const r = await doc.handle(
      new Request(`http://doc${path}`, {
        method: init.method ?? "GET",
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        headers: {
          "content-type": "application/json",
          "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
          "x-erga-who": JSON.stringify(init.agent ? { login: "ada", via } : { login: "ada" }),
          ...(init.agent ? { "x-erga-via": JSON.stringify(via), ...(init.via ? {} : { "x-erga-turn": "turn-1" }) } : {}),
        },
      })
    );
    return (await r.json()) as T;
  };
  const edit = (oldText: string, newText: string, via?: string) =>
    asAda<{ ok: boolean }>("/api/operations/edit", {
      method: "POST",
      agent: true,
      via,
      body: { path: "index.html", edits: [{ oldText, newText }] },
    });
  const undo = () => asAda<{ ok: boolean }>("/api/undo", { method: "POST" });

  // Bo, in the room: his own replica, which hears each change and who made it.
  const { room } = await (doc as unknown as { room(): Promise<{ room: Room }> }).room();
  const bo = new Y.Doc();
  const me: Author = { user: "bo", name: "Bo", color: "#2f6fec", kind: "person" };
  joinLocal(room, bo, new Awareness(bo));
  const text = () => files(bo).get("index.html");
  await until(() => text()?.toString() == PAGE);
  introduce(bo, me);
  const seen: (string | undefined)[] = [];
  text()!.observe((_e, tr) => {
    if (!tr.local) seen.push(authorOf(bo, tr)?.name);
  });
  const str = () => text()!.toString();

  expect((await edit("<h1>Launch notes", "<h1>Launch notes ONE")).ok).toBe(true);
  expect((await edit("Where the leads go.", "Where the leads go. TWO")).ok).toBe(true);
  await until(() => str().includes("ONE") && str().includes("TWO"));
  // The agent's turn ends, as the server says when its run is done: the lock that its edits held on the source goes.
  expect((await asAda<{ ok: boolean }>("/api/turn-done", { method: "POST", agent: true })).ok).toBe(true);
  // Where its turn ended is its own: "last_turn" is the default start of its diff. Another agent of Ada's has none here.
  type Answer = { ok: boolean; content?: { text: string }[]; error?: string };
  const diff = (via?: string) => asAda<Answer>("/api/operations/diff_versions", { method: "POST", agent: true, via, body: {} });
  expect((await diff()).content?.[0].text).toMatch(/^No changes from v\d+ \(where your last turn ended\) to current/);
  expect((await diff(VIA.token("CI"))).error).toMatch(/^You have no last turn in this document yet/);
  bo.transact(() => text()!.insert(str().indexOf("<h1>") + 4, "BO "));
  await until(() => room.text("index.html")?.includes("BO "));
  // Two changes to undo: the agent's, not Bo's.
  // (Both in her agent's turn: the document marked it at the first call that had its id.)
  expect(await asAda<object>("/api/undo")).toMatchObject({ count: 2, redo: 0, turn: { changes: 2, files: ["index.html"] } });
  const heard = seen.length;
  expect((await undo()).ok).toBe(true);
  await until(() => !str().includes("TWO"));
  // The earlier change and Bo's edit stay; the undo is the agent's.
  expect(str()).toBe("<h1>BO Launch notes ONE</h1>\n<p>Where the leads go.</p>\n");
  expect(seen.slice(heard)).toEqual(["Ada, via their agent"]);
  // Then the first.
  expect((await undo()).ok).toBe(true);
  await until(() => !str().includes("ONE"));
  expect(str()).toBe("<h1>BO Launch notes</h1>\n<p>Where the leads go.</p>\n");
  // Nothing more to undo; and the document has what Bo has.
  expect((await undo()).ok).toBe(false);
  expect(room.text("index.html")).toBe(str());

  // Another agent of Ada's (one with her token) is another participant: its edit has its own name, and Undo takes
  // back the newest change of the two, whoever's.
  const CI = VIA.token("CI");
  expect((await asAda<{ ok: boolean }>("/api/redo", { method: "POST" })).ok).toBe(true);
  await until(() => str().includes("ONE"));
  expect((await edit("Where the leads go.", "Where the leads go. CI", CI)).ok).toBe(true);
  await until(() => str().includes("CI"));
  expect(seen.at(-1)).toBe(`Ada, via ${CI}`);
  expect(await asAda<object>("/api/undo")).toMatchObject({ count: 2, redo: 1 });
  expect((await undo()).ok).toBe(true);
  await until(() => !str().includes("CI"));
  expect(str()).toBe("<h1>BO Launch notes ONE</h1>\n<p>Where the leads go.</p>\n");
  expect(seen.at(-1)).toBe(`Ada, via ${CI}`);
  // Without source locks, undoing the earlier agent's change succeeds immediately too.
  expect((await undo()).ok).toBe(true);
  await until(() => !str().includes("ONE"));
  expect(str()).toBe("<h1>BO Launch notes</h1>\n<p>Where the leads go.</p>\n");
});
