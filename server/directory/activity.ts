// What people did each day (activity_days, server/migrations/0400_activity.sql), for the admins' Analytics page (/admin)
// and the operation `analytics`: one count for each day, person and metric, which grows (an upsert); never a row for
// each event. Who writes it, each off the way of typing and of a page's answer:
//
//   view      the viewer sends a document's page (server/documents/view.ts, after the answer)
//   edit      a document cuts a version: a burst of edits, by each of its authors (document/history.ts)
//   in:*      a model's tokens: the person's agent at each model turn (agents/person/sessions.ts), a page's model at the
//   out:*     end of its call (page-llm.ts), a version's description (document/history.ts, nobody's); `server`: the server's
//             API keys, `own`: the person's own key
//
// A person is active on a day when they have any row that day: they opened a document, edited one, or used a model.

import { safeAvatar } from "../../shared/avatars.ts";
import type { Sql, Statement } from "./model.ts";
import type { Actor, Users } from "./users.ts";

export const METRICS = ["view", "edit", "in:server", "out:server", "in:own", "out:own"] as const;
export type Metric = (typeof METRICS)[number];
export type Counts = Partial<Record<Metric, number>>;

export const DAY_MS = 86_400_000;
/** The day of `at`: days since 1970-01-01, UTC. */
export const dayOf = (at: number) => Math.floor(at / DAY_MS);

/** The end of an upsert into activity_days: a count that's there grows. */
export const ADD_COUNT = "ON CONFLICT (day, login, metric) DO UPDATE SET n = n + excluded.n";

/** A login as activity_days keeps it: lowercase; '' for nobody's (signed out, or the server by itself). */
const loginOf = (login: string | null | undefined) => (login && /^[a-z0-9][a-z0-9-]*$/i.test(login) ? login.toLowerCase() : "");

/** One day: the active people, the documents' views and edits, and the models' tokens by whose key. */
export interface DayActivity {
  day: number;
  people: number;
  views: number;
  edits: number;
  tokens: { server: { input: number; output: number }; own: { input: number; output: number } };
}

/** A person, with what they did in the days asked for (`active`), or when they joined (`newest`). */
export interface PersonActivity {
  login: string;
  name: string;
  avatar: string | null;
  created: number;
  lastSeen: number | null;
  /** The days they were active. */
  days: number;
  views: number;
  edits: number;
  /** Their models' tokens, input and output, by any key. */
  tokens: number;
}

/** A page of a list: its people, and whether there are more after them. */
export interface PeoplePage {
  people: PersonActivity[];
  more: boolean;
}

const SUMS = `SUM(CASE metric WHEN 'view' THEN n ELSE 0 END) AS views, SUM(CASE metric WHEN 'edit' THEN n ELSE 0 END) AS edits`;

export class Activity {
  constructor(
    private sql: Sql,
    private users: Users
  ) {}

  /** The statements that add `counts` to `login`'s day of `at` (nobody's: null). */
  static statements(login: string | null, counts: Counts, at = Date.now()): Statement[] {
    return Object.entries(counts).flatMap(([metric, n]): Statement[] =>
      n && n > 0 && Number.isFinite(n)
        ? [
            [
              `INSERT INTO activity_days (day, login, metric, n) VALUES (?1, ?2, ?3, ?4) ${ADD_COUNT}`,
              dayOf(at),
              loginOf(login),
              metric,
              Math.round(n),
            ],
          ]
        : []
    );
  }

  /** Adds `counts` to `login`'s day of `at`. */
  async add(login: string | null, counts: Counts, at = Date.now()): Promise<void> {
    const statements = Activity.statements(login, counts, at);
    if (statements.length) await this.sql.batch(statements);
  }

  /** The tokens (input and output) that `login`'s models used on the server's keys in the day of `at`. */
  async serverTokens(login: string, at = Date.now()): Promise<number> {
    const [row] = await this.sql.all<{ n: number | null }>(
      "SELECT SUM(n) AS n FROM activity_days WHERE day = ?1 AND login = ?2 AND metric IN ('in:server', 'out:server')",
      dayOf(at),
      loginOf(login)
    );
    return Number(row?.n ?? 0);
  }

