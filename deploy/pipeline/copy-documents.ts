// The deploy pipeline's copy of documents from one server to another (the
// "documents" step, pipeline.ts), through the snapshot
// endpoints of both (document/snapshot.ts).

import { DeployError, type Fetch } from "./cloudflare-api";
import { snapshotAuth, type DocSnapshot } from "../../document/snapshot";

/**
 * Copies documents' storage from the server at `from` to the one at `to`:
 * up to `batch` documents at a time (fewer, or part of one, when they're
 * large: SNAPSHOT_BUDGET), read from one and written to the other; `wipe`
 * empties documents the target had that the source doesn't. A document the
 * source couldn't read is `failed` (its id and why) and emptied on the
 * target; the others are still copied. `unsupported`: the source has no
 * snapshot endpoint (an older version, or no SNAPSHOT_TOKEN).
 */
export async function copyDocuments(o: {
  ids: string[];
  wipe: string[];
  from: string;
  to: string;
  token: string;
  fetch: Fetch;
  batch?: number;
}): Promise<{ copied: number; missing: number; wiped: number; failed: { id: string; error: string }[]; unsupported: boolean }> {
  // Each request is signed with the secret, which never travels (document/snapshot.ts, snapshotAuth).
  const post = async (url: string, body: string) =>
    o.fetch(url, {
      method: "POST",
      headers: { Authorization: await snapshotAuth(o.token, "POST", url, body), "Content-Type": "application/json" },
      body,
    });
  const size = o.batch ?? 25;
  const put = async (docs: DocSnapshot[], wipe: string[]) => {
    const r = await post(`${o.to}/api/snapshot/docs/import`, JSON.stringify({ docs, wipe })).catch((e) => {
        throw new DeployError({ message: `Couldn't reach ${o.to} to copy documents in: ${(e as Error).message}` });
      });
    if (!r.ok)
      throw new DeployError({
        message: `${o.to} didn't take the documents' copy (it answered ${r.status}${r.status == 404 ? ": it needs SNAPSHOT_FROM (a staging instance) and SNAPSHOT_TOKEN" : ""}).`,
      });
  };
  // Documents with a part copied, those that failed, and those the source didn't have.
  const started = new Set<string>(),
    failed = new Map<string, string>();
  let missing = 0,
    queue = o.ids,
    after: string | null = null,
    first = true;
  while (queue.length) {
    const ids = queue.slice(0, size);
    const r = await post(`${o.from}/api/snapshot/docs`, JSON.stringify(after == null ? { ids } : { ids, after })).catch((e) => {
        throw new DeployError({ message: `Couldn't reach ${o.from} to read its documents: ${(e as Error).message}` });
      });
    if (r.status == 404 && first) {
      if (o.wipe.length) await put([], o.wipe);
      return { copied: 0, missing: 0, wiped: o.wipe.length, failed: [], unsupported: true };
    }
    first = false;
    if (!r.ok)
      throw new DeployError({
        message: `${o.from} didn't give its documents' snapshot (it answered ${r.status}${r.status == 403 ? ": the two servers' SNAPSHOT_TOKEN differ, their clocks do, or it runs a version from before signed requests" : ""}).`,
      });
    const answer = (await r.json()) as { docs: DocSnapshot[]; done?: number; failed?: { id: string; error: string }[] };
    // An older source sends each document whole, and no `done`.
    const done = answer.done ?? ids.length;
    const docs = answer.docs.map((d) => ({ id: d.id, entries: d.entries, alarm: d.alarm, ...(started.has(d.id) ? { append: true } : {}) }));
    if (docs.length) await put(docs, []);
    for (const d of docs) started.add(d.id);
    for (const f of answer.failed ?? []) failed.set(f.id, f.error);
    for (const id of ids.slice(0, done)) if (!started.has(id) && !failed.has(id)) missing++;
    const last = answer.docs.at(-1);
    const next = last?.more ?? null;
    if (next != null && (last!.id != ids[done] || next === after))
      throw new DeployError({ message: `${o.from} gave a part of ${last!.id} it can't continue from.` });
    if (done == 0 && next == null) throw new DeployError({ message: `${o.from} gave nothing of ${ids[0]}.` });
    after = next;
    queue = queue.slice(done);
  }
  // A failed document may be in part on the target: emptied, as the source has it unread.
  const wipe = [...new Set([...o.wipe, ...failed.keys()])];
  if (wipe.length) await put([], wipe);
  return {
    copied: [...started].filter((id) => !failed.has(id)).length,
    missing,
    wiped: o.wipe.length,
    failed: [...failed].map(([id, error]) => ({ id, error })),
    unsupported: false,
  };
}
