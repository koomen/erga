// The shell's side of the document room: a replica of the shared Yjs doc
// (src/room/doc.ts), synced with the host over a WebSocket (y-websocket's
// protocol), and the binding between it and the editor's CodeMirror state.
//
// Local edits are CodeMirror transactions; each becomes one Yjs transaction
// on the document's Y.Text. Edits from anyone else arrive as Y.Text events,
// are turned back into CodeMirror changes and applied through the same path
// agent edits always took (`PageEditor.applyExternal`), so the page patches
// in place and marks the change, now in its author's colour. Presence rides
// on awareness: who is here, where their caret is (as Yjs relative
// positions, so it stays put while the text around it changes), when each
// tab was last used, and whether an agent is busy.

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { ChangeSet } from "@codemirror/state";
import { applyChanges, assets, authorOf, deltaToChanges, files, hasSeen, introduce, roomInfo, stamp, stateVector, type Author } from "../room/doc";
import { changesBetween } from "./merge";
import { BASE } from "./base";

/** Someone in the room, from awareness. */
export interface Presence {
  client: number;
  user: Author;
  busy?: boolean;
  activity?: string | null;
  cursor?: { path: string; anchor: unknown; head: unknown | null } | null;
  /**
   * When this tab was last focused or used (ms). A person with several tabs
   * open is shown by the one they used last, so only its caret is drawn.
   */
  active?: number;
}

export interface CollabOptions {
  /** The document's path in the room (the page being edited). */
  path: string;
  me: Author;
  /** Someone else changed the document. */
  onRemote: (changes: ChangeSet, author: Author | null) => void;
  /** Another file in the folder changed (a stylesheet, a script, an image). */
  onFiles: (paths: string[]) => void;
  /** Who's here, or what they're doing, changed. */
  onPresence: () => void;
  onStatus: (connected: boolean) => void;
  /**
   * The room refused this tab: it holds a history from before the host lost
   * its state (room.ts), and merging would double the document. Reload.
   */
  onStale: () => void;
}

export class Collab {
  readonly doc = new Y.Doc();
  readonly provider: WebsocketProvider;
  private text: Y.Text | null = null;
  /** The origin of this tab's own transactions, which the observer skips. */
  private readonly local = { tab: true };
  private synced: Promise<void>;
  /** Set once the first sync is done; until then everything arriving is the initial state. */
  private live = false;

