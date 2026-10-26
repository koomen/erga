// What a document needs of its agents, and what it gives them: the contract
// the document agent (agents/document/session.ts, `documentAgents`) fulfils.
// The document's host (host.ts) starts each person's session through
// `DocumentAgents`, and passes in how the agent's tools reach the document
// (`SessionOptions`). The agent itself, its model and its tools are in
// agents/: the document only holds this side of it.

import type { Attachment } from "../shared/attach.ts";
import type { Log, LogEvent, ViewRequest, ViewResult } from "../shared/agent-log.ts";
import type { BlobStore } from "./blobs.ts";
import type { Naming } from "./names.ts";
import type { DocKind, TreeEntry, TreeOp } from "./pages.ts";
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
  file(ref: string | number, path: string): Promise<Uint8Array | null>;
  /** Every file of a version (null if there's no such version). */
  files(ref: string | number): Promise<Map<string, Uint8Array> | null>;
  /** Every file as it is now, up to the keystroke. */
  current(): Promise<Map<string, Uint8Array>>;
  /** Brings a version back (or, with `path`, one file of it) as a new current version, by `by` (a login). */
  restore(ref: string | number, by: string, path?: string | null): Promise<RestoreResult>;
}

/** The document's pages as list_pages answers them: every entry (titles on pages), and the document's address. */
export interface PageTree {
  address: string;
  entries: TreeEntry[];
}
/** What open_page did: the page it opened, and in how many of the person's tabs (none: nothing opened). */
export interface OpenResult {
  path: string;
  tabs: number;
  message: string;
}

/** A person's agent session in one document, as its host starts it. */
export interface SessionOptions {
  /** The document's id: where the person's conversation here is kept, and the document the agent's server tools are in. */
  docId: string;
  room: Room;
  /** The person this session works for. */
  owner: { id: string; name: string };
  docName: string;
  /** A test document: its agent is the scripted model, free and the same every run. */
  scripted?: boolean;
  /** A document that's a single file opened from disk: its path (the agent can't make other files). */
  only?: string;
  /** A document (one page: no other page can be made) or a project (pages), now; a project if not given. */
  kind?: () => DocKind;
  /** Whether the owner may edit (an agent acts with its user's permissions). */
  canEdit: () => boolean;
  /** Asks one of the owner's open tabs to render and capture the page. */
  view: (req: ViewRequest) => Promise<ViewResult>;
  readAsset: (path: string) => Promise<Uint8Array | null>;
  /** The document's title and address, as the owner (get_title, set_title); without it those tools are left out. */
  naming?: Naming;
  /** Does a tree operation in the room: new_page, mkdir, mv and rm; without it those tools are left out. */
  tree?: (op: TreeOp) => Promise<void>;
  /** The document's pages with titles, and its address (list_pages); without it list_pages and open_page are left out. */
  pages?: () => Promise<PageTree>;
  /** Switches the owner's open editor tabs to a page (open_page, new_page's open). */
  open?: (path: string) => Promise<OpenResult>;
  /** The agent's turn ended (or an external agent's run of calls did): the document cuts a version, and answers the version it's at then (diff_versions' "last_turn"). */
  turnEnded?: () => Promise<string | null> | void;
  /** The document's versions; without it those tools are left out. */
  versions?: VersionsAccess;
  /** Every file's size, time and kind, PDFs' text, and writes of bytes (host.ts); without it the file tools see text and names only. */
  files?: FilesAccess;
  /** Where the document's files kept whole are: the conversation keeps its big pictures and PDFs there too, by hash. */
  blobs?: BlobStore;
}

export interface AgentSession {
  /** The model's name, or null when the embedded agent is off (its tools still work). */
  readonly model: string | null;
  /** The model it's on (DocumentAgents.models); null when off or scripted (nothing to switch). */
  readonly modelChoice: string | null;
  /** Switches model from the next turn on (a running turn finishes on the old one). */
  setModel(choice: string): boolean;
  /**
   * Gives the session the agent's settings as they are now (a key an admin
   * stored, replaced or cleared since it started): the next model call uses
   * them. Answers why the embedded agent is off ("" if it's on).
   */
  refresh(): Promise<string>;
  /** The transcript so far (for a tab that just loaded). */
  log(): Log;
  /** Sends a message, with any files attached; while a turn is running it steers the current one. */
  prompt(text: string, context: string | null, files?: Attachment[]): void;
  abort(): void;
  reset(): Promise<void>;
  /** Takes back the agent's most recent change (one tool call), if any. */
  undo(): boolean;
  subscribe(listener: (ev: LogEvent) => void): () => void;
  /**
   * Goes on with a run that a restart cut off, from its last checkpoint (the
   * first call only; call it once the session's events reach its tabs).
   * Answers whether a run goes on.
   */
  resume(): Promise<boolean>;
  /** The tools, for an external agent. */
  tools(): ToolSpec[];
  /**
   * Runs one tool for an external agent, exactly as the embedded agent would:
   * same replica of the doc, same attribution, presence and undo history. The
   * call shows in the transcript, marked as external. Throws with a message
   * the caller can act on (unknown tool, bad arguments, the tool's own error).
   * `via`: how the person acts through the outside agent (shared/attribution.ts:
   * "a shared agent (label)"); its edits are theirs, via it.
   */
  runTool(name: string, args: unknown, via?: string): Promise<ToolContent[]>;
  /** Leaves the room and stops its timers (the document closed: it starts again the next time it's needed). */
  close(): void;
}

/** A document's agents: what the server around it gives it (DocumentDeps.agents). */
export interface DocumentAgents {
  /** A person's session, with the agent's settings as they are now (off, with no key: its tools still work for an outside agent). */
  start(opts: SessionOptions): Promise<AgentSession>;
  /** The guide an outside agent reads first (GET /api/ext): the document's tools, and how to call them. */
  guide(o: { docName: string; owner: string; base: string; tools: ToolSpec[] }): string;
  /** The models a person may switch between. */
  models: readonly { id: string; label: string }[];
  /** The tools that change the document: someone who may only view it has none of them. */
  changes: ReadonlySet<string>;
  /** The key the versions' descriptions are written with ("" for none: a plain description). */
  descriptionKey(): Promise<string>;
}
