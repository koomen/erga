// The editor's own styles in the page: its carets and layers, never the page's own look.

export const PAGE_STYLE = `
html { overscroll-behavior: none; }
body[contenteditable] { outline: none; }
[data-erga-text] { cursor: text; }
[data-erga-text].erga-empty { min-height: 1lh; }
[data-erga-text].erga-locked { cursor: default; }
[data-erga-text] [contenteditable="false"] { cursor: default; }
[data-erga-text] a[href] { cursor: text; }
/* An agent's new text that hasn't played yet (marks.ts, playTyping): there, unseen, until its typing gets to it. */
::highlight(erga-unshown) { color: transparent; text-decoration-color: transparent; }
/* Comments (comments.ts): drawn over the text, never written into it; the thread in use, stronger. */
::highlight(erga-comment) { background-color: rgba(250, 204, 21, 0.3); text-decoration: underline 2px #e0b100; }
::highlight(erga-comment-on) { background-color: rgba(250, 204, 21, 0.55); text-decoration: underline 2px #e0b100; }
erga-peers { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none; }
erga-peer-sel { all: initial; position: absolute; border-radius: 2px; }
erga-peer { all: initial; position: absolute; width: 2px; margin-left: -1px; background: var(--erga-peer); border-radius: 1px; }
erga-peer[data-agent] { background: repeating-linear-gradient(to bottom, var(--erga-peer) 0 3px, transparent 3px 5px); }
erga-peer-name {
  all: initial; position: absolute; left: -1px; bottom: 100%; margin-bottom: 1px; white-space: nowrap;
  font: 600 10.5px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff;
  background: var(--erga-peer); border-radius: 3px 3px 3px 0; padding: 0 5px; opacity: 0.92;
}
`;
