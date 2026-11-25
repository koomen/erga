// The document's page, in the viewer's one frame on its own origin: the viewer's one word to the editor in it (edit or
// standby, with the edit key, or view: libs/text/ui/mode.ts), and what the page's first script (client/inline/reader.ts, Erga's)
// tells the viewer while editing: the viewer's shortcuts pressed in the page, a press on it, a link to another of the document's pages, the page's
// problems. The editor itself asks for one thing: the page loaded again (erga-reload), which the viewer does with the
// page's view kept (viewer-frames.ts). It says how far its edits are saved (erga-save: client/common/save-mark.ts). And it
// raises its alerts (client/common/alerts.ts), and hears their buttons; it
// hands over the files a person dropped on the page (erga-upload), and hears each one's state (erga-uploads).
// Everything that comes from the page is checked: the page itself could have sent it.

import type { EditMode } from "../../libs/text/ui/mode";
import type { Word } from "./editor-state";
import type { Keys } from "../common/app-keys";
import type { Pressed } from "../../shared/feedback-context";
import type { RawProblem } from "./problems";
import { readMessage, type AlertAct, type Event as AlertEvent } from "../common/alerts";
import type { At } from "../common/save-mark";
import type { PageFile } from "../common/uploads";
import type { Pending } from "../../shared/room-socket";
import type { NewFile } from "./uploads";

/** What the keys of the page's alerts start with here: the page can't name one of the viewer's own. */
const PAGE_KEY = "page/";

/** What "edit" says, but the notes and the tests' settings, which this adds. */
export type EditWord = Omit<Exclude<EditMode, { mode: "view" }>, "type" | "mode" | "notes" | "timescale" | "check">;

/** Caret and selection context reported by the page editor for agent prompts and feedback. */
export interface PageContext {
  line: number;
  endLine: number;
  selected?: string;
  lineText: string;
  near: { html: string; htmlFrom: number; line: number; column: number };
}

export interface PageFrameConfig {
  /** The frame now: a load of the page again puts a new one in its place (client/inline/viewer-frames.ts). */
  frame: () => HTMLIFrameElement;
  /** The frame's origin: messages from anywhere else are ignored. */
  origin: string;
  /** The address of the document's files there (with the token that opens them): another of its pages is at its path under it. */
  files: string;
  /** What the page was told last (editor-state.ts decides it): it's told again when it loads again. */
  told: () => Word;
  /** What "edit" says now, with `key`: where the document is, who this tab is, the page and this tab's mark. */
  edit: (key: string) => EditWord;
  /** The viewer shows the page that the editor is on (viewing, a link goes to another: client/viewer/nav.ts). */
  here: () => boolean;
  onKey: (keys: Keys) => void;
  /** A press on the page. */
  onPress: () => void;
  /** The pointer moved over the page, in the viewer's coordinates. */
  onPointer: (x: number, y: number) => void;
  onActivity: (kind: "focus" | "key" | "edit") => void;
  /** The page editor's latest caret/selection context, for the agent and feedback. */
  onContext: (path: string, context: PageContext) => void;
  /** A key pressed in the page, or text typed there with no key (not in a field of the page's own): for a feedback's context. */
  onPressed: (key: Pressed) => void;
  /** A link on the page to another of the document's pages was followed (its path in the document). */
  onOpen: (path: string) => void;
  /** A problem the page reported (`base`: the page's folder on its origin, for the names of its files). */
  onProblem: (problem: RawProblem, base: string) => void;
  /** The editor in the page says how far its edits are: on the server, on their way, or not saved (libs/text/ui/unsaved.ts). */
  onSave: (at: At) => void;
  /** The editor in the page raised an alert, changed it or ended it. */
  onAlert: (event: Extract<AlertEvent, { t: "raise" | "row" | "end" }>) => void;
  /** The editor in the page has files for the document, each at a path it chose; `point`: where in the page's window they were dropped. */
  onUpload: (files: NewFile[], point?: { x: number; y: number }) => void;
  /** A button on a file in the page (cancel, remove, retry, raise). */
  onUploadAct: (path: string, action: string) => void;
  /** The editor in the page needs to know which files are on their way: it is new there and asks, or it was told to edit. */
  onUploadsAsk: () => void;
  /** A page came into the frame: this one again, or another. */
  onLoad: () => void;
  /** The page shows its steps bar (a presentation), at the bottom centre. */
  onSteps: (on: boolean) => void;
}

/** A key as the page said it (the page could have sent anything): null for none. */
function keysOf(sent: unknown): Keys | null {
  const k = sent as Record<string, unknown> | null | undefined;
  if (!k || typeof k.key != "string" || k.key.length > 30) return null;
  return { key: k.key, metaKey: !!k.metaKey, ctrlKey: !!k.ctrlKey, shiftKey: !!k.shiftKey, altKey: !!k.altKey };
}

