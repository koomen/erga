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
//      that changed hands is refused, and the page says so.
//   3. Anyone else who may join makes a new account: they choose a username
//      first (/auth/username). Until they do, who they are waits in a signed
//      cookie for half an hour, and nothing is written.
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
import { type Directory, groupOf, KIND_PEOPLE, label, NotAllowed, type RuleKind, type Vouched } from "../directory/index.ts";
import { safeAvatar } from "../../shared/avatars.ts";
import { SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { cookies, withCookie } from "./cookies.ts";
import { noteOf, readOnce, seeOther } from "./flash.ts";
import { signed } from "../signed.ts";
import { clearState, signIn } from "./sign-in.ts";
import type { TestEnd } from "./app-test.ts";

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
  if (!o.join) return taken ? { kind: "refused", taken } : { kind: "refused" };
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
    return outcome.taken ? takenPage(v, outcome.taken) : yield* refusedPage(platform, v, outcome.login);
  }
  if (outcome.kind == "new") {
    yield* tested({ kind: "new", handle: v.handle });
    return yield* toUsernameStep(platform, request, v, next, outcome.taken);
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

/** A login whose Erga account is someone else's (another account of the provider, or another provider). */
const takenNote = (v: Vouched, login: string) =>
  `The Erga account <b>${esc(login)}</b> is someone else's: it doesn't sign in with this ${esc(label(v.provider))} account. A ${esc(label(v.provider))} login that changes hands never brings its Erga account with it.`;

function takenPage(v: Vouched, login: string) {
  return page(
    "Not your account",
    `${takenNote(v, login)} You signed in with ${esc(label(v.provider))} as <b>${esc(v.handle)}</b>, and this server is invite-only: ask an admin to add you under another username.`,
    403
  );
}

/** Who the access rules let in, and why this person isn't one of them: in place, so they know what to ask for. */
const refusedPage = Effect.fnUntraced(function* (platform: Platform, v: Vouched, login?: string) {
  const who = login ?? v.handle;
  const rules = yield* call(() => platform.directory.rules.all().catch(() => []));
  type Kind = Exclude<RuleKind, "everybody">;
  const kinds = [...new Set(rules.flatMap((r) => (r.kind != "everybody" && r.access != "none" ? [r.kind] : [])))] as Kind[];
  const valuesOf = (kind: Kind) => rules.filter((r) => r.kind == kind && r.access != "none").map((r) => `<b>${esc(r.value)}</b>`);
  const ways = ["the people an admin added", ...kinds.map((kind) => KIND_PEOPLE[kind](valuesOf(kind)))];
  let why = `<b>${esc(who)}</b> (${esc(label(v.provider))}) isn't one of them.`;
  // What the provider said of their groups, where a rule reads that kind of group.
  const groups = SIGN_IN_PROVIDERS[v.provider]?.groups;
  if (groups && kinds.some((kind) => kind == groups.kind)) {
    const prefix = groupOf(groups.kind as Kind, "");
    why += ` ${groups.said((v.groups ?? []).filter((g) => g.startsWith(prefix)).map((g) => esc(g.slice(prefix.length))))}`;
  }
  return page("Not on this server", `This server lets in ${ways.join(", ")}. ${why} An admin can add you on the Users page.`, 403);
});

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
    if (!(yield* call(() => mayJoin(platform, url, v)))) return yield* refusedPage(platform, v);
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
  // The role an admin added them with (their wait ends), or none (a group's rule let them in), or local
  // development's (everyone may there): write.
  const dir = platform.directory;
  const login = yield* Effect.tryPromise({
    try: async () => {
      const { may, person } = await dir.joining(v);
      return dir.identities.createAccount(wanted, v, person ? { role: person.role, waited: person.id } : may ? {} : { role: "write" });
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchIf(
      (e): e is NotAllowed => e instanceof NotAllowed,
      (e) => Effect.succeed(e)
    ),
    Effect.orDie
  );
  if (login instanceof NotAllowed) return yield* seeOther(platform, request, "/auth/username", { error: login.message, value: wanted });
  return withJoin(yield* signIn(platform, request, sessionFor(login, v), pending.next), request, "", 0);
});

const UsernameForm = Schema.Struct({ username: Field });

function usernamePage(v: Vouched, value: string, error: string | null, taken?: string) {
  const body = `${taken ? `${takenNote(v, taken)}</p><p>` : ""}Welcome. You signed in with ${esc(label(v.provider))} as <b>${esc(v.handle)}</b>. Choose a username for your Erga account: it is in the address of each of your documents (/<i>username</i>/…).</p>
<form method="post" action="/auth/username" class="username" novalidate>
  <label for="username">Username</label>
  <p class="row"><input class="input" id="username" name="username" value="${esc(value)}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" maxlength="39" required autofocus>
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
  const provider = q.get("provider") ?? "";
  const info = SIGN_IN_PROVIDERS[provider];
  const subject = q.get("subject")?.trim();
  const handle = q.get("handle")?.trim();
  if (!info || !subject || !handle) return page("Not enough", "Give the pretend identity's provider=, subject= and handle=.", 400);
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