  constructor(private opts: CollabOptions, params: Record<string, string>) {
    const proto = location.protocol == "https:" ? "wss:" : "ws:";
    this.provider = new WebsocketProvider(`${proto}//${location.host}${BASE}/api/room`, "doc", this.doc, { params, disableBc: true });
    const awareness = this.provider.awareness;
    awareness.setLocalState({ user: opts.me, cursor: null, active: document.hasFocus() ? Date.now() : 0 });
    awareness.on("change", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      // This tab's own cursor moving is no news to it.
      if ([...added, ...updated, ...removed].some((c) => c != this.doc.clientID)) opts.onPresence();
    });
    this.provider.on("status", (e: { status: string }) => opts.onStatus(e.status == "connected"));
    this.provider.on("connection-close", (e: CloseEvent | null) => {
      if (e?.code != 4409) return;
      this.provider.shouldConnect = false;
      opts.onStale();
    });
    this.synced = new Promise((resolve) => {
      const done = (ok: boolean) => { if (ok) { this.provider.off("sync", done); resolve(); } };
      this.provider.on("sync", done);
    });
    files(this.doc).observeDeep((events) => this.filesChanged(events));
    assets(this.doc).observe((e) => { if (this.live) opts.onFiles([...e.keysChanged]); });
  }

  /** Resolves with the document's text once the first sync with the room is done. */
  async ready(timeoutMs = 8000): Promise<string> {
    await Promise.race([this.synced, new Promise((_, reject) => setTimeout(() => reject(new Error("the room didn't answer")), timeoutMs))]);
    introduce(this.doc, this.opts.me);
    // From now on this tab holds the room's history: say which, on every reconnect.
    this.provider.params.epoch = roomInfo(this.doc).get("epoch") ?? "";
    this.live = true;
    this.bind();
    if (!this.text) throw new Error(`${this.opts.path} isn't in the room`);
    return this.text.toString();
  }

  private bind(): void {
    const t = files(this.doc).get(this.opts.path) ?? null;
    if (t == this.text) return;
    this.text?.unobserve(this.observer);
    this.text = t;
    t?.observe(this.observer);
  }

  private observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin === this.local) return;
    let inserted = 0, deleted = 0;
    for (const op of event.delta) {
      if (typeof op.insert == "string") inserted += op.insert.length;
      else if (op.delete != null) deleted += op.delete;
    }
    const before = this.text!.length - inserted + deleted;
    this.opts.onRemote(deltaToChanges(event.delta, before), authorOf(this.doc, tr));
  };

  private filesChanged(events: Y.YEvent<any>[]): void {
    if (!this.live) return;
    const others = new Set<string>();
    for (const e of events) {
      if (e.target === files(this.doc)) {
        for (const k of (e as Y.YMapEvent<Y.Text>).keysChanged) {
          if (k != this.opts.path) { others.add(k); continue; }
          // The document itself was replaced (deleted and recreated on disk).
          const old = this.text?.toString() ?? "";
          this.bind();
          if (this.text) this.opts.onRemote(changesBetween(old, this.text.toString()), authorOf(this.doc, e.transaction));
        }
      } else if (e.target instanceof Y.Text && e.target !== this.text) {
        const item = e.target._item;
        if (item?.parentSub) others.add(item.parentSub);
      }
    }
    if (others.size) this.opts.onFiles([...others]);
  }

  /** A local edit: one Yjs transaction, attributed to this tab's person. */
  push(changes: ChangeSet): void {
    const t = this.text;
    if (!t || changes.empty) return;
    // Typing without keys (dictation, a paste from the menu) is using the tab too.
    this.activate();
    this.doc.transact(() => {
      const { inserted, deleted } = applyChanges(t, changes);
      if (deleted && !inserted) stamp(this.doc, this.opts.me);
    }, this.local);
  }

  /** The room's current text of the document (to check the editor agrees). */
  current(): string { return this.text?.toString() ?? ""; }

  /** Publishes where this tab's caret is (null when it isn't in the document). */
  setCursor(anchor: number | null, head: number | null): void {
    const t = this.text, aw = this.provider.awareness;
    const prev = aw.getLocalState() ?? {};
    if (!t || anchor == null) { if (prev.cursor) aw.setLocalStateField("cursor", null); return; }
    const rel = (i: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(t, i));
    aw.setLocalStateField("cursor", { path: this.opts.path, anchor: rel(anchor), head: head == null || head == anchor ? null : rel(head) });
  }

  /**
   * This tab was focused or used: make it the one its person is shown by.
   * Newer than any of their other tabs even if the clocks disagree, and
   * nothing is sent while it already is.
   */
  activate(): void {
    const aw = this.provider.awareness;
    const mine = (aw.getLocalState()?.active as number | undefined) ?? 0;
    let newest = -1;
    for (const p of this.others()) if (p.user.kind == "person" && p.user.user == this.opts.me.user) newest = Math.max(newest, p.active ?? 0);
    if (mine > newest) return;
    aw.setLocalStateField("active", Math.max(Date.now(), newest + 1));
  }

  /**
   * Everyone else as they're shown: one presence per person, from the tab
   * they used last, and none for your own other tabs. Agents are their own
   * participants, each shown as it is.
   */
  shown(): Presence[] {
    const out: Presence[] = [], persons = new Map<string, Presence>();
    for (const p of this.others()) {
      if (p.user.kind != "person") { out.push(p); continue; }
      if (p.user.user == this.opts.me.user) continue;
      const prev = persons.get(p.user.user);
      const newer = !prev || (p.active ?? 0) > (prev.active ?? 0) || ((p.active ?? 0) == (prev.active ?? 0) && p.client > prev.client);
      if (newer) persons.set(p.user.user, p);
    }
    return [...persons.values(), ...out];
  }

  /** Everyone else in the room. */
  others(): Presence[] {
    const out: Presence[] = [];
    for (const [client, s] of this.provider.awareness.getStates()) {
      if (client != this.doc.clientID && s.user) out.push({ client, ...(s as Omit<Presence, "client">) });
    }
    return out;
  }

  /** A presence's caret and selection as positions in the document, if it's in it. */
  positions(p: Presence): { anchor: number; head: number | null } | null {
    const c = p.cursor;
    if (!c || c.path != this.opts.path || !this.text) return null;
    const abs = (j: unknown) => {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), this.doc);
      return pos && pos.type === this.text ? pos.index : null;
    };
    const anchor = abs(c.anchor);
    if (anchor == null) return null;
    return { anchor, head: c.head ? abs(c.head) : null };
  }

  /** This tab's state vector, so the host can wait until the room has its edits. */
  vector(): string { return stateVector(this.doc); }

  /** Waits until this tab has every edit some other participant had (a state vector), or gives up. */
  waitFor(vector: string, timeoutMs = 3000): Promise<boolean> {
    if (hasSeen(this.doc, vector)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => { if (hasSeen(this.doc, vector)) { this.doc.off("update", check); clearTimeout(timer); resolve(true); } };
      const timer = setTimeout(() => { this.doc.off("update", check); resolve(false); }, timeoutMs);
      this.doc.on("update", check);
    });
  }
}
