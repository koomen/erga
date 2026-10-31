// The news hub: which rows changed, for the open pages that show them (docs/design: live pages). A change is a key
// ("doc:<id>") and who may see it; the hub gives it a version, keeps the last version of each key for each person
// ("admins" for every admin's), and tells that person's open pages. A message holds keys and versions, never data:
// the page then asks for those rows as its person (routes.ts), so who may see what is decided there, as for the page.
//
// A page that was away (its socket dropped, its tab hidden) says the last version it saw (`since`), and hears every
// key of its person changed since. A key's last version is kept for KEEP_MS; a page away longer is told to start over.
//
// Platform-neutral on purpose (sockets are anything with send), so the tests run it without Cloudflare; the Durable
// Object (cloudflare/objects/news.ts) gives it its SQLite and its sockets.

import type { News } from "../directory/index.ts";

/** An open page's socket, and whose it is. */
export interface Listener {
  send(text: string): void;
  login: string;
  admin: boolean;
}

/** What the hub needs of SQLite. */
export interface HubSql {
  exec<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
}

/** What the hub says: these keys changed, at these versions; or the page was away too long, and starts over. */
export type Said = { changed: { key: string; v: number }[] } | { reset: true };

/** How long a key's last version is kept: a page away longer starts over. */
export const KEEP_MS = 30 * 24 * 3600_000;
const ADMINS = "admins";

export class Hub {
  private last: number;

  constructor(
    private sql: HubSql,
    private listeners: () => Iterable<Listener>,
    private now: () => number = Date.now
  ) {
    sql.exec("CREATE TABLE IF NOT EXISTS news (scope TEXT NOT NULL, key TEXT NOT NULL, v INTEGER NOT NULL, PRIMARY KEY (scope, key))");
    sql.exec("CREATE INDEX IF NOT EXISTS news_v ON news (scope, v)");
    this.last = sql.exec<{ v: number | null }>("SELECT MAX(v) AS v FROM news")[0]?.v ?? 0;
  }

  /** The changes, at one new version: kept, and told to the open pages of who may see them. Returns the version. */
  publish(news: readonly News[]): number {
    // A version is a time (so a page rendered at a time may start from it), and always more than the last.
    const v = (this.last = Math.max(this.last + 1, this.now()));
    const keys = new Map<string, Set<string>>();
    for (const n of news)
      for (const scope of n.to == "admins" ? [ADMINS] : n.to.map((l) => l.toLowerCase())) {
        this.sql.exec(
          "INSERT INTO news (scope, key, v) VALUES (?1, ?2, ?3) ON CONFLICT (scope, key) DO UPDATE SET v = ?3",
          scope,
          n.key,
          v
        );
        let set = keys.get(scope);
        if (!set) keys.set(scope, (set = new Set()));
        set.add(n.key);
      }
    this.sql.exec("DELETE FROM news WHERE v < ?1", this.now() - KEEP_MS);
    for (const l of this.listeners()) {
      const mine = [...(keys.get(l.login) ?? []), ...(l.admin ? (keys.get(ADMINS) ?? []) : [])];
      if (mine.length) send(l, { changed: [...new Set(mine)].map((key) => ({ key, v })) });
    }
    return v;
  }

  /** What changed for `l`'s person after version `since`; or, away longer than the hub keeps, start over. */
  since(l: Pick<Listener, "login" | "admin">, since: number): Said {
    if (!(since > this.now() - KEEP_MS)) return { reset: true };
    const rows = this.sql.exec<{ key: string; v: number }>(
      "SELECT key, MAX(v) AS v FROM news WHERE (scope = ?1 OR scope = ?2) AND v > ?3 GROUP BY key ORDER BY v",
      l.login,
      l.admin ? ADMINS : l.login,
      since
    );
    return { changed: rows.map((r) => ({ key: r.key, v: Number(r.v) })) };
  }
}

const send = (l: Listener, said: Said) => {
  try {
    l.send(JSON.stringify(said));
  } catch {
    /* gone: its close comes */
  }
};
