// Nothing is lost when people leave, when the room goes idle (a Durable
// Object being evicted), or when the server restarts or dies. Tabs that
// stayed open through a restart reconnect and merge without doubling the
// document; a tab whose history the room no longer has is refused.

import * as Y from "yjs";
import { converged, Participant } from "../client";
import { expect, sleep, until, type Test } from "../harness";

const STORE_MS = 5000;

export const durability: Test[] = [
  {
    name: "everyone leaves; the next person in gets every edit",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      a.insertAfter("<h1>", "KEPT ");
      await until(async () => (await d.stored(d.path))?.text.includes("KEPT "), STORE_MS, "stored");
      a.destroy();
      await sleep(300);
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      expect(b.str().includes("<h1>KEPT "), "Bo gets Ada's edit");
    },
  },
  {
    name: "the room survives going idle (eviction)",
    timeoutMs: 200_000,
    async run(ctx) {
      // Long enough for a hosted room to be evicted with --long (Durable Objects idle out after ~70s).
      const idle = ctx.long ? 75_000 : 2_000;
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      const epoch = a.epoch;
      a.insertAfter("<h1>", "IDLE ");
      await sleep(600);
      a.destroy();
      await sleep(idle);
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      expect(b.str().includes("<h1>IDLE "), "the edit is still there");
      expect(b.epoch == epoch, "the room kept its history (same epoch)", { before: epoch, after: b.epoch });
      ctx.metric("idle", idle);
    },
  },
  {
    name: "a graceful restart loses nothing, even edits made just before it",
    needs: ["restart"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      a.insertAfter("<h1>", "JUST-IN-TIME ");
      await sleep(30); // well inside the write delay
      a.destroy();
      await d.restart!("graceful");
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      expect(b.str().includes("JUST-IN-TIME "), "the edit survived the restart");
      expect((await d.stored(d.path))?.text.includes("JUST-IN-TIME "), "and was written on the way out");
    },
  },
  {
    name: "a tab open through a restart, editing while the server is down, merges without doubling",
    needs: ["restart"],
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      a.insertAfter("<h1>", "BEFORE ");
      await converged([a, b], 3000);
      await d.restart!("graceful", async () => {
        await until(() => !a.connected, 3000, "Ada notices the server is gone");
        a.insertAfter("</h1>", "<p>WHILE-DOWN</p>");
        b.insertAfter("<h1>", "BO-OFFLINE ");
      });
      const text = (await converged([a, b], 15_000, "both reconnect and converge"))[d.path];
      expect(text.includes("WHILE-DOWN") && text.includes("BO-OFFLINE ") && text.includes("BEFORE "), "every edit is there", text.slice(0, 300));
      expect(text.split("<h1>").length == 2 && text.split("BEFORE ").length == 2, "nothing is doubled", text.slice(0, 400));
      await until(async () => (await d.stored(d.path))?.text == text, STORE_MS, "storage has the merge");
    },
  },
  {
    name: "a killed server: edits held by open tabs come back, the document isn't doubled",
    needs: ["kill"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      a.insertAfter("<h1>", "SAVED ");
      await until(async () => (await d.stored(d.path))?.text.includes("SAVED "), STORE_MS, "stored");
      await sleep(200);
      a.insertAfter("<h1>", "UNSAVED "); // still inside the write delay when the server dies
      await sleep(20);
      await d.restart!("kill");
      await until(() => a.provider.synced && a.connected || a.refused, 10_000, "Ada reconnects or is refused");
      expect(!a.refused, "the room kept its history, so Ada isn't refused");
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      const text = (await converged([a, b], 10_000))[d.path];
      expect(text.includes("SAVED ") && text.includes("UNSAVED "), "Ada's unsaved edit came back with her", text.slice(0, 200));
      expect(text.split("<h1>").length == 2, "nothing is doubled", text.slice(0, 300));
    },
  },
  {
    name: "a room that lost its saved history starts afresh from the files and refuses old tabs",
    needs: ["kill"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      a.insertAfter("<h1>", "STORED ");
      await until(async () => (await d.stored(d.path))?.text.includes("STORED "), STORE_MS, "stored");
      const epoch = a.epoch;
      await d.restart!("lose-state", async () => { await until(() => !a.connected, 3000, "Ada notices"); a.insertAfter("<h1>", "LOST "); });
      await until(() => a.refused, 10_000, "Ada's tab is refused on reconnect");
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      expect(b.epoch != epoch, "the room is in a new epoch");
      expect(b.str().includes("STORED ") && !b.str().includes("LOST "), "it holds what was stored, not the refused tab's edit", b.str().slice(0, 200));
      expect(b.str().split("<h1>").length == 2, "nothing is doubled");
    },
  },
  {
    name: "a replica from another history is refused, never merged",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      // A replica holding the same text under an unrelated history (as a tab
      // would after a room lost its state and started a new epoch).
      const foreign = new Y.Doc();
      foreign.getMap("room").set("epoch", "some-other-epoch");
      const t = new Y.Text(); t.insert(0, a.str()); foreign.getMap("files").set(d.path, t);
      const x = await Participant.join(d, "Stale", { epoch: "some-other-epoch", ydoc: foreign });
      ctx.defer(() => x.destroy());
      expect(x.refused, "the room refuses it");
      await sleep(500);
      expect(a.str().split("<h1>").length == 2, "the room's text isn't doubled");
    },
  },
];