  /** Each of the `days` days up to and with `now`'s, oldest first; a day with no row has zeros. Admins only. */
  async days(by: Actor, days: number, now = Date.now()): Promise<DayActivity[]> {
    await this.users.mustAdmin(by);
    const last = dayOf(now),
      first = last - days + 1;
    const rows = await this.sql.all<Record<string, number>>(
      `SELECT day, COUNT(DISTINCT CASE WHEN login != '' THEN login END) AS people, ${SUMS},
         SUM(CASE metric WHEN 'in:server' THEN n ELSE 0 END) AS si, SUM(CASE metric WHEN 'out:server' THEN n ELSE 0 END) AS so,
         SUM(CASE metric WHEN 'in:own' THEN n ELSE 0 END) AS oi, SUM(CASE metric WHEN 'out:own' THEN n ELSE 0 END) AS oo
       FROM activity_days WHERE day BETWEEN ?1 AND ?2 GROUP BY day`,
      first,
      last
    );
    const byDay = new Map(rows.map((r) => [Number(r.day), r]));
    return Array.from({ length: days }, (_, i) => {
      const r = byDay.get(first + i);
      const n = (k: string) => Number(r?.[k] ?? 0);
      return {
        day: first + i,
        people: n("people"),
        views: n("views"),
        edits: n("edits"),
        tokens: { server: { input: n("si"), output: n("so") }, own: { input: n("oi"), output: n("oo") } },
      };
    });
  }

  /**
   * The most active people in the `days` days up to and with `now`'s: the most edits and views together first, then
   * the most tokens. Admins only.
   */
  async active(by: Actor, o: { days: number; offset: number; limit: number; now?: number }): Promise<PeoplePage> {
    await this.users.mustAdmin(by);
    const first = dayOf(o.now ?? Date.now()) - o.days + 1;
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT u.login, u.name, u.avatar, u.created, u.last_seen, COUNT(DISTINCT a.day) AS days, ${SUMS},
         SUM(CASE WHEN metric LIKE 'in:%' OR metric LIKE 'out:%' THEN n ELSE 0 END) AS tokens
       FROM activity_days a JOIN users u ON u.login = a.login
       WHERE a.day >= ?1 GROUP BY u.login
       ORDER BY edits + views DESC, tokens DESC, u.login LIMIT ?2 OFFSET ?3`,
      first,
      o.limit + 1,
      o.offset
    );
    return { people: rows.slice(0, o.limit).map(personOf), more: rows.length > o.limit };
  }

  /** The people who joined last, newest first, with what they did in the `days` days up to `now`'s. Admins only. */
  async newest(by: Actor, o: { days: number; offset: number; limit: number; now?: number }): Promise<PeoplePage> {
    await this.users.mustAdmin(by);
    const first = dayOf(o.now ?? Date.now()) - o.days + 1;
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT u.login, u.name, u.avatar, u.created, u.last_seen, COUNT(DISTINCT a.day) AS days, ${SUMS},
         SUM(CASE WHEN metric LIKE 'in:%' OR metric LIKE 'out:%' THEN n ELSE 0 END) AS tokens
       FROM (SELECT * FROM users WHERE created > 0 ORDER BY created DESC, login LIMIT ?2 OFFSET ?3) u
       LEFT JOIN activity_days a ON a.login = u.login AND a.day >= ?1
       GROUP BY u.login ORDER BY u.created DESC, u.login`,
      first,
      o.limit + 1,
      o.offset
    );
    return { people: rows.slice(0, o.limit).map(personOf), more: rows.length > o.limit };
  }
}

function personOf(r: Record<string, unknown>): PersonActivity {
  return {
    login: String(r.login),
    name: String(r.name ?? r.login),
    avatar: safeAvatar(r.avatar as string | null),
    created: Number(r.created),
    lastSeen: r.last_seen == null ? null : Number(r.last_seen),
    days: Number(r.days ?? 0),
    views: Number(r.views ?? 0),
    edits: Number(r.edits ?? 0),
    tokens: Number(r.tokens ?? 0),
  };
}
