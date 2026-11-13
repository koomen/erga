// Which account a sign-in is: the step after a sign-in, of either mode
// (mode.ts), says who someone is (a `Vouched`), the same for each provider.
// Nothing here asks which provider it is, or the mode.
//
//   1. An identity already linked (by the provider's subject id) signs in to
//      its account, whatever its email or login is now. Each provider's
//      account is its own Erga account: nothing links two of them, by email
//      or otherwise.
//   2. An identity whose old login (Vouched.oldLogin: a GitHub login) names an
//      account with no identity at all (one from before identities) claims
//      it, once: the accounts from before keep that login as their username.
//      An account that has an identity is never claimed by a login: a login
//      that changed hands is taken, and its person gets another username.
//   3. Anyone else who may join makes a new account. Where this sign-in is the
//      server's one way in and its names are one person's each, Erga names the
//      account itself, at once (namesItself). Else they choose a username first
//      (/auth/username): until they do, who they are waits in a signed cookie
//      for half an hour, and nothing is written.
//   4. Anyone who may not join sees one page (refusedPage), which says nothing
//      of who may: the server's access rules are private.
//
// The emails a provider verified are kept to match a person an admin added
// by an email (server/directory/people.ts), never to find an account.
// (The routes /auth/username and /auth/dev are rows of server/app.ts's list.)

import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Platform, Session } from "../platform.ts";
import { inlineScript, inlineStyle, page, safeNext } from "../pages/index.ts";
import { call, ctx, Field, form, json, plainJson, redirect, text, type Route } from "../http.ts";
import { esc } from "../../shared/html.ts";
import { type Directory, groupOf, label, NotAllowed, type RuleKind, type Vouched } from "../directory/index.ts";
import { safeAvatar } from "../../shared/avatars.ts";
import { SIGN_IN_PROVIDERS, signedInWith } from "../../shared/sign-in.ts";
import { cookies, withCookie } from "./cookies.ts";
import { noteOf, readOnce, seeOther } from "./flash.ts";
import { signed } from "../signed.ts";
import { signInChoices } from "./settings.ts";
import { clearState, signIn } from "./sign-in.ts";
import type { TestEnd } from "./app-test.ts";

const JOIN = "erga_join";
const JOIN_SECONDS = 30 * 60;

/** Where a sign-in goes next. */
export type Outcome =
  | { kind: "in"; login: string; claimed?: boolean }
  | { kind: "new"; suggestion: string; taken?: string }
  | { kind: "refused"; login?: string };

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
    await dir.people.signedIn(v);
    dir.forgetAccess(known.login);
    users.forget(known.login);
    const user = await users.signedIn(known.login, v.name, { create: o.create });
    if (!user) return { kind: "refused", login: known.login };
    return { kind: "in", login: user.login };
  }
  let taken: string | undefined;
  if (v.oldLogin) {
    const row = await users.get(v.oldLogin);
    if (row && (await identities.unclaimed(row.login))) {
      if (o.onlyAdmins && !(await users.isAdmin(row.login))) return { kind: "refused" };
      // Its row first: a bootstrap admin has none yet, and the link writes the picture into it.
      const user = await users.signedIn(row.login, v.name, { create: o.create });
      if (!user) return { kind: "refused", login: row.login };
      await identities.link(row.login, v);
      users.forget(row.login);
      return { kind: "in", login: user.login, claimed: true };
    }
    if (row) taken = row.login;
  }
  if (!o.join) return { kind: "refused" };
  return taken ? { kind: "new", suggestion: await identities.suggest(v), taken } : { kind: "new", suggestion: await identities.suggest(v) };
}

// ------------------------------------------------------------ after a provider's answer

/**
 * A provider vouched for someone: sign them in to their account, or on to the username step, or say why not.
 * `tested`: a test sign-in's result (app-test.ts), at each end. `after`: what runs once they're in, with their login.
 */
