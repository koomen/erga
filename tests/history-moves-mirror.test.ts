// Focused unit tests for lean history (libs/text/ui/history.ts), watchMoves teardown (libs/text/ui/moves.ts),
// Mirror text-node ownership and planning (libs/text/ui/mirror.ts), and PageEditor reconcileEach + make() atomicity.

import { describe, expect, test } from "bun:test";
import { ChangeSet, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import * as M from "../shared/manuscript";
import { history, historyField, isolateHistory, redo, undo } from "../libs/text/ui/history";
import { watchMoves } from "../libs/text/ui/moves";
import { Mirror } from "../libs/text/ui/mirror";
import { PageEditor } from "../libs/text/ui/editor";
import { carrySrc, elOf, markUnit, src as coreSrc } from "../libs/text/ui/core";
import { applyChanges } from "../libs/text/ui/render";
import type { PageUpdate } from "../libs/text/ui/types";

// ------------------------------------------------------------------ 1. history.ts

describe("history.ts", () => {
  const runCmd = (state: EditorState, cmd: typeof undo): { ok: boolean; state: EditorState; tr: Transaction | null } => {
    let next = state;
    let lastTr: Transaction | null = null;
    const ok = cmd({
      state,
      dispatch: (tr) => {
        lastTr = tr;
        next = tr.state;
      },
    });
    return { ok, state: next, tr: lastTr };
  };

  test("groups consecutive adjacent edits of the same userEvent within newGroupDelay and breaks on delay, event change, or isolation", () => {
    const ext = [history({ newGroupDelay: 500 })];
    let s = EditorState.create({ doc: "a", selection: { anchor: 1 }, extensions: ext });

    // Adjacent input.type within 500ms -> grouped into one step.
    s = s.update({
      changes: { from: 1, insert: "b" },
      selection: { anchor: 2 },
      userEvent: "input.type",
      annotations: Transaction.time.of(1000),
    }).state;
    s = s.update({
      changes: { from: 2, insert: "c" },
      selection: { anchor: 3 },
      userEvent: "input.type",
      annotations: Transaction.time.of(1100),
    }).state;
    expect(s.doc.toString()).toBe("abc");

    // Different userEvent (delete.backward) within 500ms -> new group.
    s = s.update({
      changes: { from: 2, to: 3 },
      selection: { anchor: 2 },
      userEvent: "delete.backward",
      annotations: Transaction.time.of(1200),
    }).state;
    s = s.update({
      changes: { from: 1, to: 2 },
      selection: { anchor: 1 },
      userEvent: "delete.backward",
      annotations: Transaction.time.of(1300),
    }).state;
    expect(s.doc.toString()).toBe("a");

    // Delay >= 500ms -> new group.
    s = s.update({
      changes: { from: 1, insert: "x" },
      selection: { anchor: 2 },
      userEvent: "input.type",
      annotations: Transaction.time.of(2000),
    }).state;
    s = s.update({
      changes: { from: 2, insert: "y" },
      selection: { anchor: 3 },
      userEvent: "input.type",
      annotations: Transaction.time.of(2600),
    }).state;
    expect(s.doc.toString()).toBe("axy");

    // Undo "y" alone (separated by delay).
    let r = runCmd(s, undo);
    expect(r.ok).toBe(true);
    expect(r.tr!.isUserEvent("undo")).toBe(true);
    expect(r.state.doc.toString()).toBe("ax");
    expect(r.state.selection.main.head).toBe(2);

    // Undo "x".
    r = runCmd(r.state, undo);
    expect(r.state.doc.toString()).toBe("a");

    // Undo both grouped delete.backwards together -> "abc".
    r = runCmd(r.state, undo);
    expect(r.state.doc.toString()).toBe("abc");
    expect(r.state.selection.main.head).toBe(3);

    // Undo both grouped input.types ("bc") -> "a".
    r = runCmd(r.state, undo);
    expect(r.state.doc.toString()).toBe("a");
    expect(r.state.selection.main.head).toBe(1);

    // Stack empty.
    expect(runCmd(r.state, undo).ok).toBe(false);

    // Redo restores step by step with redo userEvent.
    r = runCmd(r.state, redo);
    expect(r.ok).toBe(true);
    expect(r.tr!.isUserEvent("redo")).toBe(true);
    expect(r.state.doc.toString()).toBe("abc");
    expect(r.state.selection.main.head).toBe(3);
  });

  test("isolateHistory before/after/full and selection moves separate groups without clearing redo", () => {
    const ext = [history()];
    let s = EditorState.create({ doc: "", selection: { anchor: 0 }, extensions: ext });
    s = s.update({
      changes: { from: 0, insert: "a" },
      selection: { anchor: 1 },
      userEvent: "input.type",
      annotations: Transaction.time.of(100),
    }).state;
    s = s.update({
      changes: { from: 1, insert: "b" },
      selection: { anchor: 2 },
      userEvent: "input.type",
      annotations: [Transaction.time.of(110), isolateHistory.of("before")],
    }).state;
    s = s.update({
      changes: { from: 2, insert: "c" },
      selection: { anchor: 3 },
      userEvent: "input.type",
      annotations: [Transaction.time.of(120), isolateHistory.of("after")],
    }).state;
    s = s.update({
      changes: { from: 3, insert: "d" },
      selection: { anchor: 4 },
      userEvent: "input.type",
      annotations: Transaction.time.of(130),
    }).state;
    // Selection move separates "d" from "e".
    s = s.update({ selection: { anchor: 4 }, userEvent: "select" }).state;
    s = s.update({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      userEvent: "input.type",
      annotations: Transaction.time.of(140),
    }).state;
    expect(s.doc.toString()).toBe("abcde");

    // Undo "e", then move caret, then Redo must still restore "e".
    let r = runCmd(s, undo);
    expect(r.state.doc.toString()).toBe("abcd");
    const moved = r.state.update({ selection: { anchor: 1 }, userEvent: "select" }).state;
    r = runCmd(moved, redo);
    expect(r.ok).toBe(true);
    expect(r.state.doc.toString()).toBe("abcde");

    // Step through all groups: "e", "d", "bc", "a".
    const steps: string[] = [];
    s = r.state;
    for (;;) {
      const u = runCmd(s, undo);
      if (!u.ok) break;
      s = u.state;
      steps.push(s.doc.toString());
    }
    expect(steps).toEqual(["abcd", "abc", "a", ""]);
  });

  test("maps undo and redo stacks cleanly across remote edits, including edits that delete user text", () => {
    const ext = [history()];
    let s = EditorState.create({ doc: "hello world", selection: { anchor: 5 }, extensions: ext });
    // User edit 1: insert " dear" at 5 -> "hello dear world"
    s = s.update({
      changes: { from: 5, insert: " dear" },
      selection: { anchor: 10 },
      annotations: isolateHistory.of("full"),
    }).state;
    // Remote edit 1: prepend ">> " -> ">> hello dear world"
    s = s.update({ changes: { from: 0, insert: ">> " }, annotations: Transaction.addToHistory.of(false) }).state;
    // User edit 2: append "!" -> ">> hello dear world!"
    s = s.update({
      changes: { from: s.doc.length, insert: "!" },
      selection: { anchor: s.doc.length + 1 },
      annotations: isolateHistory.of("full"),
    }).state;
    // Remote edit 2: delete the "!" user just added -> ">> hello dear world"
    s = s.update({
      changes: { from: s.doc.length - 1, to: s.doc.length },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    expect(s.doc.toString()).toBe(">> hello dear world");

    // Edit 2 was completely subsumed by remote edit 2, so Undo skips straight to Edit 1 without throwing!
    let r = runCmd(s, undo);
    expect(r.ok).toBe(true);
    expect(r.state.doc.toString()).toBe(">> hello world");
    expect(r.state.selection.main.head).toBe(8);

    // Remote edit 3 while undone stack is non-empty: prepend "[1] "
    const withRemote = r.state.update({ changes: { from: 0, insert: "[1] " }, annotations: Transaction.addToHistory.of(false) }).state;
    expect(withRemote.doc.toString()).toBe("[1] >> hello world");

    // JSON roundtrip preserves both done and undone stacks with mapped changes.
    const restored = EditorState.fromJSON(withRemote.toJSON({ history: historyField }), { extensions: ext }, { history: historyField });
    r = runCmd(restored, redo);
    expect(r.ok).toBe(true);
    expect(r.state.doc.toString()).toBe("[1] >> hello dear world");
    expect(r.state.selection.main.head).toBe(17);
  });

  test("respects minDepth and readOnly", () => {
    const ext = [history({ minDepth: 5 })];
    let s = EditorState.create({ doc: "", extensions: ext });
    for (let i = 0; i < 40; i++)
      s = s.update({ changes: { from: s.doc.length, insert: "a" }, annotations: isolateHistory.of("full") }).state;
    let count = 0;
    while (true) {
      const r = runCmd(s, undo);
      if (!r.ok) break;
      s = r.state;
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(5);
    expect(count).toBeLessThan(40);

    const ro = EditorState.create({ doc: "x", extensions: [history(), EditorState.readOnly.of(true)] });
    const ro2 = ro.update({ changes: { from: 1, insert: "y" }, filter: false }).state;
    expect(runCmd(ro2, undo).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ 2. moves.ts

describe("watchMoves", () => {
  function fakeEnv() {
    const listeners = new Map<string, Set<EventListener>>();
    let observed = 0,
      disconnected = 0;
    let observerCb: ((records: { target: Node }[]) => void) | null = null;
    let rafSeq = 1;
    const rafs = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];

    class FakeMutationObserver {
      constructor(cb: (records: { target: Node }[]) => void) {
        observerCb = cb;
      }
      observe() {
        observed++;
      }
      disconnect() {
        disconnected++;
        observerCb = null;
      }
    }

    const win = {
      MutationObserver: FakeMutationObserver,
      requestAnimationFrame(cb: FrameRequestCallback) {
        const id = rafSeq++;
        rafs.set(id, cb);
        return id;
      },
      cancelAnimationFrame(id: number) {
        cancelled.push(id);
        rafs.delete(id);
      },
    } as unknown as Window & typeof globalThis;

    const doc = {
      defaultView: win,
      addEventListener(type: string, f: EventListener) {
        let s = listeners.get(type);
        if (!s) listeners.set(type, (s = new Set()));
        s.add(f);
      },
      removeEventListener(type: string, f: EventListener) {
        const s = listeners.get(type);
        if (!s) return;
        s.delete(f);
        if (!s.size) listeners.delete(type);
      },
    } as unknown as Document;

    const emit = (type: string, event: Record<string, unknown> = {}) => {
      for (const f of [...(listeners.get(type) ?? [])]) f(event as unknown as Event);
    };
    const mutate = (target: { nodeType: number; localName: string }) => observerCb?.([{ target: target as unknown as Node }]);
    const listenerCount = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);

    return { doc, win, emit, mutate, listenerCount, rafs, cancelled, stats: () => ({ observed, disconnected }) };
  }

  test("shares one hub per document and tears down all listeners, observer, and RAF when last subscriber unsubscribes", () => {
    const env = fakeEnv();
    let a = 0,
      b = 0;
    const unsubA = watchMoves(env.doc, env.win, () => a++);
    const unsubB = watchMoves(env.doc, env.win, () => b++);

    expect(env.stats()).toEqual({ observed: 1, disconnected: 0 });
    expect(env.listenerCount()).toBeGreaterThan(0);

    env.emit("scroll");
    expect([a, b]).toEqual([1, 1]);

    // Ignores pointermove with buttons == 0 and mutations on <erga-*> elements.
    env.emit("pointermove", { buttons: 0 });
    env.mutate({ nodeType: 1, localName: "erga-caret" });
    expect([a, b]).toEqual([1, 1]);

    env.emit("pointermove", { buttons: 1 });
    env.mutate({ nodeType: 1, localName: "div" });
    expect([a, b]).toEqual([3, 3]);

    // Trigger an active transition RAF loop.
    env.emit("transitionrun", {
      target: {
        nodeType: 1,
        localName: "div",
        getAnimations: () => [{ currentTime: 0, effect: { getComputedTiming: () => ({ endTime: 500 }) } }],
      },
    });
    expect(env.rafs.size).toBe(1);

    // Unsubscribing A leaves hub active for B.
    unsubA();
    unsubA(); // idempotent
    expect(env.stats().disconnected).toBe(0);
    env.emit("wheel");
    expect([a, b]).toEqual([3, 4]);

    // Unsubscribing B tears down everything: listeners, MutationObserver, RAF.
    unsubB();
    expect(env.listenerCount()).toBe(0);
    expect(env.stats()).toEqual({ observed: 1, disconnected: 1 });
    expect(env.cancelled.length).toBe(1);
    expect(env.rafs.size).toBe(0);

    // Re-subscribing later creates a fresh hub cleanly.
    let c = 0;
    const unsubC = watchMoves(env.doc, env.win, () => c++);
    expect(env.stats()).toEqual({ observed: 2, disconnected: 1 });
    env.emit("scroll");
    expect(c).toBe(1);
    unsubC();
    expect(env.listenerCount()).toBe(0);
    expect(env.stats()).toEqual({ observed: 2, disconnected: 2 });
  });
});

// ------------------------------------------------------------------ 3 & 4. Tiny DOM + Mirror + EditorRender

class FakeNode {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null;
  }
  get isConnected(): boolean {
    let cur: FakeNode | null = this;
    while (cur) {
      if (cur === this.ownerDocument.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  contains(other: FakeNode | null): boolean {
    for (let cur = other; cur; cur = cur.parentNode) if (cur === this) return true;
    return false;
  }
}

class FakeText extends FakeNode {
  nodeValue: string;
  constructor(text: string, doc: FakeDocument) {
    super(3, "#text", doc);
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  readonly localName: string;
  private attrs = new Map<string, string>();
  classList = {
    set: new Set<string>(),
    add: (...cs: string[]) => cs.forEach((c) => this.classList.set.add(c)),
    remove: (...cs: string[]) => cs.forEach((c) => this.classList.set.delete(c)),
    contains: (c: string) => this.classList.set.has(c),
    toggle: (c: string, force?: boolean) => (force ? this.classList.set.add(c) : this.classList.set.delete(c)),
    get length() {
      return this.set.size;
    },
  };
  constructor(tag: string, doc: FakeDocument) {
    super(1, tag.toUpperCase(), doc);
    this.localName = tag.toLowerCase();
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n.nodeType == 1);
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs.entries()].map(([name, value]) => ({ name, value }));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  insertBefore<T extends FakeNode>(node: T, before: FakeNode | null): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  appendChild<T extends FakeNode>(node: T): T {
    return this.insertBefore(node, null);
  }
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  removeChild<T extends FakeNode>(node: T): T {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      node.parentNode = null;
    }
    return node;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const c of this.childNodes.splice(0)) c.parentNode = null;
    for (const n of nodes) this.appendChild(n);
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof FakeText ? n.nodeValue : (n as FakeElement).textContent)).join("");
  }
  set textContent(v: string) {
    this.replaceChildren();
    if (v) this.appendChild(new FakeText(v, this.ownerDocument));
  }
  closest(sel: string): FakeElement | null {
    return sel.includes("contenteditable") && this.getAttribute("contenteditable") ? this : null;
  }
  querySelector(): FakeElement | null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
}

class FakeTemplate extends FakeElement {
  content: FakeElement;
  constructor(doc: FakeDocument) {
    super("template", doc);
    this.content = new FakeElement("#fragment", doc);
  }
  set innerHTML(html: string) {
    this.content.replaceChildren();
    const parsed = M.parseHtml(html);
    buildDom(parsed.children, this.content, html, this.ownerDocument);
  }
}

class FakeDocument {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  constructor(src: string) {
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    const root = M.parseHtml(src);
    const htmlNode = root.children.find((c): c is M.ElementNode => c.kind == "element" && c.tag == "html");
    const headNode = (htmlNode ?? root).children.find((c): c is M.ElementNode => c.kind == "element" && c.tag == "head");
    const bodyNode = (htmlNode ?? root).children.find((c): c is M.ElementNode => c.kind == "element" && c.tag == "body");
    if (headNode) {
      copyAttrs(src.slice(headNode.from, headNode.openTo), this.head);
      this.documentElement.appendChild(this.head);
      buildDom(headNode.children, this.head, src, this);
    }
    this.documentElement.appendChild(this.body);
    if (bodyNode) {
      copyAttrs(src.slice(bodyNode.from, bodyNode.openTo), this.body);
      buildDom(bodyNode.children, this.body, src, this);
    } else {
      buildDom(root.children, this.body, src, this);
    }
  }
  createElement(tag: string): FakeElement {
    return tag.toLowerCase() == "template" ? new FakeTemplate(this) : new FakeElement(tag, this);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text, this);
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  querySelector(): FakeElement | null {
    return null;
  }
}

function copyAttrs(openTag: string, el: FakeElement): void {
  const m = /^<[a-z0-9-]+([\s\S]*?)\/?>$/i.exec(openTag);
  if (!m) return;
  for (const a of m[1].matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
    el.setAttribute(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
}

function buildDom(nodes: M.SourceNode[], parent: FakeElement, src: string, doc: FakeDocument): void {
  for (const n of nodes) {
    if (n.kind == "text") {
      const { text } = M.decodeText(src, n.from, n.to, false, M.basicDecoder);
      if (text) parent.appendChild(doc.createTextNode(text));
    } else if (n.tag != "#comment" && !n.tag.startsWith("!")) {
      const el = doc.createElement(n.tag);
      copyAttrs(src.slice(n.from, n.openTo), el);
      parent.appendChild(el);
      buildDom(n.children, el, src, doc);
    }
  }
}

describe("Mirror.wasOurs and canReconcile", () => {
  test("preserves foreign text nodes added by page scripts while still removing owned text nodes deleted from HTML", () => {
    const oldSrc = '<html><body><div id="box"><p>Hello</p></div></body></html>';
    const doc = new FakeDocument(oldSrc);
    const root = M.parseHtml(oldSrc);
    const mirror = Mirror.bind(doc as unknown as Document, root, oldSrc)!;
    const box = doc.body.firstElementChild!;

    // Page script appends a foreign text node inside #box.
    const foreignInBox = doc.createTextNode(" [script-badge]");
    box.appendChild(foreignInBox);

    // Structural edit inside #box: split <p>Hello</p> into <p>Hi</p><p>Two</p> (reconciles #box).
    const from = oldSrc.indexOf("Hello");
    const insert = "Hi</p><p>Two";
    const newSrc = oldSrc.slice(0, from) + insert + oldSrc.slice(from + "Hello".length);
    const changes = ChangeSet.of({ from, to: from + "Hello".length, insert }, oldSrc.length);
    expect(mirror.reconcile(changes, oldSrc, newSrc, M.basicDecoder)).not.toBeNull();

    // Foreign text node in #box is preserved across the structural reconcile.
    expect(box.childNodes).toContain(foreignInBox);
    expect(foreignInBox.nodeValue).toBe(" [script-badge]");

    // Now append a foreign text node inside the first <p>, then delete the owned "Hi" text (turning <p>Hi</p> into <p><br></p>):
    // owned "Hi" is removed, while the foreign text node stays!
    const firstP = box.children[0];
    const foreignInP = doc.createTextNode(" (ext)");
    firstP.appendChild(foreignInP);
    const from2 = newSrc.indexOf("Hi");
    const newSrc2 = newSrc.slice(0, from2) + "<br>" + newSrc.slice(from2 + 2);
    const changes2 = ChangeSet.of({ from: from2, to: from2 + 2, insert: "<br>" }, newSrc.length);
    expect(mirror.reconcile(changes2, newSrc, newSrc2, M.basicDecoder)).not.toBeNull();

    expect(box.children[0]).toBe(firstP);
    expect(firstP.childNodes.some((n) => n instanceof FakeText && n.nodeValue == "Hi")).toBe(false);
    expect(firstP.childNodes).toContain(foreignInP);
    expect(foreignInP.nodeValue).toBe(" (ext)");
  });

  test("canReconcile rejects detached target elements without mutating the DOM", () => {
    const oldSrc = "<html><body><p>One</p><p>Two</p></body></html>";
    const doc = new FakeDocument(oldSrc);
    const root = M.parseHtml(oldSrc);
    const mirror = Mirror.bind(doc as unknown as Document, root, oldSrc)!;
    const secondP = doc.body.children[1];
    secondP.remove(); // Page script detached <p>Two</p>

    const from = oldSrc.indexOf("Two");
    const newSrc = oldSrc.slice(0, from) + "Two!" + oldSrc.slice(from + 3);
    const changes = ChangeSet.of({ from, to: from + 3, insert: "Two!" }, oldSrc.length);
    expect(mirror.canReconcile(changes, oldSrc, newSrc)).toBe(false);
    expect(mirror.reconcile(changes, oldSrc, newSrc, M.basicDecoder)).toBeNull();
    expect(secondP.textContent).toBe("Two");
  });
});

describe("PageEditor reconcileEach & make()", () => {
  function mountFake(html: string, fakeDoc: FakeDocument) {
    const updates: PageUpdate[] = [];
    let reloads = 0;
    const state = EditorState.create({ doc: html, selection: EditorSelection.cursor(html.indexOf("<p>") + 3), extensions: [history()] });
    const ed = new PageEditor({
      win: { document: fakeDoc, scrollY: 0, innerHeight: 800, focus() {}, scrollBy() {}, dispatchEvent() {} } as unknown as Window,
      source: "",
      state,
      base: "/",
      headless: true,
      onUpdate: (u) => updates.push(u),
      onReload: () => {
        reloads++;
      },
    });
    const core = ed.core;
    core.doc = fakeDoc as unknown as Document;
    core.mirror = Mirror.bind(core.doc, core.tree!, html);
    for (const u of core.units) {
      const el = elOf(core, u);
      if (el) markUnit(core, u, el);
    }
    const applyMulti = (changes: ChangeSet) => {
      const oldSrc = coreSrc(core);
      const oldUnits = core.units;
      const tr = core.state.update({ changes });
      carrySrc(core, tr.changes, tr.startState.doc, tr.newDoc);
      core.state = tr.state;
      applyChanges(core, tr, oldUnits, oldSrc);
    };
    return { ed, updates, reloads: () => reloads, applyMulti };
  }

  test("reconcileEach pre-validates all parts so a failure on part 2 leaves part 1 unmutated", () => {
    // Part 0 edits <style> in <head> (valid) and Part 1 edits a detached <p> in <body> (invalid):
    // single-region reconcile fails (spans head + body), so reconcileEach runs and must reject before mutating <style>.
    const src = "<html><head><style>p { color: red; }</style></head><body><p>Alpha</p><p>Beta</p></body></html>";
    const doc = new FakeDocument(src);
    const { ed, applyMulti } = mountFake(src, doc);
    const styleEl = doc.head.firstElementChild!;
    const pBeta = doc.body.children[1];
    pBeta.remove();
    const changes = ChangeSet.of(
      [
        { from: src.indexOf("red"), to: src.indexOf("red") + 3, insert: "blue" },
        { from: src.indexOf("Beta"), to: src.indexOf("Beta") + 4, insert: "BETA2" },
      ],
      src.length
    );
    applyMulti(changes);
    expect(ed.upToDate).toBe(false);
    // Part 0 (<style>) must NOT have been mutated!
    expect(styleEl.textContent).toBe("p { color: red; }");

    // Also test Part 0 in <body> (valid <p>) + Part 1 in <script> in <body> (invalid):
    const src2 = "<html><body><p>One</p><script>let x = 1;</script></body></html>";
    const doc2 = new FakeDocument(src2);
    const h2 = mountFake(src2, doc2);
    const pOne = doc2.body.children[0];
    const changes2 = ChangeSet.of(
      [
        { from: src2.indexOf("One"), to: src2.indexOf("One") + 3, insert: "MUTATED" },
        { from: src2.indexOf("let x = 1"), to: src2.indexOf("let x = 1") + 9, insert: "let x = 2" },
      ],
      src2.length
    );
    h2.applyMulti(changes2);
    expect(h2.ed.upToDate).toBe(false);
    expect(pOne.textContent).toBe("One");
  });

  test("reconcileEach succeeds in place when all disjoint parts are valid (style + body text)", () => {
    const src = "<html><head><style>p { color: red; }</style></head><body><p>Hello</p></body></html>";
    const doc = new FakeDocument(src);
    const { ed, applyMulti } = mountFake(src, doc);
    const changes = ChangeSet.of(
      [
        { from: src.indexOf("red"), to: src.indexOf("red") + 3, insert: "blue" },
        { from: src.indexOf("Hello"), to: src.indexOf("Hello") + 5, insert: "World" },
      ],
      src.length
    );
    applyMulti(changes);
    expect(ed.upToDate).toBe(true);
    expect(doc.head.firstElementChild!.textContent).toBe("p { color: blue; }");
    expect(doc.body.firstElementChild!.textContent).toBe("World");
  });

  test("make() applies changes and selection in one atomic transaction and undo step", () => {
    const src = "<html><body><p>First</p></body></html>";
    const doc = new FakeDocument(src);
    const { ed, updates } = mountFake(src, doc);
    const beforeSel = ed.state.selection.main;
    const at = src.indexOf("</p>") + 4;
    const insert = "<p>Added</p>";
    ed.make([{ from: at, to: at, insert }], "input.page");

    // Only ONE update/dispatch happened (not two).
    expect(updates.length).toBe(1);
    expect(updates[0].docChanged).toBe(true);
    expect(updates[0].selectionSet).toBe(true);
    expect(ed.state.doc.toString()).toBe("<html><body><p>First</p><p>Added</p></body></html>");
    const afterSel = ed.state.selection.main;
    expect(ed.state.sliceDoc(afterSel.from, afterSel.to)).toBe("Added");

    // Single Undo restores both the original HTML and the original selection cleanly.
    expect(ed.undo()).toBe(true);
    expect(ed.state.doc.toString()).toBe(src);
    expect(ed.state.selection.main.anchor).toBe(beforeSel.anchor);
    expect(ed.state.selection.main.head).toBe(beforeSel.head);
    expect(ed.lastUndoRedo).toBe(true);
    expect(ed.undo()).toBe(false);

    // Single Redo restores both the added paragraph and its selection.
    expect(ed.redo()).toBe(true);
    expect(ed.state.doc.toString()).toBe("<html><body><p>First</p><p>Added</p></body></html>");
    expect(ed.state.sliceDoc(ed.state.selection.main.from, ed.state.selection.main.to)).toBe("Added");
    expect(ed.lastUndoRedo).toBe(true);
  });
});
