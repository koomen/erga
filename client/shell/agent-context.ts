// What the editor tells your agent with each message (client/agent/person-agent.ts asks, window.ergaPage.agentContext):
// the page open, how it's seen, the selection or the caret, and the problems the alerts' card shows, so "this", "here"
// and "the error" mean something to it. And, while the server asks for it (the setting feedback_context), what a
// feedback keeps when the agent sends one (window.ergaPage.feedbackContext, shared/feedback-context.ts): the same,
// with the page's HTML near the caret and the keys pressed last.

import { isMac } from "../common/app-keys";
import { type FeedbackContext, lookSteps, type Pressed, pressedWith, sourceNear } from "../../shared/feedback-context";
import { pageReport } from "../../shared/page-report";
import { plural } from "../../shared/time";
import type { Shell } from "./shell";

/** The most problems a message's note names: page_log's console has each. */
const MOST = 8;

/**
 * What goes with a message that the person types: where they are, and each problem the alerts' card shows them now,
 * in the card's words (client/common/alerts.ts), as data (shared/page-report.ts).
 */
export function messageContext(shell: Shell): string {
  const said = shell.alerts.said();
  if (!said.length) return editorContext(shell);
  const more = said.length > MOST ? ` (the first ${MOST} are here; page_log's console has each)` : "";
  return `${editorContext(shell)}\nThe editor shows the user ${plural(said.length, "problem")} now${more}, each in a page-report as they read it:\n${said.slice(0, MOST).map(pageReport).join("\n")}`;
}

/** Where the user is in the document, so "this" and "here" mean something to the agent. */
export function editorContext(shell: Shell): string {
  const at = shell.addressOf(shell.pagePath).replace(/[?#].*$/, "");
  return `The user has the page ${shell.pagePath} open (${at}).\n${viewContext(shell)}\n${caretContext(shell)}`;
}
/** How the user sees the page: the size and mode to give view_page to see it as they do. */
function viewContext(shell: Shell): string {
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const w = shell.frame.clientWidth, h = shell.frame.clientHeight;
  return `Their window shows the page${w && h ? ` at ${w}×${h} CSS pixels` : ""}, in ${scheme} mode.`;
}
function caretContext(shell: Shell): string {
  const s = shell.currentState();
  const sel = s.selection.main;
  const line = s.doc.lineAt(sel.from);
  if (!sel.empty) {
    const endLine = s.doc.lineAt(sel.to).number;
    const text = s.sliceDoc(sel.from, sel.to);
    return `The user has selected lines ${line.number}-${endLine} of ${shell.pagePath}:\n${text.length > 4000 ? text.slice(0, 4000) + "\n[...]" : text}`;
  }
  const text = line.text.length > 400 ? line.text.slice(0, 400) + "[...]" : line.text;
  return `The user's caret is on line ${line.number} of ${shell.pagePath}: ${text}`;
}

/** The keys pressed last in the page, oldest first (the page says each: client/inline/reader.ts). */
let pressed: Pressed[] = [];
export function keyPressed(key: Pressed): void {
  pressed = pressedWith(pressed, key);
}

/** What a feedback keeps of the page, if the agent sends one for the message that this goes with. */
export function feedbackContext(shell: Shell): FeedbackContext {
  const s = shell.currentState();
  const w = shell.frame.clientWidth,
    h = shell.frame.clientHeight;
  return {
    page: new URL(shell.addressOf(shell.pagePath), location.href).pathname,
    file: shell.pagePath,
    ...sourceNear(s.doc.toString(), s.selection.main.head),
    keys: lookSteps(pressed, isMac),
    view: `${w}×${h} CSS pixels, ${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"} mode`,
    problems: shell.alerts.said(),
  };
}
