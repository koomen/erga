// Erga's repository as a read-only JSON API, for any page (the homepage's page /source reads it in the browser).
// GET only: nothing here writes. It reads the repository on GitHub over Platform.repo (server/repo-github.ts), where
// the server has SOURCE_REPO (erga.dev and staging: deploy/run.ts).
//
//   GET /api/repo                      the name, the clone address, main and staging (their heads, when each last
//                                      changed and their recent commits), and the release tags
//   GET /api/repo/tree/<ref>/<path>    a folder's entries, or a file's text (README.md for the page's README)
//
// <ref> is main or staging. Only those two: a feature branch is an admin's work in progress.
// The setting public_source (server/directory/settings.ts) decides who may read: on (the default), anyone, with CORS
// for any origin and no credentials; off, the server's admins only, and a 404 for anyone else.
// Answers for anyone are kept in the edge's cache for a short time (a commit's files never change, a branch's head
// does), and each address may ask the repository at most RATE times a minute.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { whoOf, type Platform } from "./platform.ts";
import { call, ctx, fromWeb, type Route } from "./http.ts";

/** A folder's entries, or a file's text (null: binary), as the repository answers a "view". */
export type SourceView =
  | { kind: "folder"; path: string; entries: { name: string; folder: boolean; size: number }[] }
  | { kind: "file"; path: string; size: number; text: string | null; link?: string; cut?: boolean };

/** What the API reads of the repository (server/repo-github.ts). */
export interface Repository {
  /** The address to clone it from. */
  clone: string;
  branches(): Promise<{
    branches: { name: string; commit: string | null; commits: { sha: string; subject: string; author: string; at: number }[] }[];
    tags?: { name: string; commit: string; at: number }[];
  }>;
  read(q: { ref: string; path: string }): Promise<{ commit: string; view?: SourceView } | { error: string }>;
}

declare module "./platform.ts" {
  interface Platform {
    /** Erga's repository on GitHub, read-only, where the server has SOURCE_REPO (erga.dev and staging); absent elsewhere. */
    repo?: Repository;
  }
}

/** The API's paths. */
export const isRepoApiPath = (path: string) => path == "/api/repo" || path.startsWith("/api/repo/");

/** The branches anyone may read, and what each is. */
const BRANCHES = { main: "what erga.dev runs", staging: "the changes that come next" } as const;
type Ref = keyof typeof BRANCHES;
const isRef = (r: string): r is Ref => Object.hasOwn(BRANCHES, r);

/** How long a cache keeps an answer for anyone (seconds). */
const FRESH = 60;
/** The reads that miss the cache that one address may make in a minute. */
const RATE = 120;
/** The recent commits of each branch, and the release tags, in the summary. */
const COMMITS = 30,
  TAGS = 10;

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}
class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", { message: Schema.String }) {}
class TooMany extends Schema.TaggedError<TooMany>()("TooMany", { message: Schema.String }) {}

const CORS = { "Access-Control-Allow-Origin": "*" };
const answer = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers },
  });

/** The API: the answer, or null for a method it doesn't take (the server's API answers those). */
export const repoApi: Route = Effect.gen(function* () {
  const { request, url, platform: p } = yield* ctx;
  if (request.method != "GET" && request.method != "HEAD") {
    return fromWeb(answer({ error: "This API only reads: use GET." }, 405, { Allow: "GET, HEAD", "Cache-Control": "no-store", ...CORS }));
  }
  const open = (yield* call(() => p.directory.config.get("public_source"))) !== false;
  // Off: only an admin reads, and the answer is theirs alone (no cache, no CORS). Anyone else learns nothing, not even that it's there.
  if (!open && !(yield* call(() => isAdmin(p, request))))
    return fromWeb(answer({ error: "Not found." }, 404, { "Cache-Control": "no-store" }));
  const headers = open ? { ...CORS, "Cache-Control": `public, max-age=${FRESH}` } : { "Cache-Control": "private, no-store" };
  const cache = open ? p.edge.cache : null;
  const key = `${url.origin}${url.pathname}`;
  const hit = cache ? yield* call(() => cache.match(key).catch(() => undefined)) : undefined;
  if (hit) return fromWeb(hit);
  const result = yield* read(p, url, request).pipe(
    Effect.map((body) => answer(body, 200, headers)),
    Effect.catchTags({
      NotFound: (e) => Effect.succeed(answer({ error: e.message }, 404, headers)),
      Unreachable: (e) => Effect.succeed(answer({ error: e.message }, 502, { ...headers, "Cache-Control": "no-store" })),
      TooMany: (e) => Effect.succeed(answer({ error: e.message }, 429, { ...headers, "Cache-Control": "no-store", "Retry-After": "60" })),
    })
  );
  if (cache && (result.status == 200 || result.status == 404)) p.edge.background(cache.put(key, result.clone()));
  return fromWeb(result);
});

