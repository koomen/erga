/// <reference types="vite/client" />
// erga.dev's front door. It signs people in with GitHub and serves the
// app's own routes (front.ts, shared with the local host): the demo
// read-only at /, new documents (blank, or a copy of the demo), each
// person's list, and everything under a document's address forwarded to
// that document's Durable Object (doc-host.ts):
//
//   /                          the demo, rendered, with an Edit button (and your documents, signed in)
//   /new                       a blank document for you (signs you in first); /new?from=demo a copy of the demo
//   /docs                      your documents (doc-list.ts), latest edit first; POST /docs/delete deletes one
//   /<owner>/<id>              the editor on that document (anyone signed in may edit)
//   /<owner>/<id>/<rest>       the document's own host: /api/..., /doc/..., the sockets
//   /auth/github[/callback]    signing in; /auth/logout signs out
//   /tokens                    a test token, for running the test suite against erga.dev
//   /auth/test?token=&as=      a test person (Ada, Bo...) signed in with one; they open only test documents
//   /page.js, /style.css, ...  the editor's own files (static assets)

import { frontDoor, page, type Platform } from "../front";
import { allowed, finishSignIn, isDev, mintTestToken, sessionOf, signOut, startSignIn, testSignIn } from "./auth";
import type { Env } from "./env";

export { DocHost } from "./doc-host";
export { DocList } from "./doc-list";

/** The templates' files, by template then path ("demo" → { "index.html": "..." }). Text files only. */
const TEMPLATES: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(import.meta.glob("../templates/*/**", { query: "?raw", import: "default", eager: true }) as Record<string, string>)) {
  const [, name, rel] = /^\.\.\/templates\/([^/]+)\/(.+)$/.exec(path)!;
  (TEMPLATES[name] ??= {})[rel] = text;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path == "/auth/github") return startSignIn(env, request);
    if (path == "/auth/github/callback") return finishSignIn(env, request);
    if (path == "/auth/logout") return signOut(request);
    if (path == "/auth/test") return testSignIn(env, request);
    if (path == "/tokens") return tokens(env, request);
    if (path == "/page.js" || path == "/style.css" || path.startsWith("/fonts/")) return env.ASSETS.fetch(request);
    return frontDoor(request, platform(env));
  },
} satisfies ExportedHandler<Env>;

/**
 * The front door (front.ts) on Cloudflare: people sign in with GitHub, a
 * document is a Durable Object named "<owner>/<id>" (doc-host.ts), and
 * each person's list is one named by their login (doc-list.ts).
 */
const platform = (env: Env): Platform => {
  const doc = (owner: string, id: string) => env.DOCS.getByName(`${owner.toLowerCase()}/${id}`);
  return {
    sessionOf: (request) => sessionOf(env, request),
    templates: TEMPLATES,
    editor: (request) => env.ASSETS.fetch(new Request(new URL("/editor.html", request.url))),
    mayCreate: (session, url) => allowed(env, session.login) || isDev(env, url),
    dev: (url) => isDev(env, url),
    docs: {
      create: (owner, id, files, index, opts) => doc(owner, id).create(owner, id, files, index, opts),
      exists: (owner, id) => doc(owner, id).exists(),
      delete: (owner, id) => doc(owner, id).delete(owner),
      unlist: (owner, id) => env.LISTS.getByName(owner.toLowerCase()).remove(id),
      list: (owner) => env.LISTS.getByName(owner.toLowerCase()).list(),
      fetch: (owner, id, request) => doc(owner, id).fetch(request),
    },
  };
};

/** /tokens: a fresh test token for the signed-in person, and how to use it. */
async function tokens(env: Env, request: Request): Promise<Response> {
  const session = await sessionOf(env, request);
  if (!session) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/tokens")}` } });
  if (session.test) return page("Not for test people", "Sign in as yourself to make a test token.", 403);
  const { token, expires } = await mintTestToken(env, session.login);
  const origin = new URL(request.url).origin;
  return page("Test token", `This token signs in test people (Ada, Bo, ...) who can open only test documents under
<b>/${session.login}/test…</b>, where a scripted agent stands in for the model, so the test suite runs here for free.
It lasts until ${expires.toUTCString()}. Each visit makes a new one.</p>
<p><code style="word-break:break-all;user-select:all">${token}</code></p>
<p>Run the suite against ${origin}:</p>
<p><code style="word-break:break-all;user-select:all">ERGA_TEST_TOKEN=${token} bun run test:prod</code>`, 200);
}
