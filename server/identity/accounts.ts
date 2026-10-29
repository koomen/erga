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
//   GET  /auth/dev                 ?provider=&subject=&handle=&name=&email=&verified=&org=&hd=&picture=:
//                                  local development only: a pretend provider's sign-in, through the same steps

import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Platform, Session } from "../platform.ts";
import { inlineScript, inlineStyle, page, safeNext } from "../pages/index.ts";
import { call, ctx, Field, form, json, plainJson, redirect, text, type Route } from "../http.ts";
import { esc } from "../../shared/html.ts";
import { type Directory, label, NotAllowed, type SignInProvider, type Vouched } from "../directory/index.ts";
import { cookies, withCookie } from "./cookies.ts";
import { sign, unsign } from "./session.ts";
import { clearState, signIn } from "./sign-in.ts";

const JOIN = "erga_join";
const JOIN_SECONDS = 30 * 60;

/** Where a sign-in goes next. */
export type Outcome =
  | { kind: "in"; login: string; claimed?: boolean }
  | { kind: "new"; suggestion: string; taken?: string }
  | { kind: "refused"; login?: string; taken?: string };

/**
 * Whether someone a provider vouched for may make a new account here: an admin added them (Users), or a group rule
 * matches them with read or write (Access). Local development stands in for an admin while the group rules are as a
 * server starts: everyone may join there, and may write. A group's rule decides there as anywhere.
 */
