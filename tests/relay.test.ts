import { expect, test } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import { Authority, Relay, changesFrom } from "../src/page/bridge";

/** A seeded random number generator (mulberry32), so a failure can be replayed. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The shell and the frame, with a queue of messages each way (delivered in
 * order, as postMessage does), as main.ts and frame.ts wire them up.
 */
function pair(initial: string) {
  const shell = { text: Text.of(initial.split("\n")), authority: new Authority() };
  const frame = { text: shell.text } as { text: Text; relay: Relay };
  const toShell: { version: number; changes: unknown }[] = [];
  const toFrame: ({ type: "external"; changes: unknown } | { type: "ack" } | { type: "reject" })[] = [];
  frame.relay = new Relay(0, (version, changes) => toShell.push({ version, changes: changes.toJSON() }));
  return {
    shell, frame, toShell, toFrame,
    /** Someone in the room edits: the shell applies it and tells the frame. */
    room(changes: ChangeSet) {
      shell.text = changes.apply(shell.text);
      shell.authority.record(changes);
      toFrame.push({ type: "external", changes: changes.toJSON() });
    },
    /** The person types in the page. */
    type(changes: ChangeSet) {
      frame.text = changes.apply(frame.text);
      frame.relay.local(changes);
    },
    /** The shell reads the frame's next offer. */
    deliverToShell() {
      const m = toShell.shift()!;
      const changes = changesFrom(m.changes, shell.text.length);
      if (m.version != shell.authority.version || !changes) { toFrame.push({ type: "reject" }); return; }
      shell.text = changes.apply(shell.text);
      shell.authority.record(changes);
      toFrame.push({ type: "ack" });
    },
    /** The frame reads the shell's next message. */
    deliverToFrame() {
      const m = toFrame.shift()!;
      if (m.type == "ack") frame.relay.accepted();
      else if (m.type == "reject") frame.relay.refused();
      else frame.text = frame.relay.remote(ChangeSet.fromJSON(m.changes)).apply(frame.text);
    },
  };
}

/** A random edit of a text: an insertion of `token`, a deletion, or a replacement. */
function edit(r: () => number, doc: Text, token: string, deletes: boolean): ChangeSet {
  const len = doc.length;
  const from = Math.floor(r() * (len + 1));
  const to = deletes && r() < 0.4 ? Math.min(len, from + Math.floor(r() * 6)) : from;
  return ChangeSet.of({ from, to, insert: r() < 0.85 || !deletes ? token : "" }, len);
}

function run(seed: number, steps: number, deletes: boolean) {
  const r = rng(seed);
  const p = pair("The quick brown fox.\nJumps over the lazy dog.");
  const tokens: string[] = [];
  for (let i = 0; i < steps; i++) {
    const x = r();
    // One character each, from the private use area, so another insertion can't land inside one.
    const token = String.fromCharCode(0xe000 + i);
    if (x < 0.25) { p.type(edit(r, p.frame.text, token, deletes)); tokens.push(token); }
    else if (x < 0.45) { p.room(edit(r, p.shell.text, token, deletes)); tokens.push(token); }
    else if (x < 0.75 && p.toShell.length) p.deliverToShell();
    else if (p.toFrame.length) p.deliverToFrame();
  }
  // Everything still on its way arrives.
  while (p.toShell.length || p.toFrame.length) {
    if (p.toFrame.length) p.deliverToFrame();
    if (p.toShell.length) p.deliverToShell();
  }
  return { p, tokens };
}

test("the frame and the shell end up with the same text, whatever the interleaving", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { p } = run(seed, 120, true);
    expect({ seed, text: p.frame.text.toString() }).toEqual({ seed, text: p.shell.text.toString() });
    expect(p.frame.relay.idle).toBe(true);
    expect(p.frame.relay.version).toBe(p.shell.authority.version);
  }
});

test("no insertion is lost or doubled", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { p, tokens } = run(seed, 120, false);
    const text = p.shell.text.toString();
    for (const t of tokens) expect({ seed, t, n: text.split(t).length - 1 }).toEqual({ seed, t, n: 1 });
  }
});

test("an offer that doesn't fit the shell's text is refused", () => {
  expect(changesFrom(ChangeSet.of({ from: 0, insert: "x" }, 5).toJSON(), 6)).toBeNull();
  expect(changesFrom({ nonsense: true }, 5)).toBeNull();
  expect(changesFrom(ChangeSet.of({ from: 0, insert: "x" }, 5).toJSON(), 5)).not.toBeNull();
});

test("the authority keeps recent changes to catch a state up", () => {
  const a = new Authority();
  for (let i = 0; i < 3; i++) a.record(ChangeSet.of({ from: 0, insert: String(i) }, i));
  expect(a.since(1)!.length).toBe(2);
  expect(a.since(3)!.length).toBe(0);
  expect(a.since(4)).toBeNull();
});