async function isAdmin(p: Platform, request: Request): Promise<boolean> {
  const session = await p.sessionOf(request);
  return !!session && (await p.directory.users.isAdmin(whoOf(session)));
}

/** The answer's body for the path. */
function read(p: Platform, url: URL, request: Request) {
  return Effect.gen(function* () {
    const repo = p.repo;
    if (!repo) return yield* new NotFound({ message: "This server has no repository." });
    yield* limit(request);
    const rest = url.pathname.slice("/api/repo".length).replace(/\/+$/, "");
    if (rest == "") return yield* summary(repo);
    const parts = rest.split("/").filter(Boolean).map(decode);
    if (parts[0] != "tree" || parts.some((s) => s == null))
      return yield* new NotFound({ message: "No such address: /api/repo and /api/repo/tree/<branch>/<path> are the API." });
    const [, ref = "main", ...path] = parts as string[];
    if (!isRef(ref)) return yield* new NotFound({ message: `No branch "${ref}": main and staging are the branches here.` });
    return yield* tree(repo, ref, path.join("/"));
  });
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** The repository's name and clone address, its two branches and its release tags. */
function summary(object: Repository) {
  return Effect.gen(function* () {
    const all = yield* Effect.tryPromise({
      try: () => object.branches(),
      catch: () => new Unreachable({ message: "Erga couldn't read its repository just now. Try again in a minute." }),
    });
    const branches = all.branches
      .filter((b) => isRef(b.name))
      .map((b) => ({
        name: b.name,
        about: BRANCHES[b.name as Ref],
        commit: b.commit,
        updated: b.commits[0]?.at ?? null,
        commits: b.commits.slice(0, COMMITS).map((c) => ({ sha: c.sha, subject: c.subject, author: c.author, at: c.at })),
      }));
    const main = branches.find((b) => b.name == "main");
    return {
      name: "erga",
      clone: object.clone,
      default: "main",
      updated: main?.updated ?? null,
      branches,
      tags: (all.tags ?? []).slice(0, TAGS).map((t) => ({ name: t.name, commit: t.commit, at: t.at })),
    };
  });
}

/** A folder's entries (folders first, by name), or a file's text: null for a binary file. */
function tree(object: Repository, ref: Ref, path: string) {
  return Effect.gen(function* () {
    const got = yield* Effect.tryPromise({
      try: () => object.read({ ref, path }),
      catch: () => new Unreachable({ message: "Erga couldn't read its repository just now. Try again in a minute." }),
    });
    if ("error" in got || !got.view) {
      // A path that isn't there says so; the repository's own trouble stays on the server.
      if ("error" in got && /^There's no file or folder|can't go up/.test(got.error))
        return yield* new NotFound({ message: `There's no ${path} on ${ref}.` });
      return yield* new Unreachable({ message: "Erga couldn't read its repository just now. Try again in a minute." });
    }
    const v: SourceView = got.view;
    const base = { ref, commit: got.commit, path: v.path };
    if (v.kind == "folder") {
      return {
        ...base,
        kind: "folder" as const,
        entries: v.entries.map((e) => ({
          name: e.name,
          kind: e.folder ? ("folder" as const) : ("file" as const),
          ...(e.folder ? {} : { size: e.size }),
        })),
      };
    }
    return {
      ...base,
      kind: "file" as const,
      size: v.size,
      text: v.link == null ? v.text : null,
      ...(v.link != null ? { link: v.link } : {}),
      ...(v.cut ? { cut: true } : {}),
    };
  });
}

/** Each address's reads that missed the cache, this minute (in this isolate: a soft limit, on top of the cache). */
let window = { minute: 0, counts: new Map<string, number>() };
function limit(request: Request) {
  return Effect.suspend(() => {
    const minute = Math.floor(Date.now() / 60_000);
    if (window.minute != minute) window = { minute, counts: new Map() };
    const who = request.headers.get("cf-connecting-ip") ?? "local";
    const n = (window.counts.get(who) ?? 0) + 1;
    window.counts.set(who, n);
    return n > RATE
      ? Effect.fail(new TooMany({ message: "Too many reads of the repository from this address: try again in a minute." }))
      : Effect.void;
  });
}
