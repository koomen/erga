// The server's own settings and people, on the admin pages (/admin): the settings and their change log, the API
// keys (read and clear: a key is set only on the page), how people sign in (read, switch, clear: an app's values are
// set only on the page), the users, and the access rules. Each needs admin power (`admin`), and the directory checks
// who's asking itself (Users.mustAdmin).

import * as Schema from "effect/Schema";
import {
  ACCESS_LABEL,
  type AccessRule,
  type ConfigEntry,
  ConfigError,
  KIND_LABEL,
  type Person,
  ROLE_LABEL,
  roleValue,
  type User,
  type UserRole,
} from "../directory/index.ts";
import type { AuthOps, AuthStatus } from "../identity/index.ts";
import { type Caller, iso, LOGIN, type Operation, OperationError } from "./operation.ts";

export const ADMIN_OPERATIONS: Operation[] = [
  // ------------------------------------------------------------ the server's settings (admins)
  {
    name: "list_settings",
    ui: "Settings (/admin): the settings",
    label: "Read the server's settings",
    activity: "reading the server's settings",
    admin: true,
    description:
      "Admins only. The server's settings: each one's key, what it does, its value now, its default, where the value comes from (default, set by an admin, or locked by the deploy), and who last set it. A locked one can't be changed here.",
    parameters: Schema.Struct({}),
    run: async (_args, { dir, who }) => (await dir.config.list(who)).map(entryOf),
  },
  {
    name: "set_setting",
    ui: "Settings (/admin): change a setting",
    label: "Change a server setting",
    activity: "changing a server setting",
    admin: true,
    description:
      "Admins only. Sets one of the server's settings (list_settings lists them, with what each takes). The value is JSON: a number, a string, true, false or null (e.g. delete_docs_after_hours: a number of hours, or null to never delete unedited documents). A setting the deploy locks can't be changed. Answers the setting as it is now.",
    parameters: Schema.Struct({
      key: Schema.String.annotate({ description: "The setting's key, e.g. delete_docs_after_hours" }),
      value: Schema.Unknown.annotate({ description: "Its new value (a number, string, boolean or null, as the setting takes)" }),
    }),
    run: async (args, { dir, who }) => {
      const key = String(args.key ?? "");
      if (args.value === undefined)
        throw new OperationError({ message: "Give the value to set it to (reset_setting puts it back to its default).", status: 400 });
      try {
        return entryOf(await dir.config.set(who, key, args.value));
      } catch (e) {
        // "48" for 48: a model may send a number as a string.
        if (!(e instanceof ConfigError) || typeof args.value != "string") throw e;
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.value);
        } catch {
          throw e;
        }
        if (typeof parsed == "string") throw e;
        return entryOf(await dir.config.set(who, key, parsed));
      }
    },
  },
  {
    name: "reset_setting",
    ui: "Settings (/admin): Reset to the default",
    label: "Reset a server setting",
    activity: "resetting a server setting",
    admin: true,
    description: "Admins only. Puts one of the server's settings back to its default. A setting the deploy locks can't be changed.",
    parameters: Schema.Struct({ key: Schema.String.annotate({ description: "The setting's key" }) }),
    run: async (args, { dir, who }) => entryOf(await dir.config.reset(who, String(args.key ?? ""))),
  },
  {
    name: "list_setting_changes",
    ui: "Change log (/admin/changes)",
    label: "Read the settings' change log",
    activity: "reading the settings' change log",
    admin: true,
    description:
      "Admins only. The settings' change log (/admin/changes), newest first: each change's number, when, who made it, and each setting's value before and after (reset: put back to its default; credential: an API key set, replaced or cleared, never the key). 20 at a time unless you ask for more (up to 100); before: only changes older than that number. total: how many there are.",
    parameters: Schema.Struct({
      limit: Schema.optionalKey(Schema.Int.annotate({ description: "How many, the latest first (default 20, at most 100)" })),
      before: Schema.optionalKey(Schema.Int.annotate({ description: "Only changes numbered lower than this" })),
    }),
    run: async (args, { dir, who }) => {
      const { versions, total } = await dir.config.history(who, {
        limit: Math.min(100, Number(args.limit) || 20),
        ...(args.before != null ? { before: Number(args.before) } : {}),
      });
      return {
        total,
        changes: versions.map((v) => ({ n: v.n, at: iso(v.at), by: v.by, ...(v.via ? { via: v.via } : {}), changes: v.changes })),
      };
    },
  },
  {
    name: "list_api_keys",
    ui: "API keys (/admin/api-keys): whether each is set",
    label: "Read the API keys' status",
    activity: "reading the API keys' status",
    admin: true,
    description:
      "Admins only. The server's API keys (Anthropic's, OpenAI's, Google's and OpenRouter's: the models of each person's agent), as /admin/api-keys shows them: whether each is stored, its last four characters, who set it and when, whether a Worker secret stands in, and whether a stored key doesn't open on this server. Never the key itself. An admin sets, replaces or clears a key only on /admin/api-keys, so a key never goes through a conversation.",
    parameters: Schema.Struct({}),
    run: async (_args, { dir, who }) =>
      (await dir.credentials.list(who)).map((c) => ({
        name: c.name,
        label: c.label,
        description: c.description,
        stored: c.set,
        last4: c.last4,
        updated: iso(c.updated),
        updatedBy: c.updatedBy,
        ...(c.updatedVia ? { updatedVia: c.updatedVia } : {}),
        workerSecret: c.fallback,
        ...(c.unreadable
          ? {
              unreadable:
                "stored, but this server can't open it (encrypted with another server's FACTORY_KEY): an admin must paste it again on /admin/api-keys",
            }
          : {}),
      })),
  },

  {
    name: "clear_api_key",
    ui: "API keys (/admin/api-keys): Clear",
    label: "Clear an API key",
    activity: "clearing an API key",
    admin: true,
    description:
      "Admins only. Clears one of the server's API keys (list_api_keys lists them), as Clear on /admin/api-keys does: the server goes back to its Worker secret, if one stands in, else does without (the agents stop running that provider's models on the server's key). The change log says who cleared it. Setting or replacing a key is done only on /admin/api-keys, so a key never goes through a conversation.",
    parameters: Schema.Struct({ name: Schema.String.annotate({ description: "The key's name: anthropic" }) }),
    run: async (args, { dir, who }) => {
      const c = await dir.credentials.clear(who, String(args.name ?? ""));
      return { cleared: c.name, label: c.label, stored: c.set, workerSecret: c.fallback };
    },
  },

  // ------------------------------------------------------------ sign-in (admins)
  {
    name: "get_sign_in_status",
    ui: "Authentication (/admin/auth): how people sign in",
    label: "Read how people sign in",
    activity: "reading how people sign in",
    admin: true,
    description:
      "Admins only. How people sign in, as /admin/auth shows it: which providers are on (GitHub, Google); and for each of this server's GitHub OAuth app and Google OAuth client: its client ID (public) and where it comes from (the deploy, or set on /admin/auth), whether its client secret is set (never the secret), the homepage and callback URLs the app must have, a live check with GitHub or Google (working, misconfigured and why, not set up, unknown), values that wait for a test sign-in, and, where the app doesn't work, the steps to make one. An app's values are pasted only on /admin/auth, never in a conversation.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
      const { here, google, providers } = await authOf(caller).status(caller.who);
      return { providersOn: providers, github: signInOf(here), google: signInOf(google) };
    },
  },
  {
    name: "switch_sign_in_provider",
    ui: "Authentication (/admin/auth): each provider's switch",
    label: "Turn a sign-in provider on or off",
    activity: "turning a sign-in provider on or off",
    admin: true,
    description:
      "Admins only. Turns sign-in with GitHub or Google on or off on this server, as the switches on /admin/auth do. Anyone allowed on the server may then sign in with each provider that's on. The rules, so nobody is locked out: a provider goes on only while its app works (get_sign_in_status says); one goes off only while the other is on and works, and only by an admin whose own account signs in with the other provider (each account signs in with one). Answers which providers are on now.",
    parameters: Schema.Struct({
      provider: Schema.Literals(["github", "google"]).annotate({ description: "github or google" }),
      on: Schema.Boolean.annotate({ description: "true: people may sign in with it; false: they may not" }),
    }),
    run: async (args, caller) => {
      const provider = args.provider == "google" ? "google" : args.provider == "github" ? "github" : null;
      if (!provider) throw new OperationError({ message: 'provider: "github" or "google".', status: 400 });
      if (typeof args.on != "boolean") throw new OperationError({ message: "on: true or false.", status: 400 });
      return { providersOn: await authOf(caller).setProvider(caller.who, provider, args.on) };
    },
  },
  {
    name: "clear_sign_in_app",
    ui: "Authentication (/admin/auth): Clear, and Discard",
    label: "Clear sign-in values",
    activity: "clearing sign-in values",
    admin: true,
    description:
      "Admins only. Clears a provider's app values set on /admin/auth (provider: github, the default, or google), as Clear there does: sign-in goes back to the deploy's values. With what: \"pending\", it only discards new values that wait for a test sign-in (Discard), and sign-in keeps the values in use. It refuses when the values set on the page work and the deploy's don't, since everyone would stop being able to sign in; force: true clears anyway, and only when the person says so after you told them that. Setting an app's values is done only on /admin/auth.",
    parameters: Schema.Struct({
      provider: Schema.optionalKey(Schema.Literals(["github", "google"]).annotate({ description: "github (default) or google" })),
      what: Schema.optionalKey(
        Schema.Literals(["all", "pending"]).annotate({
          description: "all (default): the values set on the page; pending: only those that wait for a test sign-in",
        })
      ),
      force: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Clear even if sign-in would stop working: only when the person says so" })
      ),
    }),
    run: async (args, caller) => {
      const provider = args.provider == "google" ? "google" : "github";
      if (args.what == "pending") return { provider, ...(await authOf(caller).discard(caller.who, provider)) };
      return { provider, ...(await authOf(caller).clear(caller.who, args.force === true, provider)) };
    },
  },

  // ------------------------------------------------------------ the server's users (admins)
  {
    name: "list_users",
    ui: "Users (/admin/users): the users",
    label: "List the server's users",
    activity: "listing the users",
    admin: true,
    description:
      "Admins only. The users on /admin/users: each account (login: its username; accounts: the GitHub and Google accounts it signs in with), its one role, as roleLabel says it: admin ('Admin'), write ('Can create and edit content': may sign in, open what is shared with them or public, and make and edit documents) or read ('Can authenticate': may sign in, and open what is shared with them or public), or none ('No role': only the group rules on /admin/access let them in); a person's access is the highest of their role and every group rule that matches them. Also whether they were granted the deploy role (deploy), whether they may deploy (mayDeploy), whether they're an admin by the deploy (bootstrap: can't be changed or removed here), when they were added and by whom, and when they were last seen. People an admin added who haven't signed in yet come too, with waiting: true and a person id instead of a login (provider, handle: their GitHub login or Google email). Use the role words when you tell the person.",
    parameters: Schema.Struct({}),
    run: async (_args, { dir, who }) => {
      const [users, people, ids] = await Promise.all([dir.users.list(who), dir.people.list(who), dir.identities.byLogin()]);
      return [
        ...users.map((u) => ({
          ...userOf(u),
          accounts: (ids.get(u.login) ?? []).map((i) => ({ provider: i.provider, handle: i.handle })),
        })),
        ...people.map(personOf),
      ];
    },
  },
  {
    name: "add_user",
    ui: "Users (/admin/users): Add user",
    label: "Add a user",
    activity: "adding a user",
    admin: true,
    description:
      "Admins only. Adds a user, as Add user on /admin/users does, before they ever signed in too: a GitHub account by its login (GitHub's id for it is found now and matched at sign-in; refused if GitHub has no such login) or a Google account by its email (matched as a verified email at its first sign-in, then by Google's id), with one role: admin ('Admin'), write ('Can create and edit content': may sign in, open what is shared with them or public, and make and edit documents) or read ('Can authenticate': may sign in, and open what is shared with them or public). An account that signs in with it already gets the role. An admin by the deploy is one already (note says so). Only when the person asks in this conversation; say what you did, with the role's words.",
    parameters: Schema.Struct({
      provider: Schema.Literals(["github", "google"]).annotate({ description: "github or google" }),
      handle: Schema.String.annotate({ description: "The GitHub login, or the Google account's email" }),
      role: Schema.Literals(["admin", "write", "read"]).annotate({
        description: "admin ('Admin'), write ('Can create and edit content') or read ('Can authenticate')",
      }),
    }),
    run: async (args, { dir, who }) => {
      const r = await dir.addUser(who, { provider: args.provider, handle: args.handle }, roleValue(args.role) as UserRole);
      return {
        ...(r.user ? { user: userOf(r.user) } : {}),
        ...(r.person ? { person: personOf(r.person) } : {}),
        ...(r.note ? { note: r.note } : {}),
      };
    },
  },
  {
    name: "list_access_rules",
    ui: "Access (/admin/access): the group rules, and public sharing",
    label: "Read the access rules",
    activity: "reading the access rules",
    admin: true,
    description:
      "Admins only. The access rules on /admin/access, one list: each rule's id, who (a group: everybody; a Google Workspace organization, by its domain, matched on the hd claim Google gives Workspace accounts; a GitHub organization, its members checked at each GitHub sign-in) and access: none ('No access'), read ('Can authenticate': may sign in, and open what is shared with them or public) or write ('Can create and edit content': also make and edit them). Specific people are users with a role (list_users), not rules. A person gets the highest of their user role and every rule that matches them; if that's none, they can't sign in. Admins always have 'Can create and edit content'. Only a specific set of people: everybody 'No access', and those people as users. Each rule's accessLabel is the words the Access page shows: use them when you tell the person. Also the Workspace domains and GitHub organizations of people who signed in here (suggestions), and whether users can share content publicly (publicSharing).",
    parameters: Schema.Struct({}),
    run: async (_args, { dir, who }) => ({
      rules: (await dir.rules.list(who)).map(ruleOf),
      suggestions: await dir.rules.suggestions(who),
      publicSharing: await dir.config.get("public_sharing"),
    }),
  },
  {
    name: "set_public_sharing",
    ui: "Access (/admin/access): Users can share content publicly",
    label: "Turn public sharing on or off",
    activity: "changing whether users can share content publicly",
    admin: true,
    description:
      "Admins only. 'Users can share content publicly', the switch on /admin/access. On: a document shared with anyone with the link opens for people who aren't signed in too, as viewers, and owners may share that way. Off: nobody may share with anyone with the link (it's refused, saying why), and such shares made before stay but open only for people who sign in; turning it on again restores them. The homepage is public either way. Only when the person asks in this conversation; say what changed.",
    parameters: Schema.Struct({
      on: Schema.Boolean.annotate({ description: "true: users can share content publicly; false: they can't" }),
    }),
    run: async (args, { dir, who }) => {
      if (typeof args.on != "boolean") throw new OperationError({ message: "on: true or false.", status: 400 });
      const before = await dir.config.get("public_sharing");
      return { publicSharing: (await dir.config.set(who, "public_sharing", args.on)).value, before };
    },
  },
  {
    name: "add_access_rule",
    ui: "Access (/admin/access): Add a rule",
    label: "Add an access rule",
    activity: "adding an access rule",
    admin: true,
    description:
      "Admins only. Adds an access rule, as Add on /admin/access does (a rule for the same who changes its access). kind: workspace (value: the Google Workspace organization's domain) or github_org (value: the organization's login); a specific person is added with add_user instead. access: none ('No access'), read ('Can authenticate') or write ('Can create and edit content'). Only when the person asks in this conversation; say what you added, in those words.",
    parameters: Schema.Struct({
      kind: Schema.Literals(["workspace", "github_org"]).annotate({ description: "workspace or github_org" }),
      value: Schema.String.annotate({ description: "The domain or the organization" }),
      access: Schema.Literals(["none", "read", "write"]).annotate({
        description: "none ('No access'), read ('Can authenticate') or write ('Can create and edit content')",
      }),
    }),
    run: async (args, { dir, who }) => ruleOf(await dir.rules.add(who, { kind: args.kind, value: args.value, access: args.access })),
  },
  {
    name: "change_access_rule",
    ui: "Access (/admin/access): a rule's access",
    label: "Change an access rule",
    activity: "changing an access rule",
    admin: true,
    description:
      "Admins only. Changes a rule's access (list_access_rules gives each id), as its select on /admin/access does: none ('No access'), read ('Can authenticate') or write ('Can create and edit content'). Only when the person asks; say what changed, from what to what, in those words.",
    parameters: Schema.Struct({
      id: Schema.Int.annotate({ description: "The rule's id" }),
      access: Schema.Literals(["none", "read", "write"]).annotate({
        description: "none ('No access'), read ('Can authenticate') or write ('Can create and edit content')",
      }),
    }),
    run: async (args, { dir, who }) => {
      const before = (await dir.rules.list(who)).find((r) => r.id == Number(args.id));
      const after = await dir.rules.change(who, Number(args.id), args.access);
      return { rule: ruleOf(after), from: before ? `${before.access} (${ACCESS_LABEL[before.access]})` : null };
    },
  },
  {
    name: "remove_access_rule",
    ui: "Access (/admin/access): Remove a rule",
    label: "Remove an access rule",
    activity: "removing an access rule",
    admin: true,
    description:
      "Admins only. Removes a rule (list_access_rules gives each id), as its remove button on /admin/access does. Everybody's rule stays: set it to none with change_access_rule. Someone no rule matches any more is signed out within seconds. Only when the person asks.",
    parameters: Schema.Struct({ id: Schema.Int.annotate({ description: "The rule's id" }) }),
    run: async (args, { dir, who }) => {
      const before = (await dir.rules.list(who)).find((r) => r.id == Number(args.id));
      await dir.rules.remove(who, Number(args.id));
      return { removed: before ? ruleOf(before) : Number(args.id) };
    },
  },
  {
    name: "set_user_role",
    ui: "Users (/admin/users): a user's role",
    label: "Change a user's role",
    activity: "changing a user's role",
    admin: true,
    description:
      "Admins only. Changes a user's one role, as its select on /admin/users does: admin ('Admin'), write ('Can create and edit content': may sign in, open what is shared with them or public, and make and edit documents) or read ('Can authenticate': may sign in, and open what is shared with them or public), or for an account none ('No role': only the group rules let them in). Give login for an account, or person (list_users's id) for someone who hasn't signed in yet. An admin by the deploy (bootstrap) stays one, and the server keeps an admin. Only when the person asks; say what changed, with the role's words.",
    parameters: Schema.Struct({
      login: Schema.optionalKey(LOGIN),
      person: Schema.optionalKey(Schema.Int.annotate({ description: "The id of someone who hasn't signed in yet (list_users)" })),
      role: Schema.Literals(["admin", "write", "read", "none"]).annotate({
        description: "admin, write, read, or none (an account only)",
      }),
    }),
    run: async (args, { dir, who }) => {
      if (args.person != null) return personOf(await dir.people.setRole(who, Number(args.person), roleValue(args.role) as UserRole));
      return userOf(await dir.users.setUserRole(who, String(args.login ?? ""), roleValue(args.role, { none: true })));
    },
  },
  {
    name: "set_user_deploy",
    ui: "Users (/admin/users): the deploy role",
    label: "Grant or revoke the deploy role",
    activity: "changing a user's deploy role",
    admin: true,
    description:
      "Admins only. Grants a user the deploy role, or revokes it: with it they may use /deploy (deploy Erga to their own Cloudflare account) when the deploy_page setting is admins, as admins may.",
    parameters: Schema.Struct({
      login: LOGIN,
      deploy: Schema.Boolean.annotate({ description: "true to grant the deploy role, false to revoke it" }),
    }),
    run: async (args, { dir, who }) => userOf(await dir.users.setDeploy(who, String(args.login ?? ""), args.deploy === true)),
  },
  {
    name: "remove_user",
    ui: "Users (/admin/users): Remove",
    label: "Remove a user",
    activity: "removing a user",
    admin: true,
    description:
      "Admins only. Removes a user, as the remove button on /admin/users does: their sessions and tokens stop working within seconds, unless a group rule on /admin/access lets them in; their documents stay. Give login for an account, or person (list_users's id) for someone who hasn't signed in yet. An admin by the deploy (bootstrap) can't be removed here.",
    parameters: Schema.Struct({
      login: Schema.optionalKey(LOGIN),
      person: Schema.optionalKey(Schema.Int.annotate({ description: "The id of someone who hasn't signed in yet (list_users)" })),
    }),
    run: async (args, { dir, who }) => {
      if (args.person != null) {
        await dir.people.remove(who, Number(args.person));
        return { removed: { person: Number(args.person) } };
      }
      const login = String(args.login ?? "")
        .trim()
        .toLowerCase();
      if (!(await dir.users.get(login))) throw new OperationError({ message: `${login} isn't a user.`, status: 404 });
      await dir.users.remove(who, login);
      return { removed: login };
    },
  },
];

