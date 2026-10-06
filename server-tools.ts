// Tools both kinds of agent have, defined once: the editor's own agent
// (agent.ts, given them by its document's host, worker/doc-host.ts) and an
// external agent holding one of the person's agent tokens (server-api.ts,
// over HTTP, /mcp and the guide). They need only the directory (directory.ts:
// documents' permissions, the server's users and settings) and who's asking,
// so they run the same in a document's host and in the Worker.
//
//   document_access, share_document     who a document is shared with, and sharing it (its owner)
//   list_settings, set_setting,         the server's settings (config.ts), admins only;
//   reset_setting                       a setting the deploy locks can be seen, not changed
//   list_users, add_user,               who may sign in, and who's an admin (users.ts),
//   set_user_role, set_user_deploy,     admins only
//   remove_user
//
// An admin tool is offered only to an admin who has unlocked admin access
// with their SSH key (`toolsFor`; admin-keys.ts): an external agent with an
// admin token. The editor's agent never has them (a document's host never
// carries an unlock, and a document's text could steer its agent). The
// directory checks again on every call (Users.mustAdmin), so a tool list
// that's gone stale (an unlock ended, someone stopped being an admin) still
// can't do anything.
//
// Adding one: an entry in SERVER_TOOLS. Both agents get it.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type TObject } from "typebox";
import { ConfigError, type ConfigEntry } from "./config.ts";
import { type Action, type Directory, type DocRow, type Grant, type Route, type Who, ANYONE, NotAllowed, nameOf } from "./directory.ts";
import { ID, OWNER } from "./front.ts";
import { LOCKED, type User } from "./users.ts";

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

  // ------------------------------------------------------------ the server's users (admins)
  {
    name: "list_users",
    label: "List the server's users",
    activity: "listing the users",
    admin: true,
    description: "Admins only. Everyone who may sign in to this server: login, name, role (user or admin), whether they have the deploy role (may use /deploy when deploy_page is admins), whether they're an admin by the deploy (bootstrap: can't be demoted or removed here), when they were added and by whom, and when they were last seen.",
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

/** The tools someone may use: the admin ones only for an admin who has unlocked admin access (admin-keys.ts). */
export async function toolsFor(dir: Directory, who: Who): Promise<ServerToolDef[]> {
  const admin = await dir.users.isUnlocked(who);
  return SERVER_TOOLS.filter((t) => admin || !t.admin);
}

/**
 * Runs one, with what the directory throws turned into ToolErrors (not
 * allowed: 403; a bad value: 400).
 */
export async function runServerTool(tool: ServerToolDef, args: Record<string, unknown>, ctx: ToolWho): Promise<string | object> {
  if (tool.admin && !(await ctx.dir.users.isUnlocked(ctx.who))) throw new ToolError((await ctx.dir.users.isAdmin(ctx.who)) ? LOCKED : "Only an admin can do that.", 403);
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e instanceof NotAllowed) throw new ToolError(e.message, /no such|isn't a user/i.test(e.message) ? 404 : 403);
    if (e instanceof ConfigError) throw new ToolError(e.message, 400);
    throw e;
  }
}

/** The tools as the editor's agent takes them (pi's AgentTool), for someone in a document. */
export async function agentToolsFor(ctx: ToolWho): Promise<AgentTool[]> {
  return (await toolsFor(ctx.dir, ctx.who)).map((t): AgentTool => ({
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    execute: async (_id, params) => {
      const out = await runServerTool(t, params as Record<string, unknown>, ctx).catch((e: unknown) => { throw new Error(e instanceof Error ? e.message : String(e)); });
      return { content: [{ type: "text" as const, text: typeof out == "string" ? out : JSON.stringify(out, null, 2) }], details: {} };
    },
  }));
}

/** What the editor's agent is doing while one runs. */
export const SERVER_TOOL_ACTIVITY: Record<string, string> = Object.fromEntries(SERVER_TOOLS.map((t) => [t.name, t.activity]));

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
    login: p.login, role: p.role, ...(p.login == ANYONE ? { means: "anyone signed in who has the link" } : {}),
    granted: new Date(p.granted).toISOString(), ...(p.grantedBy ? { grantedBy: p.grantedBy } : {}),
  }));
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

function entryOf(e: ConfigEntry) {
  const locked = e.locked;
  return { key: e.key, description: e.description, value: e.value, default: e.default, source: e.source, locked, ...(locked ? { deployed: e.deployed, note: "Locked by the deploy (server.config.ts): it can't be changed here." } : {}), updated: iso(e.updated), updatedBy: e.updatedBy };
}

function userOf(u: User) {
  return { login: u.login, name: u.name, role: u.role, deploy: u.deploy, bootstrap: u.bootstrap, added: u.created ? iso(u.created) : null, addedBy: u.addedBy, lastSeen: iso(u.lastSeen) };
}
