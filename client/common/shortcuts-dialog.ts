// Keyboard shortcuts: a dialog on every page of someone signed in, loaded the first time it's asked for. The quick
// search's "Keyboard shortcuts" opens it (a link to "#shortcuts": client/agent/person-agent.ts), and ⌘/ does while
// editing (client/shell/main.ts). It lists the editor's keys and its Markdown. The browser's own modal dialog: Esc, the
// ✕ or a click outside it closes it, and the focus goes back where it was. No bar has a button for it.

import { isMac } from "./app-keys";

let dialog: HTMLDialogElement | null = null;

/** Opens the dialog (made the first time), or closes it when it's open. */
export function toggleShortcuts(): void {
  dialog ??= make();
  if (dialog.open) dialog.close();
  else dialog.showModal();
}

function make(): HTMLDialogElement {
  document.head.insertAdjacentHTML("beforeend", `<style>${STYLE}</style>`);
  const d = document.createElement("dialog");
  d.id = "erga-shortcuts";
  d.setAttribute("aria-labelledby", "erga-shortcuts-title");
  d.innerHTML = `<header><h2 id="erga-shortcuts-title">Keyboard shortcuts</h2><button type="button" class="close" aria-label="Close">✕</button></header>
<div class="keys"><dl>
<dt>Bold</dt><dd><kbd>⌘</kbd><kbd>B</kbd></dd>
<dt>Italic</dt><dd><kbd>⌘</kbd><kbd>I</kbd></dd>
<dt>Code</dt><dd><kbd>⌘</kbd><kbd>E</kbd></dd>
<dt>Link</dt><dd><kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd></dd>
<dt>Clear formatting</dt><dd><kbd>⌘</kbd><kbd>\\</kbd></dd>
<dt>Comment</dt><dd><kbd>⌘</kbd><kbd>⌥</kbd><kbd>M</kbd></dd>
<dt>Insert a block</dt><dd><kbd>/</kbd></dd>
<dt>Heading</dt><dd><kbd>#</kbd> to <kbd>######</kbd></dd>
<dt>List</dt><dd><kbd>-</kbd> or <kbd>1.</kbd></dd>
<dt>To-do</dt><dd><kbd>[ ]</kbd></dd>
<dt>Quote</dt><dd><kbd>&gt;</kbd></dd>
<dt>Code block</dt><dd><kbd>\`\`\`</kbd> <kbd>Enter</kbd></dd>
<dt>Divider</dt><dd><kbd>---</kbd> <kbd>Enter</kbd></dd>
<dt>Indent a list item</dt><dd><kbd>Tab</kbd> / <kbd>⇧</kbd><kbd>Tab</kbd></dd>
<dt>New paragraph</dt><dd><kbd>Enter</kbd></dd>
<dt>Line break</dt><dd><kbd>⇧</kbd><kbd>Enter</kbd></dd>
<dt>Undo / redo</dt><dd><kbd>⌘</kbd><kbd>Z</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Z</kbd></dd>
<dt>Leave text</dt><dd><kbd>Esc</kbd></dd>
<dt>Open or close the editor</dt><dd><kbd>⌘</kbd><kbd>⇧</kbd><kbd>E</kbd></dd>
<dt>Agent</dt><dd><kbd>⌘</kbd><kbd>J</kbd></dd>
<dt>Go to a document or page</dt><dd><kbd>⌘</kbd><kbd>K</kbd></dd>
<dt>Zoom</dt><dd><kbd>⌘</kbd><kbd>+</kbd> <kbd>⌘</kbd><kbd>−</kbd> <kbd>⌘</kbd><kbd>0</kbd></dd>
<dt>Print</dt><dd><kbd>⌘</kbd><kbd>P</kbd></dd>
<dt>This list</dt><dd><kbd>⌘</kbd><kbd>/</kbd></dd>
</dl>
<p>Type the Markdown at the start of a line, then a space (a heading, a list, a to-do, a quote); <kbd>\`\`\`</kbd> and <kbd>---</kbd> alone on a line, then Enter. In a line: **bold**, *italic*, \`code\`. Select text for the style bar. ⌘-click a link to open it.</p>
<p>Others who edit the page show as carets with their names. ⌘Z only undoes your own edits; the agent panel has its own undo for your agent's.</p></div>`;
  // Another system's names for the keys.
  if (!isMac)
    for (const k of d.querySelectorAll("kbd")) {
      if (k.textContent == "⌘") k.textContent = "Ctrl";
      else if (k.textContent == "⌥") k.textContent = "Alt";
      else if (k.textContent == "⇧") k.textContent = "Shift";
    }
  document.body.append(d);
  d.querySelector(".close")!.addEventListener("click", () => d.close());
  // A click on the backdrop (the dialog itself, outside its content) closes it.
  d.addEventListener("click", (e) => {
    if (e.target == d) d.close();
  });
  return d;
}

// (kbd's look is every page's: client/style.css.)
const STYLE = `
#erga-shortcuts { width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 0; border: 1px solid var(--panel-border); border-radius: 14px;
  overscroll-behavior: contain; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font: 13.5px/1.5 var(--font-text); }
#erga-shortcuts::backdrop { background: rgba(0, 0, 0, 0.25); }
#erga-shortcuts header { position: sticky; top: 0; margin: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px;
  border-bottom: 1px solid var(--rule); background: var(--bg); }
#erga-shortcuts h2 { margin: 0; font-size: 18px; color: var(--fg-strong); }
#erga-shortcuts .close { border: 0; background: none; color: var(--chrome); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
#erga-shortcuts .close:hover { color: var(--chrome-hover); background: var(--code-bg); }
#erga-shortcuts .keys { padding: 16px 20px; }
#erga-shortcuts dl { display: grid; grid-template-columns: 1fr auto; gap: 5px 12px; margin: 0; }
#erga-shortcuts dt { color: var(--soft); }
#erga-shortcuts dd { margin: 0; display: flex; gap: 3px; align-items: center; color: var(--soft); }
#erga-shortcuts p { margin: 14px 0 0; color: var(--soft); font-size: 12.5px; }
`;
