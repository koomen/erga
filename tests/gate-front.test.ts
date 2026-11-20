// A gate in front of the server (server/identity/mode.ts, the mode "gate"; gate/mounts/): the whole app in memory, as
// its Worker runs with GATE_KEY set. The server runs no gate of its own: a request counts only with the key that the
// gate sends, the caller is who the gate names, and the server's answers ask the gate for what only the gate does
// (a code, a token, sign-out). The gate itself is tested in tests/gate-*.test.ts.

import { expect, test } from "bun:test";
import { ASK, type Caller, signOutAt } from "../gate/core.ts";
import { HttpServerResponse } from "effect/http";
import { toWeb } from "../server/http.ts";
import { forwarded } from "../server/documents/index.ts";
import { asking, callerOf, FRONT } from "../server/identity/caller";
import { authOps, gated, signInChoices, signInOf } from "../server/identity/index.ts";
import { calling, server as app } from "./helpers/app";

const KEY = "front-gate-key-".repeat(3);
const ORIGIN = "https://erga.example";
const person = (sub: string, email: string, name = "", i = Date.now()): Caller => ({
  kind: "person",
  p: "corp-oidc",
  sub,
  email,
  name,
  i,
  e: Math.floor(i / 1000) + 3600,
});
const ADA = person("sub-ada", "ada@example.com", "Ada Lovelace");

/**
 * A server whose deploy says a gate is in front, where anyone the gate lets through may make an account (Anyone's
 * level: the organization's sign-in is the wall); `ask` is a request as the gate sends it on: with the key and
 * the caller.
 */
async function front() {
  const s = app();
  const admin = { login: "tester", admin: true };
  await s.dir.setAnyone(admin, "write");
  (s.platform as { signIn: unknown }).signIn = { mode: "gate", key: KEY, devLogin: null, encryptionKey: "local:secret" };
  const ask = (path: string, caller: Caller, init: RequestInit = {}) =>
    s.fetch(ORIGIN + path, {
      redirect: "manual",
      ...init,
      headers: { [FRONT]: KEY, ...calling(caller), ...(init.headers as Record<string, string>) },
    });
  /** The cookies an answer set, as a browser sends them back. */
  const cookiesOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  return { s, ask, cookiesOf };
}

test("a request counts only with the gate's key: without it, nothing, whoever its header names", async () => {
  const { s, ask } = await front();
  const admin: Caller = { kind: "person", p: "dev", sub: "tester", email: "", name: "tester", i: Date.now(), e: Date.now() / 1000 + 3600 };
  for (const headers of [{}, { [FRONT]: "" }, { [FRONT]: KEY.slice(0, -1) }, { [FRONT]: `${KEY}x` }, { [FRONT]: KEY.toUpperCase() }]) {
    const r = await s.fetch(`${ORIGIN}/documents`, { headers: { ...calling(admin), ...headers } as Record<string, string> });
    expect([r.status, await r.text()]).toEqual([403, ""]);
  }
  // A key that is too short to be a secret is no key: the server answers nobody.
  (s.platform.signIn as { key: string }).key = "short";
  expect((await s.fetch(`${ORIGIN}/documents`, { headers: { [FRONT]: "short", ...calling(ADA) } })).status).toBe(403);
  (s.platform.signIn as { key: string }).key = KEY;
  // With the key, the caller is who the gate names: nobody is nobody (no dev login here), and local development's
  // issuer names nobody on a server behind a gate.
  expect((await ask("/documents", { kind: "none" })).headers.get("location")).toBe("/auth/sign-in?next=%2Fdocuments");
  expect((await ask("/documents", admin)).headers.get("location")).toBe("/auth/sign-in?next=%2Fdocuments");
});

test("the gate's key ends at the check: the app never hears it, nor does a document's host after the app", async () => {
  const { s } = await front();
  const heard: Request[] = [];
  const asked = new Request(`${ORIGIN}/ada/notes/api/room`, { headers: { [FRONT]: KEY, ...calling(ADA), "x-other": "kept" } });
  const answer = await gated(s.platform, asked, async (request) => {
    heard.push(request);
    return new Response("the app's");
  });
  expect([await answer.text(), heard.length]).toEqual(["the app's", 1]);
  expect([heard[0].headers.get(FRONT), heard[0].headers.get("x-other"), heard[0].url]).toEqual([null, "kept", asked.url]);
  expect(callerOf(heard[0])).toMatchObject({ kind: "person", sub: "sub-ada" });
  // The app copies a request's headers on to a document's host: the key is not among them.
  expect(forwarded(heard[0], new URL(asked.url), "/api/room", null).headers.get(FRONT)).toBeNull();
});

