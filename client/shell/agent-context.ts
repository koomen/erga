// What the editor tells your agent with each message (client/agent/person-agent.ts asks, window.ergaPage.agentContext):
// the page open, how it's seen, and the selection or the caret, so "this" and "here" mean something to it.

import type { Shell } from "./shell";

/** Where the user is in the document, so "this" and "here" mean something to the agent. */
export function editorContext(shell: Shell): string {
  const at = shell.addressOf(shell.info!.path).replace(/[?#].*$/, "");
  return `The user has the page ${shell.info!.path} open (${at}).\n${viewContext(shell)}\n${caretContext(shell)}`;
}
/** How the user sees the page: view_page renders at this size and in this mode unless asked otherwise. */
function viewContext(shell: Shell): string {
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const w = shell.frame.clientWidth, h = shell.frame.clientHeight;
  return `${w && h ? `Their window shows the page at ${w}×${h} CSS pixels` : "Their window shows the source, not the page"}, in ${scheme} mode.`;
}
function caretContext(shell: Shell): string {
  const s = shell.currentState();
  const sel = s.selection.main;
  const line = s.doc.lineAt(sel.from);
  if (!sel.empty) {
    const endLine = s.doc.lineAt(sel.to).number;
    const text = s.sliceDoc(sel.from, sel.to);
    return `The user has selected lines ${line.number}-${endLine} of ${shell.info!.name}:\n${text.length > 4000 ? text.slice(0, 4000) + "\n[...]" : text}`;
  }
  const text = line.text.length > 400 ? line.text.slice(0, 400) + "[...]" : line.text;
  return `The user's caret is on line ${line.number} of ${shell.info!.name}: ${text}`;
}

