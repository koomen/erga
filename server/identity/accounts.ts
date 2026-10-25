// Which account a sign-in is: the step after a provider (GitHub, Google)
// says who someone is (a `Vouched`), the same for each provider.
//
//   1. An identity already linked (by the provider's subject id: GitHub's
//      numeric id, Google's sub) signs in to its account, whatever its email
//      or login is now. Each GitHub account and each Google account is its
//      own Erga account: nothing links two of them, by email or otherwise.
//   2. A GitHub identity whose login names an account with no identity at all
//      (one from before identities, or one an admin added by GitHub login)
//      claims it, once: the accounts from before keep their GitHub login as
//      their username. An account that has an identity is never claimed by a
//      login: a login that changed hands is refused, and the page says so.
//   3. Anyone else who may join makes a new account: they choose a username
//      first (/auth/username). Until they do, who they are waits in a signed
//      cookie for half an hour, and nothing is written.
//
// The email a provider vouches for (Google's, only when email_verified) is
// kept for the access rules' domains (server/directory/access.ts), never to
// find an account.
//
//   GET  /auth/username            the username step: a username to choose, for a new account
//   GET  /auth/username ?check=    whether a username is free: {ok} or {problem}
//   POST /auth/username            username: makes the account, signs in, goes on to `next`
//   GET  /auth/dev                 ?provider=&subject=&handle=&name=&email=&verified=&org=:
//                                  local development only: a pretend provider's sign-in, through the same steps

import type { Platform, Session } from "../platform.ts";
import { esc, page, safeNext } from "../pages/index.ts";
import { type Directory, label, NotAllowed, ruleLets, vouchedEmails, type SignInProvider, type Vouched } from "../directory/index.ts";
import { cookieName, cookies } from "./cookies.ts";
import { b64, sign, unb64, unsign } from "./session.ts";
import { clearCookie, signIn } from "./sign-in.ts";

const JOIN = "erga_join";
const JOIN_SECONDS = 30 * 60;

/** Where a sign-in goes next. */
export type Outcome =
  | { kind: "in"; login: string; claimed?: boolean }
  | { kind: "new"; suggestion: string; taken?: string }
  | { kind: "refused"; login?: string; taken?: string };

/**
 * Whether someone a provider vouched for may make a new account here. Local development stands in for an admin's add
 * while the read rule lets in listed accounts only (the default): everyone may join there. A rule an admin set with
 * domains or organizations decides there as anywhere.
 */
export async function mayJoin(platform: Pick<Platform, "dev" | "directory">, url: URL, v: Vouched): Promise<boolean> {
  if (await platform.directory.mayJoin(v)) return true;
  const rule = await platform.directory.config.get("access_read");
  return platform.dev(url) && rule.mode == "some" && !rule.domains.length && !rule.orgs.length;
}

/**
 * The account a vouched-for identity signs in to, or the username step, or no (the steps at the top of this file).
 * `onlyAdmins`: the provider is off, so it claims nothing.
 */
export async function resolve(dir: Directory, v: Vouched, o: { join: boolean; create?: boolean; onlyAdmins?: boolean }): Promise<Outcome> {
  const { users, identities } = dir;
  const known = await identities.find(v.provider, v.subject);
  if (known) {
    // Its verified email now, for the domain rules, first: the read rule may depend on it.
    await identities.used(v);
    await identities.refreshEmails(known.login, v);
    dir.forgetAccess(known.login);
    const user = await users.signedIn(known.login, v.name, { create: o.create });
    if (!user) return { kind: "refused", login: known.login };
    return { kind: "in", login: user.login };
  }
  let taken: string | undefined;
  if (v.provider == "github") {
    const row = await users.get(v.handle);
    if (row && (await identities.unclaimed(row.login))) {
      if (o.onlyAdmins && !(await users.isAdmin(row.login))) return { kind: "refused" };
      await identities.link(row.login, v);
      const user = await users.signedIn(row.login, v.name, { create: o.create });
      return user ? { kind: "in", login: user.login, claimed: true } : { kind: "refused", login: row.login };
    }
    if (row) taken = row.login;
  }
  if (!o.join) return taken ? { kind: "refused", taken } : { kind: "refused" };
  return taken ? { kind: "new", suggestion: await identities.suggest(v), taken } : { kind: "new", suggestion: await identities.suggest(v) };
}

