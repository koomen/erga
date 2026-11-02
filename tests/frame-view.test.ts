// The frame's build has an inert stand-in for @codemirror/view (libs/text/ui/frame-view.ts,
// client/build.ts FRAME_VIEW): the frame keeps an EditorState and never a view. This
// checks that the frame's bundle has none of the real view's code, and that what the
// frame does with CodeMirror (a state with its history: edits, undo and redo; the state
// handed to the shell as JSON and back) works the same over the stand-in.

import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FRAME_VIEW } from "../client/build.ts";
import * as standIn from "../libs/text/ui/frame-view.ts";

const ROOT = resolve(import.meta.dir, "..");

test("the frame's bundle has nothing of @codemirror/view but the stand-in", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "erga-frame-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(ROOT, "libs/text/ui/frame.ts")],
      outdir,
      splitting: true,
      target: "browser",
      format: "esm",
      metafile: true,
      plugins: [FRAME_VIEW],
    } as Bun.BuildConfig);
    expect(built.success).toBe(true);
    const meta = (built as unknown as { metafile: { inputs: Record<string, unknown>; outputs: Record<string, { inputs: Record<string, unknown>; entryPoint?: string }> } }).metafile;
    const all = Object.keys(meta.inputs);
    expect(all.filter((p) => p.includes("@codemirror/view"))).toEqual([]);
    expect(all.some((p) => p.endsWith("libs/text/ui/frame-view.ts"))).toBe(true);
    // And the agent's screenshots load only when asked for: a chunk of their own, not the frame's script.
    const entry = Object.values(meta.outputs).find((o) => o.entryPoint)!;
    expect(Object.keys(entry.inputs).filter((p) => p.includes("modern-screenshot"))).toEqual([]);
    expect(all.some((p) => p.includes("modern-screenshot"))).toBe(true);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

test("the frame's CodeMirror work, over the stand-in: edits, undo and redo, its state as JSON", async () => {
  // (A factory that returns the module as it is: one that imports it hangs when another test loaded the view first.)
  mock.module("@codemirror/view", () => standIn);
  const { EditorState, Transaction } = await import("@codemirror/state");
  const { history, historyField, undo, redo, isolateHistory } = await import("@codemirror/commands");

  const extensions = [history()];
  let state = EditorState.create({ doc: "<p>one</p>", extensions });
  const run = (cmd: (t: { state: typeof state; dispatch: (tr: ReturnType<typeof state.update>) => void }) => boolean) => {
    let next = state;
    const ok = cmd({ state, dispatch: (tr) => { next = tr.state; } });
    state = next;
    return ok;
  };
  state = state.update({ changes: { from: 6, insert: " two" }, annotations: isolateHistory.of("full") }).state;
  state = state.update({ changes: { from: 10, insert: " three" }, annotations: isolateHistory.of("full") }).state;
  // Another's edit stays out of the history.
  state = state.update({ changes: { from: 0, insert: "<!-- x -->" }, annotations: Transaction.addToHistory.of(false) }).state;
  expect(state.doc.toString()).toBe("<!-- x --><p>one two three</p>");
  // As the frame hands it to the shell and takes it back (bridge.ts stateJSON, frame.ts stateFrom).
  state = EditorState.fromJSON(state.toJSON({ history: historyField }), { extensions }, { history: historyField });
  expect(run(undo)).toBe(true);
  expect(state.doc.toString()).toBe("<!-- x --><p>one two</p>");
  expect(run(undo)).toBe(true);
  expect(state.doc.toString()).toBe("<!-- x --><p>one</p>");
  expect(run(undo)).toBe(false);
  expect(run(redo)).toBe(true);
  expect(run(redo)).toBe(true);
  expect(state.doc.toString()).toBe("<!-- x --><p>one two three</p>");
});
