// Which account a sign-in is: the step after a provider (GitHub, Google)
// says who someone is (a `Vouched`), the same for each provider.
//
//   1. An identity already linked (by the provider's subject id) signs in to
//      its account, whatever its email or login is now. Its verified
//      addresses are kept again, but never move it to another account.
//   2. A new identity links, once, to the account it shares a verified
//      address with (Google's email_verified; GitHub's /user/emails, any
//      verified one; never a GitHub noreply address). A GitHub identity
//      whose login names an account with no identity at all (one from before
//      identities, or one an admin added by GitHub login) links to it too:
//      the accounts from before keep their GitHub login as their username.
//   3. Not when that's ambiguous: when the address matches two accounts, or
//      the account already has an identity of this provider, nothing is
//      linked, and the page says so and lets them choose (sign in to an
//      account of theirs, or make a new one).
//   4. Anyone else who may join makes a new account: they choose a username
//      first (/auth/username). Until they do, who they are waits in a signed
//      cookie for half an hour, and nothing is written.
//
// A signed-in person also links or unlinks the other provider by hand, on
// /settings (server/api.ts, with sign-in.ts's link flow).
//
//   GET  /auth/username            the username step: a username to choose, for a new account
//   GET  /auth/username ?check=    whether a username is free: {ok} or {problem}
//   POST /auth/username            username: makes the account, signs in, goes on to `next`
//   GET  /auth/dev                 ?provider=&subject=&handle=&name=&email=&verified=[&link=1]:
//                                  local development only: a pretend provider's sign-in, through the same steps

import type { Platform, Session } from "../platform.ts";
import { esc, page, safeNext } from "../pages/index.ts";
import { type Directory, label, linkable, NotAllowed, type SignInProvider, type Vouched } from "../directory/index.ts";
import { cookieName, cookies } from "./cookies.ts";
import { b64, sign, unb64, unsign } from "./session.ts";
import { clearCookie, signIn } from "./sign-in.ts";
import { providersOn } from "./settings.ts";

const JOIN = "erga_join";
const JOIN_SECONDS = 30 * 60;

/** Where a sign-in goes next. */
export type Outcome =
  | { kind: "in"; login: string; linked?: boolean }
  | { kind: "new"; suggestion: string; taken?: string }
  | { kind: "refused"; login?: string; taken?: string }
  /** Not linked: the address matches several accounts, or the one it matches already has an identity of this provider. */
  | { kind: "choose"; why: "several" | "has-provider"; accounts: { login: string; providers: SignInProvider[] }[]; join: boolean };

/** Whether someone a provider vouched for may make a new account here. */
export async function mayJoin(platform: Pick<Platform, "dev">, url: URL, _v: Vouched): Promise<boolean> {
  // Local development: everyone may (as everyone may sign in there).
  return platform.dev(url);
}

/**
 * The account a vouched-for identity signs in to, or the username step, or a choice, or no (the steps at the top of
 * this file). `onlyAdmins`: the provider is off, so it links nothing new.
 */
export async function resolve(dir: Directory, v: Vouched, o: { join: boolean; create?: boolean; onlyAdmins?: boolean }): Promise<Outcome> {
  const { users, identities } = dir;
  const known = await identities.find(v.provider, v.subject);
  if (known) {
    const user = await users.signedIn(known.login, v.name, { create: o.create });
    if (!user) return { kind: "refused", login: known.login };
    // The addresses it has now are kept; the account stays the one its id names.
    await identities.used(v);
    await identities.refreshEmails(known.login, v);
    return { kind: "in", login: user.login };
  }
  // A new identity: the accounts it may be. One that shares a verified address (never a GitHub noreply one).
  const candidates = new Set<string>();
  for (const login of await identities.accountsWithEmails(linkable(v))) if (await users.get(login)) candidates.add(login);
  // A GitHub login that names an account with no identity at all (from before identities, or added by an admin).
  // When it's another person's (it has an identity), this person took the login: they never get that account.
  let taken: string | undefined;
  if (v.provider == "github") {
    const row = await users.get(v.handle);
    if (row && (await identities.unclaimed(row.login))) candidates.add(row.login);
    else if (row && !candidates.has(row.login)) taken = row.login;
  }
  if (candidates.size > 1 || (candidates.size == 1 && (await identities.of([...candidates][0])).some((i) => i.provider == v.provider))) {
    if (o.onlyAdmins) return { kind: "refused" };
    const accounts = await Promise.all([...candidates].map(async (login) => ({ login, providers: (await identities.of(login)).map((i) => i.provider) })));
    return { kind: "choose", why: candidates.size > 1 ? "several" : "has-provider", accounts, join: o.join };
  }
  if (candidates.size == 1) {
    const login = [...candidates][0];
    if (o.onlyAdmins && !(await users.isAdmin(login))) return { kind: "refused" };
    await identities.link(login, v);
    const user = await users.signedIn(login, v.name, { create: o.create });
    return user ? { kind: "in", login: user.login, linked: true } : { kind: "refused", login };
  }
  if (!o.join) return taken ? { kind: "refused", taken } : { kind: "refused" };
  return taken ? { kind: "new", suggestion: await identities.suggest(v), taken } : { kind: "new", suggestion: await identities.suggest(v) };
}

