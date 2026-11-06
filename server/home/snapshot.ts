// The homepage's snapshot and its copies, pure: the snapshot's shape, checked at each copy (the home object's stored
// one, its answer, this isolate's memory, the edge's cache), and the decision what / does with the copies it has.
// serve.ts and deploys.ts do the IO it asks for.

import * as Schema from "effect/Schema";
import { Site } from "./site.ts";

/** A deployed snapshot, as serve.ts serves it. */
export const LivePage = Schema.Struct({
  gen: Schema.String,
  docId: Schema.String,
  /** The document's address when it was deployed (its Edit link: a later rename redirects). */
  address: Schema.String,
  /** The page, split where the controls go. */
  before: Schema.String,
  after: Schema.String,
  /** Every file it has, by path (the page among them, as it is in the document). */
  files: Schema.Array(Schema.String),
  /** The site's settings, from its files (site.ts). */
  site: Site,
  at: Schema.Number,
  version: Schema.NullOr(Schema.Number),
});
export type LivePage = typeof LivePage.Type;

/**
 * A copy is kept by another release than the one that reads it (storage, the edge's cache) or sent by one (the home
 * object, during a deploy): one of another shape is no copy at all, whatever field it lacks.
 */
export const isLivePage = Schema.is(LivePage);

/** A copy of the snapshot, and when someone last asked the home object whether it's still current. */
export interface Copy {
  page: LivePage;
  checked: number;
}

/** A copy older than this is never served without asking first: deploys keep a snapshot's files this long (KEEP_MS). */
export const STALE_MAX_MS = 60_000;
/** How long a deploy keeps the files of a snapshot that is no longer live: longer than any isolate serves it. */
export const KEEP_MS = 2 * STALE_MAX_MS;

/** What / does: serve a copy (and ask for a newer one after), look in the edge's cache first, or ask the home object. */
export type Decision = { do: "serve"; copy: Copy; refresh: boolean } | { do: "cache" } | { do: "ask" };

/**
 * The decision, from this isolate's copy, the edge's (undefined: not looked at yet), the time and how often to check
 * (0: always ask). A copy checked less than `recheckMs` ago serves; one less than STALE_MAX_MS ago serves, and the home
 * object is asked after; an older one names files a later deploy may have deleted, so it never serves.
 */
export function decide(memo: Copy | null, cache: Copy | null | undefined, now: number, recheckMs: number): Decision {
  if (recheckMs <= 0) return { do: "ask" };
  for (const copy of [memo, cache]) {
    if (!copy) continue;
    const age = now - copy.checked;
    if (age < STALE_MAX_MS) return { do: "serve", copy, refresh: age >= recheckMs };
  }
  return cache === undefined ? { do: "cache" } : { do: "ask" };
}

/** The home object's answer to page(known?.gen). */
export type Answer = { same: true; gen: string } | { same: false; page: unknown } | null;

/**
 * This isolate's copy after the home object answered. `known`: the snapshot it had when it asked (another call may
 * have forgotten it meanwhile). Null: there's no snapshot. "keep": the answer can't be used (an older release's shape,
 * or `same` for a snapshot it doesn't have), so the copy stays as it was.
 */
export function settle(known: LivePage | null, answer: Answer, now: number): Copy | null | "keep" {
  if (!answer) return null;
  if (answer.same) return known?.gen == answer.gen ? { page: known, checked: now } : "keep";
  return isLivePage(answer.page) ? { page: answer.page, checked: now } : "keep";
}

/** A snapshot that is no longer live, and since when. */
export interface Retired {
  gen: string;
  at: number;
}

/**
 * The snapshots whose files a new deploy (`gen`) keeps: its own, the one before (pages still open on it), and each that
 * stopped being live less than KEEP_MS ago (an isolate may still serve it: decide()). `retired` is the new list to store.
 */
export function kept(
  gen: string,
  previous: string | null,
  retired: readonly Retired[],
  now: number
): { keep: Set<string>; retired: Retired[] } {
  const next = [...retired.filter((r) => now - r.at < KEEP_MS), ...(previous ? [{ gen: previous, at: now }] : [])];
  return { keep: new Set([gen, ...next.map((r) => r.gen)]), retired: next };
}
