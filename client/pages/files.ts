// The files view (server/pages/files.ts): every file of a document or
// project as a tree, and the selected one shown as the browser shows it.
// It reads the list with the operation ls (server/operations/editor.ts), and hears the tree change
// over a socket of its own (<base>/api/room?watch=files: it never joins the
// room), so a file someone or an agent adds, moves or deletes shows at once.
// The files themselves come over HTTP: from the document's pages origin (a
// PDF, an image, a video: the browser shows them there), or as text from the
// document's own address.
//
// Whoever may edit adds files by dropping them, or folders, anywhere on the
// window (into the folder under the pointer, else the selected one), each
// with PUT <base>/api/files/<path> and a progress bar; a file with the same
// name is replaced, and the page says so ("Replaced 3 files"). Rows move by
// drag and drop onto a folder, rename in place (F2, or the pencil) and
// delete (a folder asks once): the operations mv and rm. Errors show where they happened, in the
// server's words.

import { readableSize, sha256Hex } from "../../shared/bytes";
import { baseName, encodePath, joinPath, parentOf } from "../../document/pages";
import { plural, timeAgo } from "../../shared/time";
import { esc } from "../../shared/html";
import { runTool } from "../common/tools";

interface FileRow { path: string; kind: "text" | "file"; size: number | null; at: number | null; type: string }
interface Listing { files: FileRow[]; folders: string[]; index: string; canEdit: boolean }

const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
const base = meta("erga-base");
const docId = meta("erga-doc");
const pages = meta("erga-pages");
const main = document.querySelector<HTMLElement>("main.files")!;
const treeEl = main.querySelector<HTMLUListElement>("ul.tree")!;
const statusEl = main.querySelector<HTMLElement>(".status")!;
const uploadsEl = main.querySelector<HTMLUListElement>("ul.uploads")!;
const viewEl = main.querySelector<HTMLElement>(".view-pane")!;
const dropEl = main.querySelector<HTMLElement>(".drop")!;

let listing: Listing = { files: [], folders: [], index: "index.html", canEdit: meta("erga-can-edit") == "1" };
/** The selected file or folder ("" is the top): at first, the one the address names (?files=<path>, a link from a project's page tree). */
let selected = new URLSearchParams(location.search).get("files") ?? "";
const collapsed = new Set<string>();
/** Something is being named or confirmed here: a change from elsewhere waits for it. */
let busy = false;
let stale = false;

const isFolder = (p: string) => p == "" || folderSet().has(p);

function folderSet(): Set<string> {
  const out = new Set(listing.folders);
  for (const f of listing.files) for (let d = parentOf(f.path); d; d = parentOf(d)) out.add(d);
  return out;
}

const SVG = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  chevron: SVG(`<path d="M9 6l6 6-6 6"/>`),
  folder: SVG(`<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`),
  file: SVG(`<path d="M7 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h4.5"/>`),
  image: SVG(`<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L20 17"/>`),
  page: SVG(`<path d="M7 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1z"/><path d="M9 12h6M9 15.5h6"/>`),
  rename: SVG(`<path d="M4.75 19.25l1-4L15.6 5.4a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8.75 18.25zM13.75 7.25l3 3"/>`),
  delete: SVG(`<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>`),
};

