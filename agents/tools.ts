// Tools both kinds of agent have, defined once: the editor's own agent
// (editor-agent/session.ts, given them by its document's host, cloudflare/document-object.ts) and an
// external agent holding one of the person's agent tokens (server/api.ts,
// over HTTP, /mcp and the guide). They need only the directory (server/directory/:
// documents' permissions, the server's users and settings) and who's asking,
// so they run the same in a document's host and in the Worker.
//
//   document_access, share_document     who a document is shared with, and sharing it (its owner)
//   list_documents, create_document,    the documents list (/docs): the person's documents, a new one (blank, from a
//   delete_document                     template, or a copy), deleting one; the editor's agent only (`docs`: the
//                                       REST API has its own, server/api.ts, which also publish files)
//   list_settings, set_setting,         the server's settings, admins only;
//   reset_setting                       a setting the deploy locks can be seen, not changed
//   list_setting_changes                the settings' change log (server/directory/settings.ts history), admins only
//   list_api_keys, clear_api_key        which API keys are set, never a key, and clearing one,
//                                       admins only; a key is set only on /admin/api-keys, never in a conversation
//   get_sign_in_status,                 how people sign in on this server: which providers are on, its GitHub app and
//   switch_sign_in_provider,               Google client, never a secret;
//   clear_sign_in_app                   turning a provider on or off; clearing the values set on /admin/auth, or discarding
//                                       those that wait for a test sign-in. Admins only, with ToolWho.auth; an app's
//                                       values are set only on /admin/auth, never in a conversation
//   list_users, add_user,               the users on /admin/users, each a GitHub or Google account with one role (Admin,
//   set_user_role, set_user_deploy,     Can create and edit content, Can authenticate), before their first sign-in too;
//   remove_user                         admins only
//   list_access_rules, add_access_rule, the group rules on /admin/access (everybody, Workspaces, GitHub organizations),
//   change_access_rule,                 and whether users can share content publicly; admins only
//   remove_access_rule, set_public_sharing
//
// An admin tool is offered only to an admin with admin power (`toolsFor`;
// Users.actsAsAdmin): an external agent with an admin-scope token,
// and the admin's agent (agents/admin.ts, `adminTools`),
// acting as the admin whose session it is. The editor's agent never has them (a document's host never
// carries admin power, and a document's text could steer its agent). The
// directory checks again on every call (Users.mustAdmin), so a tool list
// that's gone stale (an unlock ended, someone stopped being an admin) still
// can't do anything.
//
// Adding one: an entry in SERVER_TOOLS. Both agents get it.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type TObject } from "typebox";
import {
  ACCESS_LABEL,
  type AccessRule,
  type Action,
  ANYONE,
  KIND_LABEL,
  NO_WRITE,
  type Person,
  ROLE_LABEL,
  roleValue,
  type UserRole,
  type ConfigEntry,
  ConfigError,
  CredentialError,
  type Directory,
  type DocRow,
  type Grant,
  ID,
  LOCKED,
  nameOf,
  newDocId,
  NotAllowed,
  OWNER,
  type Route,
  type User,
  type Who,
} from "../server/directory/index.ts";
import { AuthError, type AuthOps, type AuthStatus } from "../server/identity/index.ts";
import { makeDoc, startingFiles } from "../server/documents/index.ts";
import type { Platform } from "../server/platform.ts";
import { TEMPLATES, templateById } from "../server/pages/index.ts";
import { isDocKind } from "../document/pages.ts";

/** A tool's failure, worded for the agent to act on; `status` is the HTTP status the REST API answers. */
export class ToolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** What a tool runs with: the directory, who's asking, and (for the editor's agent) the document it's in. */
export interface ToolWho {
  readonly dir: Directory;
  readonly who: Who;
  /** The document the editor's agent works in: the default for a `document` argument. */
  readonly here?: string;
  /** The server's origin, for URLs in answers (else addresses only). */
  readonly origin?: string;
  /** The platform: for the documents list's tools (`docs`), which only the editor's agent gets. */
  readonly platform?: Platform;
  /** Sign-in's settings, where the server has them: for the sign-in tools. */
  readonly auth?: AuthOps;
}

export interface ServerToolDef {
  readonly name: string;
  /** For the editor's agent panel. */
  readonly label: string;
  /** What the agent is doing while it runs ("sharing the document"). */
  readonly activity: string;
  readonly description: string;
  readonly parameters: TObject;
  /** Only for server admins. */
  readonly admin?: boolean;
  /** The documents list's (needs ToolWho.platform): for the editor's agent; the REST API has its own. */
  readonly docs?: boolean;
  /** Its answer: text, or JSON (shown as text). Throws a ToolError (or NotAllowed, ConfigError) the agent can act on. */
  run(args: Record<string, unknown>, ctx: ToolWho): Promise<string | object>;
}

