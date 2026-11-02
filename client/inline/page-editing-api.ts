// `ergaEditor`, for the page's own script (server/pages/reader.ts puts it in a document's page): whether the editor is
// on it now (`editing`, and data-erga-editing on its <html>, which the editor sets and takes off: libs/text/ui/frame.ts), with
// the event erga-editing on the window as it changes, and `apply(edits)` for its custom edits (agents/document/PROMPT.md,
// "Custom edits"), which waits for the editor (window.__ergaApply: libs/text/ui/render.ts).

type ApplyWindow = Window & {
  __ergaApplyQueue?: [unknown, (r: unknown) => void][];
  __ergaApply?: (ops: unknown) => unknown;
  ergaEditor?: { readonly editing: boolean; apply(ops: unknown): Promise<unknown> };
};

export default function pageEditingApi(): void {
  const w = window as ApplyWindow;
  const q: [unknown, (r: unknown) => void][] = [];
  w.__ergaApplyQueue = q;
  w.ergaEditor = Object.freeze({
    get editing() {
      return document.documentElement.hasAttribute("data-erga-editing");
    },
    apply: (ops: unknown) =>
      new Promise<unknown>((done) => {
        if (w.__ergaApply) done(w.__ergaApply(ops));
        else q.push([ops, done]);
      }),
  });
}
