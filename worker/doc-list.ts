// One person's documents on erga.dev, as a Durable Object named by their
// login (lowercase): the index /docs lists. Each document (doc-host.ts)
// keeps its own entry up to date: it puts it when it's made, when it opens
// (so documents made before there was an index turn up once opened) and
// when one of its files changes, and removes it when it's deleted.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/** A document as its owner's list shows it. */
export interface Listed {
  id: string;
  title: string;
  created: number;
  /** When a file last changed (when it was made, if never). */
  modified: number;
  /** When it goes away if nobody edits it (only while it's never been edited). */
  expires?: number;
}

const DOC = "doc:";

export class DocList extends DurableObject<Env> {
  async put(doc: Listed): Promise<void> {
    await this.ctx.storage.put(DOC + doc.id, doc);
  }

  async remove(id: string): Promise<void> {
    await this.ctx.storage.delete(DOC + id);
  }

  /** Every document, most recently changed first. */
  async list(): Promise<Listed[]> {
    const docs = await this.ctx.storage.list<Listed>({ prefix: DOC });
    return [...docs.values()].sort((a, b) => b.modified - a.modified);
  }
}
