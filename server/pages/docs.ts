// The documents list page (/docs): a person's documents, latest edit first.

import type { Listed, LiveRow, LiveRows, Session } from "../platform.ts";
import { asset, assetScripts } from "./assets.ts";
import { appPage, ICON, link, withEdit } from "./chrome.ts";
import { homeButton, pageBars } from "./bars.ts";
import { esc } from "../../shared/html.ts";
import { newDocButton } from "./templates.ts";
import { inlineScript, inlineStyle } from "./inline.ts";
import { plural } from "../../shared/time.ts";
import { addressOf, HOME_ADDRESS, HOME_OWNER } from "../../document/names.ts";

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "12 days ago", or the date (the page's script redoes it in the reader's zone). */
export function ago(t: number, now: number): string {
  const min = Math.round((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${plural(min, "minute")} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
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

/**
 * One document's row on the list: the full page's, and the one an open list fetches when the row changes
 * (server/news/: data-live is its key, data-sort its place, the latest edit first).
 */
export function docRow(session: Session, d: Listed, now: number, hours: number | null): string {
  const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
  const mine = d.role == "owner";
  const note =
    d.owner == HOME_OWNER
      ? `<span class="note" title="This site's homepage, at /: every admin may edit it">Homepage</span>`
      : !mine
        ? `<span class="note" title="Shared with you by ${esc(d.owner)}">${esc(d.owner)} · ${d.role == "editor" ? "can edit" : "view only"}</span>`
        : d.path != null
          ? `<span class="note" title="${esc(d.path)}">On disk</span>`
          : left != null
            ? `<span class="note" title="${hours == null ? "Made when unedited documents were deleted: it still goes unless someone edits it" : `A document nobody edits is deleted ${hours} hours after it's made`}">Unedited · deleted in ${left}h</span>`
            : "";
  const when = new Date(d.modified).toISOString();
  // One opened from disk only comes off the list: its files stay where they are.
  const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
  // A project's row opens to its pages (the chevron); a document has one page, so its row has none (one from
  // before kinds that hasn't opened since has it, as before).
  const twist = d.kind == "document" ? `<span class="twist none" aria-hidden="true"></span>`
      : `<button type="button" class="twist" aria-expanded="false" aria-controls="pages-${esc(d.id)}" aria-label="Pages of ${esc(d.title)}" data-tip="Pages" data-id="${esc(d.id)}" data-base="${esc(addressOf(d))}" data-title="${esc(d.title)}"${d.role == "viewer" ? "" : " data-edit"}>${ICON.chevron}</button>`;
  // The whole row opens the document (the link stretches over it); its buttons sit on top.
  return `  <li data-live="doc:${esc(d.id)}" data-sort="${d.modified}">
    <div class="name">${twist}<a class="doc" href="${esc(withEdit(link(addressOf(d), session)))}"><span class="title">${esc(d.title)}</span></a>${d.kind == "project" ? `<span class="note kind" title="A folder of pages, each with its own address">Project</span>` : ""}${note}${mine ? sharedNote(d) : ""}</div>
    <time datetime="${when}">${ago(d.modified, now)}</time>
    <div class="acts">${
      mine
        ? `<button type="button" class="act share" aria-label="Share ${esc(d.title)}" data-tip="Share" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-address="${esc(addressOf(d))}">${ICON.share}</button>
    <form data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="act delete" aria-label="${label}" data-tip="${remove}">${ICON.delete}</button></form>`
        : ""
    }</div>
  </li>`;
}

/** The documents view: yours and those shared with you, with new, open, share and delete. */
export function docsPage(session: Session, docs: Listed[], now: number, hours: number | null): string {
  const rows = docs.map((d) => docRow(session, d, now, hours)).join("\n");
  const count = plural(docs.length, "document");
  return appPage(
    "Documents",
    inlineStyle("docs"),
    `${pageBars(session, [{ label: "Documents" }], { docs: homeButton(link(HOME_ADDRESS, session)) })}<main>
  <header>
    <div><h1>Documents</h1><p class="sub" id="docs-count"${docs.length ? "" : " hidden"}>${count}</p></div>
    ${newDocButton("pill", "New")}
  </header>
  <div class="labels" aria-hidden="true"${docs.length ? "" : " hidden"}><span>Name</span><span>Edited</span><span></span></div>
  <ol class="rows" data-live-kind="doc" data-live-view="docs" data-live-at="${now}"${docs.length ? "" : " hidden"}>\n${rows}\n  </ol>
  <p class="empty"${docs.length ? " hidden" : ""}>No documents yet. A new one starts blank${hours == null ? "." : `, and goes away after ${plural(hours, "hour")} if you never edit it.`}</p>
</main>
<dialog id="share" aria-labelledby="share-title" data-me="${esc(session.login.toLowerCase())}">
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
${inlineScript("docs", { close: ICON.close, tree: asset("pages-tree.js"), query: session.as ? `?user=${encodeURIComponent(session.as)}` : "", editor: assetScripts("page.js") })}`
  );
}

/** The rows of /docs that `keys` name ("doc:<id>"), as the person's list has them now (null: off it), for an open list (server/news/). */
export const docsRows: LiveRows = async (platform, session, keys) => {
  const ids = keys.map((k) => k.slice("doc:".length));
  const [docs, hours] = await Promise.all([
    platform.docs.list(session.login, ids),
    platform.directory.config.get("delete_docs_after_hours"),
  ]);
  const now = Date.now();
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const d of docs) out[`doc:${d.id}`] = { html: docRow(session, d, now, hours), sort: d.modified };
  return out;
};