function entryOf(e: ConfigEntry) {
  const locked = e.locked;
  return {
    key: e.key,
    ...(e.label ? { label: e.label } : {}),
    description: e.description,
    value: e.value,
    default: e.default,
    source: e.source,
    locked,
    ...(locked ? { deployed: e.deployed, note: "Locked by the deploy (deploy/locked-settings.ts): it can't be changed here." } : {}),
    updated: iso(e.updated),
    updatedBy: e.updatedBy,
    ...(e.updatedVia ? { updatedVia: e.updatedVia } : {}),
  };
}

function ruleOf(r: AccessRule) {
  return {
    id: r.id,
    who: r.kind == "everybody" ? "everybody" : `${KIND_LABEL[r.kind]}: ${r.value}`,
    kind: r.kind,
    value: r.value,
    access: r.access,
    accessLabel: ACCESS_LABEL[r.access],
    added: r.created ? iso(r.created) : null,
    addedBy: r.addedBy,
    ...(r.addedVia ? { addedVia: r.addedVia } : {}),
  };
}

function userOf(u: User) {
  const role = u.role == "admin" ? "admin" : (u.access ?? "none");
  return {
    login: u.login,
    name: u.name,
    role,
    roleLabel: ROLE_LABEL[role],
    deploy: u.deploy,
    mayDeploy: u.mayDeploy,
    bootstrap: u.bootstrap,
    added: u.created ? iso(u.created) : null,
    addedBy: u.addedBy,
    ...(u.addedVia ? { addedVia: u.addedVia } : {}),
    lastSeen: iso(u.lastSeen),
  };
}

