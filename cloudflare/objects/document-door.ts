// The document object's one door: a request by its name and its arguments (DocumentObject.call), which every caller
// goes through (document-stub.ts). No type of the Worker's here: a unit test runs it (tests/document-door.test.ts).

/** The object's methods the Worker calls. */
export const CALLS = [
  "create",
  "keep",
  "link",
  "publish",
  "paths",
  "index",
  "snapshot",
  "delete",
  "notify",
  "diskPath",
  "exportStorage",
  "importStorage",
  "wipeStorage",
  "versionsState",
  "restore",
  "currentFiles",
  "version",
  "versionFile",
  "tree",
  "treeOp",
  "fileList",
  "rename",
  "setPermissions",
  "view",
  "comments",
] as const;
export type Call = (typeof CALLS)[number];

/** The answer of the object's one door (`call`): the method's own answer, or that this object's code has no such method. */
export type CallAnswer = { ok: true; value: unknown } | { ok: false; unknown: string };

/**
 * The one door: runs the method `op` of `target` with `args`, if `op` is one of `calls`. A name the object's code does
 * not know is an answer, not a failed call: an object that still runs the code from before a deploy (document-stub.ts) then says so, and the Worker can answer for it.
 */
export async function throughDoor(target: object, calls: readonly string[], op: string, args: readonly unknown[]): Promise<CallAnswer> {
  const method = calls.includes(op) ? (target as Record<string, unknown>)[op] : undefined;
  if (typeof method != "function") return { ok: false, unknown: op };
  return { ok: true, value: await method.apply(target, args) };
}

/** The object's stub, as Cloudflare gives it: the door, and the requests of the web. */
export type Door = { call(op: string, args: readonly unknown[]): Promise<CallAnswer>; fetch(request: Request): Promise<Response> };

/**
 * The caller's side of the door: a function for each call, which sends its name and arguments through `door` and gives
 * the method's answer. An object that doesn't know the call fails with `behind(op)`.
 */
export function callsThrough(
  door: Pick<Door, "call">,
  behind: (op: Call) => Error
): Record<Call, (...args: unknown[]) => Promise<unknown>> {
  const through =
    (op: Call) =>
    async (...args: unknown[]) => {
      const answer = await door.call(op, args);
      if (!answer.ok) throw behind(op);
      return answer.value;
    };
  return Object.fromEntries(CALLS.map((op) => [op, through(op)])) as Record<Call, (...args: unknown[]) => Promise<unknown>>;
}
