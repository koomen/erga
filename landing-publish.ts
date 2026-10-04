// The network half of publishing the repo's landing project (landing.ts),
// with no filesystem: the files come as the server's API takes them. The
// deploy page (worker/deploy.ts) publishes a new server's front page with it
// from inside the Worker.

/** A project's files, by path: text as text, anything else as base64. */
export type Files = Record<string, string | { base64: string }>;

/** The files that go as text; anything else goes as base64. */
export const TEXT = /\.(html?|md|markdown|css|m?js|json|svg|txt|xml|csv)$/i;

export interface Published {
  id: string;
  url: string;
  address: string;
  /** Made by this run (else published into the one there was). */
  created: boolean;
  /** Whether landing_document was set by this run (it isn't when it already named it, or the deploy locks it). */
  set: boolean;
}

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/**
 * Publishes `files` (a landing project's, as readProject gives them) to
 * `server` as `token`'s person's document at /<login>/<slug> (made if it
 * isn't there, else published into) and makes it the front page
 * (landing_document). `wait`: how long to keep asking a server that doesn't
 * know landing_document yet (a deploy still rolling out), in ms. `fetch`:
 * what to reach the server with (the deploy page's tests hand it a mock).
 */
export async function publishFiles(opts: { server: string; token: string; files: Files; slug: string; folder?: string; wait?: number; log?: (line: string) => void; fetch?: typeof fetch }): Promise<Published> {
  const server = opts.server.replace(/\/+$/, "");
  const log = opts.log ?? (() => {});
  const { slug, files } = opts;
  const fetch = opts.fetch ?? globalThis.fetch;
  const call = async (path: string, body: unknown) => {
    const r = await fetch(server + path, { method: "POST", headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const answer = (await r.json().catch(() => ({ ok: false, error: `${server}${path} answered ${r.status}, not JSON` }))) as { ok: boolean; error?: string; content?: { text: string }[] } & Record<string, unknown>;
    if (!r.ok || !answer.ok) throw new ApiError(answer.error ?? `${server}${path} answered ${r.status}`, r.status);
    return answer;
  };
  const tool = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => JSON.parse((await call(`/api/ext/tools/${name}`, args)).content?.[0]?.text ?? "null") as T;

  // An admin's token, on a server that has the setting (just after a deploy, the old Worker may still be answering).
  type Entry = { key: string; value: unknown; locked: boolean };
  let entry: Entry | undefined;
  for (const until = Date.now() + (opts.wait ?? 0); ;) {
    let settings: Entry[];
    try { settings = await tool<Entry[]>("list_settings"); } catch (e) {
      if (e instanceof ApiError && (e.status == 401 || e.status == 403)) throw new Error(`${server} won't let this token change its settings: the landing page needs an admin's agent token (make one at ${server}/tokens). It said: ${e.message}`);
      throw e;
    }
    entry = settings.find((s) => s.key == "landing_document");
    if (entry || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!entry) throw new Error(`${server} has no landing_document setting: is it running this version of Erga?`);
  const { login } = await tool<{ login: string }>("whoami");

  // Into the same document each time: the one the deploy locks, else this person's at /<login>/<slug>.
  const target = entry.locked ? String(entry.value ?? "") : `/${login}/${slug}`;
  if (entry.locked && !target) throw new Error("The deploy locks landing_document to nothing: take it out of server.config.ts, or lock it to a document.");
  let doc: { id: string; url: string; address: string }, created = false;
  try {
    doc = await call("/api/publish", { document: target, files }) as unknown as typeof doc;
  } catch (e) {
    if (!(e instanceof ApiError && e.status == 404) || entry.locked) throw e;
    doc = await call("/api/publish", { files, slug }) as unknown as typeof doc;
    created = true;
  }
  const refused = (doc as { refused?: { path: string; why: string }[] }).refused ?? [];
  log(`${created ? "published" : "republished"} ${opts.folder ?? "the landing project"} at ${doc.url}${refused.length ? ` (refused: ${refused.map((r) => `${r.path}, ${r.why}`).join("; ")})` : ""}`);
  let set = false;
  if (!entry.locked && entry.value != doc.id) {
    await tool("set_setting", { key: "landing_document", value: doc.id });
    set = true;
    log(`landing_document is now ${doc.address}: ${server}/ shows it`);
  }
  return { id: doc.id, url: doc.url, address: doc.address, created, set };
}
