// One person's documents on erga.dev, as a Durable Object named by their
// login (lowercase): the index /docs listed before the directory
// (directory.ts, in D1). Nothing writes to it any more; the Worker reads it
// once per person, to copy it into the directory (worker/index.ts,
// backfill). Once everyone's has been copied, it and the LISTS binding can go
// (a Durable Object class deletion migration), with the data in it.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/** An entry as documents kept it: `expires` only while never edited; `title` its id if it had none. */
export interface ListEntry { id: string; title: string; created: number; modified: number; expires?: number }

const DOC = "doc:";

export class DocList extends DurableObject<Env> {
  /** Every document, most recently changed first. */
  async list(): Promise<ListEntry[]> {
    const docs = await this.ctx.storage.list<ListEntry>({ prefix: DOC });
    return [...docs.values()].sort((a, b) => b.modified - a.modified);
  }
}