function iconOf(f: FileRow): string {
  if (/^image\//.test(f.type)) return ICON.image;
  if (/\.html?$/i.test(f.path)) return ICON.page;
  return ICON.file;
}

const when = (at: number | null) => (at ? timeAgo(at) : "");

// The times say how long ago, so they move on with the clock.
setInterval(() => {
  for (const t of document.querySelectorAll<HTMLTimeElement>("time[datetime]")) t.textContent = when(Date.parse(t.dateTime));
}, 15_000);

function say(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}

async function errorOf(r: Response): Promise<string> {
  const text = await r.text().catch(() => "");
  try { const j = JSON.parse(text) as { error?: string }; if (j.error) return j.error; } catch { /* plain text */ }
  return text.trim() || `The server answered ${r.status}.`;
}

// ---------------------------------------------------------------- the list

async function load(): Promise<void> {
  const r = await runTool<Omit<Listing, "files"> & { files: (Omit<FileRow, "at"> & { at: string | null })[] }>("ls", {
    document: docId,
  }).catch((e: Error) => e);
  if (r instanceof Error) {
    say(r.message, true);
    return;
  }
  listing = { ...r, files: r.files.map((f) => ({ ...f, at: f.at ? Date.parse(f.at) : null })) };
  main.setAttribute("aria-busy", "false");
  if (selected && !listing.files.some((f) => f.path == selected) && !isFolder(selected)) selected = "";
  render();
  if (!viewEl.dataset.path || viewEl.dataset.path != selected) show(selected);
}

let reloading: ReturnType<typeof setTimeout> | null = null;
/** The tree changed elsewhere: read it again soon (after whatever someone is doing here). */
function reloadSoon(): void {
  if (busy) { stale = true; return; }
  if (reloading) clearTimeout(reloading);
  reloading = setTimeout(() => { reloading = null; void load(); }, 150);
}

function render(): void {
  const folders = folderSet();
  const kids = (dir: string) => {
    const subdirs = [...folders].filter((d) => parentOf(d) == dir).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const files = listing.files.filter((f) => parentOf(f.path) == dir).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
    return { subdirs, files };
  };
  const build = (dir: string, level: number, into: HTMLUListElement) => {
    const { subdirs, files } = kids(dir);
    for (const d of subdirs) {
      const li = document.createElement("li");
      li.setAttribute("role", "none");
      li.append(row({ path: d, folder: true, level }));
      if (!collapsed.has(d)) {
        const ul = document.createElement("ul");
        ul.setAttribute("role", "group");
        build(d, level + 1, ul);
        li.append(ul);
      }
      into.append(li);
    }
    for (const f of files) {
      const li = document.createElement("li");
      li.setAttribute("role", "none");
      li.append(row({ path: f.path, folder: false, level, file: f }));
      into.append(li);
    }
  };
  const top = document.createElement("ul");
  build("", 1, top);
  treeEl.replaceChildren(...top.childNodes);
  if (!listing.files.length && !folders.size) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = listing.canEdit ? "No files yet." : "No files.";
    treeEl.append(li);
  }
}

function row(o: { path: string; folder: boolean; level: number; file?: FileRow }): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  el.setAttribute("role", "treeitem");
  el.setAttribute("aria-level", String(o.level));
  el.setAttribute("aria-selected", String(selected == o.path));
  el.dataset.path = o.path;
  el.dataset.type = o.folder ? "folder" : "file";
  el.tabIndex = selected == o.path ? 0 : -1;
  const twist = o.folder
    ? `<button type="button" class="twist" aria-label="${collapsed.has(o.path) ? "Open" : "Close"} ${esc(baseName(o.path))}" aria-expanded="${!collapsed.has(o.path)}">${ICON.chevron}</button>`
    : `<span></span>`;
  const icon = `<span class="icon">${o.folder ? ICON.folder : iconOf(o.file!)}</span>`;
  const size = o.file ? `<span class="size">${o.file.size == null ? "" : readableSize(o.file.size)}</span>` : `<span></span>`;
  const time = o.file?.at ? `<time datetime="${new Date(o.file.at).toISOString()}" title="${esc(new Date(o.file.at).toLocaleString())}">${esc(when(o.file.at))}</time>` : `<span></span>`;
  const mine = listing.canEdit && o.path != listing.index;
  const acts = mine
    ? `<span class="acts"><button type="button" class="rename" aria-label="Rename ${esc(baseName(o.path))}" title="Rename">${ICON.rename}</button><button type="button" class="delete" aria-label="Delete ${esc(baseName(o.path))}" title="Delete">${ICON.delete}</button></span>`
    : `<span></span>`;
  el.innerHTML = `${twist}${icon}<span class="name" title="${esc(o.path)}">${esc(baseName(o.path))}</span>${size}${time}${acts}`;
  if (mine) el.draggable = true;
  return el;
}

function select(path: string): void {
  selected = path;
  for (const el of treeEl.querySelectorAll<HTMLElement>(".row")) {
    const on = el.dataset.path == path;
    el.setAttribute("aria-selected", String(on));
    el.tabIndex = on ? 0 : -1;
  }
  show(path);
}

// ---------------------------------------------------------------- the viewer

