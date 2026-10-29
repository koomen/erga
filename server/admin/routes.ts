// The admin page: the server's settings and its users and
// admins, for admins only. Everyone else gets "not found": they
// can't see the page, nor that there is one.
//
//   /admin                     the Settings page (GET /admin/settings redirects here)
//   /admin/changes             the Change log: the settings' versions, factory tasks added and merged, and production deploys, newest first; ?before=n for older ones
//   /admin/users               the Users page: the specific people, each a GitHub or Google account with one role (Admin, Can
//                              create and edit content, Can authenticate), the deploy role as a switch, when they joined and last came;
//                              add one (before their first sign-in too), remove one
//   /admin/access              the Access page: the group rules (everybody, a Google Workspace, a GitHub organization: No
//                              access, Can authenticate or Can create and edit content), and whether users can share content publicly
//   /admin/api-keys            the API keys page: every key Erga needs from the services it calls (GET /admin/credentials redirects here)
//   /admin/auth                the Authentication page: how people sign in on this server (GitHub, Google)
//   GET /admin/auth/status     the same as JSON {here, google, providers} (server/identity/apps.ts, AuthStatus: never a secret), with live checks
//   POST /admin/auth           provider (github or google), and do=save (clientId, secret), do=discard (the values that wait for a test sign-in), do=clear (force=1: even if sign-in would stop) or do=providers (provider, on: 1 or 0)
//   GET /admin/documents       q (a part of a title, owner or address), limit: the server's documents and projects, everyone's,
//                              as JSON {found: [{id, title, owner, address, kind}]}, for the Homepage Project picker
//   POST /admin/settings       key, and value (JSON; null for never) to set it, or reset=1 to put it back to its default
//   POST /admin/users          do=add (provider: github or google, handle: the login or email, role: admin, write or read)
//   POST /admin/users          do=role (login, or person: one waiting; role: admin, write, read, or none for an account), do=remove (login or person)
//   POST /admin/users          do=deploy (login, deploy: 1 or 0)
//   POST /admin/access         do=add_rule (kind, value, access), do=change_rule (id, access), do=remove_rule (id): the group rules
//   POST /admin/access         do=public_sharing (on: 1 or 0): whether users can share content publicly
//   POST /admin/credentials    name (anthropic), and value to set or replace its key, or clear=1 to remove it
//   POST /admin/share          rotate=1 (optional): Share with agent's admin token, for an outside
//                              agent: { token, id, label, expires }; the same one until it's near its end (12 hours), or rotated
//
// The API keys page shows whether each key is set, its
// last four characters, and who set it when; and, read-only, the secrets only the
// deploy sets. The page never gets a saved key back, nor does any answer here.
//
// The Authentication page shows this server's GitHub OAuth app and Google
// OAuth client: the client ID (public), whether the secret is set (never the
// secret), the URLs the provider needs, a live check, and how to make one.
// A client ID and secret pasted there win over the deploy's, after the
// provider accepts them, with the lockout rules server/identity/apps.ts gives.
// Each server's page sets its own sign-in only. A save, a discard or a clear
// shows the page again in place, with its message under the provider's card.
//
// Every page has the layout every admin page shares: the
// breadcrumb, Share with agent, and the sidebar to Settings, API keys, Authentication, Change log, Users and Ops.
//
// The POSTs answer JSON ({ entry } or { user } or { ok }, or { error } with
// the message the directory gave, for a person to act on) and come only from
// this site's pages. The directory checks who's asking itself (NotAllowed);
// this file only shows it. An agent token (Session.agent) never gets in, even
// an admin's. A setting the deploy locks is shown, read-only,
// and so is a bootstrap admin (ADMINS), who can't be demoted or removed here,
// and the last admin, who can't be demoted or removed at all.

import { ConfigError, CredentialError, NotAllowed, roleValue, type UserRole } from "../directory/index.ts";
import { link, page } from "../pages/index.ts";
import { type Platform, whoOf } from "../platform.ts";
import { authOps, AuthError, ScopeError, type Provider } from "../identity/index.ts";
import { json } from "../../shared/http.ts";
import { settingsPage } from "./settings.ts";
import { apiKeysPage } from "./api-keys.ts";
import { authPage } from "./auth.ts";
import { usersPage } from "./users.ts";
import { accessPage } from "./access.ts";
import { changesPage } from "./changes.ts";

