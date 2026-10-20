// Each person's agent conversations, as a Durable Object (one per person,
// named by their login): their conversations with the document agent, one
// for each document ("doc:<id>"), kept step by step (agents/checkpoint.ts,
// in agents/chat-store.ts's tables). A document has many editors, and each
// one's conversation is theirs: it is kept here, never on the document.
//
// The agent runs in the document's object, where its tools are; it saves
// each checkpoint here. A deploy restarts both objects. The editor wakes
// the run again when it reconnects; this object's alarm does it too, so a
// run goes on with no editor open.

import { DurableObject } from "cloudflare:workers";
import { ChatTables, STALE_MS, wakeRuns } from "../../agents/chat-store";
import type { ChatSave, StoredChat } from "../../agents/checkpoint";
import type { Env } from "../env";
import { documentOf } from "../document-host";

export class PersonAgent extends DurableObject<Env> {
  private chats = new ChatTables({
    exec: <T>(query: string, ...params: (string | number | null)[]) => this.ctx.storage.sql.exec(query, ...params).toArray() as T[],
    transaction: (f) => this.ctx.storage.transactionSync(f),
  });

  async load(scope: string): Promise<StoredChat | null> { return this.chats.load(scope); }

  async save(scope: string, change: ChatSave): Promise<void> {
    this.chats.save(scope, change);
    if (change.state.running || change.state.queued.length) await this.watch();
  }

  async clear(scope: string): Promise<void> { this.chats.clear(scope); }

  /** While a run goes: the alarm looks again a little after its checkpoints should have come. */
  private async watch(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + STALE_MS + 5_000);
  }

  /** A run with no checkpoint for a while: its document wakes it (it goes on from its last checkpoint, if it isn't running). */
  async alarm(): Promise<void> {
    const more = await wakeRuns(this.chats, async (scope, state) => {
      const doc = /^doc:(.+)$/.exec(scope)?.[1];
      if (!doc || !state.meta.person) return;
      await documentOf(this.env, doc).resumeAgent({ id: state.meta.person, name: state.meta.name ?? state.meta.person });
    });
    if (more) await this.ctx.storage.setAlarm(Date.now() + STALE_MS);
  }
}