const DOCUMENT = Type.Optional(Type.String({ description: "The document: its address (/<owner>/<slug>), its URL, its id, or the slug of one of yours. The editor's agent may leave it out for the document it's in." }));
const LOGIN = Type.String({ description: "A GitHub login" });

/** Every tool both agents have. Add one here and the editor's agent, the REST API, MCP and the guide all have it. */
export const SERVER_TOOLS: ServerToolDef[] = [
  // ------------------------------------------------------------ sharing
  {
    name: "document_access",
    label: "Who has access",
    activity: "checking who has access",
    description: "Who a document is shared with: its owner, and everyone given a role (editor or viewer; \"*\" is anyone signed in who has the link). Only its owner may see this.",
    parameters: Type.Object({ document: DOCUMENT }),
    run: async (args, ctx) => {
      const doc = await findDocument(ctx, args.document, "share");
      return { document: described(doc, ctx), permissions: await permissionsOf(ctx.dir, doc.id) };
    },
  },
  {
    name: "share_document",
    label: "Share the document",
    activity: "sharing the document",
    description:
      'Shares a document (only its owner may): gives someone the role of editor (may edit and rename it) or viewer (may only look), or takes theirs away with role "none". login "*" means anyone with the link: anyone signed in, and people who aren\'t signed in too (as viewers); the server refuses it, saying why, unless it lets users share content publicly (the Access page). Answers who has access now.',
    parameters: Type.Object({
      document: DOCUMENT,
      login: Type.String({
        description:
          'Whose role to set: a GitHub login, or "*" for anyone with the link (only while the server lets users share content publicly)',
      }),
      role: Type.Union([Type.Literal("editor"), Type.Literal("viewer"), Type.Literal("none")], { description: "editor, viewer, or none to stop sharing it with them" }),
    }),
    run: async (args, ctx) => {
      const doc = await findDocument(ctx, args.document, "share");
      const role = args.role == "none" ? null : (args.role as Grant);
      await ctx.dir.share(ctx.who, doc.id, String(args.login ?? ""), role);
      return { document: described(doc, ctx), permissions: await permissionsOf(ctx.dir, doc.id) };
    },
  },

  // ------------------------------------------------------------ the documents list (/docs)
  {
    name: "list_documents",
    label: "List documents",
    activity: "listing the documents",
    docs: true,
    description: "The person's documents, as the documents list (/docs) shows them, most recently edited first: their own and the ones shared with them. Each one's id, title, address, whose it is, their role in it, when it was last edited, and when it goes if nobody edits it (only for never-edited ones).",
    parameters: Type.Object({}),
    run: async (_args, ctx) => (await docsOf(ctx).docs.list(ctx.who.login.toLowerCase())).map((d) => ({
      id: d.id, title: d.title, address: `/${d.owner}/${d.slug}`, ...(ctx.origin ? { url: `${ctx.origin}/${d.owner}/${d.slug}` } : {}), owner: d.owner, role: d.role,
      modified: iso(d.modified), ...(d.kind ? { kind: d.kind } : {}), ...(d.expires != null ? { expires: iso(d.expires) } : {}), ...(d.id == ctx.here ? { here: true } : {}),
    })),
  },
  {
    name: "create_document",
    label: "Make a document",
    activity: "making a document",
    docs: true,
    description: `Makes a new document for the person, as New on the documents list does: from a template (${TEMPLATES.map((t) => `"${t.id}": ${t.description}`).join(" ")} "landing": a copy of the server's front page), or a copy of a document they may open (from; someone who may not edit it copies its published version). A blank page by default. It goes if nobody edits it in time (the delete_docs_after_hours setting; the answer says when). The title follows the page's first heading unless you give one; the address follows the title unless you give a slug. Answers its address: open it, or say where it is.`,
    parameters: Type.Object({
      template: Type.Optional(Type.String({ description: `A template: ${TEMPLATES.map((t) => t.id).join(", ")} (the default), or landing` })),
      from: Type.Optional(Type.String({ description: "A document to copy instead: its address, URL or id" })),
      title: Type.Optional(Type.String({ description: "Its title (else the page's first heading)" })),
      slug: Type.Optional(Type.String({ description: "Its address after /<owner>/ (else made from the title)" })),
      kind: Type.Optional(Type.Union([Type.Literal("document"), Type.Literal("project")], { description: "document: one page and any files beside it (the default, or the kind of the document copied); project: a folder of pages, each with its own address" })),
    }),
    run: async (args, ctx) => {
      const { who } = ctx, platform = docsOf(ctx);
      if (who.test) throw new ToolError("You can't make documents on this server.", 403);
      if (!(await ctx.dir.mayWrite(who.login))) throw new ToolError(NO_WRITE, 403);
      const named = typeof args.template == "string" && args.template.trim() ? args.template.trim() : null;
      if (named && args.from) throw new ToolError("Give a template or a document to copy (from), not both.");
      const template = named && named != "landing" ? templateById(named) : undefined;
      if (named && named != "landing" && !template) throw new ToolError(`There's no template "${named}": ${TEMPLATES.map((t) => t.id).join(", ")}, or landing.`);
      const from = args.from ? (await findDocument(ctx, args.from, "open")).id : named == "landing" ? "landing" : null;
      const start = await startingFiles(platform, from, who, template);
      if (!start) throw new ToolError(from == "landing" ? "This server has no front page (landing document) to copy." : "There's nothing there you can copy.", 404);
      const title = typeof args.title == "string" ? args.title : undefined, slug = typeof args.slug == "string" ? args.slug : undefined;
      for (let tries = 0; tries < 5; tries++) {
        const kind = isDocKind(args.kind) ? args.kind : start.kind;
        const doc = await makeDoc(platform, who.login.toLowerCase(), newDocId(), start.files, { index: start.index, title, slug, kind });
        if (doc) return { made: described(doc, ctx), from: from ?? `the ${template?.id ?? TEMPLATES[0].id} template`, ...(doc.expires != null ? { expires: `${iso(doc.expires)}, unless someone edits it` } : {}) };
      }
      throw new ToolError("Couldn't pick an address for it: try again.", 500);
    },
  },
  {
    name: "delete_document",
    label: "Delete a document",
    activity: "deleting a document",
    docs: true,
    description: "Deletes one of the person's documents for good, as Delete on the documents list does (only its owner may). A document that's a folder on disk (local development) only comes off the list. Not the document you're in: the person deletes that one on the documents list (/docs). Only delete when the person asks, naming the document.",
    parameters: Type.Object({ document: Type.String({ description: "The document: its address (/<owner>/<slug>), its URL or its id" }) }),
    run: async (args, ctx) => {
      const doc = await findDocument({ ...ctx, here: undefined }, args.document, "delete");
      if (doc.id == ctx.here) throw new ToolError("That's the document you're in: the person deletes it on the documents list (/docs).", 409);
      const platform = docsOf(ctx);
      if (!(await platform.docs.delete(doc))) await platform.directory.remove(doc.id);
      return { deleted: described(doc, ctx) };
    },
  },

  // ------------------------------------------------------------ the server's settings (admins)
  {
    name: "list_settings",
    label: "Read the server's settings",
    activity: "reading the server's settings",
    admin: true,
    description: "Admins only. The server's settings: each one's key, what it does, its value now, its default, where the value comes from (default, set by an admin, or locked by the deploy), and who last set it. A locked one can't be changed here.",
    parameters: Type.Object({}),
    run: async (_args, { dir, who }) => (await dir.config.list(who)).map(entryOf),
  },
  {
    name: "set_setting",
    label: "Change a server setting",
    activity: "changing a server setting",
    admin: true,
    description: "Admins only. Sets one of the server's settings (list_settings lists them, with what each takes). The value is JSON: a number, a string, true, false or null (e.g. delete_docs_after_hours: a number of hours, or null to never delete unedited documents). A setting the deploy locks can't be changed. Answers the setting as it is now.",
    parameters: Type.Object({
      key: Type.String({ description: "The setting's key, e.g. delete_docs_after_hours" }),
      value: Type.Unknown({ description: "Its new value (a number, string, boolean or null, as the setting takes)" }),
    }),
    run: async (args, { dir, who }) => {
      const key = String(args.key ?? "");
      if (args.value === undefined) throw new ToolError("Give the value to set it to (reset_setting puts it back to its default).");
      try {
        return entryOf(await dir.config.set(who, key, args.value));
      } catch (e) {
        // "48" for 48: a model may send a number as a string.
        if (!(e instanceof ConfigError) || typeof args.value != "string") throw e;
        let parsed: unknown;
        try { parsed = JSON.parse(args.value); } catch { throw e; }
        if (typeof parsed == "string") throw e;
        return entryOf(await dir.config.set(who, key, parsed));
      }
    },
  },
  {
    name: "reset_setting",
    label: "Reset a server setting",
    activity: "resetting a server setting",
    admin: true,
    description: "Admins only. Puts one of the server's settings back to its default. A setting the deploy locks can't be changed.",
    parameters: Type.Object({ key: Type.String({ description: "The setting's key" }) }),
    run: async (args, { dir, who }) => entryOf(await dir.config.reset(who, String(args.key ?? ""))),
  },
  {
    name: "search_documents",
    label: "Find a document or project on the server",
    activity: "finding a document or project",
    admin: true,
    description:
      "Admins only. Finds any of the server's documents and projects, everyone's, by a part of its title, its owner, its address (/<owner>/<slug>) or its id, as the Homepage Project setting's picker on /admin does; most recently edited first. Each: its id, title, owner, address and kind (document or project). To make one the homepage, give its address or id to set_setting with the key landing_document.",
    parameters: Type.Object({
      query: Type.String({ description: "A part of the title, owner or address; empty: the most recently edited" }),
      limit: Type.Optional(Type.Integer({ description: "At most this many (default 20, at most 100)" })),
    }),
    run: async (args, { dir, who }) => ({ found: await dir.search(who, String(args.query ?? ""), Number(args.limit) || 20) }),
  },

  {
    name: "list_setting_changes",
    label: "Read the settings' change log",
    activity: "reading the settings' change log",
    admin: true,
    description: "Admins only. The settings' change log (/admin/changes), newest first: each change's number, when, who made it, and each setting's value before and after (reset: put back to its default; credential: an API key set, replaced or cleared, never the key). 20 at a time unless you ask for more (up to 100); before: only changes older than that number. total: how many there are.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ description: "How many, the latest first (default 20, at most 100)" })),
      before: Type.Optional(Type.Integer({ description: "Only changes numbered lower than this" })),
    }),
    run: async (args, { dir, who }) => {
      const { versions, total } = await dir.config.history(who, { limit: Math.min(100, Number(args.limit) || 20), ...(args.before != null ? { before: Number(args.before) } : {}) });
      return { total, changes: versions.map((v) => ({ n: v.n, at: iso(v.at), by: v.by, ...(v.via ? { via: v.via } : {}), changes: v.changes })) };
    },
  },
  {
    name: "list_api_keys",
    label: "Read the API keys' status",
    activity: "reading the API keys' status",
    admin: true,
    description: "Admins only. The server's API keys (Anthropic, OpenAI, the GitHub mirror token, the Cloudflare deploy token), as /admin/api-keys shows them: whether each is stored, its last four characters, who set it and when, whether a Worker secret stands in, and whether a stored key doesn't open on this server. Never the key itself. An admin sets, replaces or clears a key only on /admin/api-keys, so a key never goes through a conversation.",
    parameters: Type.Object({}),
    run: async (_args, { dir, who }) => (await dir.credentials.list(who)).map((c) => ({
      name: c.name, label: c.label, description: c.description, stored: c.set, last4: c.last4, updated: iso(c.updated), updatedBy: c.updatedBy, ...(c.updatedVia ? { updatedVia: c.updatedVia } : {}), workerSecret: c.fallback, ...(c.unreadable ? { unreadable: "stored, but this server can't open it (encrypted with another server's FACTORY_KEY): an admin must paste it again on /admin/api-keys" } : {}),
    })),
  },

  {
    name: "clear_api_key",
    label: "Clear an API key",
    activity: "clearing an API key",
    admin: true,
    description: "Admins only. Clears one of the server's API keys (list_api_keys lists them), as Clear on /admin/api-keys does: the server goes back to its Worker secret, if one stands in, else does without (the Anthropic key: the agents stop). The change log says who cleared it. Setting or replacing a key is done only on /admin/api-keys, so a key never goes through a conversation.",
    parameters: Type.Object({ name: Type.String({ description: "The key's name: anthropic, openai, github_mirror or cloudflare_deploy" }) }),
    run: async (args, { dir, who }) => {
      const c = await dir.credentials.clear(who, String(args.name ?? ""));
      return { cleared: c.name, label: c.label, stored: c.set, workerSecret: c.fallback };
    },
  },

  // ------------------------------------------------------------ sign-in (admins)
  {
    name: "get_sign_in_status",
    label: "Read how people sign in",
    activity: "reading how people sign in",
    admin: true,
    description:
      "Admins only. How people sign in, as /admin/auth shows it: which providers are on (GitHub, Google); and for each of this server's GitHub OAuth app and Google OAuth client: its client ID (public) and where it comes from (the deploy, or set on /admin/auth), whether its client secret is set (never the secret), the homepage and callback URLs the app must have, a live check with GitHub or Google (working, misconfigured and why, not set up, unknown), values that wait for a test sign-in, and, where the app doesn't work, the steps to make one. An app's values are pasted only on /admin/auth, never in a conversation.",
    parameters: Type.Object({}),
    run: async (_args, ctx) => {
      const { here, google, providers } = await authOf(ctx).status(ctx.who);
      return { providersOn: providers, github: signInOf(here), google: signInOf(google) };
    },
  },
  {
    name: "switch_sign_in_provider",
    label: "Turn a sign-in provider on or off",
    activity: "turning a sign-in provider on or off",
    admin: true,
    description: "Admins only. Turns sign-in with GitHub or Google on or off on this server, as the switches on /admin/auth do. Anyone allowed on the server may then sign in with each provider that's on. The rules, so nobody is locked out: a provider goes on only while its app works (get_sign_in_status says); one goes off only while the other is on and works, and only by an admin whose own account signs in with the other provider (each account signs in with one). Answers which providers are on now.",
    parameters: Type.Object({
      provider: Type.Union([Type.Literal("github"), Type.Literal("google")], { description: "github or google" }),
      on: Type.Boolean({ description: "true: people may sign in with it; false: they may not" }),
    }),
    run: async (args, ctx) => {
      const provider = args.provider == "google" ? "google" : args.provider == "github" ? "github" : null;
      if (!provider) throw new ToolError('provider: "github" or "google".');
      if (typeof args.on != "boolean") throw new ToolError("on: true or false.");
      return { providersOn: await authOf(ctx).setProvider(ctx.who, provider, args.on) };
    },
  },
  {
    name: "clear_sign_in_app",
    label: "Clear sign-in values",
    activity: "clearing sign-in values",
    admin: true,
    description:
      "Admins only. Clears a provider's app values set on /admin/auth (provider: github, the default, or google), as Clear there does: sign-in goes back to the deploy's values. With what: \"pending\", it only discards new values that wait for a test sign-in (Discard), and sign-in keeps the values in use. It refuses when the values set on the page work and the deploy's don't, since everyone would stop being able to sign in; force: true clears anyway, and only when the person says so after you told them that. Setting an app's values is done only on /admin/auth.",
    parameters: Type.Object({
      provider: Type.Optional(Type.Union([Type.Literal("github"), Type.Literal("google")], { description: "github (default) or google" })),
      what: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("pending")], { description: "all (default): the values set on the page; pending: only those that wait for a test sign-in" })),
      force: Type.Optional(Type.Boolean({ description: "Clear even if sign-in would stop working: only when the person says so" })),
    }),
    run: async (args, ctx) => {
      const provider = args.provider == "google" ? "google" : "github";
      if (args.what == "pending") return { provider, ...(await authOf(ctx).discard(ctx.who, provider)) };
      return { provider, ...(await authOf(ctx).clear(ctx.who, args.force === true, provider)) };
    },
  },

  // ------------------------------------------------------------ the server's users (admins)
  {
    name: "list_users",
    label: "List the server's users",
    activity: "listing the users",
    admin: true,
    description:
      "Admins only. The users on /admin/users: each account (login: its username; accounts: the GitHub and Google accounts it signs in with), its one role, as roleLabel says it: admin ('Admin'), write ('Can create and edit content': may sign in, open what is shared with them or public, and make and edit documents) or read ('Can authenticate': may sign in, and open what is shared with them or public), or none ('No role': only the group rules on /admin/access let them in); a person's access is the highest of their role and every group rule that matches them. Also whether they were granted the deploy role (deploy), whether they may deploy (mayDeploy), whether they're an admin by the deploy (bootstrap: can't be changed or removed here), when they were added and by whom, and when they were last seen. People an admin added who haven't signed in yet come too, with waiting: true and a person id instead of a login (provider, handle: their GitHub login or Google email). Use the role words when you tell the person.",
    parameters: Type.Object({}),
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
    label: "Add a user",
    activity: "adding a user",
    admin: true,
    description:
      "Admins only. Adds a user, as Add user on /admin/users does, before they ever signed in too: a GitHub account by its login (GitHub's id for it is found now and matched at sign-in; refused if GitHub has no such login) or a Google account by its email (matched as a verified email at its first sign-in, then by Google's id), with one role: admin ('Admin'), write ('Can create and edit content': may sign in, open what is shared with them or public, and make and edit documents) or read ('Can authenticate': may sign in, and open what is shared with them or public). An account that signs in with it already gets the role. An admin by the deploy is one already (note says so). Only when the person asks in this conversation; say what you did, with the role's words.",
    parameters: Type.Object({
      provider: Type.Union([Type.Literal("github"), Type.Literal("google")], { description: "github or google" }),
      handle: Type.String({ description: "The GitHub login, or the Google account's email" }),
      role: Type.Union([Type.Literal("admin"), Type.Literal("write"), Type.Literal("read")], {
        description: "admin ('Admin'), write ('Can create and edit content') or read ('Can authenticate')",
      }),
    }),
    run: async (args, { dir, who }) => {
      const r = await dir.addUser(who, { provider: args.provider, handle: args.handle, role: args.role }, roleValue(args.role) as UserRole);
      return {
        ...(r.user ? { user: userOf(r.user) } : {}),
        ...(r.person ? { person: personOf(r.person) } : {}),
        ...(r.note ? { note: r.note } : {}),
      };
    },
  },
  {
    name: "list_access_rules",
    label: "Read the access rules",
    activity: "reading the access rules",
    admin: true,
    description:
      "Admins only. The access rules on /admin/access, one list: each rule's id, who (a group: everybody; a Google Workspace organization, by its domain, matched on the hd claim Google gives Workspace accounts; a GitHub organization, its members checked at each GitHub sign-in) and access: none ('No access'), read ('Can authenticate': may sign in, and open what is shared with them or public) or write ('Can create and edit content': also make and edit them). Specific people are users with a role (list_users), not rules. A person gets the highest of their user role and every rule that matches them; if that's none, they can't sign in. Admins always have 'Can create and edit content'. Only a specific set of people: everybody 'No access', and those people as users. Each rule's accessLabel is the words the Access page shows: use them when you tell the person. Also the Workspace domains and GitHub organizations of people who signed in here (suggestions), and whether users can share content publicly (publicSharing).",
    parameters: Type.Object({}),
    run: async (_args, { dir, who }) => ({ rules: (await dir.rules.list(who)).map(ruleOf), suggestions: await dir.rules.suggestions(who), publicSharing: await dir.config.get("public_sharing") }),
  },
  {
    name: "set_public_sharing",
    label: "Turn public sharing on or off",
    activity: "changing whether users can share content publicly",
    admin: true,
    description:
      "Admins only. 'Users can share content publicly', the switch on /admin/access. On: a document shared with anyone with the link opens for people who aren't signed in too, as viewers, and owners may share that way. Off: nobody may share with anyone with the link (it's refused, saying why), and such shares made before stay but open only for people who sign in; turning it on again restores them. The homepage is public either way. Only when the person asks in this conversation; say what changed.",
    parameters: Type.Object({ on: Type.Boolean({ description: "true: users can share content publicly; false: they can't" }) }),
    run: async (args, { dir, who }) => {
      if (typeof args.on != "boolean") throw new ToolError("on: true or false.");
      const before = await dir.config.get("public_sharing");
      return { publicSharing: (await dir.config.set(who, "public_sharing", args.on)).value, before };
    },
  },
  {
    name: "add_access_rule",
    label: "Add an access rule",
    activity: "adding an access rule",
    admin: true,
    description:
      "Admins only. Adds an access rule, as Add on /admin/access does (a rule for the same who changes its access). kind: workspace (value: the Google Workspace organization's domain) or github_org (value: the organization's login); a specific person is added with add_user instead. access: none ('No access'), read ('Can authenticate') or write ('Can create and edit content'). Only when the person asks in this conversation; say what you added, in those words.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("workspace"), Type.Literal("github_org")], { description: "workspace or github_org" }),
      value: Type.String({ description: "The domain or the organization" }),
      access: Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write")], {
        description: "none ('No access'), read ('Can authenticate') or write ('Can create and edit content')",
      }),
    }),
    run: async (args, { dir, who }) => ruleOf(await dir.rules.add(who, { kind: args.kind, value: args.value, access: args.access })),
  },
  {
    name: "change_access_rule",
    label: "Change an access rule",
    activity: "changing an access rule",
    admin: true,
    description:
      "Admins only. Changes a rule's access (list_access_rules gives each id), as its select on /admin/access does: none ('No access'), read ('Can authenticate') or write ('Can create and edit content'). Only when the person asks; say what changed, from what to what, in those words.",
    parameters: Type.Object({
      id: Type.Integer({ description: "The rule's id" }),
      access: Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write")], {
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
    label: "Remove an access rule",
    activity: "removing an access rule",
    admin: true,
    description: "Admins only. Removes a rule (list_access_rules gives each id), as its remove button on /admin/access does. Everybody's rule stays: set it to none with change_access_rule. Someone no rule matches any more is signed out within seconds. Only when the person asks.",
    parameters: Type.Object({ id: Type.Integer({ description: "The rule's id" }) }),
    run: async (args, { dir, who }) => {
      const before = (await dir.rules.list(who)).find((r) => r.id == Number(args.id));
      await dir.rules.remove(who, Number(args.id));
      return { removed: before ? ruleOf(before) : Number(args.id) };
    },
  },
  {
    name: "set_user_role",
    label: "Change a user's role",
    activity: "changing a user's role",
    admin: true,
    description:
      "Admins only. Changes a user's one role, as its select on /admin/users does: admin ('Admin'), write ('Can create and edit content': may sign in, open what is shared with them or public, and make and edit documents) or read ('Can authenticate': may sign in, and open what is shared with them or public), or for an account none ('No role': only the group rules let them in). Give login for an account, or person (list_users's id) for someone who hasn't signed in yet. An admin by the deploy (bootstrap) stays one, and the server keeps an admin. Only when the person asks; say what changed, with the role's words.",
    parameters: Type.Object({
      login: Type.Optional(LOGIN),
      person: Type.Optional(Type.Integer({ description: "The id of someone who hasn't signed in yet (list_users)" })),
      role: Type.Union([Type.Literal("admin"), Type.Literal("write"), Type.Literal("read"), Type.Literal("none")], {
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
    label: "Grant or revoke the deploy role",
    activity: "changing a user's deploy role",
    admin: true,
    description: "Admins only. Grants a user the deploy role, or revokes it: with it they may use /deploy (deploy Erga to their own Cloudflare account) when the deploy_page setting is admins, as admins may.",
    parameters: Type.Object({ login: LOGIN, deploy: Type.Boolean({ description: "true to grant the deploy role, false to revoke it" }) }),
    run: async (args, { dir, who }) => userOf(await dir.users.setDeploy(who, String(args.login ?? ""), args.deploy === true)),
  },
  {
    name: "remove_user",
    label: "Remove a user",
    activity: "removing a user",
    admin: true,
    description:
      "Admins only. Removes a user, as the remove button on /admin/users does: their sessions and tokens stop working within seconds, unless a group rule on /admin/access lets them in; their documents stay. Give login for an account, or person (list_users's id) for someone who hasn't signed in yet. An admin by the deploy (bootstrap) can't be removed here.",
    parameters: Type.Object({
      login: Type.Optional(LOGIN),
      person: Type.Optional(Type.Integer({ description: "The id of someone who hasn't signed in yet (list_users)" })),
    }),
    run: async (args, { dir, who }) => {
      if (args.person != null) {
        await dir.people.remove(who, Number(args.person));
        return { removed: { person: Number(args.person) } };
      }
      const login = String(args.login ?? "")
        .trim()
        .toLowerCase();
      if (login == who.login.toLowerCase()) throw new ToolError("That's you: another admin has to remove you.");
      if (!(await dir.users.get(login))) throw new ToolError(`${login} isn't a user.`, 404);
      await dir.users.remove(who, login);
      return { removed: login };
    },
  },
];

/** The tools someone may use: the admin ones only for an admin with admin power (Users.actsAsAdmin). */
export async function toolsFor(dir: Directory, who: Who): Promise<ServerToolDef[]> {
  const admin = await dir.users.actsAsAdmin(who);
  return SERVER_TOOLS.filter((t) => admin || !t.admin);
}

/**
 * Runs one, with what the directory throws turned into ToolErrors (not
 * allowed: 403; a bad value: 400).
 */
export async function runServerTool(tool: ServerToolDef, args: Record<string, unknown>, ctx: ToolWho): Promise<string | object> {
  if (tool.admin && !(await ctx.dir.users.actsAsAdmin(ctx.who))) throw new ToolError((await ctx.dir.users.isAdmin(ctx.who)) ? LOCKED : "Only an admin can do that.", 403);
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e instanceof NotAllowed) throw new ToolError(e.message, /no such|isn't a user/i.test(e.message) ? 404 : 403);
    if (e instanceof ConfigError || e instanceof CredentialError || e instanceof AuthError) throw new ToolError(e.message, 400);
    throw e;
  }
}

/** The tools as the editor's agent takes them (pi's AgentTool), for someone in a document. */
export async function agentToolsFor(ctx: ToolWho): Promise<(AgentTool & { activity: string })[]> {
  return (await toolsFor(ctx.dir, ctx.who))
    .filter((t) => !t.docs || ctx.platform)
    .map((t) => ({
      name: t.name,
      label: t.label,
      activity: t.activity,
      description: t.description,
      parameters: t.parameters,
      execute: async (_id, params) => {
        const out = await runServerTool(t, params as Record<string, unknown>, ctx).catch((e: unknown) => { throw new Error(e instanceof Error ? e.message : String(e)); });
        return toolResult(out);
      },
    }));
}

/** A tool's answer as pi takes it: the text for the model; an `offer` in it (a button for the person) goes to the panel too. */
export function toolResult(out: unknown) {
  const offer = out && typeof out == "object" && "offer" in out ? (out as { offer: unknown }).offer : undefined;
  return { content: [{ type: "text" as const, text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }], details: offer ? { offer } : {} };
}

// ---------------------------------------------------------------- helpers

/**
 * The document an agent names (an address, a URL, an id, or one of the
 * person's slugs; nothing for the one it's in), if they may do `action` with it.
 */

export async function findDocument(ctx: ToolWho, ref: unknown, action: Action): Promise<DocRow> {
  const { dir, who } = ctx;
  if ((ref == null || ref === "") && ctx.here) ref = ctx.here;
  if (typeof ref != "string" || !ref.trim()) throw new ToolError("Name the document: its address (/<owner>/<slug>), URL or id.");
  let path = ref.trim();
  try { path = new URL(path).pathname; } catch { /* not a URL */ }
  const parts = path.split("/").filter(Boolean);
  let route: Route | null = null;
  if (parts.length >= 2) route = parts[0] == "d" ? (ID.test(parts[1]) ? await dir.route(parts[1]) : null) : await routeAt(dir, parts[0], parts[1]);
  else if (parts.length == 1) {
    route = ID.test(parts[0]) ? await dir.route(parts[0]) : null;
    route ??= await routeAt(dir, who.login, parts[0]);
  }
  const doc = route && await dir.get(route.id);
  if (!doc) throw new ToolError(`There's no document "${ref}". list_documents lists yours.`, 404);
  if (!(await dir.may(who, action, doc))) {
    throw new ToolError(action == "delete" ? "Only its owner can delete a document." : action == "share" ? "Only its owner can share a document, or see who it's shared with." : `You can't ${action} that document.`, 403);
  }
  return doc;
}

/** The document at /<owner>/<segment>: by id (if it's theirs), slug, or an old slug. */
async function routeAt(dir: Directory, owner: string, segment: string): Promise<Route | null> {
  if (!OWNER.test(owner)) return null;
  owner = owner.toLowerCase();
  if (ID.test(segment)) {
    const byId = await dir.route(segment);
    if (byId?.owner == owner) return byId;
  }
  const found = await dir.locate(owner, segment);
  return found && { id: found.doc.id, owner: found.doc.owner, test: found.doc.test };
}

function described(doc: DocRow, { origin }: ToolWho) {
  const name = nameOf(doc);
  return { id: doc.id, title: name.title, address: name.address, ...(origin ? { url: origin + name.address } : {}) };
}

async function permissionsOf(dir: Directory, id: string) {
  return (await dir.permissions(id)).map((p) => ({
    login: p.login,
    role: p.role,
    ...(p.login == ANYONE
      ? {
          means:
            "anyone with the link: anyone signed in, and, while the server lets users share content publicly, people who aren't signed in too (as viewers)",
        }
      : {}),
    granted: new Date(p.granted).toISOString(),
    ...(p.grantedBy ? { grantedBy: p.grantedBy } : {}),
    ...(p.grantedVia ? { grantedVia: p.grantedVia } : {}),
  }));
}

/** The platform, for the documents list's tools. */
function docsOf(ctx: ToolWho): Platform {
  if (!ctx.platform) throw new ToolError("The documents list isn't reachable from here.", 501);
  return ctx.platform;
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

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
  return { id: r.id, who: r.kind == "everybody" ? "everybody" : `${KIND_LABEL[r.kind]}: ${r.value}`, kind: r.kind, value: r.value, access: r.access, accessLabel: ACCESS_LABEL[r.access], added: r.created ? iso(r.created) : null, addedBy: r.addedBy, ...(r.addedVia ? { addedVia: r.addedVia } : {}) };
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
function authOf(ctx: ToolWho): AuthOps {
  if (!ctx.auth) throw new ToolError("This server's sign-in settings aren't reachable from here.", 404);
  return ctx.auth;
}

/** A server's sign-in, as an agent reads it: never a secret. */
function signInOf(s: AuthStatus) {
  return {
    target: s.target, origin: s.origin, provider: s.provider, state: s.check.state, summary: s.check.summary, reasons: s.check.reasons,
    clientId: s.inUse.clientId, clientIdFrom: s.inUse.source == "page" ? "/admin/auth" : "the deploy", secretSet: s.inUse.secretSet,
    homepageUrl: s.homepageUrl, callbackUrl: s.callbackUrl, localDevelopment: s.dev || undefined,
    deploy: { clientId: s.deploy.clientId, secretSet: s.deploy.secretSet },
    setOnPage: s.page ? { clientId: s.page.clientId, updated: iso(s.page.updated), updatedBy: s.page.updatedBy, ...(s.page.updatedVia ? { updatedVia: s.page.updatedVia } : {}) } : null,
    waitingForTestSignIn: s.pending ? { clientId: s.pending.clientId, updated: iso(s.pending.updated), updatedBy: s.pending.updatedBy, check: s.pendingCheck?.summary, lastTest: s.pending.test ?? null } : null,
    canKeepValues: s.canStore,
    setupSteps: s.setup,
  };
}
