// The server's own settings and people, on the admin pages (/admin): the settings, the API keys and the change log
// (read; a key is cleared here, and set only on the page), how people sign in (read, switch, clear: an app's values are
// set only on the page), the users, and the access rules. Each needs admin power (`admin`), and the directory checks
// who's asking itself (Users.mustAdmin). Reads stay apart from changes: an app may allow the reads with no prompt.

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

const PROVIDER = Schema.Literals(["github", "google"]).annotate({ description: "github or google" });
const ACCESS = Schema.Literals(["none", "read", "write"]).annotate({
  description: "none ('No access'), read ('Can authenticate') or write ('Can create and edit content')",
});
const PERSON = Schema.Int.annotate({ description: "For someone who hasn't signed in yet: their person id (people)" });

/** An argument an action needs: its value, or a 400 that says which. */
function need<T>(args: Record<string, unknown>, key: string, action: unknown): T {
  if (args[key] == null || args[key] === "") throw new OperationError({ message: `${action} needs ${key}.`, status: 400 });
  return args[key] as T;
}

export const ADMIN_OPERATIONS: Operation[] = [
  // ------------------------------------------------------------ the server's settings and API keys (admins)
  {
    name: "settings",
    ui: "Settings (/admin), API keys (/admin/api-keys) and Change log (/admin/changes)",
    label: "Read the server's settings",
    activity: "reading the server's settings",
    admin: true,
    description: "The server's settings and API keys, or the settings' change log (changes).",
    parameters: Schema.Struct({
      changes: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "true: the change log instead, newest first (each change's number, when, who, each setting before and after; never a key). Default: the settings (key, value, default, source, locked) and the API keys (stored, last4, who set it; never the key)",
        })
      ),
      limit: Schema.optionalKey(Schema.Int.annotate({ description: "The change log: how many (default 20, at most 100)" })),
      before: Schema.optionalKey(Schema.Int.annotate({ description: "The change log: only changes numbered lower than this" })),
    }),
    run: async (args, { dir, who }) => {
      if (args.changes === true) {
        const { versions, total } = await dir.config.history(who, {
          limit: Math.min(100, Number(args.limit) || 20),
          ...(args.before != null ? { before: Number(args.before) } : {}),
        });
        return {
          total,
          changes: versions.map((v) => ({ n: v.n, at: iso(v.at), by: v.by, ...(v.via ? { via: v.via } : {}), changes: v.changes })),
        };
      }
      const [settings, keys] = await Promise.all([dir.config.list(who), dir.credentials.list(who)]);
      return {
        settings: settings.map(entryOf),
        apiKeys: keys.map((c) => ({
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
        keysNote: "An admin sets or replaces a key only on /admin/api-keys, never in a conversation.",
      };
    },
  },
  {
    name: "set_setting",
    ui: "Settings (/admin): change a setting, or Reset to the default",
    label: "Change a server setting",
    activity: "changing a server setting",
    admin: true,
    description: "Sets one of the server's settings, or puts it back to its default (reset).",
    parameters: Schema.Struct({
      key: Schema.String.annotate({ description: "The setting's key, e.g. delete_docs_after_hours (settings lists them)" }),
      value: Schema.optionalKey(
        Schema.Unknown.annotate({
          description: "Its new value, as JSON: a number, string, boolean or null, as the setting takes. A locked setting can't change",
        })
      ),
      reset: Schema.optionalKey(Schema.Boolean.annotate({ description: "true: back to its default (no value)" })),
    }),
    run: async (args, { dir, who }) => {
      const key = String(args.key ?? "");
      if (args.reset === true) return entryOf(await dir.config.reset(who, key));
      if (args.value === undefined)
        throw new OperationError({ message: "Give the value to set it to, or reset: true to put back its default.", status: 400 });
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
    name: "clear_api_key",
    ui: "API keys (/admin/api-keys): Clear",
    label: "Clear an API key",
    activity: "clearing an API key",
    admin: true,
    description: "Clears one of the server's API keys; its Worker secret, if any, stands in.",
    parameters: Schema.Struct({ name: Schema.String.annotate({ description: "The key's name, e.g. anthropic (settings lists them)" }) }),
    run: async (args, { dir, who }) => {
      const c = await dir.credentials.clear(who, String(args.name ?? ""));
      return { cleared: c.name, label: c.label, stored: c.set, workerSecret: c.fallback };
    },
  },

  // ------------------------------------------------------------ sign-in (admins)
  {
    name: "sign_in",
    ui: "Authentication (/admin/auth): how people sign in",
    label: "Read how people sign in",
    activity: "reading how people sign in",
    admin: true,
    description: "How people sign in: the providers on, each OAuth app, and a live check of each.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
      const { here, google, providers } = await authOf(caller).status(caller.who);
      return {
        providersOn: providers,
        github: signInOf(here),
        google: signInOf(google),
        note: "An app's values are pasted only on /admin/auth, never in a conversation.",
      };
    },
  },
  {
    name: "set_sign_in",
    ui: "Authentication (/admin/auth): each provider's switch, Clear, and Discard",
    label: "Change how people sign in",
    activity: "changing how people sign in",
    admin: true,
    description: "Turns a sign-in provider on or off, or clears its app values set on /admin/auth.",
    parameters: Schema.Struct({
      provider: PROVIDER,
      action: Schema.Literals(["on", "off", "clear", "discard"]).annotate({
        description:
          "on or off: people may sign in with it or not (on only while its app works; off only while the other works and you sign in with it). clear: back to the deploy's app values. discard: only the new values that wait for a test sign-in",
      }),
      force: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "clear: even when the page's values work and the deploy's don't (nobody could sign in). Only after you told the person",
        })
      ),
    }),
    run: async (args, caller) => {
      const provider = args.provider == "google" ? "google" : args.provider == "github" ? "github" : null;
      if (!provider) throw new OperationError({ message: 'provider: "github" or "google".', status: 400 });
      const auth = authOf(caller);
      if (args.action == "on" || args.action == "off")
        return { providersOn: await auth.setProvider(caller.who, provider, args.action == "on") };
      if (args.action == "discard") return { provider, ...(await auth.discard(caller.who, provider)) };
      if (args.action == "clear") return { provider, ...(await auth.clear(caller.who, args.force === true, provider)) };
      throw new OperationError({ message: "action: on, off, clear or discard.", status: 400 });
    },
  },

  // ------------------------------------------------------------ the server's people (admins)
  {
    name: "people",
    ui: "Users (/admin/users) and Access (/admin/access): the users, the group rules, and public sharing",
    label: "Read the users and access rules",
    activity: "reading the users and access rules",
    admin: true,
    description: "The users and their roles, the group rules, and whether public sharing is on.",
    parameters: Schema.Struct({}),
    run: async (_args, { dir, who }) => {
      const [users, people, ids, rules, suggestions, publicSharing] = await Promise.all([
        dir.users.list(who),
        dir.people.list(who),
        dir.identities.byLogin(),
        dir.rules.list(who),
        dir.rules.suggestions(who),
        dir.config.get("public_sharing"),
      ]);
      return {
        users: [
          ...users.map((u) => ({
            ...userOf(u),
            accounts: (ids.get(u.login) ?? []).map((i) => ({ provider: i.provider, handle: i.handle })),
          })),
          ...people.map(personOf),
        ],
        rules: rules.map(ruleOf),
        suggestions,
        publicSharing,
        note: "Access is the highest of a person's role and every group rule that matches them; none: they can't sign in. waiting: added, not signed in yet (use its person id). bootstrap: an admin by the deploy, fixed. Tell the person the labels (roleLabel, accessLabel).",
      };
    },
  },
  {
    name: "set_user",
    ui: "Users (/admin/users): Add user, a user's role, the deploy role, and Remove",
    label: "Change a user",
    activity: "changing a user",
    admin: true,
    description: "Adds a user, changes a user's role or deploy role, or removes a user.",
    parameters: Schema.Struct({
      action: Schema.Literals(["add", "role", "deploy", "remove"]).annotate({
        description:
          "add (provider, handle, role; before they ever signed in too), role (role), deploy (deploy: may use /deploy), remove (sessions and tokens stop; documents stay)",
      }),
      provider: Schema.optionalKey(PROVIDER),
      handle: Schema.optionalKey(Schema.String.annotate({ description: "add: the GitHub login, or the Google account's email" })),
      login: Schema.optionalKey(LOGIN),
      person: Schema.optionalKey(PERSON),
      role: Schema.optionalKey(
        Schema.Literals(["admin", "write", "read", "none"]).annotate({
          description:
            "admin ('Admin'), write ('Can create and edit content'), read ('Can authenticate'), or none ('No role', an account only)",
        })
      ),
      deploy: Schema.optionalKey(Schema.Boolean.annotate({ description: "deploy: true grants the deploy role, false revokes it" })),
    }),
    run: async (args, { dir, who }) => {
      const action = args.action;
      if (action == "add") {
        const r = await dir.addUser(
          who,
          { provider: need(args, "provider", action), handle: need(args, "handle", action) },
          roleValue(need(args, "role", action)) as UserRole
        );
        return {
          ...(r.user ? { user: userOf(r.user) } : {}),
          ...(r.person ? { person: personOf(r.person) } : {}),
          ...(r.note ? { note: r.note } : {}),
        };
      }
      if (action == "role") {
        const role = need(args, "role", action);
        if (args.person != null) return personOf(await dir.people.setRole(who, Number(args.person), roleValue(role) as UserRole));
        return userOf(await dir.users.setUserRole(who, String(need(args, "login", action)), roleValue(role, { none: true })));
      }
      if (action == "deploy") {
        if (typeof args.deploy != "boolean") throw new OperationError({ message: "deploy needs deploy: true or false.", status: 400 });
        return userOf(await dir.users.setDeploy(who, String(need(args, "login", action)), args.deploy));
      }
      if (action == "remove") {
        if (args.person != null) {
          await dir.people.remove(who, Number(args.person));
          return { removed: { person: Number(args.person) } };
        }
        const login = String(need(args, "login", action))
          .trim()
          .toLowerCase();
        if (!(await dir.users.get(login))) throw new OperationError({ message: `${login} isn't a user.`, status: 404 });
        await dir.users.remove(who, login);
        return { removed: login };
      }
      throw new OperationError({ message: "action: add, role, deploy or remove.", status: 400 });
    },
  },
  {
    name: "set_access",
    ui: "Access (/admin/access): Add a rule, a rule's access, Remove a rule, and Users can share content publicly",
    label: "Change the access rules",
    activity: "changing the access rules",
    admin: true,
    description: "Adds, changes or removes a group rule, or turns public sharing on or off.",
    parameters: Schema.Struct({
      action: Schema.Literals(["add", "change", "remove", "public"]).annotate({
        description:
          "add (kind, value, access; a rule for the same group changes it), change (id, access), remove (id; everybody's rule stays), public (on)",
      }),
      kind: Schema.optionalKey(
        Schema.Literals(["workspace", "github_org"]).annotate({
          description: "add: workspace (a Google Workspace domain) or github_org (a GitHub organization). A person is a user (set_user)",
        })
      ),
      value: Schema.optionalKey(Schema.String.annotate({ description: "add: the domain or the organization's login" })),
      access: Schema.optionalKey(ACCESS),
      id: Schema.optionalKey(Schema.Int.annotate({ description: "change, remove: the rule's id (people)" })),
      on: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "public: true lets owners share with anyone with the link, signed in or not; false stops it (old links then need a sign-in)",
        })
      ),
    }),
    run: async (args, { dir, who }) => {
      const action = args.action;
      if (action == "add")
        return ruleOf(
          await dir.rules.add(who, {
            kind: need(args, "kind", action),
            value: need(args, "value", action),
            access: need(args, "access", action),
          })
        );
      if (action == "change") {
        const id = Number(need(args, "id", action));
        const before = (await dir.rules.list(who)).find((r) => r.id == id);
        const after = await dir.rules.change(who, id, need(args, "access", action));
        return { rule: ruleOf(after), from: before ? `${before.access} (${ACCESS_LABEL[before.access]})` : null };
      }
      if (action == "remove") {
        const id = Number(need(args, "id", action));
        const before = (await dir.rules.list(who)).find((r) => r.id == id);
        await dir.rules.remove(who, id);
        return { removed: before ? ruleOf(before) : id };
      }
      if (action == "public") {
        if (typeof args.on != "boolean") throw new OperationError({ message: "public needs on: true or false.", status: 400 });
        const before = await dir.config.get("public_sharing");
        return { publicSharing: (await dir.config.set(who, "public_sharing", args.on)).value, before };
      }
      throw new OperationError({ message: "action: add, change, remove or public.", status: 400 });
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
