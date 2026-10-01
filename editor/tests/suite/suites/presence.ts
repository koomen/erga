// Who's here and where: awareness reaches everyone, carets stay put as text
// moves, people who leave (politely or not) disappear, and every edit is
// attributed to whoever made it.

import { Participant } from "../client";
import { expect, sleep, until, type Test } from "../harness";

export const presence: Test[] = [
  {
    name: "a caret reaches others and stays on its word as text is inserted before it",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      const at = a.str().indexOf("Launch");
      a.setCursor(at);
      await until(() => b.others().some((o) => o.user.name == "Ada" && o.cursor), 3000, "Bo sees Ada's caret");
      const ada = () => b.others().find((o) => o.user.name == "Ada")!;
      expect(b.resolve(ada().cursor!.anchor) == at, "it resolves to the same place");
      b.insert(0, "<!-- 12345 -->");
      await until(() => a.str().startsWith("<!-- 12345 -->"), 3000, "Ada has Bo's insert");
      expect(b.resolve(ada().cursor!.anchor) == at + 14, "the caret moved with its word");
      expect(b.str().slice(b.resolve(ada().cursor!.anchor)!).startsWith("Launch"), "still before 'Launch'");
    },
  },
  {
    name: "someone who leaves politely disappears at once",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => b.destroy());
      await until(() => b.others().some((o) => o.user.name == "Ada"), 3000, "Bo sees Ada");
      const t0 = performance.now();
      a.destroy();
      await until(() => !b.others().some((o) => o.user.name == "Ada"), 3000, "Ada disappears for Bo");
      ctx.metric("gone after", performance.now() - t0);
    },
  },
  {
    name: "someone whose connection just drops disappears too",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      await until(() => b.others().some((o) => o.user.name == "Ada"), 3000, "Bo sees Ada");
      const t0 = performance.now();
      a.sever();
      // The server sees the socket close and removes her; awareness timeouts (30s) are the backstop.
      await until(() => !b.others().some((o) => o.user.name == "Ada"), 35_000, "Ada disappears for Bo");
      ctx.metric("gone after", performance.now() - t0);
    },
  },
  {
    name: "every edit is attributed: insertions, pure deletions, publishes",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b, c] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo"), await Participant.join(d, "Cy")];
      ctx.defer(() => { a.destroy(); b.destroy(); c.destroy(); });
      a.insertAfter("<h1>", "A");
      await until(() => c.seen.length >= 1, 3000, "Cy sees Ada's insert");
      await until(() => b.str().includes("<h1>A"), 3000, "Bo has it");
      b.delete(b.str().indexOf("Launch"), 6);
      await until(() => c.seen.length >= 2, 3000, "Cy sees Bo's deletion");
      await until(async () => (await d.stored(d.path))?.text == c.str(), 5000, "stored catches up");
      const now = (await d.stored(d.path))!;
      await d.push(d.path, now.text.replace("</h1>", " (pub)</h1>"), now.etag);
      await until(() => c.seen.length >= 3, 3000, "Cy sees the publish");
      const who = c.seen.map((x) => x.author);
      expect(who[0] == "Ada" && who[1] == "Bo" && c.seen[2].kind == "disk", "attributed to Ada, Bo, storage", c.seen);
    },
  },
  {
    name: "thirty people: everyone sees everyone, and the right ones leave",
    timeoutMs: 90_000,
    async run(ctx) {
      const d = await ctx.doc();
      const n = ctx.long ? 60 : 30;
      const ps: Participant[] = [];
      for (let i = 0; i < n; i++) ps.push(await Participant.join(d, `P${i}`));
      ctx.defer(() => ps.forEach((p) => p.destroy()));
      await until(() => ps.every((p) => p.others().length == n - 1), 10_000, `each sees ${n - 1} others`, () => ps.map((p) => p.others().length));
      const leaving = ps.splice(0, n / 2);
      leaving.forEach((p) => p.destroy());
      await until(() => ps.every((p) => p.others().length == ps.length - 1), 10_000, "the rest see each other only", () => ps.map((p) => p.others().length));
      await sleep(100);
    },
  },
];