test("a server still on the old sign-in at a proxy does not come up: PROXY_SIGN_IN with no gate's key says what to do", () => {
  const none = { clientId: "", secret: "" };
  const values = { gate: "", proxy: "", apps: { github: none, google: none }, origins: { github: null, google: null } };
  // The setting that the server read before the gate, and no gate: it would come up with no sign-in that works.
  for (const proxy of ['{"kind":"cloudflare-access","team":"t","aud":"a"}', "{}", " x "])
    expect(() => signInOf({ ...values, proxy })).toThrow(/PROXY_SIGN_IN.*GATE_KEY/s);
  // With the gate's key the gate signs people in, whatever the old setting says; with neither, the OAuth providers.
  expect(signInOf({ ...values, proxy: "{}", gate: KEY })).toEqual({ mode: "gate", key: KEY });
  expect(signInOf(values).mode).toBe("oauth");
  expect(signInOf({ ...values, proxy: "  " }).mode).toBe("oauth");
});

test("a first sign-in: the gate signed them in, and the account comes with a username; then every request is theirs", async () => {
  const { s, ask, cookiesOf } = await front();
  // One way to sign in here, the organization's: the server shows no providers and keeps no OAuth app.
  expect(await signInChoices(s.platform)).toEqual([{ id: "sso", label: "your organization's sign-in" }]);
  expect(await authOps(s.platform, ORIGIN).status({ login: "tester", admin: true })).toEqual({ mode: "gate" });
  // No account yet: her documents ask her to sign in, and the sign-in is the gate's already: on to the username step.
  expect((await ask("/documents", ADA)).headers.get("location")).toBe("/auth/sign-in?next=%2Fdocuments");
  expect((await ask("/auth/sign-in?next=%2Fdocuments", ADA)).headers.get("location")).toBe("/auth/sso?next=%2Fdocuments");
  const step = await ask("/auth/sso?next=%2Fdocuments", ADA);
  expect(step.headers.get("location")).toBe("/auth/username");
  const cookie = cookiesOf(step);
  const page = await (await ask("/auth/username", ADA, { headers: { Cookie: cookie } })).text();
  expect(page).toContain("You signed in with <b>ada@example.com</b>");
  // Another person with her cookie waits for no account of hers.
  expect((await ask("/auth/username", person("sub-eve", "eve@example.com"), { headers: { Cookie: cookie } })).status).toBe(400);
  const made = await ask("/auth/username", ADA, {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=ada",
  });
  expect(made.headers.get("location")).toBe("/documents");
  expect((await ask("/documents", ADA)).status).toBe(200);
  // Her account is by the sign-in's subject, under the organization's sign-in: another address, the same person.
  expect((await s.dir.identities.find("sso", "sub-ada"))?.login).toBe("ada");
  expect((await ask("/documents", person("sub-ada", "ada@new.example.com"))).status).toBe(200);
  expect((await ask("/documents", person("sub-other", "ada@example.com"))).status).toBe(302);
});

test("with usernames from email addresses, the first sign-in makes the account at once", async () => {
  const { s, ask, cookiesOf } = await front();
  await s.dir.config.set({ login: "tester", admin: true }, "usernames", "email");
  expect((await ask("/auth/sso?next=%2Fnew", ADA)).headers.get("location")).toBe("/new");
  expect((await s.dir.identities.find("sso", "sub-ada"))?.login).toBe("ada");
  // A sign-in that gives no address has no name to take: the username step.
  expect((await ask("/auth/sso", person("sub-anon", ""))).headers.get("location")).toBe("/auth/username");
  // The organization has a second email domain, with the same prefix: never a second ada. Its person chooses.
  const other = person("sub-ada-2", "ada@example.net");
  const step = await ask("/auth/sso", other);
  expect(step.headers.get("location")).toBe("/auth/username");
  const page = await (await ask("/auth/username", other, { headers: { Cookie: cookiesOf(step) } })).text();
  expect(page).toContain('id="username-hint">The Erga account <b>ada</b> is already taken.</p>');
  expect(page).toContain('name="username" value="ada2"');
});

