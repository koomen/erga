// Undo of a person's agent's changes in a document (document/host.ts, /api/agent/undo; agents/document/session.ts):
// each of the agent's tool calls is one step, taken back last first, and nobody else's edit goes with it. One document
// on memory (tests/helpers/files-fixture.ts); the agent's calls come as the server sends them for a person's own agent.

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { authorOf, files, introduce, type Author } from "../document/content";
import { joinLocal, type Room } from "../document/room";
import { VIA } from "../shared/attribution";
import { Awareness } from "../shared/yjs-protocol";
import { setup } from "./helpers/files-fixture";
import { until } from "./helpers/until";

const PAGE = "<h1>Launch notes</h1>\n<p>Where the leads go.</p>\n";

test("undo takes back exactly the agent's last change, then the one before", async () => {
  const { doc } = await setup();
  await doc.publish({ "index.html": PAGE }, [], "ada");
  /** A request of Ada's to the document: from her page, or (agent) from her own agent, as the server sends its tool calls. */
  const asAda = async <T>(path: string, init: { method?: string; body?: unknown; agent?: boolean } = {}) => {
    const r = await doc.handle(
      new Request(`http://doc${path}`, {
        method: init.method ?? "GET",
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        headers: {
          "content-type": "application/json",
          "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
          "x-erga-who": JSON.stringify(init.agent ? { login: "ada", via: VIA.agent } : { login: "ada" }),
          ...(init.agent ? { "x-erga-agent": "1", "x-erga-via": JSON.stringify(VIA.agent) } : {}),
        },
      })
    );
    return (await r.json()) as T;
  };
  const edit = (oldText: string, newText: string) =>
    asAda<{ ok: boolean }>("/api/tools/edit", { method: "POST", agent: true, body: { path: "index.html", edits: [{ oldText, newText }] } });
  const undo = () => asAda<{ ok: boolean }>("/api/agent/undo", { method: "POST" });

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
  expect((await asAda<{ ok: boolean }>("/api/agent/done", { method: "POST", agent: true })).ok).toBe(true);
  bo.transact(() => text()!.insert(str().indexOf("<h1>") + 4, "BO "));
  await until(() => room.text("index.html")?.includes("BO "));
  // Two changes to undo: the agent's, not Bo's.
  expect((await asAda<{ count: number }>("/api/agent/undo")).count).toBe(2);
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
});
