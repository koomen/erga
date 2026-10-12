// The viewer on a document: the page at /<owner>/<slug>, which frames the document's own
// page from its pages origin, and is the editor too for whoever may edit (#edit). The
// decisions are here (who may edit, share, clone; which token the frame gets); the page's
// scripts and styles are pages/viewer.ts.

import { pageAddress } from "../../document/pages.ts";
import { mayDeploy } from "../deploys/access.ts";
import { type DocRow, type Role, roleMay } from "../directory.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { pagesOrigin, pagesToken } from "./pages-origin.ts";
import { cloneButton, editButton, esc, link, viewerPage } from "../pages/index.ts";

/** What the editor's menu on your avatar needs to know that the document doesn't: the links it offers. */
async function accountMeta(platform: Platform, session: Session): Promise<string> {
  const admin = !session.test && !session.agent && (await platform.directory.users.isAdmin(whoOf(session)));
  const deploy = await mayDeploy(platform.directory, session);
  const links = { docs: link("/docs", session), settings: link("/settings", session), ...(deploy ? { deploy: link("/deploy", session) } : {}), ...(admin ? { admin: link("/admin", session) } : {}), signOut: "/auth/logout" };
  return `<meta name="erga-account" content="${esc(JSON.stringify(links))}">`;
}

/**
 * A document's page, the viewer (/<owner>/<slug>, or one of its other pages)
 * and the editor (the same address with #edit) alike: the document as it renders, on its own pages origin (whoever edits
 * it can't act as the people who view it), in a frame filling the window,
 * with the controls floating over its top corners. The page is the same in
 * both, and small: the document shows at once, and editing is loaded on top
 * of it (EDIT_BOOT) only when someone goes into it, by the pencil or at #edit,
 * without reloading or moving the document. Over the viewer, Clone (a copy of
 * your own) for anyone who may see it, and Edit for those who may edit it.
 * The front page is this, on the landing document.
 */
export async function viewDocument(platform: Platform, request: Request, opened: { doc: DocRow; index: string | null; role: Role | null }, session: Session | null, landing: boolean): Promise<Response> {
  const url = new URL(request.url);
  const { doc, index, role } = opened;
  const origin = pagesOrigin(doc.owner, doc.id, url, platform);
  // The frame's host page (pagesDoor), with the token that opens the document's files, showing its page straight away.
  // What they may do, from the role the caller looked up (as Directory.may decides).
  const canEdit = !!session && !session.agent && roleMay(role, "edit");
  // What the editor needs to know, for whoever may go into it: where its document's host and frame are, and the links on its avatar.
  const editable = canEdit;
  const [token, account] = await Promise.all([
    // Someone who may not edit it sees only its published version, in every file the frame asks for.
    // On a server for admins alone (staging), the token names its admin, whom the pages origin checks again.
    pagesToken(platform.secret, doc.owner, doc.id, url.origin, undefined, { published: !canEdit, ...(platform.adminsOnly && session ? { by: session.login } : {}) }),
    editable && session ? accountMeta(platform, session) : "",
  ]);
  const host = `${origin}/t/${token}/`;
  const address = `/${doc.owner}/${doc.slug}`;
  const clone = cloneButton(link(`/new?from=${landing ? "landing" : doc.id}`, session));
  // This page's address (one of the document's other pages, or the document's own).
  const here = index && pageAddress(index) ? `${address}/${pageAddress(index).split("/").map(encodeURIComponent).join("/")}` : address;
  const edit = canEdit ? editButton(`${link(here, session)}#edit`, false) : "";
  // Its owner shares it with people from the editor too (/docs/share).
  const canShare = editable && !!session && !session.agent && !session.test && roleMay(role, "share");
  // The document's address and which of its pages this is, for everyone: the address bar follows the page shown (NAV_SCRIPT).
  const meta = `<meta name="erga-address" content="${esc(address)}">${index ? `<meta name="erga-page" content="${esc(index)}">` : ""}` + (editable && session
    ? `<meta name="erga-pages" content="${esc(host)}"><meta name="erga-base" content="/d/${doc.id}">${canShare ? `<meta name="erga-share" content="${esc(link("/docs/share", session))}">` : ""}${account}`
    : "");
  return viewerPage({ title: doc.title, docId: doc.id, origin, host, index, meta, session, editable, landing, clone, edit });
}
