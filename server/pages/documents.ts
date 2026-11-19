// The documents list page (/documents): a person's documents, latest edit first.

import type { Listed, LiveRow, LiveRows, Session } from "../platform.ts";
import type { AccessRequest, ListView } from "../directory/index.ts";
import { asset, assetScripts } from "./assets.ts";
import { appPage, ICON, link, withEdit } from "./chrome.ts";
import { homeButton, pageBars } from "./bars.ts";
import { esc } from "../../shared/html.ts";
import { newDocButton, PLUS } from "./templates.ts";
import { scratchMakeTip } from "./scratch.ts";
import { inlineScript, inlineStyle } from "./inline.ts";
import { plural, timeAgo } from "../../shared/time.ts";
import { addressOf, HOME_ADDRESS, HOME_OWNER } from "../../document/model/names.ts";

/** Who a document is shared with, as its row in the list says it (the owner's own view). */
function sharedNote(d: Listed): string {
  if (!d.shared) return "";
  return `<span class="note shared" title="Shared with ${d.shared} besides you">Shared</span>`;
}

/**
 * One document's row on the list: the full page's, and the one an open list fetches when the row changes
 * (server/news/: data-live is its key, data-sort its place, the latest edit first).
 */
export function docRow(session: Session, d: Listed, now: number, hours: number | null, view: ListView): string {
  const left = d.expires != null ? Math.max(1, Math.ceil((d.expires - now) / 3600000)) : null;
  const mine = d.role == "owner";
  const note =
    d.owner == HOME_OWNER
      ? `<span class="note" title="The default homepage (/_home): every admin may edit it">Homepage</span>`
      : !mine
        ? `<span class="note" title="Shared with you by ${esc(d.owner)}">${esc(d.owner)} · ${d.role == "editor" ? "can edit" : d.role == "commenter" ? "can comment" : "view only"}</span>`
        : d.path != null
          ? `<span class="note" title="${esc(d.path)}">On disk</span>`
          : left != null && view == "scratch"
            ? `<span class="note" title="${esc(scratchMakeTip(hours))}">Deleted in ${left}h</span>`
            : left != null
            ? `<span class="note" title="${hours == null ? "Made when unedited documents were deleted: it still goes unless someone edits it" : `A document nobody edits is deleted ${hours} hours after it's made`}">Unedited · deleted in ${left}h</span>`
            : "";
  const when = new Date(d.modified).toISOString();
  // One opened from disk only comes off the list: its files stay where they are.
  const [remove, label] = d.path != null ? ["Remove from the list", `Remove ${esc(d.title)} from the list`] : ["Delete", `Delete ${esc(d.title)}`];
  // A row with more than one page opens to them (the chevron); one with one page has none (one not counted yet has it).
  const twist =
    d.pages == 1
      ? `<span class="twist none" aria-hidden="true"></span>`
      : `<button type="button" class="twist" aria-expanded="false" aria-controls="pages-${esc(d.id)}" aria-label="Pages of ${esc(d.title)}" data-tip="Pages" data-id="${esc(d.id)}" data-base="${esc(addressOf(d))}" data-title="${esc(d.title)}"${d.role == "owner" || d.role == "editor" ? " data-edit" : ""}>${ICON.chevron}</button>`;
  // Archive (Unarchive on /documents/archived): each person's own, on their permission; the default homepage has none of theirs.
  // On /documents/scratch, Save in its place (save_document), for the owner. Each takes the row off the list it is on.
  const [op, tip, icon] =
    view == "scratch"
      ? ["save_document", "Save", ICON.save]
      : view == "archived"
        ? ["unarchive_document", "Unarchive", ICON.unarchive]
        : ["archive_document", "Archive", ICON.archive];
  const move =
    d.owner == HOME_OWNER || (view == "scratch" && !mine)
      ? ""
      : `<button type="button" class="act move" aria-label="${tip} ${esc(d.title)}" data-tip="${tip}" data-op="${op}" data-id="${esc(d.id)}">${icon}</button>`;
  // The whole row opens the document (the link stretches over it); its buttons sit on top.
  return `  <li data-live="doc:${esc(d.id)}" data-sort="${d.modified}">
    <div class="name">${twist}<a class="doc" href="${esc(withEdit(link(addressOf(d), session)))}"><span class="title">${esc(d.title)}</span></a>${note}${mine ? sharedNote(d) : ""}</div>
    <time datetime="${when}">${timeAgo(d.modified, now, "en-US", "UTC")}</time>
    <div class="acts">${move}${
      mine
        ? `<button type="button" class="act share" aria-label="Share ${esc(d.title)}" data-tip="Share" data-id="${esc(d.id)}" data-title="${esc(d.title)}" data-address="${esc(addressOf(d))}">${ICON.share}</button>
    <form data-title="${esc(d.title)}"${d.path != null ? " data-disk" : ""}><input type="hidden" name="id" value="${esc(d.id)}"><button class="act delete" aria-label="${label}" data-tip="${remove}">${ICON.delete}</button></form>`
        : ""
    }</div>
  </li>`;
}

/**
 * The documents view: yours and those shared with you, with new, open, archive, share and delete; or, by `view`, those
 * you archived (/documents/archived), the same rows with Unarchive, or your scratch ones (/documents/scratch), with Save.
 * The heading of /documents links to the other lists, and theirs back to it.
 */