// ------------------------------------------------------------ after a provider's answer

/**
 * A provider vouched for someone: sign them in to their account, or on to the username step, or say why not.
 * `after`: what runs once they're in (a test sign-in's result), with their account's login.
 */
export async function vouchedSignIn(platform: Platform, request: Request, v: Vouched, next: string, o: { onlyAdmins?: boolean; linkTo?: string | null }, after?: (login: string) => Promise<void>): Promise<Response> {
  const url = new URL(request.url);
  if (o.linkTo) return linkByHand(platform, request, v, o.linkTo, next);
  const dev = platform.dev(url);
  const outcome = await resolve(platform.directory, v, { join: !o.onlyAdmins && (await mayJoin(platform, url, v)), create: dev, onlyAdmins: o.onlyAdmins });
  if (outcome.kind == "refused") return outcome.taken ? takenPage(v, outcome.taken) : refusedPage(v, outcome.login);
  if (outcome.kind == "new") return toUsernameStep(platform, request, v, next, outcome.taken);
  if (outcome.kind == "choose") return choosePage(platform, request, v, next, outcome);
  // A provider that's off signs in only admins (their test sign-in, from /admin/auth).
  if (o.onlyAdmins && !(await platform.directory.users.isAdmin(outcome.login))) return page(`${label(v.provider)} sign-in is off`, `This server doesn't take sign-in with ${esc(label(v.provider))}. <a href="/auth/sign-in?next=${encodeURIComponent(safeNext(next))}">Sign in another way</a>.`, 403);
  await after?.(outcome.login);
  return signIn(platform, request, sessionFor(outcome.login, v), safeNext(next));
}

const sessionFor = (login: string, v: Vouched): Session => ({ login, name: v.name?.trim().split(/\s+/)[0] || login });

/** A GitHub login whose Erga account is someone else's (another GitHub id, or another provider). */
const takenNote = (login: string) => `The Erga account <b>${esc(login)}</b> is someone else's: it doesn't sign in with this GitHub account. A GitHub login that changes hands never brings its Erga account with it.`;

function takenPage(v: Vouched, login: string): Response {
  return page("Not your account", `${takenNote(login)} You signed in with ${esc(label(v.provider))} as <b>${esc(v.handle)}</b>, and this server is invite-only: ask an admin to add you under another username.`, 403);
}

/**
 * The address matched more than one account, or one that already signs in with another account of this provider: not
 * linked. The page says what happened, and lets them choose: sign in to an account they have with its own sign-in, or
 * make a new one (where they may join; who they are waits in the username step's cookie).
 */
async function choosePage(platform: Platform, request: Request, v: Vouched, next: string, o: Extract<Outcome, { kind: "choose" }>): Promise<Response> {
  const on = await providersOn(platform);
  const what = o.why == "several"
    ? `Your ${esc(label(v.provider))} address matches ${o.accounts.length} Erga accounts, so Erga didn't link it to any of them.`
    : `Your ${esc(label(v.provider))} address matches the Erga account <b>${esc(o.accounts[0].login)}</b>, but that account already signs in with another ${esc(label(v.provider))} account, so Erga didn't link this one.`;
  const ways = o.accounts.map((a) => {
    const providers = a.providers.filter((p) => on[p]);
    const buttons = providers.map((p) => `<a class="new sign-in" href="/auth/${p}?next=${encodeURIComponent(safeNext(next))}">Sign in to ${esc(a.login)} with ${esc(label(p))}</a>`).join(" ");
    return buttons || `<span>${esc(a.login)} signs in with a provider that's off here.</span>`;
  }).join("</p><p>");
  const body = `${what} You signed in as <b>${esc(v.handle)}</b>.</p><p><b>Is one of them yours?</b> Sign in to it the way it signs in now; then you can link this ${esc(label(v.provider))} account on Settings, if it has none yet.</p><p>${ways}</p>${o.join ? `<p><b>Or make a new account</b> with this ${esc(label(v.provider))} account. <a class="new" href="/auth/username">Make a new account</a>` : "<p>This server is invite-only, so it can't make a new account for you."}`;
  const answer = page("Which account?", body, 409);
  if (o.join) answer.headers.append("Set-Cookie", await pendingCookie(platform, request, v, next));
  answer.headers.append("Set-Cookie", clearCookie(request));
  return answer;
}

