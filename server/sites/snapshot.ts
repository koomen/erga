// A domain's snapshot and its copies, pure: the snapshot's shape, checked at each copy (the site object's stored one,
// its answer, this isolate's memory, the edge's cache), and the decision what a request does with the copies it has.
// serve.ts and publishing.ts do the IO it asks for.

import * as Schema from "effect/Schema";
import { Addresses } from "./addresses.ts";

/** A published version, as serve.ts serves it. */
export const LivePage = Schema.Struct({
  gen: Schema.String,
  docId: Schema.String,
  /** The document's address when it was published (its Edit link: a later rename redirects). */
  address: Schema.String,
  /** The page, split where the controls go. */
  before: Schema.String,
  after: Schema.String,
  /** Every file it has, by path (the page among them, as it is in the document). */
  files: Schema.Array(Schema.String),
  /** How the site answers its addresses, from its files (addresses.ts). */
  site: Addresses,
  at: Schema.Number,
  version: Schema.NullOr(Schema.Number),
});
export type LivePage = typeof LivePage.Type;

/**
 * A copy is kept by another release than the one that reads it (storage, the edge's cache) or sent by one (the site
 * object, during a release's deploy): one of another shape is no copy at all, whatever field it lacks.
 */
export const isLivePage = Schema.is(LivePage);

/** What a domain serves: its snapshot, and whether Erga's header bar is on it (the domain's state: it changes at once). */
export const Served = Schema.Struct({ page: LivePage, bars: Schema.Boolean });
export type Served = typeof Served.Type;
export const isServed = Schema.is(Served);

/** What names a copy: another snapshot, or the bar on or off, is another tag. */
export const tagOf = (s: Served) => `${s.page.gen}:${s.bars ? 1 : 0}`;

/** A copy of what the domain serves, and when someone last asked the site object whether it's still current. */
export interface Copy {
  served: Served;
  checked: number;
}

/** A copy older than this is never served without asking first: a publish keeps a snapshot's files this long (KEEP_MS). */
export const STALE_MAX_MS = 60_000;
/** How long a publish keeps the files of a snapshot that is no longer live: longer than any isolate serves it. */
export const KEEP_MS = 2 * STALE_MAX_MS;

/** What a request does: serve a copy (and ask for a newer one after), look in the edge's cache first, or ask the site object. */
export type Decision = { do: "serve"; copy: Copy; refresh: boolean } | { do: "cache" } | { do: "ask" };

/**
 * The decision, from this isolate's copy, the edge's (undefined: not looked at yet), the time and how often to check
 * (0: always ask). A copy checked less than `recheckMs` ago serves; one less than STALE_MAX_MS ago serves, and the site
 * object is asked after; an older one names files a later publish may have deleted, so it never serves.
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

/** The site object's answer to served(known's tag). */
export type Answer = { same: true; tag: string } | { same: false; served: unknown } | null;

/**
 * This isolate's copy after the site object answered. `known`: what it had when it asked (another call may have
 * forgotten it meanwhile). Null: the domain serves nothing. "keep": the answer can't be used (another release's shape,
 * or `same` for a copy it doesn't have), so the copy stays as it was.
 */
export function settle(known: Served | null, answer: Answer, now: number): Copy | null | "keep" {
  if (!answer) return null;
  if (answer.same) return known && tagOf(known) == answer.tag ? { served: known, checked: now } : "keep";
  return isServed(answer.served) ? { served: answer.served, checked: now } : "keep";
}

/** A snapshot that is no longer live, and since when. */
export interface Retired {
  gen: string;
  at: number;
}

/**
 * The snapshots whose files a new publish (`gen`) keeps: its own, the one before (pages still open on it), and each that
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