test("the server asks the gate: sign-out, a token to paste, and MCP's code, each in the answer's header", async () => {
  const { s, ask } = await front();
  await s.dir.config.set({ login: "tester", admin: true }, "usernames", "email");
  await ask("/auth/sso", ADA);
  // A token to paste: the grant is the server's, the token is the gate's to sign, for the person it named.
  const made = await ask("/tokens/new", ADA, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Script", scope: "documents" }),
  });
  const { info } = (await made.json()) as { info: { id: string; expires: number } };
  expect(made.headers.get(ASK)).toBe(`token ${info.id} ${Math.floor(info.expires / 1000)}`);
  // Each answer that asks the gate is for this one request: no cache keeps it, to give its ask to another browser.
  const kept = (answer: Response) => answer.headers.get("cache-control");
  expect(kept(made)).toBe("no-store");
  // The token names her as the gate does (its issuer, not the server's name for it), and the grant: the agent is hers.
  const agent: Caller = { kind: "agent", p: "corp-oidc", sub: "sub-ada", g: info.id };
  const me = await ask("/api/tools/whoami", agent, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(((await me.json()) as { result: { login: string } }).result.login).toBe("ada");
  expect((await ask("/api/tools/whoami", { ...agent, sub: "sub-eve" }, { method: "POST", body: "{}" })).status).toBe(401);
  // What is a person's own, in a browser, is not her agent's: the panel refuses it, and the Document LLM API takes it for
  // nobody. The server knows the agent by the caller alone (no token reaches it: the gate keeps it).
  const panel = await ask("/api/agent", agent);
  expect([panel.status, await panel.json()]).toEqual([403, { error: "Sign in as yourself to talk to your agent." }]);
  const model = await ask("/api/llm?document=none", agent);
  expect([model.status, await model.json()]).toEqual([200, expect.objectContaining({ on: false, signedIn: false })]);
  // MCP's approval: the answer asks for a code for the new grant, or says the person denied.
  const at =
    "/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=x&code_challenge_method=S256";
  const post = (answer: string) =>
    ask(at, ADA, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: `answer=${answer}`,
    });
  const [approved, denied] = [await post("approve"), await post("deny")];
  expect([approved.headers.get(ASK), kept(approved)]).toEqual([expect.stringMatching(/^code [a-z0-9]{16}$/), "no-store"]);
  expect([denied.headers.get(ASK), kept(denied)]).toEqual(["deny", "no-store"]);
  // Sign-out: the answer asks the gate to end its cookies, and every sign-in of hers made until now is nobody's.
  const out = await ask("/auth/logout", ADA, { method: "POST", headers: { Origin: ORIGIN } });
  expect([out.status, out.headers.get(ASK), kept(out)]).toEqual([200, "out", "no-store"]);
  // The page goes on to the home page, after its frames.
  expect(/"to":"([^"]+)"/.exec(await out.text())![1]).toBe("/");
  // The server asks the gate to end the cookies of a sign-in from before it (another browser of hers, a copy).
  const old = await ask("/documents", ADA);
  expect([old.status, old.headers.get(ASK), kept(old)]).toEqual([302, "out", "no-store"]);
  // Whatever the route said of its answer: one that a shared cache would keep for the next browser, too.
  const shared = HttpServerResponse.text("a file", { headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
  expect(toWeb(asking(shared, "out")).headers.get("cache-control")).toBe("no-store");
  const later = person("sub-ada", "ada@example.com", "Ada", Date.now() + 1);
  expect((await ask("/documents", later)).status).toBe(200);
});

test("sign-out behind Cloudflare Access: the gate's cookies, the documents' site's frame, then Access's own sign-out", async () => {
  const { s, ask } = await front();
  await s.dir.config.set({ login: "tester", admin: true }, "usernames", "email");
  // Access's proof names her on each request: the gate says so in the caller (gate/core.ts: the issuer "access").
  const ada = { ...person("sub-ada", "ada@example.com", "Ada Lovelace"), p: "access" } as Caller;
  await ask("/auth/sso", ada);
  const out = await ask("/auth/logout", ada, { method: "POST", headers: { Origin: ORIGIN } });
  // First the answer asks the gate to end its cookies.
  expect([out.status, out.headers.get(ASK)]).toEqual([200, "out"]);
  // Then the page: its hidden frame on the documents' site, and last Access's own sign-out, on the app's host. Without
  // it Access's proof comes with the next page, and she is signed in again.
  const page = await out.text();
  const config = JSON.parse(/\{"to":[^<]*?\}/.exec(page)![0]) as { to: string; gate: string | null };
  expect(config.to).toBe("/cdn-cgi/access/logout");
  expect(config.gate).toMatch(/^https:\/\/accept\.[^/]+\/_edge\/sign-out$/);
  expect(signOutAt(ada)).toBe("/cdn-cgi/access/logout");
  // Any other sign-in ends with the gate's cookies: nowhere more to go. An agent's token is no sign-in of a browser.
  expect([signOutAt(ADA), signOutAt({ kind: "none" }), signOutAt({ kind: "agent", p: "access", sub: "sub-ada", g: "g" })]).toEqual([
    null,
    null,
    null,
  ]);
});

