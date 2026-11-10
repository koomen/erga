// Each failure the directory can refuse with carries its HTTP status (NotFound 404, NotAllowed 403, ConfigError 400...):
// an operation answers that status, whatever the message's words are.

import { expect, test } from "bun:test";
import { allTools, runTool } from "../agents/tools";
import { ConfigError, CredentialError, Directory, NotAllowed, NotFound } from "../server/directory/index.ts";
import { AuthError, ScopeError } from "../server/identity/index.ts";
import { type Caller, OperationError } from "../server/operations/index.ts";
import { memory } from "./helpers/memory-sql";

const run = (name: string, ctx: Caller, args: Record<string, unknown>) =>
  (runTool(allTools().find((t) => t.name == name)!, args, ctx) as Promise<unknown>).then(
    () => 200,
    (e: OperationError) => e.status
  );

test("each kind of failure has its status", () => {
  const message = "any words";
  expect(new NotFound({ message }).status).toBe(404);
  expect(new NotAllowed({ message }).status).toBe(403);
  expect(new ScopeError({ message }).status).toBe(403);
  expect(new ConfigError({ message }).status).toBe(400);
  expect(new CredentialError({ message }).status).toBe(400);
  expect(new AuthError({ message }).status).toBe(400);
});

test("an operation answers the failure's status: not found 404, not allowed 403, bad input 400", async () => {
  const dir = new Directory(memory(), { admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "bo");
  const root: Caller = { dir, who: { login: "root", admin: true } };
  expect(await run("set_user", root, { action: "role", login: "nobody", role: "write" })).toBe(404);
  expect(await run("share_document", root, { document: "aaaaaaaa", login: "bo", role: "viewer" })).toBe(404);
  // The server keeps an admin.
  expect(await run("set_user", root, { action: "role", login: "root", role: "write" })).toBe(403);
  expect(await run("set_setting", root, { key: "no_such_setting", value: 1 })).toBe(400);
});
