// The server's own settings and people, on the admin pages (/admin/settings): the settings, the API keys and the change log
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
import { type AuthOps, type AuthStatus, type Provider, providerOf, PROVIDERS } from "../identity/index.ts";
import { SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { ACTIVE_DAYS, analytics, analyticsList, isSpan, pageLlmUsage, SPANS } from "../admin/index.ts";
import { type Caller, iso, LOGIN, type Operation, OperationError, said } from "./operation.ts";

const OAUTH = Object.keys(PROVIDERS) as Provider[];
/** An OAuth provider (the OAuth mode's: set_sign_in). */
const PROVIDER = Schema.Literals(OAUTH).annotate({ description: OAUTH.join(" or ") });
/** The provider of a person's account: an OAuth provider, or the proxy of a server in the proxy mode (sign_in says the mode). */
const ACCOUNT_PROVIDER = Schema.Literals(Object.keys(SIGN_IN_PROVIDERS)).annotate({
  description: `${OAUTH.join(" or ")}; proxy on a server whose sign-in mode is proxy (sign_in)`,
});
const ACCESS = Schema.Literals(["none", "read", "write"]).annotate({
  description: "none ('No access'), read ('Can authenticate') or write ('Can create and edit content')",
});
const PERSON = Schema.Int.annotate({ description: "For someone who hasn't signed in yet: their person id (people)" });

/** US dollars to a tenth of a cent. */
const round = (usd: number) => Math.round(usd * 1000) / 1000;

/** An argument an action needs: its value, or a 400 that says which. */
function need<T>(args: Record<string, unknown>, key: string, action: unknown): T {
  if (args[key] == null || args[key] === "") throw new OperationError({ message: `${action} needs ${key}.`, status: 400 });
  return args[key] as T;
}

export const ADMIN_OPERATIONS: Operation[] = [
  // ------------------------------------------------------------ the server's settings and API keys (admins)
  {
    name: "settings",
    ui: "Settings (/admin/settings), API keys (/admin/api-keys) and Change log (/admin/changes)",
    label: "Read the server's settings",
    activity: "reading the server's settings",
    admin: true,
    description: "The server's settings, API keys and pages' model use today, or the settings' change log (changes).",
    parameters: Schema.Struct({
      changes: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "true: the change log, newest first, instead of the settings and API keys (never a key)",
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
      const [settings, keys, use] = await Promise.all([dir.config.list(who), dir.credentials.list(who), pageLlmUsage(dir)]);
      return {
        settings: settings.map(entryOf),
        pageModelsToday: {
          since: iso(use.since),
          calls: use.calls,
          inputTokens: use.input,
          outputTokens: use.output,
          costUsd: round(use.cost),
          limitUsd: use.limit,
          limitUsed: `${Math.round(use.used * 100)}%`,
          costliest: use.docs.map((d) => ({
            document: d.address ?? d.id,
            ...(d.title ? { title: d.title } : {}),
            calls: d.calls,
            inputTokens: d.input,
            outputTokens: d.output,
            costUsd: round(d.cost),
          })),
          note: "Pages' model calls since midnight UTC; the cost is an estimate from their tokens.",
        },
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
    ui: "Settings (/admin/settings): change a setting, or Reset to the default",
    label: "Change a server setting",
    activity: "changing a server setting",
    admin: true,
    description: "Sets one of the server's settings, or puts it back to its default (reset).",
    asks: (args) =>
      args.reset === true
        ? `Put the server's setting ${said(args.key)} back to its default`
        : `Set the server's setting ${said(args.key)} to ${said(args.value)}`,
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
    asks: (args) => `Clear the server's API key ${said(args.name)}`,
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
    description: "How people sign in: the mode (oauth or proxy); the providers on, each OAuth app and a live check of each; or the proxy.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
      const status = await authOf(caller).status(caller.who);
      if (status.mode == "proxy")
        return {
          mode: "proxy",
          proxy: status.proxy,
          note: "A proxy in front of the server signs each person in. The deploy sets it: nothing here changes it.",
        };
      return {
        mode: "oauth",
        providersOn: status.providers,
        ...Object.fromEntries(OAUTH.map((id) => [id, signInOf(status.apps[id])])),
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
    asks: (args) => {
      const provider = PROVIDERS[providerOf(args.provider) ?? OAUTH[0]].label;
      if (args.action == "clear")
        return `Clear the ${provider} sign-in app's values${args.force === true ? ", even if nobody can sign in then" : ""}`;
      if (args.action == "discard") return `Discard the ${provider} sign-in app's new values`;
      return `Turn sign-in with ${provider} ${said(args.action)}`;
    },
    parameters: Schema.Struct({
      provider: PROVIDER,
      action: Schema.Literals(["on", "off", "clear", "discard"]).annotate({
        description:
          "on, off (only while its app works, or the other one does). clear: back to the deploy's app values. discard: the new values that wait for a test sign-in",
      }),
      force: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "clear: even when the page's values work and the deploy's don't (nobody could sign in). Only after you told the person",
        })
      ),
    }),
    run: async (args, caller) => {
      const provider = providerOf(args.provider);
      if (!provider) throw new OperationError({ message: `provider: ${OAUTH.map((id) => `"${id}"`).join(" or ")}.`, status: 400 });
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
        note: "Access is the highest of a person's role and every group rule that matches them; none: they can't sign in. waiting: added, not signed in yet (use its person id). bootstrap: the dev server's own admin (DEV_LOGIN), fixed. Tell the person the labels (roleLabel, accessLabel).",
      };
    },
  },
  {
    name: "analytics",
    ui: "Analytics (/admin): the charts of each day (7, 30 or 90 days), and Load more under each list",
    label: "Read the analytics",
    activity: "reading the analytics",
    admin: true,
    description: "Each day's active people, document views and edits, and models' tokens; the most active and newest users.",
    parameters: Schema.Struct({
      days: Schema.optionalKey(Schema.Literals(SPANS).annotate({ description: "How many days up to today (UTC): 7, 30 (default) or 90" })),
      list: Schema.optionalKey(
        Schema.Literals(["active", "newest"]).annotate({
          description: `Only this list's next people: active (the most edits and views in the last ${ACTIVE_DAYS} days) or newest (the accounts made last)`,
        })
      ),
      offset: Schema.optionalKey(Schema.Int.annotate({ description: "With list: how many to skip (default 0)" })),
      limit: Schema.optionalKey(Schema.Int.annotate({ description: "With list: how many (default 10, at most 50)" })),
    }),
    run: async (args, { dir, who }) => {
      if (args.list === "active" || args.list === "newest")
        return analyticsList(
          dir,
          who,
          args.list,
          Math.max(0, Number(args.offset) || 0),
          Math.min(50, Math.max(1, Number(args.limit) || 10))
        );
      return {
        ...(await analytics(dir, who, isSpan(args.days) ? args.days : 30)),
        note: "Days are UTC. Active: opened a document, edited one (a version: a burst of edits), or used a model (their agent, a page's model). Tokens: input and output of every model, by the server's keys or the person's own. Each list's more: true means list with an offset gives the next.",
      };
    },
  },
  {
    name: "set_user",
    ui: "Users (/admin/users): Add user, a user's role, and Remove",
    label: "Change a user",
    activity: "changing a user",
    admin: true,
    description: "Adds a user, changes a user's role, or removes a user.",
    asks: (args) => {
      const whom = said(args.handle ?? args.login ?? `person ${args.person}`);
      if (args.action == "add") return `Add the user ${whom} with the role ${said(args.role ?? "none")}`;
      if (args.action == "remove") return `Remove the user ${whom}`;
      return `Change the role of the user ${whom} to ${said(args.role)}`;
    },
    parameters: Schema.Struct({
      action: Schema.Literals(["add", "role", "remove"]).annotate({
        description:
          "add (provider, handle, role; before they ever signed in too), role (role), remove (sessions and tokens stop; documents stay)",
      }),
      provider: Schema.optionalKey(ACCOUNT_PROVIDER),
      handle: Schema.optionalKey(
        Schema.String.annotate({ description: "add: the account's login (github), or its email (google, proxy)" })
      ),
      login: Schema.optionalKey(LOGIN),
      person: Schema.optionalKey(PERSON),
      role: Schema.optionalKey(
        Schema.Literals(["admin", "write", "read", "none"]).annotate({
          description:
            "admin ('Admin'), write ('Can create and edit content'), read ('Can authenticate'), or none ('No role', an account only)",
        })
      ),
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
    asks: (args) => {
      if (args.action == "public") return `Turn public sharing ${args.on ? "on" : "off"} for the whole server`;
      if (args.action == "add") return `Add the access rule ${said(args.kind)} ${said(args.value)}: ${said(args.access)}`;
      if (args.action == "remove") return `Remove the access rule ${said(args.id)}`;
      return `Change the access rule ${said(args.id)} to ${said(args.access)}`;
    },
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
