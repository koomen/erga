// What people did each day (server/directory/activity.ts) and the operation `analytics` that reads it for the Analytics
// page (/admin): a month of a small team's views, edits and tokens, added one event at a time as the server adds them,
// then read back as each day's numbers and the two lists, a page at a time. Load more's state machine
// (client/common/load-more.ts). The pages' models' tokens count once, at the end of a call; the migration brings in
// the log's last 30 days.

import { expect, test } from "bun:test";
import { Activity, type Counts, DAY_MS, dayOf, Directory, NotAllowed } from "../server/directory/index.ts";
import { OPERATIONS, runOperation } from "../server/operations/index.ts";
import { step, type LoadMore } from "../client/common/load-more.ts";
import { memory } from "./helpers/memory-sql";

/** Noon (UTC) today: the operation reads up to the real today. */
const NOW = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 3_600_000;
const TODAY = dayOf(NOW);
const ada = { login: "ada", admin: true };
const analytics = OPERATIONS.find((o) => o.name == "analytics")!;

/** 14 people, who joined one every two days; the first six work every weekday, the rest now and then. */
const PEOPLE = Array.from({ length: 14 }, (_, i) => ({ login: `p${String(i + 1).padStart(2, "0")}`, joined: NOW - (40 - i * 2) * DAY_MS }));

interface Event {
  at: number;
  login: string | null;
  counts: Counts;
}

/** A month of events: each person's views, edits and agent's tokens on the days they work, and readers who aren't signed in. */
function month(): Event[] {
  const events: Event[] = [];
  for (let ago = 29; ago >= 0; ago--) {
    const day = NOW - ago * DAY_MS;
    const weekday = new Date(day).getUTCDay() % 6 != 0;
    PEOPLE.forEach((p, i) => {
      if (p.joined > day) return;
      const works = i < 6 ? weekday : (ago + i) % 5 == 0;
      if (!works) return;
      for (let v = 0; v < 3 + (i % 4); v++) events.push({ at: day - v * 60_000, login: p.login, counts: { view: 1 } });
      for (let e = 0; e < (i % 3) + (ago % 2); e++) events.push({ at: day, login: p.login, counts: { edit: 1 } });
      if (i % 2 == 0) events.push({ at: day, login: p.login, counts: { "in:server": 12_000 + i * 100, "out:server": 900 + i } });
      if (i == 3) events.push({ at: day, login: p.login, counts: { "in:own": 40_000, "out:own": 2_000 } });
    });
    events.push({ at: day, login: null, counts: { view: 4 } });
  }
  return events;
}

async function setup() {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["ada"] });
  for (const p of PEOPLE)
    await sql.run("INSERT INTO users (login, name, role, created, last_seen) VALUES (?1, ?1, 'user', ?2, ?2)", p.login, p.joined);
  const events = month();
  for (const e of events) await dir.activity.add(e.login, e.counts, e.at);
  return { sql, dir, events };
}

/** What the events say a day should show. */
function expected(events: Event[], day: number) {
  const of = events.filter((e) => dayOf(e.at) == day);
  const total = (m: keyof Counts) => of.reduce((a, e) => a + (e.counts[m] ?? 0), 0);
  return {
    people: new Set(of.flatMap((e) => (e.login ? [e.login] : []))).size,
    views: total("view"),
    edits: total("edit"),
    tokens: {
      server: { input: total("in:server"), output: total("out:server") },
      own: { input: total("in:own"), output: total("out:own") },
    },
  };
}

test("each day of the span: its active people, views, edits and tokens by whose key; a day nobody worked has zeros", async () => {
  const { dir, events } = await setup();
  const days = await dir.activity.days(ada, 30, NOW);
  expect(days.length).toBe(30);
  expect(days[29].day).toBe(TODAY);
  for (const d of days) expect({ ...d, day: undefined }).toEqual({ ...expected(events, d.day), day: undefined });
  // A weekday: the six who work every weekday, and readers who aren't signed in count as views, not as people.
  const weekday = [...days].reverse().find((d) => new Date(d.day * DAY_MS).getUTCDay() % 6 != 0)!;
  expect(weekday.people).toBeGreaterThanOrEqual(6);
  expect(weekday.views).toBeGreaterThan(
    expected(
      events.filter((e) => e.login),
      weekday.day
    ).views
  );
  // 90 days: the 60 before the month have nothing.
  const quarter = await dir.activity.days(ada, 90, NOW);
  expect(quarter.slice(0, 60).every((d) => d.people == 0 && d.views == 0)).toBe(true);
  // Only an admin reads them.
  await expect(dir.activity.days({ login: "p01" }, 30, NOW)).rejects.toBeInstanceOf(NotAllowed);
});

