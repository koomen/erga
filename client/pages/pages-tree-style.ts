// The pages tree's look (client/pages/pages-tree.ts): its icons, and its stylesheet, put in the page once.

export const ICONS = {
  page: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.75h6.25L18 8.5v10.75a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z"/><path d="M13 3.9V8.75h4.85"/><path d="M9 12.75h6M9 16h4" class="et-lines"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 7a1.5 1.5 0 0 1 1.5-1.5h3.9l2 2.25h7.6a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5Z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 17.25V7a1.5 1.5 0 0 1 1.5-1.5h3.9l2 2.25h6.6a1.5 1.5 0 0 1 1.5 1.5v1.5"/><path d="M3.9 18.1 6.4 11.6a1.5 1.5 0 0 1 1.4-.95h12.1a1 1 0 0 1 .93 1.36l-2.3 5.9a1.5 1.5 0 0 1-1.4.95H5.25a1.4 1.4 0 0 1-1.35-.76Z"/></svg>`,
  file: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.25h5l3.75 3.75v9.75H8Z"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.75 7.5 4.5 4.5-4.5 4.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v11M6.5 12h11"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="17.5" cy="12" r="1.25"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 18.5l.8-3.2 8.9-8.9a1.3 1.3 0 0 1 1.8 0l1.1 1.1a1.3 1.3 0 0 1 0 1.8l-8.9 8.9z"/></svg>`,
  newPage: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 20.25H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1h6.25L18 8.5V13"/><path d="M13 3.9V8.75h4.85M18 16v5M15.5 18.5h5"/></svg>`,
  newFolder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 18.75H5.25a1.5 1.5 0 0 1-1.5-1.5V7a1.5 1.5 0 0 1 1.5-1.5h3.9l2 2.25h7.6a1.5 1.5 0 0 1 1.5 1.5v3.25"/><path d="M18 15v5.5M15.25 17.75h5.5"/></svg>`,
};

