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
//   get_sign_in_status,                 how people sign in: this server's GitHub app and the other deploy
//   clear_sign_in_app                   target's, never a secret; clearing the values set on /admin/auth, or discarding
//                                       those that wait for a test sign-in. Admins only, with ToolWho.auth; an app's
//                                       values are set only on /admin/auth, never in a conversation
//   domain_status, publish_to_domain,   a document's site at a domain of the person's own, from their Cloudflare account
//   deploy_domain, remove_domain,       a document at a domain of the person's own, where the platform has it (ToolWho.sites); connecting is
//   disconnect_cloudflare               a consent in the person's browser only, never in a conversation (the agent may disconnect it)
//   list_users, add_user,               who may sign in, and who's an admin,
//   set_user_role, set_user_deploy,     admins only
//   remove_user
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
import { type Action, ANYONE, type ConfigEntry, ConfigError, CredentialError, type Directory, type DocRow, type Grant, ID, LOCKED, nameOf, newDocId, NotAllowed, OWNER, type Route, type User, type Who } from "../server/directory/index.ts";
import { AuthError, type AuthOps, type AuthStatus, type OtherStatus } from "../server/identity/index.ts";
import { makeDoc, startingFiles } from "../server/documents/index.ts";
import type { Platform } from "../server/platform.ts";
import { TEMPLATES, templateById } from "../server/pages/index.ts";
import { publishTo, SiteError, type SiteOps, siteView, zonesOf } from "../server/sites/index.ts";
import { byLine } from "../shared/attribution.ts";

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
  /** Documents' sites on the person's Cloudflare account, where the server has them: for the domain tools. */
  readonly sites?: SiteOps;
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
  /** The domain tools (need ToolWho.sites): an agent is given them only where the server has sites. */
  readonly sites?: boolean;
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
    description: "Shares a document (only its owner may): gives someone the role of editor (may edit and rename it) or viewer (may only look), or takes theirs away with role \"none\". login \"*\" means anyone signed in who has the link. Answers who has access now.",
    parameters: Type.Object({
      document: DOCUMENT,
      login: Type.String({ description: "Whose role to set: a GitHub login, or \"*\" for anyone signed in who has the link" }),
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
      modified: iso(d.modified), ...(d.expires != null ? { expires: iso(d.expires) } : {}), ...(d.id == ctx.here ? { here: true } : {}),
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
    }),
    run: async (args, ctx) => {
      const { who } = ctx, platform = docsOf(ctx);
      if (who.test) throw new ToolError("You can't make documents on this server.", 403);
      const named = typeof args.template == "string" && args.template.trim() ? args.template.trim() : null;
      if (named && args.from) throw new ToolError("Give a template or a document to copy (from), not both.");
      const template = named && named != "landing" ? templateById(named) : undefined;
      if (named && named != "landing" && !template) throw new ToolError(`There's no template "${named}": ${TEMPLATES.map((t) => t.id).join(", ")}, or landing.`);
      const from = args.from ? (await findDocument(ctx, args.from, "open")).id : named == "landing" ? "landing" : null;
      const start = await startingFiles(platform, from, who, template);
      if (!start) throw new ToolError(from == "landing" ? "This server has no front page (landing document) to copy." : "There's nothing there you can copy.", 404);
      const title = typeof args.title == "string" ? args.title : undefined, slug = typeof args.slug == "string" ? args.slug : undefined;
      for (let tries = 0; tries < 5; tries++) {
        const doc = await makeDoc(platform, who.login.toLowerCase(), newDocId(), start.files, { index: start.index, title, slug });
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

  // ------------------------------------------------------------ a document at the person's own domain
  {
    name: "domain_status",
    sites: true,
    label: "Custom domain",
    activity: "checking the custom domain",
    description: "Whether a document is published at a domain of the person's own (served from their Cloudflare account), and how its deploys are going: its address, the version that's live, a deploy that's scheduled, running or failed (and why). Also whether the person has connected Cloudflare, and the domains (zones) their connection reaches, to choose a hostname from. Connecting is a consent in the person's own browser: when they aren't connected, a Connect Cloudflare button shows under this call in their panel (Cloudflare's consent, in a popup, on the page they're on). Tell them to click it. You can't consent for them, and there's no token to ask for.",
    parameters: Type.Object({ document: DOCUMENT }),
    run: async (args, ctx) => {
      const ops = sitesOf(ctx), doc = await findDocument(ctx, args.document, "open");
      const site = await ctx.dir.sites.get(doc.id);
      const connection = await ctx.dir.cloudflare.info(ctx.who.login);
      const zones = connection.connected ? await zonesOf(ctx.dir, ops, ctx.who.login) : null;
      return {
        document: described(doc, ctx), site: site ? { ...siteView(site), deploy: await ops.status(doc.id) } : null,
        cloudflare: connection.connected ? { connected: true, accounts: connection.accounts.map((a) => a.name), ...(zones && "zones" in zones ? { domains: zones.zones.map((z) => z.name) } : { error: zones?.error }) }
          : { connected: false, connect: "A Connect Cloudflare button shows under this call in the person's panel: they click it, and allow Erga on Cloudflare's page, in a popup.", ...(connection.error ? { error: connection.error } : {}) },
        // The button: the person's own consent, on the page they're on (server/sites/connect.ts).
        ...(connection.connected ? {} : { offer: { kind: "connect-cloudflare", label: connection.updated != null ? "Connect Cloudflare again" : "Connect Cloudflare", url: "/auth/cloudflare/start?popup=1" } }),
      };
    },
  },
  {
    name: "publish_to_domain",
    sites: true,
    label: "Publish to a domain",
    activity: "publishing to a domain",
    description: "Publishes a document at a hostname on one of the person's own domains (such as notes.example.com, or the domain itself), as Custom domain in the editor's settings does: Erga puts the document up as a Worker in their Cloudflare account, on that hostname, and puts each new version of it up after it. Needs their Cloudflare connection (domain_status says; they connect it themselves, in the browser). The first deploy runs at once; check domain_status for how it went.",
    parameters: Type.Object({ document: DOCUMENT, hostname: Type.String({ description: "The site's address, on one of their domains: notes.example.com" }) }),
    run: async (args, ctx) => {
      const ops = sitesOf(ctx), doc = await findDocument(ctx, args.document, "edit");
      try {
        const site = await publishTo(ctx.dir, ops, doc, ctx.who.login, String(args.hostname ?? ""), ctx.who.via);
        return { document: described(doc, ctx), site: siteView(site), deploy: await ops.deploy(doc.id, byLine(ctx.who.login, ctx.who.via)) };
      } catch (e) {
        if (e instanceof SiteError) throw new ToolError(e.message, e.status);
        throw e;
      }
    },
  },
  {
    name: "deploy_domain",
    sites: true,
    label: "Deploy to the domain",
    activity: "deploying to the domain",
    description: "Puts a document, as it is now, up at its domain again, now (Deploy now in the editor's settings), instead of waiting for its next version.",
    parameters: Type.Object({ document: DOCUMENT }),
    run: async (args, ctx) => {
      const ops = sitesOf(ctx), doc = await findDocument(ctx, args.document, "edit");
      if (!(await ctx.dir.sites.get(doc.id))) throw new ToolError("This document isn't published to a domain.", 409);
      return { document: described(doc, ctx), deploy: await ops.deploy(doc.id, byLine(ctx.who.login, ctx.who.via)) };
    },
  },
  {
    name: "remove_domain",
    sites: true,
    label: "Remove the domain",
    activity: "taking the site down",
    description: "Takes a document's site down (Remove under Custom domain): its custom domain and its Worker go from the Cloudflare account, and Erga stops publishing there. The document itself stays as it is.",
    parameters: Type.Object({ document: DOCUMENT }),
    run: async (args, ctx) => {
      const ops = sitesOf(ctx), doc = await findDocument(ctx, args.document, "edit");
      const site = await ctx.dir.sites.get(doc.id);
      if (!site) return { document: described(doc, ctx), site: null };
      const refused = await ops.remove(doc.id, site);
      await ctx.dir.sites.remove(doc.id);
      return { document: described(doc, ctx), removed: site.hostname, ...(refused ? { warning: `Cloudflare didn't take it down: ${refused} Delete the Worker ${site.script} in the Cloudflare dashboard.` } : {}) };
    },
  },
  {
    name: "disconnect_cloudflare",
    sites: true,
    label: "Disconnect Cloudflare",
    activity: "disconnecting Cloudflare",
    description: "Revokes Erga's access to the person's Cloudflare account and forgets it (Disconnect on /settings). Their sites stay up as they are, but stop following their documents until they connect again, which they do themselves, in the browser.",
    parameters: Type.Object({}),
    run: async (_args, ctx) => {
      const c = await ctx.dir.cloudflare.disconnect(ctx.who.login, sitesOf(ctx).oauth);
      return { connected: c.connected, sites: (await ctx.dir.sites.list(ctx.who.login)).map((s) => s.hostname) };
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
    description: "Admins only. How people sign in, as /admin/auth shows it: for this server and the other deploy target (production and staging), the GitHub OAuth app's client ID (public) and where it comes from (the deploy, or set on /admin/auth), whether its client secret is set (never the secret), the homepage and callback URLs the app must have, a live check with GitHub (working, misconfigured and why, not set up, unknown), values that wait for a test sign-in, and, where the app doesn't work, the steps to make one. An app's values are pasted only on /admin/auth, never in a conversation.",
    parameters: Type.Object({}),
    run: async (_args, ctx) => {
      const { here, other } = await authOf(ctx).status(ctx.who);
      return { thisServer: signInOf(here), otherServer: other ? signInOf(other) : null };
    },
  },
  {
    name: "clear_sign_in_app",
    label: "Clear sign-in values",
    activity: "clearing sign-in values",
    admin: true,
    description: "Admins only. Clears the GitHub app values set on /admin/auth, as Clear there does: sign-in goes back to the deploy's values. With what: \"pending\", it only discards new values that wait for a test sign-in (Discard), and sign-in keeps the values in use. server: \"here\" (this server, the default) or \"other\" (the other deploy target: production may change staging's, not the other way round). It refuses when the values set on the page work and the deploy's don't, since everyone would stop being able to sign in; force: true clears anyway, and only when the person says so after you told them that. Setting an app's values is done only on /admin/auth.",
    parameters: Type.Object({
      server: Type.Optional(Type.Union([Type.Literal("here"), Type.Literal("other")], { description: "here (default) or other" })),
      what: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("pending")], { description: "all (default): the values set on the page; pending: only those that wait for a test sign-in" })),
      force: Type.Optional(Type.Boolean({ description: "Clear even if sign-in would stop working: only when the person says so" })),
    }),
    run: async (args, ctx) => {
      const server = args.server == "other" ? "other" : "here";
      if (args.what == "pending") return { server, ...(await authOf(ctx).discard(ctx.who, server)) };
      return { server, ...(await authOf(ctx).clear(ctx.who, server, args.force === true)) };
    },
  },

  // ------------------------------------------------------------ the server's users (admins)
  {
    name: "list_users",
    label: "List the server's users",
    activity: "listing the users",
    admin: true,
    description: "Admins only. Everyone who may sign in to this server: login, name, role (user or admin), whether they were granted the deploy role (deploy), whether they may deploy (mayDeploy: an admin, or granted the deploy role; may use /deploy when deploy_page is admins), whether they're an admin by the deploy (bootstrap: can't be demoted or removed here), when they were added and by whom, and when they were last seen.",
    parameters: Type.Object({}),
    run: async (_args, { dir, who }) => (await dir.users.list(who)).map(userOf),
  },
  {
    name: "add_user",
    label: "Add a user",
    activity: "adding a user",
    admin: true,
    description: "Admins only. Lets someone sign in to this server, by GitHub login, as a user (the default) or an admin. Someone already there keeps their row; their role becomes the one given.",
    parameters: Type.Object({
      login: LOGIN,
      role: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("admin")], { description: "user (the default) or admin" })),
      name: Type.Optional(Type.String({ description: "What to call them until they sign in (else their login)" })),
    }),
    run: async (args, { dir, who }) => userOf(await dir.users.add(who, String(args.login ?? ""), {
      role: args.role == "admin" ? "admin" : "user", ...(typeof args.name == "string" ? { name: args.name } : {}),
    })),
  },
  {
    name: "set_user_role",
    label: "Change a user's role",
    activity: "changing a user's role",
    admin: true,
    description: "Admins only. Makes a user an admin, or just a user. An admin by the deploy (bootstrap) stays one.",
    parameters: Type.Object({ login: LOGIN, role: Type.Union([Type.Literal("user"), Type.Literal("admin")], { description: "user or admin" }) }),
    run: async (args, { dir, who }) => userOf(await dir.users.setRole(who, String(args.login ?? ""), args.role == "admin" ? "admin" : "user")),
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
    description: "Admins only. Stops someone signing in to this server: their sessions and tokens stop working within seconds; their documents stay. An admin by the deploy (bootstrap) can't be removed here.",
    parameters: Type.Object({ login: LOGIN }),
    run: async (args, { dir, who }) => {
      const login = String(args.login ?? "").trim().toLowerCase();
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
export async function agentToolsFor(ctx: ToolWho): Promise<AgentTool[]> {
  return (await toolsFor(ctx.dir, ctx.who)).filter((t) => (!t.docs || ctx.platform) && (!t.sites || ctx.sites)).map((t): AgentTool => ({
    name: t.name,
    label: t.label,
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

/** What the editor's agent is doing while one runs. */
export const SERVER_TOOL_ACTIVITY: Record<string, string> = Object.fromEntries(SERVER_TOOLS.map((t) => [t.name, t.activity]));

// ---------------------------------------------------------------- helpers

/**
 * The document an agent names (an address, a URL, an id, or one of the
 * person's slugs; nothing for the one it's in), if they may do `action` with it.
 */
/** The platform's sites, or a refusal the agent can pass on. */
function sitesOf(ctx: ToolWho): SiteOps {
  if (!ctx.sites) throw new ToolError("This server can't publish documents to a domain.", 501);
  if (ctx.who.test) throw new ToolError("Test people can't publish to a domain.", 403);
  return ctx.sites;
}

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
    login: p.login, role: p.role, ...(p.login == ANYONE ? { means: "anyone signed in who has the link" } : {}),
    granted: new Date(p.granted).toISOString(), ...(p.grantedBy ? { grantedBy: p.grantedBy } : {}), ...(p.grantedVia ? { grantedVia: p.grantedVia } : {}),
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
  return { key: e.key, description: e.description, value: e.value, default: e.default, source: e.source, locked, ...(locked ? { deployed: e.deployed, note: "Locked by the deploy (deploy/locked-settings.ts): it can't be changed here." } : {}), updated: iso(e.updated), updatedBy: e.updatedBy, ...(e.updatedVia ? { updatedVia: e.updatedVia } : {}) };
}

function userOf(u: User) {
  return { login: u.login, name: u.name, role: u.role, deploy: u.deploy, mayDeploy: u.mayDeploy, bootstrap: u.bootstrap, added: u.created ? iso(u.created) : null, addedBy: u.addedBy, ...(u.addedVia ? { addedVia: u.addedVia } : {}), lastSeen: iso(u.lastSeen) };
}

/** Sign-in's settings, where this agent has them. */
function authOf(ctx: ToolWho): AuthOps {
  if (!ctx.auth) throw new ToolError("This server's sign-in settings aren't reachable from here.", 404);
  return ctx.auth;
}

/** A server's sign-in, as an agent reads it: never a secret. */
function signInOf(s: AuthStatus | OtherStatus) {
  if ("error" in s) return { target: s.target, origin: s.origin, reachable: false, error: s.error };
  return {
    target: s.target, origin: s.origin, provider: s.provider, state: s.check.state, summary: s.check.summary, reasons: s.check.reasons,
    clientId: s.inUse.clientId, clientIdFrom: s.inUse.source == "page" ? "/admin/auth" : "the deploy", secretSet: s.inUse.secretSet,
    homepageUrl: s.homepageUrl, callbackUrl: s.callbackUrl, localDevelopment: s.dev || undefined,
    deploy: { clientId: s.deploy.clientId, secretSet: s.deploy.secretSet },
    setOnPage: s.page ? { clientId: s.page.clientId, updated: iso(s.page.updated), updatedBy: s.page.updatedBy, ...(s.page.updatedVia ? { updatedVia: s.page.updatedVia } : {}) } : null,
    waitingForTestSignIn: s.pending ? { clientId: s.pending.clientId, updated: iso(s.pending.updated), updatedBy: s.pending.updatedBy, check: s.pendingCheck?.summary, lastTest: s.pending.test ?? null } : null,
    takesValuesFrom: s.takesFrom, canKeepValues: s.canStore,
    setupSteps: s.setup,
  };
}