test("the operation: the most active of the last 7 days, 10 at a time, and the newest users, with Load more's next page", async () => {
  const { dir, events } = await setup();
  const week = events.filter((e) => e.login && dayOf(e.at) > TODAY - 7);
  const score = new Map<string, number>();
  for (const e of week) score.set(e.login!, (score.get(e.login!) ?? 0) + (e.counts.view ?? 0) + (e.counts.edit ?? 0));
  const ranked = [...score].sort((a, b) => b[1] - a[1] || 0).map(([l]) => l);

  const all = (await runOperation(analytics, {}, { dir, who: ada })) as any;
  expect(all.days.length).toBe(30);
  expect(all.days[29].date).toBe(new Date(NOW).toISOString().slice(0, 10));
  expect(all.active.people.length).toBe(Math.min(10, ranked.length));
  // Ranked by edits and views together: each one's score is at least the next one's.
  const scores = all.active.people.map((p: any) => p.edits + p.views);
  expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
  expect(scores[0]).toBe(score.get(all.active.people[0].login));
  expect(all.newest.people.map((p: any) => p.login)).toEqual(
    PEOPLE.slice(4)
      .reverse()
      .map((p) => p.login)
  );
  expect(all.newest.more).toBe(true);
  expect(all.newest.people[0].joined).toBe(new Date(PEOPLE[13].joined).toISOString());

  const more = (await runOperation(analytics, { list: "newest", offset: 10 }, { dir, who: ada })) as any;
  expect(more.people.map((p: any) => p.login)).toEqual(["p04", "p03", "p02", "p01"]);
  expect(more.more).toBe(false);
  const next = (await runOperation(analytics, { list: "active", offset: 10 }, { dir, who: ada })) as any;
  expect(next.people.length).toBe(ranked.length - 10);
  expect(next.more).toBe(false);

  const seven = (await runOperation(analytics, { days: 7 }, { dir, who: ada })) as any;
  expect(seven.days.length).toBe(7);
  await expect(runOperation(analytics, {}, { dir, who: { login: "p01" } })).rejects.toThrow();
});

test("a page's model call counts its tokens once, when it finishes; a failed one's reservation doesn't count", async () => {
  const { sql, dir } = await setup();
  const now = Date.now();
  const before = await dir.activity.days(ada, 1, now);
  // On a weekday (UTC), the month's events already gave p01 tokens today.
  const p01 = () =>
    (
      sql.db.query("SELECT n FROM activity_days WHERE login = 'p01' AND metric = 'in:server' AND day = ?1").get(dayOf(now)) as {
        n: number;
      } | null
    )?.n ?? 0;
  const had = p01();
  const call = async () =>
    (await dir.pageLlm.start({ login: "p01", docId: "doc1", model: "haiku", now, reserved: { input: 500, output: 1024 }, budget: 100 }))!;
  const id = await call();
  await dir.pageLlm.write(id, { state: "finished", used: { input: 320, output: 80 } });
  await dir.pageLlm.write(id, { state: "finished", used: { input: 320, output: 80 } });
  await dir.pageLlm.write(await call(), { state: "failed", counted: { input: 500, output: 1024 } });
  const [after] = await dir.activity.days(ada, 1, now);
  expect(after.tokens.server.input - before[0].tokens.server.input).toBe(320);
  expect(after.tokens.server.output - before[0].tokens.server.output).toBe(80);
  expect(p01() - had).toBe(320);
});

test("the migration brings in the pages' models' tokens the log has; a visitor who isn't a user is nobody's", () => {
  const at = Date.parse("2026-11-01T10:00:00Z");
  const sql = memory({
    at: "0400",
    run: (db) => {
      db.exec("INSERT INTO users (login, name, role, created) VALUES ('ada', 'Ada', 'admin', 1)");
      const add = db.query(
        "INSERT INTO page_llm_use (id, login, doc_id, model, at, input_tokens, output_tokens, state) VALUES (?1, ?2, 'd', 'haiku', ?3, ?4, ?5, ?6)"
      );
      add.run("a", "ada", at, 100, 10, "finished");
      add.run("b", "ada", at + 60_000, 50, 5, "finished");
      add.run("c", "guest:1.2.3.4", at, 70, 7, "finished");
      add.run("d", "ada", at, 999, 999, "started");
    },
  });
  const rows = sql.db.query("SELECT login, metric, n FROM activity_days ORDER BY login, metric").all();
  expect(rows).toEqual([
    { login: "", metric: "in:server", n: 70 },
    { login: "", metric: "out:server", n: 7 },
    { login: "ada", metric: "in:server", n: 150 },
    { login: "ada", metric: "out:server", n: 15 },
  ]);
});

test("adding counts: a login is lowercase, anything that isn't one is nobody's, and nothing is written for zero", () => {
  expect(Activity.statements("Ada", { view: 1, edit: 0 }, NOW)).toEqual([
    [expect.stringContaining("INSERT INTO activity_days"), TODAY, "ada", "view", 1],
  ]);
  expect(Activity.statements("on disk", { edit: 1 }, NOW)[0][2]).toBe("");
  expect(Activity.statements(null, { view: 2 }, NOW)[0][2]).toBe("");
});

test("Load more: a click fetches the next people once; their rows come, and it stops when there are no more; a failure tries again", () => {
  let s: LoadMore = { is: "idle", next: 10 };
  let [t, fx] = step(s, { e: "click" });
  expect(t).toEqual({ is: "loading", next: 10 });
  expect(fx).toEqual([{ fx: "fetch", offset: 10 }]);
  expect(step(t, { e: "click" })).toEqual([t, []]);
  [s] = step(t, { e: "loaded", count: 10, more: true });
  expect(s).toEqual({ is: "idle", next: 20 });
  [t] = step(s, { e: "click" });
  [s] = step(t, { e: "failed", error: "Couldn't reach the server: try again." });
  expect(s).toEqual({ is: "failed", next: 20, error: "Couldn't reach the server: try again." });
  [t, fx] = step(s, { e: "click" });
  expect(fx).toEqual([{ fx: "fetch", offset: 20 }]);
  [s] = step(t, { e: "loaded", count: 4, more: false });
  expect(s).toEqual({ is: "done" });
  expect(step(s, { e: "click" })).toEqual([s, []]);
});