test("someone the gate lets through who may not join here: one page, which names how they signed in and no other way", async () => {
  const { s, ask } = await front();
  const admin = { login: "tester", admin: true };
  await s.dir.setAnyone(admin, "none");
  const refused = await ask("/auth/sso?next=%2Fdocuments", ADA);
  expect(refused.status).toBe(403);
  const said = await refused.text();
  expect(said).toContain("You signed in with <b>ada@example.com</b>. Ask an admin of this Erga server to add you, then sign in again.");
  expect(said).not.toContain("sign in with another account");
  expect(await s.dir.identities.find("sso", "sub-ada")).toBeNull();
});

test("documents on another site: the list of documents runs the gate's hand-off in a hidden frame, and the editor's page connects to the accept host early", async () => {
  const { s, ask } = await front();
  await s.dir.config.set({ login: "tester", admin: true }, "usernames", "email");
  await ask("/auth/sso", ADA);
  // (The app at erga.example, and the documents under localhost: two sites.)
  expect(await (await ask("/documents", ADA)).text()).toContain('<iframe hidden src="https://warm.localhost/erga-warm" title=""></iframe>');
  // The frame's page, once the gate's hand-off let it through: nothing, and no document's host is needed for it.
  const warm = await s.fetch("https://warm.localhost/erga-warm", { headers: { [FRONT]: KEY, ...calling({ kind: "member" }) } });
  expect([warm.status, await warm.text()]).toEqual([200, ""]);
  const at = (await ask("/new", ADA)).headers.get("location")!;
  const editor = await ask(at, ADA);
  expect(editor.status).toBe(200);
  expect(editor.headers.get("link")).toMatch(
    /^<https:\/\/[a-z0-9-]+\.localhost>; rel=preconnect, <https:\/\/accept\.localhost>; rel=preconnect$/
  );
  // A server with the gate inside it has no hand-off (anyone may come in): no frame, and no connection to make.
  const inside = app();
  expect(await (await inside.fetch("http://127.0.0.1/documents")).text()).not.toContain("erga-warm");
  const doc = (await inside.fetch("http://127.0.0.1/new")).headers.get("location")!;
  expect((await inside.fetch(`http://127.0.0.1${doc}`)).headers.get("link")).not.toContain("accept.");
});

test("documents on another site behind the gate: a document's page asks for no service worker of Erga's; on the app's own site it does", async () => {
  const { s } = await front();
  await s.dir.config.set({ login: "tester", admin: true }, "usernames", "email");
  /** The reader's settings in the page of a new document's frame, as the app at `origin` frames it. */
  const framed = async (origin: string, fetcher: (url: string, init?: RequestInit) => Promise<Response>, caller: Caller) => {
    const at = (await fetcher(`${origin}/new`, { redirect: "manual", headers: calling(caller) })).headers.get("location")!;
    const editor = await (await fetcher(origin + at, { headers: calling(caller) })).text();
    const frame = /https?:\/\/[a-z0-9]+-[a-z0-9-]+\.localhost\/t\/[\w.-]+\//.exec(editor)![0];
    const page = await fetcher(frame, { headers: { ...calling({ kind: "member" }), "sec-fetch-dest": "iframe" } });
    return /"worker":(true|false)/.exec(await page.text())?.[1];
  };
  const gated = (url: string, init: RequestInit = {}) =>
    s.fetch(url, { ...init, headers: { [FRONT]: KEY, ...(init.headers as Record<string, string>) } });
  await gated(`${ORIGIN}/auth/sso`, { headers: calling(ADA) });
  // (The app at erga.example, and the documents under localhost: another site. The gate's member cookie is another
  // site's in the frame there, and no browser sends it with a worker's requests: dev/gate-browsers.ts.)
  expect(await framed(ORIGIN, gated, ADA)).toBe("false");
  // The app at localhost: the documents (<id>.localhost) are on its own site.
  expect(await framed("https://localhost", gated, ADA)).toBe("true");
  // A server with the gate inside it has no member cookie to need: the worker is there, on another site too.
  const inside = app();
  const dev: Caller = { kind: "none" };
  expect(await framed("http://127.0.0.1", (url, init) => inside.fetch(url, init), dev)).toBe("true");
});