// ------------------------------------------------------------ after a provider's answer

/**
 * A provider vouched for someone: sign them in to their account, or on to the username step, or say why not.
 * `after`: what runs once they're in (a test sign-in's result), with their account's login.
 */
export async function vouchedSignIn(platform: Platform, request: Request, v: Vouched, next: string, o: { onlyAdmins?: boolean }, after?: (login: string) => Promise<void>): Promise<Response> {
  const url = new URL(request.url);
  const dev = platform.dev(url);
  const outcome = await resolve(platform.directory, v, { join: !o.onlyAdmins && (await mayJoin(platform, url, v)), create: dev, onlyAdmins: o.onlyAdmins });
  if (outcome.kind == "refused") return outcome.taken ? takenPage(v, outcome.taken) : refusedPage(platform, v, outcome.login);
  if (outcome.kind == "new") return toUsernameStep(platform, request, v, next, outcome.taken);
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

/** Who the read rule lets in, and why this person isn't one of them: in place, so they know what to ask for. */
async function refusedPage(platform: Platform, v: Vouched, login?: string): Promise<Response> {
  const who = login ?? v.handle;
  const rule = await platform.directory.config.get("access_read").catch(() => null);
  const ways = ["accounts an admin listed"];
  if (rule?.domains.length) ways.push(`Google accounts with a verified email on ${rule.domains.map((d) => `<b>${esc(d)}</b>`).join(" or ")}`);
  if (rule?.orgs.length) ways.push(`GitHub accounts in the organization${rule.orgs.length > 1 ? "s" : ""} ${rule.orgs.map((o) => `<b>${esc(o)}</b>`).join(" or ")}`);
  let why = `<b>${esc(who)}</b> (${esc(label(v.provider))}) isn't one of them.`;
  if (v.provider == "github" && rule?.orgs.length) {
    why += ` GitHub says this account is an active member of ${v.orgs?.length ? v.orgs.map((o) => esc(o)).join(", ") : "none of the organizations Erga can see"}. If you are a member, the organization may not let Erga see it yet: an owner of the organization approves Erga on GitHub.`;
  }
  if (v.provider == "google" && rule?.domains.length && !v.emails.some((e) => e.verified)) why += " Google didn't say your email is verified.";
  if (v.provider == "github" && rule?.domains.length && !rule.orgs.length) why += " Email domains count for Google accounts only: GitHub doesn't vouch for an email at sign-in.";
  return page("Not on this server", `This server lets in ${ways.join(", ")}. ${why} An admin can add you on the Users page.`, 403);
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
  if (!(await mayJoin(platform, url, v))) return refusedPage(platform, v);
  try {
    // Listed when an admin invited their address (with the invitation's role), or when only local development let them
    // join (everyone may there); unlisted when a rule (anyone, domains) did.
    const dir = platform.directory, emails = vouchedEmails(v);
    const invite = await dir.users.invitationFor(emails);
    const byRule = ruleLets(await dir.config.get("access_read"), { emails, orgs: v.provider == "github" ? v.orgs ?? [] : [] });
    const login = await dir.identities.createAccount(wanted, v, {
      listed: !!invite || !byRule, role: invite?.role ?? "user",
      extra: invite ? [["DELETE FROM invites WHERE email = ?1", invite.email]] : [],
    });
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
  const orgs = provider == "github" ? q.getAll("org").filter(Boolean).map((o) => o.toLowerCase()) : null;
  return vouchedSignIn(platform, request, { provider, subject, handle, name: q.get("name") || null, emails, orgs }, q.get("next") ?? "/", {});
}
