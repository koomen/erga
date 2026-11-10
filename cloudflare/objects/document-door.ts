// The document object's one door: a request by its name and its arguments (DocumentObject.call). No type of the
// Worker's here: a unit test runs it (tests/document-door.test.ts).

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