export const STYLE = `
.et { position: relative; font: 13.5px/1.35 var(--font-text, "Inter", ui-sans-serif, system-ui, sans-serif); color: var(--fg); -webkit-font-smoothing: antialiased; }
.et [hidden] { display: none !important; }
.et-rows { display: flex; flex-direction: column; gap: 1px; }
.et-row { position: relative; display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 4px 0 calc(4px + var(--depth, 0) * 16px); border-radius: 7px;
  cursor: pointer; user-select: none; -webkit-user-select: none; outline: none; transition: background-color 120ms ease; }
.et-row:hover { background: color-mix(in srgb, var(--chrome) 11%, transparent); }
.et-row:focus-visible { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--caret) 70%, transparent); }
/* The guides: a hairline down each level, as the pages hang from their folder. */
.et-row::before { content: ""; position: absolute; top: 0; bottom: 0; left: calc(4px + var(--depth, 0) * 16px - 8.5px); border-left: 1px solid var(--rule); opacity: var(--guide, 0); pointer-events: none; }
.et-row[style*="--depth"] { --guide: 1; }
.et-twist { flex: none; display: grid; place-items: center; width: 16px; height: 16px; margin-right: -4px; color: var(--chrome); border-radius: 4px; transition: transform 140ms ease, color 120ms ease; }
.et-twist svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.et-row[aria-expanded="true"] > .et-twist { transform: rotate(90deg); }
.et-twist.none { visibility: hidden; }
.et-icon { flex: none; display: grid; place-items: center; width: 18px; height: 18px; color: var(--chrome); }
.et-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.et-icon .et-lines { opacity: 0.7; }
.et-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: none; }
.et-row.page .et-name { color: var(--fg-strong, var(--fg)); }
.et-row.folder .et-name { color: var(--fg); }
/* Files that aren't pages (a stylesheet, a script, an image) are there, quietly. */
/* Two pages that read the same: which file each is, quietly. */
.et-ext { flex: none; color: var(--chrome); font-size: 12px; }
/* The page you're on. */
.et-row[aria-current="page"] { background: color-mix(in srgb, var(--caret) 10%, transparent); }
.et-row[aria-current="page"] .et-icon { color: var(--caret); }
.et-row[aria-current="page"]:hover { background: color-mix(in srgb, var(--caret) 14%, transparent); }
.et-row.dragging { opacity: 0.45; }
.et-row.drop { background: color-mix(in srgb, var(--caret) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--caret) 55%, transparent); }
.et-row.busy { opacity: 0.55; pointer-events: none; }
/* A row's buttons: on hover or focus, always on touch. */
.et-acts { flex: none; display: flex; gap: 0; margin-right: -2px; opacity: 0; transition: opacity 120ms ease; }
.et-acts:empty { width: 24px; }
.et-row:hover .et-acts, .et-row:focus-within .et-acts, .et-row.menu-open .et-acts { opacity: 1; }
@media (hover: none) { .et-acts { opacity: 1; } }
.et-act { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--chrome); cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
.et-act:hover, .et-act[aria-expanded="true"] { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 16%, transparent); }
.et-act svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.et-act svg circle { fill: currentColor; stroke: none; }
/* Naming something new, or renaming. */
.et-row.editing { cursor: default; background: transparent; }
.et-input { flex: 1; min-width: 0; height: 24px; margin: 0 0 0 -3px; padding: 0 6px; border: 1px solid var(--caret); border-radius: 6px; outline: 2px solid color-mix(in srgb, var(--caret) 22%, transparent);
  background: var(--bg); color: var(--fg-strong, var(--fg)); font: inherit; }
.et-input::placeholder { color: var(--chrome); }
.et-msg { margin: 2px 4px 4px calc(4px + var(--depth, 0) * 16px + 22px); font-size: 12px; line-height: 1.4; color: var(--soft); }
.et-msg.error { color: #c2410c; }
.et-note { margin: 0; padding: 6px 4px 6px calc(4px + var(--depth, 0) * 16px + 26px); font-size: 12.5px; color: var(--soft); }
.et-banner { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 6px; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.4; color: #c2410c; background: color-mix(in srgb, #c2410c 9%, transparent); }
.et-banner span { flex: 1; }
.et-banner.note { color: var(--fg); background: color-mix(in srgb, var(--caret) 9%, transparent); }
.et-banner button { flex: none; padding: 0 2px; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
/* Delete a folder? Asked in its row. */
.et-row.confirm { cursor: default; background: color-mix(in srgb, #c2410c 8%, transparent); }
.et-row.confirm { padding-top: 4px; padding-bottom: 4px; flex-wrap: wrap; row-gap: 4px; }
.et-confirm { flex: 1 1 140px; min-width: 0; font-size: 12.5px; line-height: 1.35; color: var(--fg); }
.et-btn { flex: none; height: 24px; padding: 0 9px; border: 1px solid var(--rule); border-radius: 6px; background: transparent; color: var(--fg); font: 550 12px var(--font-text, inherit); cursor: pointer; }
.et-btn.danger { border-color: #c2410c; background: #c2410c; color: #fff; }
.et-btn:focus-visible, .et-add:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
/* New page, New folder: at the top level, under the rows. */
.et-foot { display: flex; gap: 4px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--rule); }
.et-add { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px 0 6px; border: 0; border-radius: 7px; background: transparent; color: var(--soft); font: 500 12.5px var(--font-text, inherit); cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
.et-add:hover { color: var(--fg-strong, var(--fg)); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
.et-add svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.et-foot.drop { background: color-mix(in srgb, var(--caret) 10%, transparent); border-radius: 7px; }
@media (pointer: coarse) { .et-row { min-height: 40px; } .et-act { width: 34px; height: 34px; } .et-add { height: 38px; } .et-input { height: 32px; font-size: 16px; } }
/* A row's menu: the avatar menu's look. */
.et-menu { position: fixed; z-index: 1000; min-width: 172px; max-width: min(280px, calc(100vw - 24px)); max-height: min(360px, calc(100vh - 24px)); overflow-y: auto; box-sizing: border-box; padding: 5px;
  font: 13px/1.3 var(--font-text, "Inter", ui-sans-serif, system-ui, sans-serif); color: var(--fg); background: var(--bg); border: 1px solid var(--panel-border, var(--rule)); border-radius: 11px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.05); animation: et-pop 120ms ease; }
@keyframes et-pop { from { opacity: 0; transform: translateY(-3px); } }
.et-menu [role="menuitem"] { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 6px 9px; padding-left: calc(9px + var(--depth, 0) * 14px); border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: pointer; outline: none; }
.et-menu [role="menuitem"] span { overflow: hidden; text-overflow: ellipsis; }
.et-menu [role="menuitem"]:hover, .et-menu [role="menuitem"]:focus-visible, .et-menu [role="menuitem"]:focus { background: color-mix(in srgb, var(--chrome) 14%, transparent); }
.et-menu [role="menuitem"].danger { color: #c2410c; }
.et-menu svg { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; color: var(--chrome); }
.et-menu .danger svg { color: currentColor; }
.et-menu hr { margin: 4px 6px; border: 0; border-top: 1px solid var(--rule); }
.et-menu .et-menu-head { margin: 0; padding: 5px 9px 6px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em; color: var(--soft); }
@media (pointer: coarse) { .et-menu [role="menuitem"] { padding-top: 10px; padding-bottom: 10px; } }
@media (prefers-reduced-motion: reduce) { .et-menu { animation: none; } .et-twist { transition: none; } }
`;
