// Agent conversations in a Durable Object's SQLite (agents/checkpoint.ts
// says what a conversation holds). Each conversation has a scope: the
// person's object (cloudflare/objects/person-agent.ts) keeps one for each
// document ("doc:<id>"), the admin agents' object one for each admin
// ("admin:<login>"). A checkpoint writes only what changed: the new
// messages, the transcript items from the first that changed, and the
// state. A SQLite value is at most 2 MB, so long ones (a screenshot) go in
// parts.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { LogItem } from "../shared/agent-log";
import type { ChatSave, ChatState, ChatStore, StoredChat } from "./checkpoint";

/** A Durable Object's SQLite, as the tables need it (bun:sqlite stands in for the tests). */
export interface ChatSql {
  exec<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
  /** Runs `f` as one transaction: all of it, or none. */
  transaction<T>(f: () => T): T;
}

/** The longest part of a value (characters). */
const PART = 512 * 1024;
/** How long a run may go without a checkpoint before its object wakes it again (ms); and when to give it up. */
export const STALE_MS = 20_000;
export const GIVE_UP_MS = 30 * 60_000;

export class ChatTables {
  constructor(private sql: ChatSql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS chat_parts (scope TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (scope, kind, seq, part))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS chats (scope TEXT PRIMARY KEY, running INTEGER NOT NULL, at INTEGER NOT NULL)`);
  }

  load(scope: string): StoredChat | null {
    const rows = this.sql.exec<{ kind: string; seq: number; part: number; body: string }>("SELECT kind, seq, part, body FROM chat_parts WHERE scope = ? ORDER BY kind, seq, part", scope);
    if (!rows.length) return null;
    const whole = new Map<string, string>();
    for (const r of rows) whole.set(`${r.kind}:${r.seq}`, (whole.get(`${r.kind}:${r.seq}`) ?? "") + r.body);
    const list = <T>(kind: string): T[] => {
      const out: T[] = [];
      for (let i = 0; whole.has(`${kind}:${i}`); i++) out.push(JSON.parse(whole.get(`${kind}:${i}`)!) as T);
      return out;
    };
    const state = whole.get("s:0");
    if (!state) return null;
    return { messages: list<AgentMessage>("m"), log: list<LogItem>("l"), state: JSON.parse(state) as ChatState };
  }

  save(scope: string, c: ChatSave): void {
    this.sql.transaction(() => {
      this.put(scope, "m", c.messages.from, c.messages.items);
      this.put(scope, "l", c.log.from, c.log.items);
      this.put(scope, "s", 0, [c.state]);
      this.sql.exec("INSERT OR REPLACE INTO chats (scope, running, at) VALUES (?, ?, ?)", scope, c.state.running || c.state.queued.length ? 1 : 0, c.state.at);
    });
  }

  clear(scope: string): void {
    this.sql.transaction(() => {
      this.sql.exec("DELETE FROM chat_parts WHERE scope = ?", scope);
      this.sql.exec("DELETE FROM chats WHERE scope = ?", scope);
    });
  }

  /** The conversations whose run was going at their last checkpoint, with their state. */
  running(): { scope: string; at: number; state: ChatState }[] {
    return this.sql.exec<{ scope: string; at: number }>("SELECT scope, at FROM chats WHERE running = 1").flatMap((r) => {
      const state = this.load(r.scope)?.state;
      return state ? [{ scope: r.scope, at: r.at, state }] : [];
    });
  }

  /** A run given up (nothing woke it for too long): it shows as stopped. */
  stop(scope: string): void {
    const s = this.load(scope);
    if (!s) return;
    this.save(scope, { messages: { from: s.messages.length, items: [] }, log: { from: s.log.length, items: [] }, state: { ...s.state, running: false, queued: [], calls: {}, at: Date.now() } });
  }

  /** Items `from` on, each in its parts; whatever was there from `from` on goes. */
  private put(scope: string, kind: string, from: number, items: unknown[]): void {
    this.sql.exec("DELETE FROM chat_parts WHERE scope = ? AND kind = ? AND seq >= ?", scope, kind, from);
    items.forEach((item, i) => {
      const body = JSON.stringify(item);
      for (let p = 0; p * PART < body.length || p == 0; p++) this.sql.exec("INSERT INTO chat_parts (scope, kind, seq, part, body) VALUES (?, ?, ?, ?, ?)", scope, kind, from + i, p, body.slice(p * PART, (p + 1) * PART));
    });
  }
}

/** One conversation of the tables, as a session's store. */
export function tableStore(tables: ChatTables, scope: string, saved?: (running: boolean) => void): ChatStore {
  return {
    load: async () => tables.load(scope),
    save: async (c) => { tables.save(scope, c); saved?.(c.state.running || c.state.queued.length > 0); },
    clear: async () => tables.clear(scope),
  };
}

/**
 * What an object's alarm does with the runs that were going: wakes each one
 * with no checkpoint for STALE_MS (a restart cut it off, or it's in a long
 * step: waking a run that goes on does nothing), gives up on one quiet for
 * GIVE_UP_MS. Answers whether to look again (some still run).
 */
export async function wakeRuns(tables: ChatTables, wake: (scope: string, state: ChatState) => Promise<unknown>, now = Date.now()): Promise<boolean> {
  let more = false;
  for (const r of tables.running()) {
    if (now - r.at > GIVE_UP_MS) { tables.stop(r.scope); continue; }
    more = true;
    if (now - r.at > STALE_MS) await wake(r.scope, r.state).catch((e: unknown) => console.log(`couldn't wake the agent's run ${r.scope}: ${e instanceof Error ? e.message : e}`));
  }
  return more;
}