function show(path: string): void {
  const f = listing.files.find((x) => x.path == path);
  viewEl.dataset.path = path;
  if (!f) {
    viewEl.innerHTML = `<p class="nothing">${path ? `${esc(baseName(path))}: a folder. ` : ""}Select a file to see it here.</p>`;
    return;
  }
  const url = pages + encodePath(f.path);
  const about =
    [f.size == null ? "" : readableSize(f.size), f.type].filter(Boolean).map(esc).join(" · ") +
    (f.at ? ` · changed <time datetime="${new Date(f.at).toISOString()}">${esc(when(f.at))}</time>` : "");
  viewEl.innerHTML = `<div class="view-head"><h2 title="${esc(f.path)}">${esc(f.path)}</h2><span class="about">${about}</span><a href="${esc(url)}" target="_blank" rel="noopener">Open in a new tab</a></div><div class="view-body"></div>`;
  const body = viewEl.querySelector<HTMLElement>(".view-body")!;
  if (/^image\//.test(f.type)) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = baseName(f.path);
    body.append(img);
  } else if (/^video\//.test(f.type)) {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.preload = "metadata";
    body.append(v);
  } else if (/^audio\//.test(f.type)) {
    const a = document.createElement("audio");
    a.src = url;
    a.controls = true;
    body.append(a);
  } else if (f.type == "application/pdf") {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = baseName(f.path);
    body.append(frame);
  } else if (f.kind == "text" || /^text\//.test(f.type) || f.type == "application/json" || f.type == "image/svg+xml") {
    const pre = document.createElement("pre");
    pre.textContent = "…";
    body.append(pre);
    void fetch(`${base}/doc/${encodePath(f.path)}`, { cache: "no-store" }).then(async (r) => {
      if (viewEl.dataset.path != path) return;
      pre.textContent = r.ok ? await r.text() : await errorOf(r);
    });
  } else {
    body.innerHTML = `<div class="other"><p>${esc(baseName(f.path))}</p><p>${esc(about)}</p><p>The browser can't show this kind of file here. <a href="${esc(url)}" target="_blank" rel="noopener">Open it</a> to download it.</p></div>`;
  }
}

// ---------------------------------------------------------------- tree operations

/** Each change's operation (server/operations/editor.ts). */
const TOOLS: Record<string, string> = { new_page: "new_page", new_folder: "mkdir", move: "mv", delete: "rm" };

async function treeOp(op: Record<string, string>): Promise<string | null> {
  const { op: name, ...args } = op;
  return runTool(TOOLS[name] ?? name, { document: docId, ...args }).then(
    () => null,
    (e: Error) => e.message
  );
}

function rowError(el: HTMLElement, text: string): void {
  el.parentElement?.querySelector(":scope > .row-error")?.remove();
  const p = document.createElement("p");
  p.className = "row-error";
  p.setAttribute("role", "alert");
  p.textContent = text;
  el.after(p);
}

function rename(el: HTMLElement): void {
  const path = el.dataset.path!;
  const name = el.querySelector<HTMLElement>(".name")!;
  const input = document.createElement("input");
  input.value = baseName(path);
  input.setAttribute("aria-label", `New name for ${baseName(path)}`);
  name.replaceChildren(input);
  busy = true;
  input.focus();
  // The name before the extension, ready to type over.
  const dot = input.value.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 && el.dataset.type == "file" ? dot : input.value.length);
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const to = joinPath(parentOf(path), input.value.trim());
    if (!save || input.value.trim() == baseName(path)) {
      busy = false;
      render();
      afterBusy();
      return;
    }
    const bad = checkName(input.value.trim());
    if (bad) { done = false; rowError(el, bad); input.focus(); return; }
    const err = await treeOp({ op: "move", from: path, to });
    busy = false;
    if (err) { render(); rowError(treeEl.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(path)}"]`) ?? treeEl, err); afterBusy(); return; }
    if (selected == path) selected = to;
    say(`Renamed ${baseName(path)} to ${baseName(to)}.`);
    await load();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key == "Enter") { e.preventDefault(); void finish(true); }
    else if (e.key == "Escape") { e.preventDefault(); void finish(false); }
  });
  input.addEventListener("blur", () => void finish(true));
}

export function checkName(name: string): string | null {
  if (!name) return "Give it a name.";
  if (/[\/\\]/.test(name)) return "A name can't have / or \\ in it.";
  if (name.startsWith(".")) return "A name can't start with a dot.";
  if (/[\x00-\x1f\x7f]/.test(name)) return "That name has characters it can't have.";
  return null;
}

async function remove(el: HTMLElement): Promise<void> {
  const path = el.dataset.path!;
  if (el.dataset.type == "folder") {
    // A folder asks once, in place.
    const inside = listing.files.filter((f) => f.path.startsWith(path + "/")).length;
    el.parentElement?.querySelector(":scope > .confirm")?.remove();
    const box = document.createElement("div");
    box.className = "confirm";
    box.innerHTML = `<span>Delete ${esc(baseName(path))} and the ${plural(inside, "file")} in it?</span><button type="button" class="danger">Delete</button><button type="button" class="cancel">Cancel</button>`;
    el.after(box);
    busy = true;
    box.querySelector<HTMLButtonElement>(".cancel")!.onclick = () => { box.remove(); busy = false; afterBusy(); };
    box.querySelector<HTMLButtonElement>(".danger")!.focus();
    box.querySelector<HTMLButtonElement>(".danger")!.onclick = async () => {
      box.remove();
      busy = false;
      const err = await treeOp({ op: "delete", path });
      if (err) { rowError(el, err); return; }
      if (selected == path || selected.startsWith(path + "/")) selected = parentOf(path);
      say(`Deleted ${baseName(path)} and the ${plural(inside, "file")} in it. They stay in the versions.`);
      await load();
    };
    return;
  }
  const err = await treeOp({ op: "delete", path });
  if (err) { rowError(el, err); return; }
  if (selected == path) selected = parentOf(path);
  say(`Deleted ${baseName(path)}. It stays in the versions.`);
  await load();
}

