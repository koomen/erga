// The frame keeps an EditorState with our own lean history (libs/text/ui/history.ts) and never loads
// @codemirror/commands, @codemirror/view, or @lezer/common. This verifies the frame and page-tools bundles build
// cleanly with zero plugins and zero view/parser/commands dependencies, and that history edits, remote edits, JSON
// serialization roundtrips, and undo/redo all work as expected.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EditorState, Transaction } from "@codemirror/state";
import { history, historyField, isolateHistory, redo, undo } from "../libs/text/ui/history.ts";

const ROOT = resolve(import.meta.dir, "..");

test("the page's bundles (the editor, the page tools) build with zero plugins and zero @codemirror/commands, @codemirror/view, or @lezer/common", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "erga-frame-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(ROOT, "libs/text/ui/frame.ts"), join(ROOT, "client/page-tools/tools.ts")],
      outdir,
      splitting: true,
      target: "browser",
      format: "esm",
      metafile: true,
    } as Bun.BuildConfig);
    expect(built.success).toBe(true);
    const meta = (
      built as unknown as {
        metafile: { inputs: Record<string, unknown>; outputs: Record<string, { inputs: Record<string, unknown>; entryPoint?: string }> };
      }
    ).metafile;
    const all = Object.keys(meta.inputs);
    expect(all.filter((p) => p.includes("@codemirror/commands") || p.includes("@codemirror/view") || p.includes("@lezer/common"))).toEqual(
      []
    );
    expect(all.some((p) => p.endsWith("libs/text/ui/history.ts"))).toBe(true);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

test("the frame's history: edits, remote edits, JSON roundtrip, undo and redo", () => {
  const extensions = [history()];
  let state = EditorState.create({ doc: "<p>one</p>", extensions });
  const run = (cmd: (t: { state: typeof state; dispatch: (tr: ReturnType<typeof state.update>) => void }) => boolean) => {
    let next = state;
    const ok = cmd({
      state,
      dispatch: (tr) => {
        next = tr.state;
      },
    });
    state = next;
    return ok;
  };
  state = state.update({ changes: { from: 6, insert: " two" }, annotations: isolateHistory.of("full") }).state;
  state = state.update({ changes: { from: 10, insert: " three" }, annotations: isolateHistory.of("full") }).state;
  // Another's edit stays out of the history.
  state = state.update({ changes: { from: 0, insert: "<!-- x -->" }, annotations: Transaction.addToHistory.of(false) }).state;
  expect(state.doc.toString()).toBe("<!-- x --><p>one two three</p>");
  // As the frame hands it to sessionStorage across reloads and restores it (frame.ts stateJSON / stateFrom).
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