export function mountPageFrame(c: PageFrameConfig) {
  /** In the editor: the page in the frame runs the editor. */
  const active = () => c.told().mode == "edit";
  /** How much of the window's bottom the alerts take, in px. */
  let notes = 0;
  /** This browser is signed out: each page that comes is told (its editor's socket tries no more: libs/text/ui/frame.ts). */
  let out = false;

  const post = (m: unknown) => {
    // A frame whose page hasn't come yet (its first, empty document is this origin's): the page says hello when it comes.
    const frame = c.frame();
    try {
      void frame.contentWindow?.location.href;
      return;
    } catch {
      /* the page's own origin: it's there */
    }
    frame.contentWindow?.postMessage(m, c.origin);
  };

  /** Tells the page what it was told last: edit or standby (with what it needs), or view. */
  function say(): void {
    const told = c.told();
    if (told.mode == "view") {
      post({ type: "erga-mode", mode: "view" } satisfies EditMode);
      return;
    }
    // (Standby is for the editor's page: another page that the viewer shows has no editor to wait.)
    if (told.mode == "standby" && !c.here()) return;
    const { __ergaTimescale: timescale, __ergaCheck: check } = globalThis as { __ergaTimescale?: number; __ergaCheck?: boolean };
    post({
      type: "erga-mode",
      mode: told.mode,
      ...c.edit(told.key),
      notes,
      ...(timescale ? { timescale } : {}),
      ...(check ? { check } : {}),
    } satisfies EditMode);
    // (An editor that started before the viewer was ready asked in vain: frame.ts.)
    if (active()) c.onUploadsAsk();
  }

  const num = (n: unknown): n is number => typeof n == "number" && Number.isFinite(n);
  window.addEventListener("message", (e) => {
    const frame = c.frame();
    if (e.source != frame.contentWindow || e.origin != c.origin || typeof e.data?.type != "string") return;
    const m = e.data as Record<string, unknown> & { type: string };
    // A page in the frame (again: it loaded again, or went to another page): the editor in it, if in the editor.
    if (m.type == "erga-hello") {
      c.onLoad();
      // (A frame with the focus: the page that came in it has it, for its editor: client/inline/viewer-frames.ts.)
      if (active()) say();
      if (out) post({ type: "erga-out" });
      return;
    }
    if (m.type == "erga-problem" && m.problem && typeof m.base == "string") {
      const p = m.problem as Record<string, unknown>;
      const s = (k: string, max: number) => (typeof p[k] == "string" ? (p[k] as string).slice(0, max) : null);
      if (p.kind == "resource" && s("tag", 50) && s("url", 2000))
        c.onProblem({ kind: "resource", tag: s("tag", 50)!, url: s("url", 2000)! }, m.base);
      else if (p.kind == "script" && s("message", 500) != null)
        c.onProblem(
          {
            kind: "script",
            message: s("message", 500)!,
            file: s("file", 2000) ?? "",
            line: num(p.line) ? p.line : 0,
            stack: s("stack", 4000) ?? undefined,
          },
          m.base
        );
    }
    if (m.type == "erga-steps") c.onSteps(m.on === true);
    // Out of the editor, the page that came says which it is (after its hello; the viewer has heard it): its editor
    // joins the room again, ahead.
    if (m.type == "erga-nav" && c.told().mode == "standby") say();
    // (Also from an editor that stops, out of the editor: its edits no longer count for the mark.)
    if (m.type == "erga-save" && (m.at == "saved" || m.at == "saving" || m.at == "error")) c.onSave(m.at as At);
    if (!active()) return;
    switch (m.type) {
      // The page's editor asks for the page made again from its files (libs/text/ui/frame.ts, reloadNow): with its view kept.
      case "erga-reload":
        window.ergaFrames.reload("?erga-edit");
        return;
      case "erga-key": {
        const k = keysOf(m.keys);
        if (k) c.onKey(k);
        return;
      }
      case "erga-press":
        c.onPress();
        return;
      case "erga-alert": {
        const event = readMessage(m, PAGE_KEY);
        if (event) c.onAlert(event);
        return;
      }
      case "erga-upload": {
        const list = (Array.isArray(m.files) ? m.files : []).slice(0, 50) as { file?: unknown; path?: unknown; noPlace?: unknown }[];
        const at = m.point as { x?: unknown; y?: unknown } | undefined;
        c.onUpload(
          list.flatMap((f) =>
            f?.file instanceof File && typeof f.path == "string"
              ? [
                  {
                    file: f.file,
                    path: f.path.slice(0, 500),
                    ...(typeof f.noPlace == "string" ? { noPlace: f.noPlace.slice(0, 300) } : {}),
                  },
                ]
              : []
          ),
          num(at?.x) && num(at?.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : undefined
        );
        return;
      }
      case "erga-uploads-ask":
        c.onUploadsAsk();
        return;
      case "erga-upload-act":
        if (typeof m.path == "string" && typeof m.action == "string") c.onUploadAct(m.path.slice(0, 500), m.action.slice(0, 20));
        return;
      case "erga-pointer": {
        if (!num(m.x) || !num(m.y) || m.tap) return;
        const r = frame.getBoundingClientRect(),
          zoom = window.ergaFrames.scale();
        c.onPointer(r.left + m.x * zoom, r.top + m.y * zoom);
        return;
      }
      case "erga-activity":
        if (m.kind == "focus" || m.kind == "key" || m.kind == "edit") c.onActivity(m.kind as "focus" | "key" | "edit");
        if (m.kind == "key" && keysOf(m.keys)) c.onPressed(keysOf(m.keys)!);
        return;
      case "erga-context": {
        if (typeof m.path != "string" || m.path.length >= 1000 || !m.context || typeof m.context != "object") return;
        const ctx = m.context as Record<string, unknown>;
        const near = ctx.near as Record<string, unknown> | undefined;
        if (
          !num(ctx.line) ||
          !num(ctx.endLine) ||
          typeof ctx.lineText != "string" ||
          !near ||
          typeof near.html != "string" ||
          !num(near.htmlFrom) ||
          !num(near.line) ||
          !num(near.column)
        )
          return;
        c.onContext(m.path, {
          line: Math.max(1, Math.floor(ctx.line)),
          endLine: Math.max(1, Math.floor(ctx.endLine)),
          ...(typeof ctx.selected == "string" ? { selected: ctx.selected.slice(0, 4100) } : {}),
          lineText: ctx.lineText.slice(0, 450),
          near: {
            html: near.html.slice(0, 4100),
            htmlFrom: Math.max(1, Math.floor(near.htmlFrom)),
            line: Math.max(1, Math.floor(near.line)),
            column: Math.max(1, Math.floor(near.column)),
          },
        });
        return;
      }
      case "erga-typed":
        if (typeof m.text == "string" && m.text) c.onPressed({ text: m.text.slice(0, 200) });
        return;
      case "erga-open":
        if (typeof m.path == "string" && m.path.length < 1000) c.onOpen(m.path);
        return;
    }
  });

  return {
    /**
     * Tells the page what it was told last, as it changed. Edit: the page in the frame loads the editor
     * (client/inline/reader.ts), which opens its own socket; again, a new key for its next socket (it's checked as a socket
     * opens). Standby: the editor in the page stops (the page stays as it is, and the editor keeps its state and its
     * socket), or loads and joins the room ahead. View: it leaves the room too.
     */
    say,
    /**
     * Another of the document's pages, in place of this one (the viewer went to it without a reload): the frame goes to
     * it (its address under the document's files, in place of this one's: no new entry in the tab's history), whose
     * editor starts afresh there.
     */
    load(path: string) {
      c.frame().contentWindow?.location.replace(c.files + path.split("/").map(encodeURIComponent).join("/"));
    },
    focus() {
      c.frame().focus();
    },
    signedOut() {
      out = true;
      post({ type: "erga-out" });
    },
    /** The alerts take `px` of the window's bottom: the editor in the page keeps its own notes over them. */
    setNotes(px: number) {
      if (px == notes) return;
      notes = px;
      if (active()) post({ type: "erga-notes", notes });
    },
    /** A button of one of the page's alerts (or that the person closed it), to the editor in the page; false: not the page's. */
    act(key: string, action: string, row?: string): boolean {
      if (!key.startsWith(PAGE_KEY)) return false;
      post({ type: "erga-alert-act", key: key.slice(PAGE_KEY.length), action, ...(row ? { row } : {}) } satisfies AlertAct);
      return true;
    },
    /**
     * The files on their way from this tab, for their elements on the page (`file`: its bytes, the first time), and
     * those that arrived since it was told last.
     */
    uploads(files: (PageFile & { file?: File })[], landed: string[]) {
      if (active()) post({ type: "erga-uploads", files, landed });
    },
    /** The files on their way from anyone, as the room says (the page's own socket doesn't hear it). */
    uploadsOf(files: Record<string, Pending>) {
      if (active()) post({ type: "erga-uploads-of", files });
    },
    /** Asks the page editor to remove a cancelled upload's element from the document's HTML files. */
    removeUpload(path: string) {
      post({ type: "erga-upload-remove", path });
    },
  };
}

export type PageFrame = ReturnType<typeof mountPageFrame>;