function afterBusy(): void {
  if (stale) { stale = false; reloadSoon(); }
}

treeEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>(".row");
  if (!el || busy) return;
  const path = el.dataset.path!;
  if (t.closest(".twist")) {
    if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
    render();
    return;
  }
  if (t.closest(".rename")) return rename(el);
  if (t.closest(".delete")) return void remove(el);
  select(path);
});

treeEl.addEventListener("keydown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!el || busy || (e.target as HTMLElement).tagName == "INPUT") return;
  const rows = [...treeEl.querySelectorAll<HTMLElement>(".row")];
  const i = rows.indexOf(el);
  const go = (to: HTMLElement | undefined) => { if (to) { select(to.dataset.path!); to.focus(); } e.preventDefault(); };
  if (e.key == "ArrowDown") go(rows[i + 1]);
  else if (e.key == "ArrowUp") go(rows[i - 1]);
  else if (e.key == "Home") go(rows[0]);
  else if (e.key == "End") go(rows[rows.length - 1]);
  else if (e.key == "ArrowRight" && el.dataset.type == "folder" && collapsed.has(el.dataset.path!)) { collapsed.delete(el.dataset.path!); render(); treeEl.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(el.dataset.path!)}"]`)?.focus(); e.preventDefault(); }
  else if (e.key == "ArrowLeft" && el.dataset.type == "folder" && !collapsed.has(el.dataset.path!)) { collapsed.add(el.dataset.path!); render(); treeEl.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(el.dataset.path!)}"]`)?.focus(); e.preventDefault(); }
  else if (e.key == "F2" && listing.canEdit && el.dataset.path != listing.index) { e.preventDefault(); rename(el); }
  else if ((e.key == "Delete" || e.key == "Backspace") && listing.canEdit && el.dataset.path != listing.index) { e.preventDefault(); void remove(el); }
});

// ---------------------------------------------------------------- drag and drop

const ROW_TYPE = "application/x-erga-path";
const fromOutside = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
const fromHere = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes(ROW_TYPE);

/** The folder a drop at this event goes into: the folder row under it, a file row's folder, else the selected folder. */
function dropFolder(e: DragEvent): string {
  const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".row");
  if (el) return el.dataset.type == "folder" ? el.dataset.path! : parentOf(el.dataset.path!);
  return isFolder(selected) ? selected : parentOf(selected);
}

function markTarget(folder: string | null): void {
  for (const el of treeEl.querySelectorAll<HTMLElement>(".row.target")) el.classList.remove("target");
  if (folder) treeEl.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(folder)}"]`)?.classList.add("target");
}

treeEl.addEventListener("dragstart", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!el || !listing.canEdit || !e.dataTransfer) return;
  e.dataTransfer.setData(ROW_TYPE, el.dataset.path!);
  e.dataTransfer.effectAllowed = "move";
});

let depth = 0;
window.addEventListener("dragenter", (e) => {
  if (!listing.canEdit || !(fromOutside(e) || fromHere(e))) return;
  depth++;
  if (fromOutside(e)) dropEl.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--depth <= 0) { depth = 0; dropEl.hidden = true; markTarget(null); }
});
window.addEventListener("dragover", (e) => {
  if (!listing.canEdit || !(fromOutside(e) || fromHere(e))) return;
  e.preventDefault();
  const folder = dropFolder(e);
  dropEl.querySelector(".drop-to")!.textContent = folder || "the top folder";
  markTarget(folder);
  if (e.dataTransfer) e.dataTransfer.dropEffect = fromHere(e) ? "move" : "copy";
});
window.addEventListener("drop", (e) => {
  depth = 0;
  dropEl.hidden = true;
  markTarget(null);
  if (!listing.canEdit || !e.dataTransfer) return;
  e.preventDefault();
  const folder = dropFolder(e);
  const moving = e.dataTransfer.getData(ROW_TYPE);
  if (moving) return void move(moving, folder);
  if (fromOutside(e)) void dropped(e.dataTransfer, folder);
});