export const vouchedSignIn = Effect.fnUntraced(function* (
  platform: Platform,
  request: Request,
  v: Vouched,
  next: string,
  o: { onlyAdmins?: boolean; tested?: (end: TestEnd) => Promise<unknown> },
  after?: (login: string) => Promise<void>
) {
  const tested = (end: TestEnd) => (o.tested ? call(() => o.tested!(end)) : Effect.void);
  const url = new URL(request.url);
  const dev = platform.dev(url);
  const join = !o.onlyAdmins && (yield* call(() => mayJoin(platform, url, v)));
  const outcome = yield* call(() => resolve(platform.directory, v, { join, create: dev, onlyAdmins: o.onlyAdmins }));
  if (outcome.kind == "refused") {
    yield* tested({ kind: "refused", who: outcome.login ?? v.handle });
    return refusedPage(v);
  }
  if (outcome.kind == "new") {
    yield* tested({ kind: "new", handle: v.handle });
    // One way in: Erga names the account, and they go on at once. A name it can't have: they choose one.
    const named =
      outcome.suggestion && (yield* call(() => namesItself(platform, v))) ? yield* makeAccount(platform, outcome.suggestion, v) : null;
    if (typeof named != "string") return yield* toUsernameStep(platform, request, v, next, outcome.taken);
    if (after) yield* call(() => after(named));
    return yield* signIn(platform, request, sessionFor(named, v), safeNext(next));
  }
  const admin = yield* call(() => platform.directory.users.isAdmin(outcome.login));
  yield* tested({ kind: "in", login: outcome.login, admin });
  // A provider that's off signs in only admins (their test sign-in, from /admin/auth).
  if (o.onlyAdmins && !admin)
    return page(
      `${label(v.provider)} sign-in is off`,
      `This server doesn't take sign-in with ${esc(label(v.provider))}. <a href="/auth/sign-in?next=${encodeURIComponent(safeNext(next))}">Sign in another way</a>.`,
      403
    );
  if (after) yield* call(() => after(outcome.login));
  return yield* signIn(platform, request, sessionFor(outcome.login, v), safeNext(next));
});

const sessionFor = (login: string, v: Vouched): Session => ({ login, name: v.name?.trim().split(/\s+/)[0] || login });

/**
 * Whether Erga names a new account itself, with no username step: this sign-in is the server's one way in, and what it
 * calls people is one person's each. A provider's logins are. Its email addresses are only when one group rule lets
 * people in, of this provider's kind (one Google Workspace), and this person is in that group: the part before the @
 * is then one person's. The server's only sign-in (the proxy) names nobody: its people choose.
 */
async function namesItself(platform: Pick<Platform, "own" | "signIn" | "directory">, v: Vouched): Promise<boolean> {
  const info = SIGN_IN_PROVIDERS[v.provider];
  const ways = await signInChoices(platform);
  if (!info || info.only || ways.length != 1 || ways[0].id != v.provider) return false;
  if (info.handle == "login") return true;
  const open = (await platform.directory.rules.all()).filter((r) => r.access != "none");
  const [rule] = open;
  return (
    open.length == 1 && rule.kind != "everybody" && rule.kind == info.groups?.kind && !!v.groups?.includes(groupOf(rule.kind, rule.value))
  );
}

/**
 * A new account under `username` for whoever `v` is: its login, or why not (the name has a problem). The role an admin
 * added them with (their wait ends), or none (a group's rule let them in), or local development's (everyone may
 * there): write.
 */
