// `ergaEditor`, for the page's own script (server/pages/reader.ts puts it in a document's page): whether the editor is
// on it now (`editing`, and data-erga-editing on its <html>, which the editor sets and takes off: libs/text/ui/frame.ts), with
// the event erga-editing on the window as it changes, and `call(edit, input)` for one of the page's own edits (its API:
// document/page-api.ts, agents/document/PROMPT.md, "A page's own edits"), which waits for the editor (window.__ergaCall:
// libs/text/ui/render.ts).

type CallWindow = Window & {
  __ergaCallQueue?: [unknown, unknown, (r: unknown) => void][];
  __ergaCall?: (edit: unknown, input: unknown) => Promise<unknown>;
  ergaEditor?: { readonly editing: boolean; call(edit: string, input?: unknown): Promise<unknown> };
};

export default function pageEditingApi(): void {
  const w = window as CallWindow;
  const q: [unknown, unknown, (r: unknown) => void][] = [];
  w.__ergaCallQueue = q;
  w.ergaEditor = Object.freeze({
    get editing() {
      return document.documentElement.hasAttribute("data-erga-editing");
    },
    call: (edit: string, input?: unknown) =>
      new Promise<unknown>((done) => {
        if (w.__ergaCall) void w.__ergaCall(edit, input ?? {}).then(done);
        else q.push([edit, input ?? {}, done]);
      }),
  });
}