function refusedPage(v: Vouched, login?: string): Response {
  const who = login ?? v.handle;
  return page("Invite only", `Erga is invite-only for now, and <b>${esc(who)}</b> (${esc(label(v.provider))}) isn't on the list yet.`, 403);
}

// ------------------------------------------------------------ linking by hand (/settings)

/**
 * The signed-in person linked this provider on /settings: it links to their own account, unless the identity signs in
 * to another account, or theirs has one of this provider already. The page says which, in place.
 */
async function linkByHand(platform: Platform, request: Request, v: Vouched, login: string, next: string): Promise<Response> {
  const session = await platform.sessionOf(request);
  if (session?.login.toLowerCase() != login || session.agent || session.test) return page("Sign-in changed", "You aren't signed in as the account this link was for any more. <a href=\"/settings\">Settings</a>", 400);
  const { identities } = platform.directory;
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${safeNext(next)}${safeNext(next).includes("?") ? "&" : "?"}${q}`, "Cache-Control": "no-store" } });
  const known = await identities.find(v.provider, v.subject);
  if (known?.login == login) {
    await identities.refreshEmails(login, v);
    return back(`linked=${v.provider}`);
  }
  if (known) return page("Not linked", `This ${esc(label(v.provider))} account (${esc(v.handle)}) already signs in to another Erga account, <b>${esc(known.login)}</b>. Sign in there and unlink it on Settings first, or link another ${esc(label(v.provider))} account. <a href="/settings">Settings</a>`, 409);
  try {
    await identities.link(login, v);
  } catch (e) {
    if (e instanceof NotAllowed) return page("Not linked", `${esc(e.message)} Unlink that one on Settings first. <a href="/settings">Settings</a>`, 409);
    throw e;
  }
  return back(`linked=${v.provider}`);
}

// ------------------------------------------------------------ the username step

interface Pending { v: Vouched; next: string; exp: number; taken?: string }

const cookieFor = (request: Request, value: string, maxAge: number) =>
  `${cookieName(request, JOIN)}=${value}; Path=/auth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol == "https:" ? "; Secure" : ""}`;

/** The username step's cookie: who they are, signed, for half an hour. */
async function pendingCookie(platform: Platform, request: Request, v: Vouched, next: string, taken?: string): Promise<string> {
  const pending: Pending = { v, next: safeNext(next), exp: Math.floor(Date.now() / 1000) + JOIN_SECONDS, ...(taken ? { taken } : {}) };
  const value = await sign(platform.secret, `join:${b64(new TextEncoder().encode(JSON.stringify(pending)))}`);
  return cookieFor(request, value, JOIN_SECONDS);
}

async function toUsernameStep(platform: Platform, request: Request, v: Vouched, next: string, taken?: string): Promise<Response> {
  const headers = new Headers({ Location: "/auth/username", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", await pendingCookie(platform, request, v, next, taken));
  headers.append("Set-Cookie", clearCookie(request));
  return new Response(null, { status: 302, headers });
}

async function pendingOf(platform: Platform, request: Request): Promise<Pending | null> {
  const raw = cookies(request).get(JOIN);
  const value = raw && (await unsign(platform.secret, raw));
  if (!value?.startsWith("join:")) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64(value.slice("join:".length)))) as Pending;
    return p.exp > Date.now() / 1000 && p.v?.subject ? p : null;
  } catch { return null; }
}

/** /auth/username: choose a username, for a new account. */
export async function usernameStep(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pending = await pendingOf(platform, request);
  if (request.method == "GET" && url.searchParams.has("check")) {
    if (!pending) return Response.json({ problem: "This sign-in expired: sign in again." }, { status: 400 });
    const problem = await platform.directory.identities.usernameProblem(url.searchParams.get("check") ?? "");
    return Response.json(problem ? { problem } : { ok: true }, { headers: { "Cache-Control": "no-store" } });
  }
  if (!pending) return page("Sign-in expired", "This sign-in waited too long, or it finished already. <a href=\"/auth/sign-in\">Sign in again</a>.", 400);
  const { v } = pending;
  if (request.method == "GET") return usernamePage(v, await platform.directory.identities.suggest(v), null, pending.taken);
  if (request.method != "POST") return new Response("Not allowed", { status: 405 });
  if (request.headers.get("origin") != url.origin) return new Response("Forbidden", { status: 403 });
  const form = await request.formData().catch(() => null);
  const wanted = String(form?.get("username") ?? "").trim().toLowerCase();
  // Who may join is asked again: a rule could have changed while they chose.
  if (!(await mayJoin(platform, url, v))) return refusedPage(v);
  try {
    const login = await platform.directory.identities.createAccount(wanted, v);
    const answer = await signIn(platform, request, sessionFor(login, v), pending.next);
    answer.headers.append("Set-Cookie", cookieFor(request, "", 0));
    return answer;
  } catch (e) {
    if (e instanceof NotAllowed) return usernamePage(v, wanted, e.message, pending.taken);
    throw e;
  }
}

function usernamePage(v: Vouched, value: string, error: string | null, taken?: string): Response {
  const body = `${taken ? `${takenNote(taken)}</p><p>` : ""}Welcome. You signed in with ${esc(label(v.provider))} as <b>${esc(v.handle)}</b>. Choose a username for your Erga account: it is in the address of each of your documents (/<i>username</i>/…).</p>