const makeAccount = (platform: Platform, username: string, v: Vouched) =>
  Effect.tryPromise({
    try: async () => {
      const dir = platform.directory;
      const { may, person } = await dir.joining(v);
      return dir.identities.createAccount(username, v, person ? { role: person.role, waited: person.id } : may ? {} : { role: "write" });
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchIf(
      (e): e is NotAllowed => e instanceof NotAllowed,
      (e) => Effect.succeed(e)
    ),
    Effect.orDie
  );

/**
 * Someone who may not make an account here: how they signed in, and what to do. It never says who may join (no rule,
 * no domain): the server's access rules are private. The server's only sign-in that gave no address: its ID, for the
 * admin.
 */
function refusedPage(v: Vouched) {
  const title = "You need permission to join";
  if (!v.handle)
    return page(title, `Ask an admin of this Erga server to add you, and give them your sign-in ID: <b>${esc(v.subject)}</b>.`, 403);
  const another = SIGN_IN_PROVIDERS[v.provider]?.only ? "" : ' Or <a href="/auth/sign-in">sign in with another account</a>.';
  return page(
    title,
    `You signed in with ${signedInWith(v.provider, v.handle)}. Ask an admin of this Erga server to add you, then sign in again.${another}`,
    403
  );
}

// ------------------------------------------------------------ the username step

/** Who waits at the username step, as the provider vouched for them, and where they go after: signed, for half an hour (server/signed.ts). */
const Join = signed(
  "join",
  Schema.Struct({
    v: Schema.Struct({
      provider: Schema.NonEmptyString,
      subject: Schema.NonEmptyString,
      handle: Schema.String,
      name: Schema.NullOr(Schema.String),
      emails: Schema.mutable(Schema.Array(Schema.Struct({ email: Schema.String, verified: Schema.Boolean }))),
      groups: Schema.optionalKey(Schema.NullOr(Schema.mutable(Schema.Array(Schema.String)))),
      picture: Schema.optionalKey(Schema.NullOr(Schema.String)),
      oldLogin: Schema.optionalKey(Schema.String),
    }),
    next: Schema.String,
    taken: Schema.optionalKey(Schema.String),
  }),
  JOIN_SECONDS
);
type Pending = typeof Join.seal extends (secret: string, value: infer A, ...rest: never[]) => unknown ? A : never;

/** An answer that sets (or, with "" and 0, clears) the username step's cookie too. */
const withJoin = (response: Parameters<typeof withCookie>[0], request: Request, value: string, maxAge: number) =>
  withCookie(response, request, JOIN, value, maxAge, "/auth");

/** On to the username step, with its cookie: who they are, signed, for half an hour. */
const toUsernameStep = Effect.fnUntraced(function* (platform: Platform, request: Request, v: Vouched, next: string, taken?: string) {
  const value = yield* call(() => Join.seal(platform.secret, { v, next: safeNext(next), ...(taken ? { taken } : {}) }));
  return clearState(withJoin(redirect("/auth/username", 302, { "Cache-Control": "no-store" }), request, value, JOIN_SECONDS), request);
});

const pendingOf = (platform: Platform, request: Request): Promise<Pending | null> => Join.open(platform.secret, cookies(request).get(JOIN));

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
  if (request.method == "GET") {
    // Who may join is asked again: a rule could have changed while they chose.
    if (!(yield* call(() => mayJoin(platform, url, v)))) return refusedPage(v);
    // A POST that didn't make the account came back here (flash.ts): its name, and why not.
    const note = yield* call(() => noteOf(platform, request));
    const shown = note?.error
      ? usernamePage(v, note.value ?? "", note.error, pending.taken)
      : usernamePage(v, yield* call(() => platform.directory.identities.suggest(v)), null, pending.taken);
    return readOnce(shown, request);
  }
  if (request.method != "POST") return text("Not allowed", 405);
  if (request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const { username } = yield* form(UsernameForm).pipe(Effect.orElseSucceed(() => ({ username: "" })));
  const wanted = username.trim().toLowerCase();
  // Never a page in answer to the form (flash.ts): the GET above shows the refusal, or the error.
  if (!(yield* call(() => mayJoin(platform, url, v)))) return redirect("/auth/username", 303);
  const login = yield* makeAccount(platform, wanted, v);
  if (login instanceof NotAllowed) return yield* seeOther(platform, request, "/auth/username", { error: login.message, value: wanted });
  return withJoin(yield* signIn(platform, request, sessionFor(login, v), pending.next), request, "", 0);
});

const UsernameForm = Schema.Struct({ username: Field });

/**
 * The username page. Under the field, in the field's error style: why the form came back (`error`), else that the
 * login they came with is another account's (`taken`), else what a username is.
 */
function usernamePage(v: Vouched, value: string, error: string | null, taken?: string) {
  const hint = error
    ? esc(error)
    : taken
      ? `The Erga account <b>${esc(taken)}</b> is already taken.`
      : "Lowercase letters, digits and dashes.";
  const body = `Welcome. You signed in with ${signedInWith(v.provider, v.handle)}. Choose a username for your Erga account: it is in the address of each of your documents (/<i>username</i>/…).</p>
<form method="post" action="/auth/username" class="username" novalidate>
  <label for="username">Username</label>
  <p class="row"><input class="input" id="username" name="username" value="${esc(value)}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" maxlength="39" required autofocus>
  <button class="new" type="submit">Make my account</button></p>
  <p class="hint${error || taken ? " error" : ""}" role="status" id="username-hint">${hint}</p>
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
  const provider = q.get("provider") ?? "";
  const info = SIGN_IN_PROVIDERS[provider];
  const subject = q.get("subject")?.trim();
  // (handle= with nothing: a sign-in that names nobody, as the proxy's with no email address.)
  const handle = q.get("handle")?.trim();
  if (!info || !subject || handle == null) return page("Not enough", "Give the pretend identity's provider=, subject= and handle=.", 400);
  const emails = q.getAll("email").filter(Boolean).map((email) => ({ email: email.toLowerCase(), verified: q.get("verified") != "0" }));
  // As the provider's own sign-in gives them (providers.ts): its groups (group=), its picture, the login an old account has.
  const kind = info.groups?.kind as Exclude<RuleKind, "everybody"> | undefined;
  const groups = kind
    ? q
        .getAll("group")
        .filter(Boolean)
        .map((g) => groupOf(kind, g))
    : [];
  const picture = safeAvatar(q.get("picture"));
  return yield* vouchedSignIn(
    platform,
    request,
    {
      provider,
      subject,
      handle,
      name: q.get("name") || null,
      emails,
      groups,
      picture,
      ...(info.handle == "login" ? { oldLogin: handle.toLowerCase() } : {}),
    },
    q.get("next") ?? "/",
    {}
  );
});