export async function mayJoin(platform: Pick<Platform, "dev" | "directory">, url: URL, v: Vouched): Promise<boolean> {
  if (await platform.directory.mayJoin(v)) return true;
  if (!platform.dev(url)) return false;
  return platform.directory.defaultRules(await platform.directory.rules.all());
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
    users.forget(known.login);
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
      users.forget(row.login);
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
export const vouchedSignIn = Effect.fnUntraced(function* (
  platform: Platform,
  request: Request,
  v: Vouched,
  next: string,
  o: { onlyAdmins?: boolean },
  after?: (login: string) => Promise<void>
) {
  const url = new URL(request.url);
  const dev = platform.dev(url);
  const join = !o.onlyAdmins && (yield* call(() => mayJoin(platform, url, v)));
  const outcome = yield* call(() => resolve(platform.directory, v, { join, create: dev, onlyAdmins: o.onlyAdmins }));
  if (outcome.kind == "refused") return outcome.taken ? takenPage(v, outcome.taken) : yield* refusedPage(platform, v, outcome.login);
  if (outcome.kind == "new") return yield* toUsernameStep(platform, request, v, next, outcome.taken);
  // A provider that's off signs in only admins (their test sign-in, from /admin/auth).
  if (o.onlyAdmins && !(yield* call(() => platform.directory.users.isAdmin(outcome.login))))
    return page(
      `${label(v.provider)} sign-in is off`,
      `This server doesn't take sign-in with ${esc(label(v.provider))}. <a href="/auth/sign-in?next=${encodeURIComponent(safeNext(next))}">Sign in another way</a>.`,
      403
    );
  if (after) yield* call(() => after(outcome.login));
  return yield* signIn(platform, request, sessionFor(outcome.login, v), safeNext(next));
});

const sessionFor = (login: string, v: Vouched): Session => ({ login, name: v.name?.trim().split(/\s+/)[0] || login });

/** A GitHub login whose Erga account is someone else's (another GitHub id, or another provider). */
const takenNote = (login: string) => `The Erga account <b>${esc(login)}</b> is someone else's: it doesn't sign in with this GitHub account. A GitHub login that changes hands never brings its Erga account with it.`;

function takenPage(v: Vouched, login: string) {
  return page("Not your account", `${takenNote(login)} You signed in with ${esc(label(v.provider))} as <b>${esc(v.handle)}</b>, and this server is invite-only: ask an admin to add you under another username.`, 403);
}

/** Who the access rules let in, and why this person isn't one of them: in place, so they know what to ask for. */
const refusedPage = Effect.fnUntraced(function* (platform: Platform, v: Vouched, login?: string) {
  const who = login ?? v.handle;
  const rules = yield* call(() => platform.directory.rules.all().catch(() => []));
  const workspaces = rules.filter((r) => r.kind == "workspace" && r.access != "none").map((r) => `<b>${esc(r.value)}</b>`);
  const orgs = rules.filter((r) => r.kind == "github_org" && r.access != "none").map((r) => `<b>${esc(r.value)}</b>`);
  const ways = ["the people an admin added"];
  if (workspaces.length) ways.push(`Google Workspace accounts of ${workspaces.join(" or ")}`);
  if (orgs.length) ways.push(`members of the GitHub organization${orgs.length > 1 ? "s" : ""} ${orgs.join(" or ")}`);
  let why = `<b>${esc(who)}</b> (${esc(label(v.provider))}) isn't one of them.`;
  if (v.provider == "github" && orgs.length) {
    why += ` GitHub says this account is an active member of ${v.orgs?.length ? v.orgs.map((o) => esc(o)).join(", ") : "no organization Erga can see"}. If you are a member, the organization may not let Erga see it yet: an owner of the organization approves Erga on GitHub.`;
  }
  if (v.provider == "google" && workspaces.length) why += v.hd ? ` Google says this account is in the Workspace ${esc(v.hd)}.` : " This is a personal Google account: it's in no Google Workspace organization.";
  return page("Not on this server", `This server lets in ${ways.join(", ")}. ${why} An admin can add you on the Users page.`, 403);
});

// ------------------------------------------------------------ the username step

interface Pending { v: Vouched; next: string; exp: number; taken?: string }

/** An answer that sets (or, with "" and 0, clears) the username step's cookie too. */
const withJoin = (response: Parameters<typeof withCookie>[0], request: Request, value: string, maxAge: number) =>
  withCookie(response, request, JOIN, value, maxAge, "/auth");

/** On to the username step, with its cookie: who they are, signed, for half an hour. */
const toUsernameStep = Effect.fnUntraced(function* (platform: Platform, request: Request, v: Vouched, next: string, taken?: string) {
  const pending: Pending = { v, next: safeNext(next), exp: Math.floor(Date.now() / 1000) + JOIN_SECONDS, ...(taken ? { taken } : {}) };
  const value = yield* call(() => sign(platform.secret, `join:${Base64Url.encode(JSON.stringify(pending))}`));
  return clearState(withJoin(redirect("/auth/username", 302, { "Cache-Control": "no-store" }), request, value, JOIN_SECONDS), request);
});

async function pendingOf(platform: Platform, request: Request): Promise<Pending | null> {
  const raw = cookies(request).get(JOIN);
  const value = raw && (await unsign(platform.secret, raw));
  if (!value?.startsWith("join:")) return null;
  try {
    const p = JSON.parse(Result.getOrThrow(Base64Url.decodeString(value.slice("join:".length)))) as Pending;
    return p.exp > Date.now() / 1000 && p.v?.subject ? p : null;
  } catch { return null; }
}

/** /auth/username: choose a username, for a new account. */
export const usernameStep: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  const pending = yield* call(() => pendingOf(platform, request));
  if (request.method == "GET" && url.searchParams.has("check")) {
    if (!pending) return plainJson({ problem: "This sign-in expired: sign in again." }, 400);
    const problem = yield* call(() => platform.directory.identities.usernameProblem(url.searchParams.get("check") ?? ""));
    return json(problem ? { problem } : { ok: true });
  }
  if (!pending) return page("Sign-in expired", "This sign-in waited too long, or it finished already. <a href=\"/auth/sign-in\">Sign in again</a>.", 400);
  const { v } = pending;
  if (request.method == "GET") return usernamePage(v, yield* call(() => platform.directory.identities.suggest(v)), null, pending.taken);
  if (request.method != "POST") return text("Not allowed", 405);
  if (request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const { username } = yield* form(UsernameForm).pipe(Effect.orElseSucceed(() => ({ username: "" })));
  const wanted = username.trim().toLowerCase();
  // Who may join is asked again: a rule could have changed while they chose.
  if (!(yield* call(() => mayJoin(platform, url, v)))) return yield* refusedPage(platform, v);
  // The role an admin added them with (their wait ends), or none (a group's rule let them in), or local
  // development's (everyone may there): write.
  const dir = platform.directory;
  const login = yield* Effect.tryPromise({
    try: async () => {
      const { may, person } = await dir.joining(v);
      return dir.identities.createAccount(
        wanted,
        v,
        person ? { role: person.role, extra: [dir.people.claimed(person.id)] } : may ? {} : { role: "write" }
      );
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchIf(
      (e): e is NotAllowed => e instanceof NotAllowed,
      (e) => Effect.succeed(e)
    ),
    Effect.orDie
  );
  if (login instanceof NotAllowed) return usernamePage(v, wanted, login.message, pending.taken);
  return withJoin(yield* signIn(platform, request, sessionFor(login, v), pending.next), request, "", 0);
});

const UsernameForm = Schema.Struct({ username: Field });

function usernamePage(v: Vouched, value: string, error: string | null, taken?: string) {
  const body = `${taken ? `${takenNote(taken)}</p><p>` : ""}Welcome. You signed in with ${esc(label(v.provider))} as <b>${esc(v.handle)}</b>. Choose a username for your Erga account: it is in the address of each of your documents (/<i>username</i>/…).</p>
<form method="post" action="/auth/username" class="username" novalidate>
  <label for="username">Username</label>
  <p class="row"><input class="input" id="username" name="username" value="${esc(value)}" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="39" required autofocus>
  <button class="new" type="submit">Make my account</button></p>
  <p class="hint${error ? " error" : ""}" role="status" id="username-hint">${error ? esc(error) : "Lowercase letters, digits and dashes."}</p>
</form>
<style>${inlineStyle("username")}</style>
${inlineScript("username")}<p>`;
  return page("Choose a username", body, error ? 400 : 200);
}

// ------------------------------------------------------------ local development's pretend provider

/** /auth/dev: a pretend provider's answer, for trying the sign-in steps and for the end-to-end tests (local development only). */
export const devSignIn: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  if (!platform.dev(url)) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  const q = url.searchParams;
  const provider = (q.get("provider") == "google" ? "google" : "github") as SignInProvider;
  const subject = q.get("subject")?.trim();
  const handle = q.get("handle")?.trim();
  if (!subject || !handle) return page("Not enough", "Give the pretend identity's subject= and handle=.", 400);
  const emails = q.getAll("email").filter(Boolean).map((email) => ({ email: email.toLowerCase(), verified: q.get("verified") != "0" }));
  const orgs = provider == "github" ? q.getAll("org").filter(Boolean).map((o) => o.toLowerCase()) : null;
  const hd = provider == "google" ? q.get("hd")?.toLowerCase() || null : null;
  const picture = provider == "google" ? q.get("picture") || null : null;
  return yield* vouchedSignIn(
    platform,
    request,
    { provider, subject, handle, name: q.get("name") || null, emails, orgs, hd, picture },
    q.get("next") ?? "/",
    {}
  );
});
