// What a document needs of its agents, and what it gives them: the contract agents/document/session.ts
// (`documentAgents`) fulfils. The document's host (host.ts) starts each person's session through `DocumentAgents`,
// and passes in how the agents' tools reach the document (`SessionOptions`). Every agent's document tools run in that
// session for its person: their own agent's (agents/person/) and an outside agent's. The agents themselves, their
// models and their tools are in agents/: the document only holds this side of it.

import type { LogEvent, ViewRequest, ViewResult } from "../shared/agent-log.ts";
import type { LiveAnswer, LiveRequest } from "../shared/live-page.ts";

/** A render of one of the document's pages in the server's browser (view_page, eval_in_page: cloudflare/render.ts). */
export interface RenderJob {
  /** The page's file, and the text to render: the room's now, or a preview's. */
  path: string;
  html: string;
  /** The person whose agent asked (their id): the render reads the document as them. */
  by: string;
  /** The app's origin, where the document's pages origin and its token are made. */
  origin: string;
  req: ViewRequest;
}
import type { DocKind } from "./pages.ts";
import type { Sandbox } from "./page-api.ts";
import type { Room } from "./room.ts";
import type { RestoreResult, Version, VersionsState } from "./versions.ts";

/** What a tool returns: text, and for read on an image or view_page, a picture; for read on a PDF, the PDF (a range of its pages). */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "document"; data: string; mimeType: "application/pdf" };
/** A tool as an outside agent sees it: its arguments as JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

/** What the file tools reach beyond the shared text: every file's size, time and kind, a file's bytes, a PDF's text, and a write of bytes. */
export interface FilesAccess {
  /** Each file's size (bytes), time (ms, when known) and kind: text, or a file kept whole (a blob), with its type. */
  stats(): Promise<Map<string, { size: number | null; at: number | null; kind: "text" | "file"; type: string }>>;
  /** A PDF's text, page by page, extracted once and kept by the PDF's hash; null if it can't be had. */
  pdfText(path: string): Promise<string[] | null>;
  /** Writes a file's bytes as `by` (the agent's person, via it): text if it is text, else a file kept whole. Refused past the limits. */
  writeBytes(path: string, bytes: Uint8Array, by: string): Promise<{ kind: "text" | "file"; replaced: boolean }>;
}

/** The document's versions, as the agents' tools reach them. */
export interface VersionsAccess {
  state(opts: { before?: string | number | null; limit?: number }): Promise<VersionsState>;
  version(ref: string | number): Promise<(Version & { files: string[]; index: string }) | null>;
  /** Every file of a version (null if there's no such version). */
  files(ref: string | number): Promise<Map<string, Uint8Array> | null>;
  /** Every file as it is now, up to the keystroke. */
  current(): Promise<Map<string, Uint8Array>>;
}

/** What open_page did: the page it opened, and in how many of the person's tabs (none: nothing opened). */
export interface OpenResult {
  path: string;
  tabs: number;
  message: string;
}

/** A person's agent session in one document, as its host starts it. */
export interface SessionOptions {
  room: Room;
  /** The person this session works for. */
  owner: { id: string; name: string };
  docName: string;
  /** A document that's a single file opened from disk: its path (the agent can't make other files). */
  only?: string;
  /** A document (one page: no other page can be made) or a project (pages), now; a project if not given. */
  kind?: () => DocKind;
  /** Whether the owner may edit (an agent acts with its user's permissions). */
  canEdit: () => boolean;
  /** Renders the page in the server's browser (view_page, eval_in_page). */
  view: (req: ViewRequest) => Promise<ViewResult>;
  /** Asks the owner's open tabs about the live page (page_log, page_input, eval_in_page with live): the best answer. */
  live: (req: LiveRequest) => Promise<LiveAnswer>;
  readAsset: (path: string) => Promise<Uint8Array | null>;
  /** Switches the owner's open editor tabs to a page (open_page). */
  open?: (path: string) => Promise<OpenResult>;
  /** An agent's run of calls ended: the document cuts a version, and answers the version it's at then (diff_versions' "last_turn"). */
  turnEnded?: () => Promise<string | null> | void;
  /** The document's versions; without it those tools are left out. */
  versions?: VersionsAccess;
  /** Every file's size, time and kind, PDFs' text, and writes of bytes (host.ts); without it the file tools see text and names only. */
  files?: FilesAccess;
}

export interface AgentSession {
  /** Takes back the agent's most recent change (one tool call), if any. */
  undo(): boolean;
  /** Puts back the change Undo took back last, if any. A new change by the agent clears what is left to redo. */
  redo(): boolean;
  /** How many of its changes Undo can take back (count), and how many Redo can put back. */
  undoable(): { count: number; redo: number };
  /** The person's agent's turn is done: it's no longer working here, and the document cuts a version of its edits. */
  done(): void;
  /** Its events for the person's tabs: Undo's and Redo's counts as they change. */
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /** The tools, as the person may use them. */
  tools(): ToolSpec[];
  /**
   * Runs one tool for the person's agent: the session's replica of the doc, attribution, presence and undo history.
   * Throws with a message the caller can act on (unknown tool, bad arguments, the tool's own error). `via`: how the
   * person acts through a shared agent (shared/attribution.ts: "a shared agent (label)"); its edits are theirs, via it.
   */
  runTool(name: string, args: unknown, via?: string): Promise<ToolContent[]>;
  /** Leaves the room and stops its timers (the document closed: it starts again the next time it's needed). */
  close(): void;
}

/** A document's agents: what the server around it gives it (DocumentDeps.agents). */
export interface DocumentAgents {
  /** A person's session. */
  start(opts: SessionOptions): Promise<AgentSession>;
  /** The tools that change the document: someone who may only view it has none of them. */
  changes: ReadonlySet<string>;
  /** The key the versions' descriptions are written with ("" for none: a plain description). */
  descriptionKey(): Promise<string>;
  /** Runs a page's own API (page-api.ts), for the agents' call_edit. (The page's own controls run it in the page.) */
  sandbox: Sandbox;
}