/** /admin and its POSTs. */
export async function adminRoutes(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const read = request.method == "GET" || request.method == "HEAD";
  if (!session && read) {
    return new Response(null, { status: 302, headers: { Location: `/auth/sign-in?next=${encodeURIComponent(url.pathname)}` } });
  }
  const who = session && whoOf(session);
  // Only the person themselves, in a browser (which comes with admin power): an agent with their token isn't an admin here.
  const admin = !!who && !session?.agent && (await platform.directory.users.actsAsAdmin(who));
  if (read) {
    if (!admin || url.pathname == "/admin/share") return notFound();
    if (url.pathname == "/admin/settings") return new Response(null, { status: 302, headers: { Location: link("/admin", session!) } });
    if (url.pathname == "/admin/credentials") return new Response(null, { status: 302, headers: { Location: link("/admin/api-keys", session!) } });

    if (url.pathname == "/admin/changes") {
      const before = Number(url.searchParams.get("before"));
      return changesPage(platform, session!, Number.isInteger(before) && before > 0 ? before : undefined);
    }
    if (url.pathname == "/admin/api-keys") return apiKeysPage(platform, session!);
    if (url.pathname == "/admin/auth" || url.pathname == "/admin/auth/status") {
      const status = await authOps(platform, url.origin).status(who!);
      return url.pathname == "/admin/auth" ? authPage(session!, status) : json(status);
    }
    if (url.pathname == "/admin/access") return accessPage(platform, session!);
    if (url.pathname == "/admin/documents") {
      const found = await platform.directory.search(who!, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit")) || 20);
      return json({ found });
    }
    return url.pathname == "/admin/users" ? usersPage(platform, session!) : settingsPage(platform, session!);
  }
  if (request.method != "POST") return notFound();
  if (!admin) return Response.json({ error: "Only an admin can do that." }, { status: session ? 403 : 401 });

  if (request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");
  try {
    // Share with agent: a person in a browser only (an agent never makes a token, whatever its scope; checked above too).
    if (url.pathname == "/admin/share") {
      if (session!.agent || session!.test) return Response.json({ error: "An agent can't make tokens." }, { status: 403 });
      const { token, info } = await platform.tokens.shareAdmin({ login: session!.login, name: session!.name }, field("rotate") == "1");
      return json({ token, id: info.id, label: info.label, expires: info.expires });
    }
    if (url.pathname == "/admin/credentials") {
      const credentials = platform.directory.credentials, name = field("name");
      // The answer says what the page shows: never the key.
      return Response.json({ credential: form.get("clear") ? await credentials.clear(who!, name) : await credentials.set(who!, name, field("value")) });
    }
    if (url.pathname == "/admin/auth") {
      const auth = authOps(platform, url.origin);
      const provider: Provider = field("provider") == "google" ? "google" : "github";
      // The answers say what the page shows: never the secret.
      switch (field("do")) {
        case "save":
          return Response.json({ result: await auth.save(who!, { clientId: field("clientId"), secret: field("secret") }, provider) });
        case "discard":
          return Response.json({ result: await auth.discard(who!, provider) });
        case "clear":
          return Response.json({ result: await auth.clear(who!, field("force") == "1", provider) });
        case "providers":
          return Response.json({ providers: await auth.setProvider(who!, provider, field("on") == "1") });
        default:
          return Response.json({ error: "do= save, discard, clear or providers" }, { status: 400 });
      }
    }
    if (url.pathname == "/admin/access") {
      const rules = platform.directory.rules;
      switch (field("do")) {
        case "add_rule": return Response.json({ rule: await rules.add(who!, { kind: field("kind"), value: field("value"), access: field("access") }) });
        case "change_rule": return Response.json({ rule: await rules.change(who!, Number(field("id")), field("access")) });
        case "remove_rule": await rules.remove(who!, Number(field("id"))); return Response.json({ ok: true });
        case "public_sharing": return Response.json({ entry: await platform.directory.config.set(who!, "public_sharing", field("on") == "1") });
        default: return Response.json({ error: "do= add_rule, change_rule, remove_rule or public_sharing" }, { status: 400 });
      }
    }
    if (url.pathname == "/admin/settings") {
      const key = field("key");
      if (form.get("reset")) return Response.json({ entry: await platform.directory.config.reset(who!, key) });
      let value: unknown;
      try { value = JSON.parse(field("value")); } catch { throw new ConfigError(`${key} needs a value as JSON (a number, true or false, "text" in quotes...).`); }
      return Response.json({ entry: await platform.directory.config.set(who!, key, value) });
    }
    const dir = platform.directory,
      users = dir.users,
      login = field("login"),
      person = Number(field("person"));
    switch (field("do")) {
      case "add":
        return Response.json(
          await dir.addUser(who!, { provider: field("provider"), handle: field("handle") }, roleValue(field("role")) as UserRole)
        );
      case "role": {
        if (person) return Response.json({ person: await dir.people.setRole(who!, person, roleValue(field("role")) as UserRole) });
        return Response.json({ user: await users.setUserRole(who!, login, roleValue(field("role"), { none: true })) });
      }
      case "deploy": {
        const deploy = field("deploy");
        if (deploy != "1" && deploy != "0") throw new NotAllowed("deploy= 1 to grant the deploy role, or 0 to revoke it.");
        return Response.json({ user: await users.setDeploy(who!, login, deploy == "1") });
      }
      case "remove":
        await (person ? dir.people.remove(who!, person) : users.remove(who!, login));
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "do= add, role, deploy or remove" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof NotAllowed || e instanceof ScopeError) return Response.json({ error: e.message }, { status: 403 });
    if (e instanceof ConfigError || e instanceof CredentialError || e instanceof AuthError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

const notFound = () => page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
