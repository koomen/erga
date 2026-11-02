// The editor's own styles in the page: its carets, marks and layers, never the page's own look.

export const PAGE_STYLE = `
html { overscroll-behavior: none; }
body[contenteditable] { outline: none; }
[data-erga-text] { cursor: text; }
[data-erga-text].erga-empty { min-height: 1lh; }
[data-erga-text].erga-locked { cursor: default; }
[data-erga-text] [contenteditable="false"] { cursor: default; }
[data-erga-text] a[href] { cursor: text; }
@keyframes erga-flash { from { background-color: rgba(59, 124, 240, 0.24); } to { background-color: rgba(59, 124, 240, 0); } }
[data-erga-text].erga-flash { animation: erga-flash 1.8s ease-out; border-radius: 3px; }
::highlight(erga-add-0) { background-color: rgba(34, 197, 94, 0.3); }
::highlight(erga-add-1) { background-color: rgba(34, 197, 94, 0.24); }
::highlight(erga-add-2) { background-color: rgba(34, 197, 94, 0.18); }
::highlight(erga-add-3) { background-color: rgba(34, 197, 94, 0.12); }
::highlight(erga-add-4) { background-color: rgba(34, 197, 94, 0.07); }
::highlight(erga-add-5) { background-color: rgba(34, 197, 94, 0.03); }
erga-peers { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none; }
erga-peer-sel { all: initial; position: absolute; border-radius: 2px; }
erga-peer { all: initial; position: absolute; width: 2px; margin-left: -1px; background: var(--erga-peer); border-radius: 1px; }
erga-peer[data-agent] { background: repeating-linear-gradient(to bottom, var(--erga-peer) 0 3px, transparent 3px 5px); }
erga-peer-name {
  all: initial; position: absolute; left: -1px; bottom: 100%; margin-bottom: 1px; white-space: nowrap;
  font: 600 10.5px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff;
  background: var(--erga-peer); border-radius: 3px 3px 3px 0; padding: 0 5px; opacity: 0.92;
}
erga-marks { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
erga-del { all: initial; position: absolute; width: 2px; margin-left: -1px; background: var(--erga-del, #e5484d); border-radius: 1px; pointer-events: auto; cursor: help; transition: opacity 120ms linear; }
erga-del::before { content: ""; position: absolute; top: -5px; left: -3px; border: 4px solid transparent; border-top-color: var(--erga-del, #e5484d); border-bottom: 0; }
erga-del::after { content: ""; position: absolute; inset: -6px -5px -2px; }
erga-tip {
  all: initial; display: none; position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%);
  font: 500 12px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #b42318;
  background: #fee4e2; border: 1px solid #fecdca; border-radius: 5px; padding: 1px 6px;
  text-decoration: line-through; text-decoration-color: rgba(180, 35, 24, 0.6);
  white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
}
erga-del:hover erga-tip { display: block; }
erga-who { all: initial; display: inline-block; font: 600 11px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; margin-right: 6px; text-decoration: none; }
`;
