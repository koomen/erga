// The calls of a person's own agent that wait for the person's Approve (an operation's `asks`): a delete, a share with
// anyone, a revoke, and each change an admin makes. The run's side is in tests/agent-turn.test.ts.

import { expect, test } from "bun:test";
import { Directory } from "../server/directory/index.ts";
import { agentTools, toolsFor } from "../agents/tools";
import { OPERATIONS } from "../server/operations/index.ts";
import { memory } from "./helpers/memory-sql";

/** The admin operations that only read. */
const ADMIN_READS = ["settings", "sign_in", "people", "analytics", "feedback"];

test("every admin operation that changes the server asks first, and no read does", () => {
  for (const op of OPERATIONS.filter((o) => o.admin)) {
    const asks = op.asks?.({}) ?? null;
    if (ADMIN_READS.includes(op.name)) expect([op.name, asks]).toEqual([op.name, null]);
    else expect([op.name, typeof asks]).toEqual([op.name, "string"]);
  }
});

test("the agent's tools ask for a delete, a share with anyone and a revoke, in words; other calls run at once", async () => {
  const dir = new Directory(memory(), { admins: ["root"] });
  const root = { dir, who: { login: "root", admin: true } };
  const tools = agentTools(await toolsFor(root, true), root);
  const asks = (tool: string, args: Record<string, unknown>) => tools.find((t) => t.name == tool)!.asks!(args);
  expect(asks("documents", { op: "delete_document", document: "/root/notes" })).toBe("Delete /root/notes for good");
  expect(asks("documents", { op: "delete_document" })).toBe("Delete the document open on the page for good");
  expect(asks("documents", { op: "share_document", document: "/root/notes", login: "*", role: "viewer" })).toBe(
    "Share /root/notes with anyone who has the link (viewer)"
  );
  expect(asks("documents", { op: "revoke", token: "tok_1" })).toBe("Revoke the token tok_1");
  expect(asks("settings", { op: "set_setting", key: "public_sharing", value: true })).toBe(
    "Set the server's setting public_sharing to true"
  );
  expect(asks("people", { op: "set_user", action: "add", handle: "mallory", role: "admin" })).toBe(
    "Add the user mallory with the role admin"
  );
  // Publishing: each change asks, in its own words.
  expect(asks("documents", { op: "publish_document", document: "/root/notes" })).toBe("Publish /root/notes to its domain as it is now");
  expect(asks("documents", { op: "set_publishing", document: "/root/notes", domain: "erga.dev" })).toBe("Link /root/notes to erga.dev");
  expect(asks("documents", { op: "set_publishing", document: "/root/notes", domain: "erga.dev", replace: true })).toBe(
    "Link /root/notes to erga.dev in place of the document that has it"
  );
  expect(asks("documents", { op: "set_publishing", document: "/root/notes", domain: "" })).toBe(
    "Unpublish /root/notes: its domain answers with nothing from then on"
  );
  expect(asks("documents", { op: "set_publishing", document: "/root/notes", bars: false })).toBe(
    "Turn off the Erga header bar on the published site of /root/notes"
  );
  // A share with a person, the end of a share, and the reads and edits: no question.
  expect(asks("documents", { op: "share_document", document: "/root/notes", login: "bo", role: "editor" })).toBeNull();
  expect(asks("documents", { op: "share_document", document: "/root/notes", login: "*", role: "none" })).toBeNull();
  expect(asks("documents", {})).toBeNull();
  expect(asks("documents", { op: "no_such_op" })).toBeNull();
  expect(asks("edit", { op: "write", path: "a.html", content: "x" })).toBeNull();
  expect(asks("settings", { op: "settings" })).toBeNull();
});
