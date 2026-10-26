// The documents list page (/docs): a person's documents, latest edit first.

import type { Listed, Session } from "../platform.ts";
import { asset } from "./assets.ts";
import { fastClickScript } from "../../shared/fast-click.ts";
import { appPage, crumbs, esc, ICON, link, TIMES_SCRIPT, withEdit } from "./chrome.ts";
import { editorScripts } from "./viewer.ts";

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "12 days ago", or the date (the page's script redoes it in the reader's zone). */
export function ago(t: number, now: number): string {
  const min = Math.round((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min == 1 ? "" : "s"} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours == 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days == 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Who a document is shared with, as its row in the list says it (the owner's own view). */
function sharedNote(d: Listed): string {
  if (!d.shared) return "";
  return `<span class="note shared" title="Shared with ${d.shared} besides you">Shared</span>`;
}

/** The documents view: yours and those shared with you, with new, open, share and delete. */
export function docsPage(session: Session, docs: Listed[], now: number, hours: number | null): string {
  const rows = docs.map((d) => {
    const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
    const mine = d.role == "owner";
    const note = !mine ? `<span class="note" title="Shared with you by ${esc(d.owner)}">${esc(d.owner)} · ${d.role == "editor" ? "can edit" : "view only"}</span>`
      : d.path != null ? `<span class="note" title="${esc(d.path)}">On disk</span>`
      : left != null ? `<span class="note" title="${hours == null ? "Made when unedited documents were deleted: it still goes unless someone edits it" : `A document nobody edits is deleted ${hours} hours after it's made`}">Unedited · deleted in ${left}h</span>` : "";
    const when = new Date(d.modified).toISOString();
    // One opened from disk only comes off the list: its files stay where they are.
    const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
    // A project's row opens to its pages (the chevron); a document has one page, so its row has none (one from
    // before kinds that hasn't opened since has it, as before).
    const twist = d.kind == "document" ? `<span class="twist none" aria-hidden="true"></span>`
      : `<button type="button" class="twist" aria-expanded="false" aria-controls="pages-${esc(d.id)}" aria-label="Pages of ${esc(d.title)}" data-tip="Pages" data-id="${esc(d.id)}" data-base="/${esc(d.owner)}/${esc(d.slug)}" data-title="${esc(d.title)}"${d.role == "viewer" ? "" : " data-edit"}>${ICON.chevron}</button>`;
    // The whole row opens the document (the link stretches over it); its buttons sit on top.
    return `  <li>
    <div class="name">${twist}<a class="doc" href="${esc(withEdit(link(`/${d.owner}/${d.slug}`, session)))}"><span class="title">${esc(d.title)}</span></a>${d.kind == "project" ? `<span class="note kind" title="A folder of pages, each with its own address">Project</span>` : ""}${note}${mine ? sharedNote(d) : ""}</div>
    <time datetime="${when}">${ago(d.modified, now)}</time>
    <div class="acts">${mine ? `<button type="button" class="act share" aria-label="Share ${esc(d.title)}" data-tip="Share" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-address="/${esc(d.owner)}/${esc(d.slug)}">${ICON.share}</button>
    <form method="post" action="${esc(link("/docs/delete", session))}" data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="act delete" aria-label="${label}" data-tip="${remove}">${ICON.delete}</button></form>` : ""}</div>
  </li>`;
  }).join("\n");
  const style = `
  /* Rows, and the labels over them, in three columns: the name (its title and what's special about it), when it was edited, its buttons. */
  .labels, ol.rows > li { display: grid; grid-template-columns: minmax(0, 1fr) 10rem 64px; align-items: center; column-gap: 16px; }
  .labels { padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 12px; font-weight: 500; color: var(--chrome); }
  ol.rows > li { position: relative; }
  /* No rules between documents: only the one under the labels. */
  ol.rows > li, ol.rows > li:first-child { border: 0; }
  ol.rows { padding-top: 6px; }
  .name { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 11px 0; }
  .doc { flex: 0 1 auto; padding: 0; }
  .doc::after { content: ""; position: absolute; inset: 0; }
  .acts { position: relative; z-index: 1; }
  .name { gap: 12px; }
  /* A document's pages (pages-tree.js, loaded once the list is up): the chevron left of its title opens them beneath its row. */
  .twist { position: relative; z-index: 1; flex: none; display: grid; place-items: center; width: 22px; height: 22px; margin: 0 -8px 0 -4px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--chrome); cursor: pointer; transition: color 120ms ease, background-color 120ms ease; }
  .twist svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform 150ms ease; }
  .twist:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .twist[aria-expanded="true"] svg { transform: rotate(90deg); }
  .twist.none, .twist.none:hover { background: none; cursor: default; }
  .twist:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  .labels span:first-child { padding-left: 22px; }
  ol.rows > li.sub { display: block; padding: 0 0 10px 18px; }
  ol.rows > li.sub[hidden] { display: none; }
  .sub-tree { max-width: 560px; }
  .sub-tree.error { margin: 0; font-size: 13px; color: #c2410c; }
  /* Before the tree's script runs: a quiet line where its rows go, faded in only if it lasts. */
  .sub-wait { margin: 0; padding: 6px 4px 6px 26px; font-size: 12.5px; color: var(--soft); animation: sub-wait 150ms 120ms both; }
  @keyframes sub-wait { from { opacity: 0; } }
  @media (pointer: coarse) { .twist { width: 34px; height: 34px; margin: 0 -10px 0 -10px; } }
  .title { transition: color 120ms ease; }
  li:hover .title { color: var(--link); }
  .note, .shared { padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--soft); background: color-mix(in srgb, var(--chrome) 13%, transparent); }
  time { margin: 0; text-align: left; }
  /* The buttons (only on your own documents) take the same room on every row, so the times line up. */
  .acts { display: flex; justify-content: flex-end; gap: 2px; }
  /* Help text on the buttons, as the editor's: plain, under the pointer, following it (server/account-menu.ts moves it). */
  .acts .act { position: relative; }
  .acts .act[data-tip]::after { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); z-index: 40;
    white-space: pre; font: 400 12px/1.3 var(--font-text); letter-spacing: 0.01em; color: var(--soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .acts .act[data-tip]:hover::after { opacity: 1; } }
  @media (pointer: coarse) { .labels, ol.rows > li { grid-template-columns: minmax(0, 1fr) 8rem 84px; } }
  @media (max-width: 520px) { .labels { display: none; } .labels, ol.rows > li { grid-template-columns: minmax(0, 1fr) auto 64px; } }
  @media (pointer: coarse) { .delete { margin-right: -6px; } }
  /* Sharing: who has it, anyone with the link, and adding someone. */
  #share { width: min(460px, calc(100vw - 32px)); }
  #share .add { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
  #share .add .field { flex: 1; margin: 0; }
  .people { list-style: none; margin: 0 0 14px; padding: 0; max-height: 40vh; overflow: auto; }
  .people li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--rule); }
  .people li:last-child { border-bottom: 1px solid var(--rule); }
  .people .face { position: relative; flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; overflow: hidden; font-size: 12px; font-weight: 600; color: var(--soft); background: color-mix(in srgb, var(--chrome) 16%, transparent); text-transform: uppercase; }
  .people .face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .people .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-strong); }
  .people .who small { margin-left: 6px; font-size: 12px; color: var(--soft); }
  .people .pending { color: #c2410c; }
  .people .fixed { font-size: 13px; color: var(--soft); padding-right: 4px; }
  .people .act { opacity: 1; width: 26px; height: 26px; }
  .anyone { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
  .anyone[hidden] { display: none; }
  .anyone .face svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; }
  .anyone .who { flex: 1; color: var(--fg-strong); }
  .anyone .who small { display: block; font-size: 12px; color: var(--soft); }
  #share .buttons { justify-content: space-between; }
`;
  const count = `${docs.length} document${docs.length == 1 ? "" : "s"}`;
  return appPage("Documents", style, `${crumbs(session, [{ label: "Documents" }])}<main>
  <header>
    <div><h1>Documents</h1>${docs.length ? `<p class="sub">${count}</p>` : ""}</div>
    <a class="pill" href="${esc(link("/new", session))}" title="New document" aria-label="New document">${ICON.plus}New</a>
  </header>
  ${docs.length ? `<div class="labels" aria-hidden="true"><span>Name</span><span>Edited</span><span></span></div>
  <ol class="rows">\n${rows}\n  </ol>` : `<p class="empty">No documents yet. A new one starts blank${hours == null ? "." : `, and goes away after ${hours} hour${hours == 1 ? "" : "s"} if you never edit it.`}</p>`}
</main>
<dialog id="share" aria-labelledby="share-title" data-action="${esc(link("/docs/share", session))}" data-me="${esc(session.login.toLowerCase())}">
  <h2 id="share-title">Share</h2>
  <form class="add">
    <div class="field"><input name="login" placeholder="A GitHub login" aria-label="GitHub login to share with" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
    <select name="role" aria-label="Their role"><option value="editor">Can edit</option><option value="viewer">Can view</option></select>
    <button class="primary">Add</button>
  </form>
  <ul class="people" aria-label="People with access"></ul>
  <div class="anyone">
    <span class="face" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5Z"/></svg></span>
    <label class="who" for="share-anyone">Anyone with the link<small id="share-anyone-note">Signed in or not, as viewers</small></label>
    <select id="share-anyone"><option value="none">No access</option><option value="viewer">Can view</option><option value="editor">Can edit</option></select>
  </div>
  <p class="hint" id="share-hint" role="status"></p>
  <div class="buttons"><button type="button" class="copy">Copy link</button><button type="button" class="primary done">Done</button></div>
</dialog>
<script>
  // Times in the reader's own language and zone, and a question before deleting.
  ${TIMES_SCRIPT}
  // The chevrons, Share and the share card's buttons act as the press starts (shared/fast-click.ts). Delete keeps its click.
  ${fastClickScript("document", "button.twist, button.share, #share .copy, #share .done")}
  for (const f of document.querySelectorAll("form[data-title]")) {
    const q = "disk" in f.dataset ? "Take “" + f.dataset.title + "” off your list? Its files stay where they are." : "Delete “" + f.dataset.title + "”? This can't be undone.";
    f.addEventListener("submit", (e) => { if (!confirm(q)) e.preventDefault(); });
  }
  // Sharing: each change is saved as it's made (POST /docs/share), and the list follows when the dialog closes.
  const share = document.getElementById("share"), action = share.dataset.action, me = share.dataset.me;
  const people = share.querySelector(".people"), adder = share.querySelector("form.add"), anyone = document.getElementById("share-anyone");
  const shareHint = document.getElementById("share-hint");
  const tell = (text, error) => { shareHint.textContent = text; shareHint.classList.toggle("error", !!error); };
  let doc = null, changed = false;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const ROLES = [["editor", "Can edit"], ["viewer", "Can view"]];
  const roleSelect = (role, label) => {
    const s = el("select", { ariaLabel: label });
    for (const [v, t] of ROLES) s.append(el("option", { value: v, textContent: t, selected: v == role }));
    return s;
  };
  function render({ permissions, notUsers, avatars, publicSharing }) {
    people.replaceChildren();
    const pending = new Set(notUsers || []);
    let all = "none";
    for (const p of permissions) {
      if (p.login == "*") { all = p.role; continue; }
      const who = el("span", { className: "who", textContent: p.login });
      if (p.login == me) who.append(el("small", { textContent: "you" }));
      if (pending.has(p.login)) who.append(el("small", { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" }));
      const face = el("span", { className: "face", ariaHidden: "true", textContent: p.login[0] });
      const pic = avatars?.[p.login];
      if (pic) { const img = el("img", { src: pic, alt: "", draggable: false }); img.addEventListener("error", () => img.remove()); face.append(img); }
      const li = el("li", {}, face, who);
      if (p.role == "owner") li.append(el("span", { className: "fixed", textContent: "Owner" }));
      else {
        const s = roleSelect(p.role, "Role for " + p.login);
        s.addEventListener("change", () => change(p.login, s.value));
        const x = el("button", { type: "button", className: "act", title: "Stop sharing with " + p.login, ariaLabel: "Stop sharing with " + p.login, innerHTML: ${JSON.stringify(ICON.close)} });
        x.addEventListener("click", () => change(p.login, "none"));
        li.append(s, x);
      }
      people.append(li);
    }
    anyone.value = all;
    // Anyone with the link, only while the server lets users share content publicly; a share made before stays, to stop.
    anyone.closest(".anyone").hidden = !publicSharing && all == "none";
    for (const o of anyone.options) o.disabled = !publicSharing && o.value != "none" && o.value != all;
    document.getElementById("share-anyone-note").textContent = publicSharing ? "Signed in or not; people who aren't signed in view it" : "Public sharing is off here: only people who sign in can open it";
  }
  async function call(init) {
    const r = await fetch(init ? action : action + (action.includes("?") ? "&" : "?") + "id=" + doc.id, init ? { method: "POST", body: new URLSearchParams(init), headers: { Accept: "application/json" } } : {}).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  async function change(login, role) {
    tell("Saving…");
    try { render(await call({ id: doc.id, login, role })); changed = true; tell(""); return true; }
    catch (e) { tell(e.message, true); return false; }
  }
  for (const b of document.querySelectorAll("button.share")) b.addEventListener("click", async () => {
    doc = { id: b.dataset.id, title: b.dataset.title, address: b.dataset.address };
    share.querySelector("h2").textContent = "Share “" + doc.title + "”";
    people.replaceChildren();
    adder.reset();
    tell("Loading…");
    share.showModal();
    adder.elements.login.focus();
    try { render(await call()); tell(""); } catch (e) { tell(e.message, true); }
  });
  adder.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = adder.elements.login.value.trim().replace(/^@/, "");
    if (login && (await change(login, adder.elements.role.value))) adder.elements.login.value = "";
  });
  anyone.addEventListener("change", () => change("*", anyone.value));
  share.querySelector(".copy").addEventListener("click", async () => {
    const url = location.origin + doc.address;
    try { await navigator.clipboard.writeText(url); tell("Link copied: " + url); } catch { tell(url); }
  });
  share.querySelector(".done").addEventListener("click", () => share.close());
  share.addEventListener("close", () => { if (changed) location.reload(); });
  // A document's pages, beneath its row: the tree. The script loads once the list is up and the tab is idle, and a
  // document's pages are read as the pointer heads for its row, together, so a click shows them at once. Each document's last
  // answer is kept for the tab: opened again, or on the next visit, its pages show straight away, and are read again behind.
  // Pages open in the editor for those who may edit, in the viewer otherwise. Which are open is remembered for the tab.
  let treeJs = null;
  const loadTree = () => treeJs ??= import(${JSON.stringify(asset("pages-tree.js"))}).then(() => window.ergaTree, () => {
    treeJs = null;
    throw new Error("Couldn't load the pages: check your connection and try again.");
  });
  (window.requestIdleCallback ?? setTimeout)(() => loadTree().catch(() => {}));
  const treeQuery = ${JSON.stringify(session.as ? `?user=${encodeURIComponent(session.as)}` : "")};
  // A tree read ahead of the click, handed to the tree for its first read (once), if it's still fresh.
  const ahead = new Map();
  const readAhead = (id) => {
    const a = ahead.get(id);
    if (a && Date.now() - a.at < 10000) return;
    const answer = fetch("/api/docs/" + encodeURIComponent(id) + "/tree" + treeQuery, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    answer.catch(() => {});
    ahead.set(id, { at: Date.now(), answer });
  };
  const fetchFor = (id) => (url, init) => {
    const a = ahead.get(id);
    if (a && (!init || !init.method || init.method == "GET")) { ahead.delete(id); if (Date.now() - a.at < 10000) return a.answer.then((r) => r.clone(), () => fetch(url, init)); }
    return fetch(url, init);
  };
  const keptKey = (id) => "erga:docs-tree:" + id;
  const kept = (id) => { try { return JSON.parse(sessionStorage.getItem(keptKey(id)) || "null"); } catch { return null; } };
  const keep = (id, answer) => { try { sessionStorage.setItem(keptKey(id), JSON.stringify({ entries: answer.entries, canEdit: answer.canEdit, kind: answer.kind })); } catch {} };
  const openKey = "erga:docs-open";
  const opened = new Set((() => { try { return JSON.parse(sessionStorage.getItem(openKey) || "[]"); } catch { return []; } })());
  const saveOpened = () => { try { sessionStorage.setItem(openKey, JSON.stringify([...opened])); } catch {} };
  const trees = new Map(), readAt = new Map();
  async function showPages(b, open) {
    const id = b.dataset.id;
    b.setAttribute("aria-expanded", String(open));
    if (open) opened.add(id); else opened.delete(id);
    saveOpened();
    let sub = document.getElementById("pages-" + id);
    // Opened again: its pages are there already; read again only if they're more than a few seconds old.
    if (sub) { sub.hidden = !open; if (open && Date.now() - (readAt.get(id) ?? 0) > 4000) trees.get(id)?.refresh({ quiet: true }); return; }
    if (!open) return;
    readAhead(id);
    sub = Object.assign(document.createElement("li"), { id: "pages-" + id, className: "sub" });
    const box = Object.assign(document.createElement("div"), { className: "sub-tree" });
    // Until the tree's script runs: the pages kept from before, or a quiet line saying they're on their way.
    box.append(Object.assign(document.createElement("p"), { className: "sub-wait", textContent: "Loading pages…" }));
    sub.append(box);
    b.closest("li").after(sub);
    try {
      const t = await loadTree();
      box.replaceChildren();
      trees.set(id, t.mountTree(box, { id, base: b.dataset.base, editing: "edit" in b.dataset, query: treeQuery, rootTitle: b.dataset.title, label: "Pages of " + b.dataset.title,
        initial: kept(id), fetch: fetchFor(id), onChange: (a) => { readAt.set(id, Date.now()); keep(id, a); } }));
    } catch (e) { box.className = "sub-tree error"; box.textContent = e.message; }
  }
  // Opening a document, ahead of the click: as the pointer rests on its row, or focus comes to it, the browser fetches its page
  // (speculation rules: the click's navigation then takes that answer instead of asking again), and the editor's files for one
  // you may edit (kept for good, by their hashed names). Its room wakes too: the tree read above goes through the room, after
  // the same access check as the page. Each document once, and at most WARM_MAX a minute, so a pointer sweeping down
  // the list fetches little. A browser without speculation rules gets the files and the room only (the page itself is never
  // cached, so a plain prefetch of it would be thrown away).
  const SPECULATE = !!HTMLScriptElement.supports?.("speculationrules"), WARM_MAX = 6;
  // The rules are a script: they take the page's nonce (server/security.ts).
  const NONCE = document.currentScript?.nonce ?? "";
  const warmed = new Set();
  let warmTimes = [], filesWarmed = false;
  const warm = (a, edit) => {
    // (With its #edit: Chrome takes a prefetch only for the very address the click goes to, fragment and all.)
    const url = a.href, now = Date.now();
    if (warmed.has(url)) return;
    warmTimes = warmTimes.filter((t) => now - t < 60000);
    if (warmTimes.length >= WARM_MAX) return;
    warmTimes.push(now);
    warmed.add(url);
    if (SPECULATE) document.head.append(Object.assign(document.createElement("script"), { type: "speculationrules", nonce: NONCE, textContent: JSON.stringify({ prefetch: [{ source: "list", urls: [url] }] }) }));
    if (edit && !filesWarmed) {
      filesWarmed = true;
      for (const href of ${editorScripts()}) document.head.append(Object.assign(document.createElement("link"), { rel: "prefetch", href }));
    }
  };
  for (const b of document.querySelectorAll("button.twist")) {
    // The pointer resting on a row (or the chevron or the title focused, or touched): its pages are read, the script fetched,
    // and the document's page fetched ahead (warm).
    let rest = 0;
    const li = b.closest("li"), a = li.querySelector("a.doc"), edit = "edit" in b.dataset;
    const ready = () => { if (!trees.has(b.dataset.id)) readAhead(b.dataset.id); loadTree().catch(() => {}); };
    const opening = () => { ready(); warm(a, edit); };
    li.addEventListener("pointerenter", () => { clearTimeout(rest); rest = setTimeout(opening, 60); });
    li.addEventListener("pointerleave", () => clearTimeout(rest));
    a.addEventListener("focus", opening);
    a.addEventListener("pointerdown", opening);
    b.addEventListener("focus", ready);
    b.addEventListener("pointerdown", ready);
    b.addEventListener("click", () => showPages(b, b.getAttribute("aria-expanded") != "true"));
    if (opened.has(b.dataset.id)) showPages(b, true);
  }
  // Changes made elsewhere (another tab, an agent) show here too: the open trees are read again when the tab comes back,
  // and every few seconds while it's in view. Quietly: never while someone is naming, moving or deleting something in one.
  const refreshOpen = () => { for (const [id, t] of trees) if (!document.getElementById("pages-" + id)?.hidden) t.refresh({ quiet: true }); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState == "visible") refreshOpen(); });
  setInterval(() => { if (document.visibilityState == "visible") refreshOpen(); }, 4000);
</script>`);
}
