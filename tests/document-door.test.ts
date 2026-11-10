// The document object's one door (cloudflare/objects/document-door.ts, throughDoor): a request by its name and
// arguments. A name the object does not know is an answer, not a failed call.

import { expect, test } from "bun:test";
import { CALLS, callsThrough, throughDoor } from "../cloudflare/objects/document-door";

class Fake {
  private title = "Plan";
  rename(person: { id: string }, patch: { title: string }) {
    this.title = patch.title;
    return Promise.resolve({ ok: true, by: person.id, title: this.title });
  }
  paths() {
    throw new Error("the document failed");
  }
  /** Not one of the calls: the door never opens it. */
  secret() {
    return "no";
  }
}

test("a known request runs the method on the object, with its arguments, and gives its answer", async () => {
  expect(await throughDoor(new Fake(), CALLS, "rename", [{ id: "ada" }, { title: "Trip" }])).toEqual({
    ok: true,
    value: { ok: true, by: "ada", title: "Trip" },
  });
});

test("a name that is not a call, or that this object's code lacks, answers unknown; a failure in a method still fails", async () => {
  expect(await throughDoor(new Fake(), CALLS, "secret", [])).toEqual({ ok: false, unknown: "secret" });
  expect(await throughDoor(new Fake(), CALLS, "constructor", [])).toEqual({ ok: false, unknown: "constructor" });
  // A request that a later deploy adds: this object runs the code from before it.
  expect(await throughDoor(new Fake(), [...CALLS, "archive"], "archive", [])).toEqual({ ok: false, unknown: "archive" });
  // One of the calls, which this fake object lacks.
  expect(await throughDoor(new Fake(), CALLS, "view", [])).toEqual({ ok: false, unknown: "view" });
  expect(throughDoor(new Fake(), CALLS, "paths", [])).rejects.toThrow("the document failed");
});

test("the door's own name is not a call: a request can't ask for the door again", () => {
  expect((CALLS as readonly string[]).includes("call")).toBe(false);
  expect((CALLS as readonly string[]).includes("fetch")).toBe(false);
});

test("the caller's side: each call goes through the door with its name and arguments; an object behind a deploy fails with a clear error", async () => {
  const object = new Fake();
  const sent: [string, readonly unknown[]][] = [];
  // The door of an object that runs the code from before a deploy: it knows the calls of then (here, all but view).
  const door = {
    call: (op: string, args: readonly unknown[]) => {
      sent.push([op, args]);
      return throughDoor(
        object,
        CALLS.filter((c) => c != "view"),
        op,
        args
      );
    },
  };
  const calls = callsThrough(door, (op) => new Error(`behind: ${op}`));
  expect(Object.keys(calls).sort()).toEqual([...CALLS].sort());
  expect(await calls.rename({ id: "ada" }, { title: "Trip" })).toEqual({ ok: true, by: "ada", title: "Trip" });
  expect(sent).toEqual([["rename", [{ id: "ada" }, { title: "Trip" }]]]);
  expect(calls.view(null, { page: "" })).rejects.toThrow("behind: view");
  expect(calls.paths()).rejects.toThrow("the document failed");
});