function personOf(p: Person) {
  return {
    person: p.id,
    waiting: true,
    provider: p.provider,
    handle: p.handle,
    role: p.role,
    roleLabel: ROLE_LABEL[p.role],
    added: iso(p.created),
    addedBy: p.addedBy,
    ...(p.addedVia ? { addedVia: p.addedVia } : {}),
  };
}

/** Sign-in's settings, where this agent has them. */
function authOf(caller: Caller): AuthOps {
  if (!caller.auth) throw new OperationError({ message: "This server's sign-in settings aren't reachable from here.", status: 404 });
  return caller.auth;
}

/** A server's sign-in, as an agent reads it: never a secret. */
function signInOf(s: AuthStatus) {
  return {
    target: s.target,
    origin: s.origin,
    provider: s.provider,
    state: s.check.state,
    summary: s.check.summary,
    reasons: s.check.reasons,
    clientId: s.inUse.clientId,
    clientIdFrom: s.inUse.source == "page" ? "/admin/auth" : "the deploy",
    secretSet: s.inUse.secretSet,
    homepageUrl: s.homepageUrl,
    callbackUrl: s.callbackUrl,
    localDevelopment: s.dev || undefined,
    deploy: { clientId: s.deploy.clientId, secretSet: s.deploy.secretSet },
    setOnPage: s.page
      ? {
          clientId: s.page.clientId,
          updated: iso(s.page.updated),
          updatedBy: s.page.updatedBy,
          ...(s.page.updatedVia ? { updatedVia: s.page.updatedVia } : {}),
        }
      : null,
    waitingForTestSignIn: s.pending
      ? {
          clientId: s.pending.clientId,
          updated: iso(s.pending.updated),
          updatedBy: s.pending.updatedBy,
          check: s.pendingCheck?.summary,
          lastTest: s.pending.test ?? null,
        }
      : null,
    canKeepValues: s.canStore,
    setupSteps: s.setup,
  };
}
