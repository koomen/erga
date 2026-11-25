// The page editor's shell, as its parts share it (client/shell/main.ts makes it and mounts each part on it): who this tab
// is, the document and the page it edits, the page editor, and each part's own calls. A part reads what another
// part keeps through here at the moment it needs it, so the parts can mount in any order the page allows.

import type { PageContext, PageFrame } from "./page-frame";
import type { Editor } from "./editor";
import type { ShellRoom } from "./shell-room";
import type { Author } from "../../shared/author";
import type { DocInfo, Hello } from "../../document/api/api";
import type { DocName } from "../../document/model/names";
import type { Settings } from "../pages/settings";
import type { Naming } from "./naming";
import type { Room } from "./room";
import type { People } from "./people";
import type { Chrome } from "./chrome";
import type { Sharing } from "./sharing";
import type { Toast } from "./toast";
import type { Alerts } from "./alerts";
import type { SaveMark } from "../common/save-mark";
import type { Uploads } from "./uploads";
import type { PageRequests } from "./page-requests";

/**
 * Where this document's host answers: "/d/<id>", which the app puts
 * in the editor's page (erga-base) and a rename never changes, on a deployed
 * instance and locally alike. Every request the editor makes, the WebSockets
 * included, goes under it. (Without it, the page's own address.)
 */
export const BASE = (document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')?.content || location.pathname).replace(/\/+$/, "");

export const $ = (id: string) => document.getElementById(id)!;

/** This browser's storage, which may refuse (private mode): a read gives null, a write false. */
export const store = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  json(key: string) { try { return JSON.parse(store.get(key) || "null"); } catch { return null; } },
};

export interface Shell {
  /** The shell's lightweight JSON-only room socket (hello, events, presence — no Yjs replica). */
  socket: ShellRoom;
  /** Who this tab is, as the host attributes edits and the agent. */
  me: Author;
  /** The query that says who this tab is in local development (?user=Ada), or "". */
  as: string;
  /** The host's endpoints, as this person. */
  api: (path: string) => string;
  readonly frame: HTMLIFrameElement;
  docId: string;

  info: DocInfo;
  /** How many pages the document has, as the host last said (more than one: the title opens them). */
  pages: number;
  /** Whether you may make pages here (the hello's tree: an editor's, and not a single file opened from disk). */
  canMakePages: boolean;
  /** The document's file tree entries, from hello and kept up to date by tree events and pages-tree refreshes. */
  treeEntries: Hello["tree"]["entries"];
  /** The page editor's last reported caret/selection context, for the agent and feedback (erga-context). */
  latestContext: { path: string; context: PageContext } | null;
  docName: DocName | null;
  /** Which of the document's pages this tab edits. */
  readonly pagePath: string;
  page: PageFrame;
  /**
   * Editing or viewing, full screen, the edit key: what the page's editor does (editor-state.ts).
   * The page this runs in is the document's page, viewing or editing: the shell runs either way once loaded, its
   * controls shown only while editing (main.ts, setEditing).
   */
  editor: Editor;
  /** The document's settings, once the gear has loaded them (Chrome.loadSettings). */
  docSettings: Settings | null;

  addressOf: (path: string | null) => string;
  goTo: (url: string, replace?: boolean) => void;
  openPage: (path: string) => void;
  swapPage: (path: string, push?: boolean) => boolean;

  naming: Naming;
  room: Room;
  people: People;
  chrome: Chrome;
  sharing: Sharing;
  toast: Toast;
  alerts: Alerts;
  /** Pending title renames made here, watched until the server has them (libs/text/ui/unsaved.ts). */
  unsaved: { edit(): void };
  /** The save mark, left of the buttons' bar: each copy of the room tells it how far its edits are (client/common/save-mark.ts). */
  save: SaveMark;
  uploads: Uploads;
  requests: PageRequests;
}
