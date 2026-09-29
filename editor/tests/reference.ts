// Loads the CodeMirror reference bundle (wip/editor-cm/vendor/vendor.js) into
// Bun so tests can compare against the real Lezer parser and CodeMirror state.
const path = new URL("../../editor-cm/vendor/vendor.js", import.meta.url).pathname;
const code = await Bun.file(path).text();
const win: any = { navigator: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", vendor: "" } };
new Function("window", "navigator", code)(win, win.navigator);
export const Vendor = win.Vendor;

export function lezerNodes(text: string): string[] {
  const tree = Vendor.markdownLanguage.parser.parse(text);
  const out: string[] = [];
  tree.iterate({ enter(n: any) { out.push(`${n.name}[${n.from},${n.to}]`); } });
  return out;
}