<form method="post" action="/auth/username" class="username" novalidate>
  <label for="username">Username</label>
  <p class="row"><input class="input" id="username" name="username" value="${esc(value)}" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="39" required autofocus>
  <button class="new" type="submit">Make my account</button></p>
  <p class="hint${error ? " error" : ""}" role="status" id="username-hint">${error ? esc(error) : "Lowercase letters, digits and dashes."}</p>
</form>
<style>
  form.username label { display: block; font-weight: 600; margin-bottom: 6px; }
  form.username .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0; }
  form.username .input { flex: 1; min-width: 180px; font: inherit; padding: 8px 10px; border: 1px solid var(--line, #8886); border-radius: 8px; background: transparent; color: inherit; }
  form.username .hint { font-size: 13px; color: var(--chrome); margin-top: 8px; }
  form.username .hint.error { color: #c0392b; }
</style>
<script>
  const input = document.getElementById("username"), hint = document.getElementById("username-hint");
  let timer = 0, asked = "";
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const name = input.value.trim().toLowerCase();
      if (!name || name == asked) return;
      asked = name;
      try {
        const r = await (await fetch("/auth/username?check=" + encodeURIComponent(name))).json();
        if (asked != name) return;
        hint.textContent = r.ok ? '"' + name + '" is free.' : r.problem;
        hint.classList.toggle("error", !r.ok);
      } catch {}
    }, 250);
  });
</script><p>`;
  return page("Choose a username", body, error ? 400 : 200);
}

// ------------------------------------------------------------ local development's pretend provider

/** /auth/dev: a pretend provider's answer, for trying the sign-in steps and for the end-to-end tests (local development only). */
export async function devSignIn(platform: Platform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!platform.dev(url)) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const q = url.searchParams;
  const provider = (q.get("provider") == "google" ? "google" : "github") as SignInProvider;
  const subject = q.get("subject")?.trim();
  const handle = q.get("handle")?.trim();
  if (!subject || !handle) return page("Not enough", "Give the pretend identity's subject= and handle=.", 400);
  const emails = q.getAll("email").filter(Boolean).map((email) => ({ email: email.toLowerCase(), verified: q.get("verified") != "0" }));
  const linkTo = q.get("link") == "1" ? (await platform.sessionOf(request))?.login.toLowerCase() ?? null : null;
  return vouchedSignIn(platform, request, { provider, subject, handle, name: q.get("name") || null, emails }, q.get("next") ?? "/", { linkTo });
}
