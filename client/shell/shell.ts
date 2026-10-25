// The page editor's shell, as its parts share it (client/main.ts makes it and mounts each part on it): who this tab
// is, the document and the page it edits, the page editor, and each part's own calls. A part reads what another
// part keeps through here at the moment it needs it, so the parts can mount in any order the page allows.

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkAuthor } from "../editor";
import type { RemotePage } from "../remote";
import type { Collab } from "../collab";
import type { Author } from "../../document/content";
import type { DocInfo, DocName } from "../../document/api";
import type { Settings } from "../settings";
import type { Naming } from "./naming";
import type { Room } from "./room";
import type { People } from "./people";
import type { Chrome } from "./chrome";
import type { Sharing } from "./sharing";
import type { Toast } from "./toast";
import type { StyleBar } from "./style-bar";
import type { Views } from "./views";
import type { PageRequests } from "./page-requests";
import type { Agent } from "./agent";
import type { Pause } from "./pause";

export const $ = (id: string) => document.getElementById(id)!;

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** This browser's storage, which may refuse (private mode): a read gives null, a write false. */
export const store = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
};

/**
 * The page this runs in is the document's page, viewing or editing: the editor runs either way once loaded, its
 * controls shown only while editing (main.ts, setEditing).
 */
export const editing = () => document.body.classList.contains("erga-editing");

/** The page itself, or the file's source (its HTML). */
export type Mode = "text" | "html";

export interface Shell {
  collab: Collab;
  /** Who this tab is, as the host attributes edits and the agent. */
  me: Author;
  self: MarkAuthor;
  /** The query that says who this tab is in local development (?user=Ada), or "". */
  as: string;
  /** The host's endpoints, as this person. */
  api: (path: string) => string;
  frame: HTMLIFrameElement;
  docId: string;
  /** `agent`: whether the agent pane is open while editing. It starts open, and stays as the user last left it. */
  settings: { track: boolean; agent: boolean };
  saveSettings: () => void;

  info: DocInfo;
  /** A document (one page) or a project (pages), as the host last said. */
  docKind: "document" | "project";
  docName: DocName | null;
  /** Which of the document's pages this tab edits. */
  pagePath: string;
  page: RemotePage;
  mode: Mode;
  sourceView: EditorView | null;
  /** The source view's code, once loaded. */
  source: typeof import("../source-view") | null;
  /** The document's settings, once the gear has loaded them (Chrome.loadSettings). */
  docSettings: Settings | null;

  addressOf: (path: string | null) => string;
  goTo: (url: string, replace?: boolean) => void;
  openPage: (path: string) => void;
  swapPage: (path: string, push?: boolean) => boolean;
  currentState: () => EditorState;

  naming: Naming;
  room: Room;
  people: People;
  chrome: Chrome;
  sharing: Sharing;
  toast: Toast;
  fmt: StyleBar;
  views: Views;
  requests: PageRequests;
  agent: Agent;
  pause: Pause;
}
