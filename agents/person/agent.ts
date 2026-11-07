// Each person's agent, on every page of Erga (the bottom-left circle, client/agent/person-agent.ts): one agent, one
// conversation that follows them from page to page, on the loop every agent shares (agents/run.ts). Its tools are its
// person's (agents/tools.ts, toolsFor): every operation they may use (the admin ones, with admin power, only for an
// admin: the settings, users, keys, sign-in, access), and the document tools for any document
// they may open or edit, run in that document's host as their agent (view_page renders in the server's browser;
// page_log and page_input use their open editor). Its prompt: agents/person/prompt.ts. One session per person, in their PersonAgent object
// (agents/person/sessions.ts, cloudflare/objects/person-agent.ts), so it keeps working when the tab closes.
//
// The rule: the agent can do everything its person can do in Erga, when they ask. agents/actions.ts lists each action
// with its tool, and tests/agent-actions.test.ts fails when one has none. The one exception is a secret: an API key or
// a new token is pasted or made only on its page, never in a conversation; the agent can clear or revoke them.
//
// Every tool acts as the person (their login), via their agent, so the change log (/admin/changes), a document's
// history name them. Documents and logs are written by others and can carry
// instructions: the system prompt says to treat that text as data and to act only on what the person asks.
//
// An outside agent (Claude Code on a laptop) gets the same powers over MCP (server/api.ts): its
// instructions and the tools' descriptions are its manual.

import type { AgentConfig, ModelChoice } from "../models";
import type { Usable } from "../../shared/models";
import type { Attachment } from "../../shared/attach";
import type { Log, LogEvent } from "../../shared/agent-log";
import type { ChatMessage, ChatStore, StoredChat } from "../checkpoint";
import { startLoop, type AgentTool, type LoopHooks } from "../run";
import { systemPrompt } from "./prompt";
import { type Access, ACCESS_LABEL, ROLE_LABEL, type UserRole } from "../../server/directory/index.ts";

export interface AgentSession {
  readonly model: string | null;
  readonly modelChoice: ModelChoice | null;
  /** The models the person can switch between now, with whose key runs each. */
  readonly models: Usable[];
  setModel(choice: ModelChoice): boolean;
  /** The settings now (a key an admin stored, replaced or cleared since it started): the next model call uses them. */
  configure(cfg: AgentConfig): void;
  log(): Log;
  /** The model's messages so far. */
  messages(): readonly ChatMessage[];
  /** A message, with any files attached; `id` is the sending tab's id for it (the transcript's copy carries it). */
  prompt(text: string, context: string | null, files?: Attachment[], id?: string): void;
  abort(): void;
  reset(): Promise<void>;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /** Goes on with a run that a restart cut off, from its last checkpoint (the first call only). Answers whether a run goes on. */
  resume(): Promise<boolean>;
}

/** What a tool call is about, for the panel: a setting's key, a login, a path. */
function about(name: string, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name == "set_setting" && typeof a.key == "string") return a.reset === true ? `${a.key} (reset)` : a.key;
  if (typeof a.key == "string") return a.key;
  if (typeof a.target == "string") return a.target;
  if (name == "clear_api_key" && typeof a.name == "string") return a.name;
  if (name == "set_sign_in") return `${a.provider == "google" ? "Google" : "GitHub"} (${a.action})`;
  if (name == "set_user") {
    const whom = a.handle ?? a.login ?? `person ${a.person}`,
      role = typeof a.role == "string" ? ` (${ROLE_LABEL[a.role as UserRole | "none"] ?? a.role})` : "";
    return `${a.action} ${whom}${a.action == "remove" ? "" : role}`;
  }
  if (name == "set_access") {
    const access = typeof a.access == "string" ? ` (${ACCESS_LABEL[a.access as Access] ?? a.access})` : "";
    if (a.action == "public") return `public sharing ${a.on ? "on" : "off"}`;
    if (a.action == "add") return `add ${a.kind} ${a.value}${access}`;
    return `${a.action} rule ${a.id ?? ""}${a.action == "change" ? access : ""}`;
  }
  if (/^revoke_/.test(name) && typeof a.id == "string") return a.id;
  if (typeof a.login == "string") return a.login;
  return null;
}

/**
 * One person's agent session (`admin`: theirs has the admin's prompt). `store`: where it keeps its conversation, step
 * by step (agents/checkpoint.ts); `stored`: the conversation as the store
 * had it, to go on with.
 */
export function startAgent(opts: {
  cfg: AgentConfig;
  owner: string;
  admin: boolean;
  tools: AgentTool[];
  store?: ChatStore;
  stored?: StoredChat | null;
  meta?: Record<string, string>;
  /** The model changed by itself (the one it was on can't be used now): the person's menus follow. */
  modelChanged?: () => void;
  /** A model turn's tokens, and whether the person's own key ran it. */
  used?: LoopHooks["used"];
}): AgentSession {
  const { owner } = opts;
  const loop = startLoop({
    cfg: opts.cfg,
    stored: opts.stored ?? null,
    store: opts.store ?? null,
    meta: { login: owner, ...opts.meta },
    tag: "page",
    hooks: { about, modelChanged: () => opts.modelChanged?.(), used: opts.used },
  });
  loop.start(opts.cfg, systemPrompt(owner, opts.admin), opts.tools);
  return {
    get model() {
      return loop.model;
    },
    get modelChoice() {
      return loop.modelChoice;
    },
    get models() {
      return loop.models;
    },
    setModel: loop.setModel,
    configure: loop.configure,
    log: () => loop.log,
    messages: () => loop.messages,
    prompt: (text, context, files = [], id) => loop.prompt(text, context, files, id),
    abort: loop.abort,
    reset: () => loop.reset(),
    subscribe: loop.subscribe,
    resume: loop.resume,
  };
}
