// The admin's agent, on every admin page: an agent panel like the editor's
// (the same transcript, shared/agent-log.ts, and the same panel,
// client/agent/agent-chat.ts, run by client/admin/admin-agent.ts), on the
// loop both agents share (agents/run.ts). Its tools: every operation of
// agents/tools.ts, with admin power: the settings on /admin, their change log, the API keys
// (read, clear), sign-in (read, clear: /admin/auth), the users, Erga's own source, the
// Ops page's (staging and main, production's deploy, GitHub, the deploys and their
// logs), the homepage's deploy, and the admin's own agent tokens. Its prompt:
// agents/admin/prompt.ts. One session per admin (agents/admin/sessions.ts),
// in the AdminAgent Durable Object, so it keeps working when the tab closes.
//
// The rule: the agent can do everything its admin can do on /admin (and the
// Ops page and /settings), so the admin can ask for anything there in
// words. agents/actions.ts lists each action with its tool, and
// tests/agent-actions.test.ts fails when one has none. The one exception is
// a secret: an API key or a new token is pasted or made only on the page,
// never in a conversation; the agent can clear or revoke them.
//
// Every tool acts as the admin themselves (their login), so the change log
// (/admin/changes) and a deploy's trigger name the admin, as if they clicked.
// They prompted it; the agent is how. Logs and the repository are written by
// others and can carry instructions, so every call checks that the person is
// still an admin (`guard`), and the system prompt says to treat that text as
// data and to act only on what the admin asks in the conversation.
//
// An outside agent (Claude Code on a laptop) gets the same powers over HTTP
// with an admin token (server/identity/tokens.ts; Share with agent on the admin pages makes
// one that ends within 12 hours), and reads agents/guides.ts `adminGuide` first.

import type { AgentConfig, ModelChoice } from "../models";
import type { Attachment } from "../../shared/attach";
import type { Log, LogEvent } from "../../shared/agent-log";
import type { ChatMessage, ChatStore, StoredChat } from "../checkpoint";
import { startLoop, type AgentTool } from "../run";
import { systemPrompt } from "./prompt";
import { type Access, ACCESS_LABEL, ROLE_LABEL, type UserRole } from "../../server/directory/index.ts";

export interface AdminAgent {
  readonly model: string | null;
  readonly modelChoice: ModelChoice | null;
  setModel(choice: ModelChoice): boolean;
  /** The settings now (a key an admin stored, replaced or cleared since it started): the next model call uses them. */
  configure(cfg: AgentConfig): void;
  log(): Log;
  /** The model's messages so far. */
  messages(): readonly ChatMessage[];
  /** A message, with any files attached. */
  prompt(text: string, context: string | null, files?: Attachment[]): void;
  abort(): void;
  reset(): Promise<void>;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /** Goes on with a run that a restart cut off, from its last checkpoint (the first call only). Answers whether a run goes on. */
  resume(): Promise<boolean>;
}

/** What a tool call is about, for the panel: a setting's key, a login, a path. */
function about(name: string, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (["list_source", "read_source", "search_source", "source_log"].includes(name)) {
    const at = typeof a.ref == "string" && a.ref && a.ref != "staging" ? ` (${a.ref})` : "";
    if (name == "search_source") return `${JSON.stringify(String(a.query ?? "")).slice(0, 80)}${at}`;
    if (name == "source_log") return typeof a.ref == "string" && a.ref ? a.ref : "staging";
    return `${typeof a.path == "string" && a.path ? a.path : "the root"}${at}`;
  }
  if (typeof a.key == "string") return a.key;
  if (typeof a.target == "string") return a.target;
  if (name == "clear_api_key" && typeof a.name == "string") return a.name;
  if (name == "clear_sign_in_app") return `${a.provider == "google" ? "Google" : "GitHub"}${a.what == "pending" ? " (pending)" : ""}`;
  if (name == "add_user") return `${a.handle} (${ROLE_LABEL[a.role as UserRole] ?? a.role})`;
  if (name == "set_user_role") return `${a.login ?? `person ${a.person}`} (${ROLE_LABEL[a.role as UserRole | "none"] ?? a.role})`;
  if (name == "add_access_rule") return `${a.kind} ${a.value} (${ACCESS_LABEL[a.access as Access] ?? a.access})`;
  if (name == "change_access_rule") return `${a.id} (${ACCESS_LABEL[a.access as Access] ?? a.access})`;
  if (name == "remove_access_rule") return String(a.id ?? "");
  if (name == "set_public_sharing") return a.on ? "on" : "off";
  if (name == "switch_sign_in_provider") return `${a.provider == "google" ? "Google" : "GitHub"} (${a.on ? "on" : "off"})`;
  if (name == "deploy_production") return typeof a.commit == "string" && a.commit ? `main to ${a.commit.slice(0, 10)}` : "main to staging";
  if (name == "resolve_conflict_file" && typeof a.path == "string") return a.path;
  if ((name == "add_domain" || name == "remove_domain") && typeof a.hostname == "string") return `${a.hostname} (${a.target})`;
  if (/^revoke_/.test(name) && typeof a.id == "string") return a.id;
  if (typeof a.login == "string") return a.login;
  return null;
}

/**
 * One admin's agent session. `store`: where it keeps its conversation, step
 * by step (agents/checkpoint.ts); `stored`: the conversation as the store
 * had it, to go on with.
 */
export function startAdminAgent(opts: { cfg: AgentConfig; owner: string; tools: AgentTool[]; store?: ChatStore; stored?: StoredChat | null; meta?: Record<string, string> }): AdminAgent {
  const { owner } = opts;
  const loop = startLoop({
    cfg: opts.cfg,
    stored: opts.stored ?? null,
    store: opts.store ?? null,
    meta: { login: owner, ...opts.meta },
    tag: "page",
    hooks: { about },
  });
  loop.start(opts.cfg, systemPrompt(owner), opts.tools);
  return {
    get model() {
      return loop.model;
    },
    get modelChoice() {
      return loop.modelChoice;
    },
    setModel: loop.setModel,
    configure: loop.configure,
    log: () => loop.log,
    messages: () => loop.messages,
    prompt: (text, context, files = []) => loop.prompt(text, context, files),
    abort: loop.abort,
    reset: () => loop.reset(),
    subscribe: loop.subscribe,
    resume: loop.resume,
  };
}