async function move(from: string, folder: string): Promise<void> {
  const to = joinPath(folder, baseName(from));
  if (to == from || folder == from || folder.startsWith(from + "/")) return;
  const err = await treeOp({ op: "move", from, to });
  if (err) { say(err, true); return; }
  if (selected == from) selected = to;
  say(`Moved ${baseName(from)} to ${folder || "the top folder"}.`);
  await load();
}

/** The files a drop brings, folders read through (webkitGetAsEntry), each with its path under the drop's folder. */
async function droppedFiles(data: DataTransfer, folder: string): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  const entries = [...data.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  if (!entries.length) {
    for (const file of data.files) out.push({ path: joinPath(folder, file.name), file });
    return out;
  }
  const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
    if (entry.name.startsWith(".")) return;
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      out.push({ path: joinPath(dir, entry.name), file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const child of batch) await walk(child, joinPath(dir, entry.name));
    }
  };
  for (const entry of entries) await walk(entry, folder);
  return out;
}

/** Files over this size are sent with their sha-256, so they stream to storage (the server asks for it over 25 MB). */
const HASH_FROM = 20_000_000;

function send(path: string, file: File, hash: string | null, progress: (sent: number) => void): Promise<{ ok: boolean; replaced?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${base}/api/files/${encodePath(path)}`);
    if (hash) xhr.setRequestHeader("x-erga-sha256", hash);
    xhr.upload.onprogress = (e) => progress(e.loaded);
    xhr.onload = () => {
      let body: { ok?: boolean; replaced?: boolean; error?: string } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      resolve(xhr.status >= 200 && xhr.status < 300 ? { ok: true, replaced: !!body.replaced } : { ok: false, error: body.error ?? (xhr.responseText.trim() || `The server answered ${xhr.status}.`) });
    };
    xhr.onerror = () => resolve({ ok: false, error: "Couldn't reach the server." });
    xhr.send(file);
  });
}

async function dropped(data: DataTransfer, folder: string): Promise<void> {
  const files = await droppedFiles(data, folder);
  if (!files.length) return;
  say(`Adding ${plural(files.length, "file")}…`);
  let added = 0, replaced = 0, failed = 0;
  const queue = [...files];
  const one = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="what"></span><span class="pct"></span>`;
      li.querySelector(".what")!.textContent = item.path;
      const bar = document.createElement("progress");
      bar.max = item.file.size || 1;
      bar.value = 0;
      if (item.file.size > 1_000_000) li.append(bar);
      uploadsEl.append(li);
      const pct = li.querySelector<HTMLElement>(".pct")!;
      const hash = item.file.size > HASH_FROM ? ((pct.textContent = "reading…"), await sha256Hex(await item.file.arrayBuffer())) : null;
      const r = await send(item.path, item.file, hash, (sent) => {
        bar.value = sent;
        pct.textContent = `${Math.round((100 * sent) / (item!.file.size || 1))}%`;
      });
      if (r.ok) {
        if (r.replaced) replaced++; else added++;
        li.remove();
      } else {
        failed++;
        li.classList.add("failed");
        pct.textContent = "";
        li.querySelector(".what")!.textContent = `${item.path}: ${r.error}`;
        bar.remove();
      }
    }
  };
  await Promise.all([one(), one(), one()]);
  const parts = [
    added ? `Added ${plural(added, "file")}.` : "",
    replaced ? `Replaced ${plural(replaced, "file")} (the old ones stay in the versions).` : "",
    failed ? `${failed} couldn't be added: see below.` : "",
  ];
  say(parts.filter(Boolean).join(" "), failed > 0);
  await load();
}

// ---------------------------------------------------------------- live

function watch(delay = 1000): void {
  const ws = new WebSocket(`${location.protocol == "https:" ? "wss" : "ws"}://${location.host}${base}/api/room?watch=files`);
  let opened = false;
  ws.onopen = () => { opened = true; };
  ws.onmessage = (e) => {
    if (typeof e.data != "string") return;
    try { const m = JSON.parse(e.data) as { type?: string }; if (m.type == "tree" || m.type == "versions") reloadSoon(); } catch { /* a pong */ }
  };
  ws.onclose = (e) => {
    if (e.code == 4404) { say("This document was deleted.", true); return; }
    // Back: read the list again (what changed meanwhile), and listen again.
    setTimeout(() => { if (opened) reloadSoon(); watch(opened ? 1000 : Math.min(delay * 2, 30_000)); }, opened ? 500 : delay);
  };
}

void load();
watch();
