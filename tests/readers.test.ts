// Who reads a document and the readers' agent (server/operations/readers.ts): share_document decides in full before it
// writes, so a refused call leaves the document as it was; and the agent stays off once "*" stops.

import { expect, test } from "bun:test";
import { Directory } from "../server/directory/index.ts";
import { allTools, runTool } from "../agents/tools";
import { type Caller, OperationError } from "../server/operations/index.ts";
import { readersStep } from "../server/operations/readers.ts";
import { memory } from "./helpers/memory-sql";

const run = (ctx: Caller, args: Record<string, unknown>) =>
  runTool(allTools().find((t) => t.name == "share_document")!, args, ctx) as Promise<any>;

async function plan() {
  const dir = new Directory(memory(), { defaults: { public_sharing: true }, admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "bo");
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  return { dir, who: { login: "ada" } };
}

test('share "*" with reader_agent on, in one call: refused, and the document stays private', async () => {
  const ada = await plan();
  const e = await run(ada, { document: "plan", login: "*", role: "viewer", reader_agent: true }).catch((e: OperationError) => e);
  expect(e).toBeInstanceOf(OperationError);
  expect((e as OperationError).status).toBe(409);
  expect(await ada.dir.isPublic("aaaaaaaa")).toBe(false);
});

test('the readers\' agent goes off when "*" starts, and stays off when "*" stops', async () => {
  const ada = await plan();
  await run(ada, { document: "plan", login: "bo", role: "viewer", reader_agent: true });
  expect((await ada.dir.readerOptions("aaaaaaaa")).agent).toBe(true);
  await run(ada, { document: "plan", login: "*", role: "viewer" });
  expect((await ada.dir.readerOptions("aaaaaaaa")).agent).toBe(false);
  const r = await run(ada, { document: "plan", login: "*", role: "none" });
  expect([r.readerAgent, r.anyoneWithLink]).toEqual([false, false]);
  // Stop "*" and turn the agent on, in one call: both.
  await run(ada, { document: "plan", login: "*", role: "viewer" });
  expect((await run(ada, { document: "plan", login: "*", role: "none", reader_agent: true })).readerAgent).toBe(true);
});

test("the readers' states: each change, and the one refusal", () => {
  const off = { state: "private", agent: false } as const,
    on = { state: "private", agent: true } as const,
    pub = { state: "public" } as const;
  expect(readersStep(on, { anyone: true })).toEqual({ next: pub, agent: false });
  expect(readersStep(off, { anyone: true })).toEqual({ next: pub, agent: false });
  expect(readersStep(pub, { anyone: false })).toEqual({ next: off });
  expect(readersStep(pub, { anyone: false, agent: true })).toEqual({ next: on, agent: true });
  expect(readersStep(off, { agent: true })).toEqual({ next: on, agent: true });
  expect(readersStep(on, {})).toEqual({ next: on });
  expect(readersStep(pub, {})).toEqual({ next: pub });
  expect(readersStep(pub, { agent: false })).toEqual({ next: pub, agent: false });
  expect(readersStep(pub, { agent: true })).toHaveProperty("refused");
  expect(readersStep(off, { anyone: true, agent: true })).toHaveProperty("refused");
});