export function documentsPage(
  session: Session,
  docs: Listed[],
  now: number,
  hours: number | null,
  view: ListView = "documents",
  /** The requests for access to the person's documents that wait for an answer (server/directory/requests.ts). */
  asks: AccessRequest[] = [],
  /** A page of the documents' site to frame, hidden: a gate in front runs its hand-off there (server/identity, handOff). */
  warm?: string
): string {
  // Each request: who asks, for which document, and the owner's two answers (client/inline/documents.ts: share_document).
  const asking = asks.length
    ? `<ul class="asks" aria-label="Requests for access">${asks
        .map(
          (r) =>
            `<li data-doc="${esc(r.doc)}" data-login="${esc(r.login)}"><span><b>${esc(r.login)}</b> asks for access to <a href="${esc(link(`/d/${r.doc}`, session))}">${esc(r.title)}</a></span><button type="button" class="share">Share</button><button type="button" class="decline">Decline</button></li>`
        )
        .join("")}</ul>`
    : "";
  const rows = docs.map((d) => docRow(session, d, now, hours, view)).join("\n");
  const count = plural(docs.length, "document");
  const [title, empty] =
    view == "scratch"
      ? [
          "Scratch",
          `No scratch documents. A scratch document is off your list${hours == null ? " until you save it" : `, and deleted after ${hours} hours unless you save it`}.`,
        ]
      : view == "archived"
        ? ["Archived", "No archived documents. A document you archive leaves your list and waits here."]
        : ["Documents", "No documents yet."];
  const others =
    view == "documents"
      ? [
          ["/documents/archived", "Archived"],
          ["/documents/scratch", "Scratch"],
        ]
      : [["/documents", "Documents"]];
  const trail = view == "documents" ? [{ label: title }] : [{ label: "Documents", href: "/documents" }, { label: title }];
  return appPage(
    title,
    inlineStyle("documents") + inlineStyle("scratch"),
    `${pageBars(session, trail, { documents: homeButton(link(HOME_ADDRESS, session)) })}<main>
  <header>
    <div><div class="heading"><h1>${title}</h1>${others.map(([to, label]) => `<a class="other-list" href="${esc(link(to, session))}">${label}</a>`).join("")}</div><p class="sub" id="documents-count"${docs.length ? "" : " hidden"}>${count}</p></div>
    <div class="make">
      <div class="make-buttons"><input type="search" class="input find" placeholder="Find" aria-label="Find documents by title or address" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false"${docs.length ? "" : " hidden"}>${newDocButton("pill", "New")}<a class="pill scratch erga-scratch-tip" href="${esc(link("/scratch", session))}" draggable="false" data-tip="${esc(scratchMakeTip(hours))}" aria-description="${esc(scratchMakeTip(hours))}">${PLUS}Scratch</a></div>
    </div>
  </header>
  ${asking}<p class="none" id="documents-none" role="status" hidden></p>
  <div class="labels" aria-hidden="true"${docs.length ? "" : " hidden"}><span>Name</span><span>Edited</span><span></span></div>
  <ol class="rows" data-live-kind="doc" data-live-view="${view == "documents" ? view : `documents-${view}`}" data-live-at="${now}"${docs.length ? "" : " hidden"}>\n${rows}\n  </ol>
  <p class="empty"${docs.length ? " hidden" : ""}>${empty}</p>
</main>${warm ? `<iframe hidden src="${esc(warm)}" title=""></iframe>` : ""}
<dialog id="share" aria-labelledby="share-title" data-me="${esc(session.login.toLowerCase())}">
  <h2 id="share-title">Share</h2>
  <form class="add">
    <div class="field"><input name="who" placeholder="A GitHub login" aria-label="GitHub login to share with" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" required></div>
    <select name="role" aria-label="Their role"><option value="editor">Can edit</option><option value="commenter">Can comment</option><option value="viewer">Can view</option></select>
    <button class="primary">Add</button>
  </form>
  <ul class="people" aria-label="People with access"></ul>
  <div class="anyone">
    <span class="face" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5Z"/></svg></span>
    <label class="who" for="share-anyone">Anyone with the link<small id="share-anyone-note">Signed in or not, as viewers</small></label>
    <select id="share-anyone"><option value="none">No access</option><option value="viewer">Can view</option><option value="commenter">Can comment</option><option value="editor">Can edit</option></select>
  </div>
  <p class="hint" id="share-hint" role="status"></p>
  <div class="buttons"><button type="button" class="copy">Copy link</button><button type="button" class="primary done">Done</button></div>
</dialog>
${inlineScript("documents", { close: ICON.close, tree: asset("pages-tree.js"), query: session.as ? `?user=${encodeURIComponent(session.as)}` : "", editor: assetScripts("page.js") })}`
  );
}

/**
 * The rows of /documents (or of the list `view`: /documents/archived, /documents/scratch) that `keys` name ("doc:<id>"), as the
 * person's list has them now (null: off it: archived or back, saved, deleted), for an open list (server/news/).
 */
export const documentsRows =
  (view: ListView): LiveRows =>
  async (platform, session, keys) => {
  const ids = keys.map((k) => k.slice("doc:".length));
  const [docs, hours] = await Promise.all([
    platform.docs.list(session.login, { ids, view }),
    platform.directory.config.get("delete_docs_after_hours"),
  ]);
  const now = Date.now();
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const d of docs) out[`doc:${d.id}`] = { html: docRow(session, d, now, hours, view), sort: d.modified };
  return out;
};
