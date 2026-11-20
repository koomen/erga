// /admin/documents, the Documents page: what governs the documents of this server. The settings for new documents and
// for their files (how long an unedited new document stays, the largest file, the largest project), and the published
// sites: the document on each domain.

import { TIMES_SCRIPT, inlineCall, link } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session } from "../platform.ts";
import { adminPage } from "./layout.ts";
import { setAt } from "./parts.ts";
import { chip, PAGE_SETTINGS, settingLiveRows, settingsSection } from "./settings.ts";
import { addressOf } from "../../document/model/names.ts";
import { domainName, ERGA, ergaName, sitesOf } from "../sites/index.ts";

/** The Sites row's key among the page's live rows. */
const SITES = "setting:sites";

/**
 * The Sites row: one line for each domain, with the document that has it (server/sites/). It only shows the links: a
 * person changes them in the document's settings ("Publish to"), which read the same state.
 */
async function sitesRow(platform: Platform, session: Session, origin: string): Promise<string> {
  const erga = ergaName(platform, origin);
  const sites = await sitesOf(platform);
  const lines = await Promise.all(
    sites.map(async ({ domain, status }) => {
      const doc = status.doc ? await platform.directory.get(status.doc) : null;
      const own = status.live && status.live.doc == status.doc ? status.live : null;
      const linked = doc
        ? `<a href="${esc(link(addressOf(doc), session))}">${esc(doc.title)}</a>`
        : `<span class="free">${status.doc ? "missing" : "Free"}</span>`;
      const state = !status.doc
        ? ""
        : own
          ? `<span class="dot on" aria-hidden="true"></span>Published${own.version != null ? ` v${own.version}` : ""}`
          : `<span class="dot" aria-hidden="true"></span>Not published`;
      return `<tr data-domain="${esc(domain == ERGA ? "erga" : domain)}"><td class="domain">${esc(domainName(domain, erga))}</td><td>${linked}</td><td class="state">${state}</td></tr>`;
    })
  );
  // The link made last: when, and by whom.
  const last = sites.filter((s) => s.status.linked).sort((a, b) => b.status.linked!.at - a.status.linked!.at)[0];
  const set = last
    ? `<p class="set">${esc(domainName(last.domain, erga))} set ${esc(setAt(last.status.linked!.at))}${last.status.linked!.by ? ` by ${esc(last.status.linked!.by)}` : ""}</p>`
    : "";
  return `  <li class="sites" data-live="${SITES}" data-sort="0">
    <p class="key">Sites</p>
    <p class="desc">Admins can publish documents to the following domains. To add a domain to this list, deploy erga with <code>bun erga deploy &lt;host&gt; --domain &lt;domain&gt;</code></p>
    <table class="site-list"><tbody>${lines.join("")}</tbody></table>
    ${set}
  </li>`;
}

/** /admin/documents. */
export async function documentsPage(platform: Platform, session: Session, origin: string) {
  const [settings, sites] = await Promise.all([
    settingsSection(platform, session, PAGE_SETTINGS.documents, "admin-documents"),
    sitesRow(platform, session, origin),
  ]);
  return adminPage({
    session,
    title: "Documents",
    here: "documents",
    body: `
  <section aria-labelledby="page-head">
    ${settings}
  </section>
  <section class="published" aria-label="Published sites">
    <ol class="rows settings" data-live-kind="setting" data-live-view="admin-sites" data-live-at="${Date.now()}">
${sites}
    </ol>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}</script>`,
  });
}

/**
 * The rows of /admin/documents that `keys` name, as they are now, for an open page (server/news/). Its two lists show
 * rows of one kind ("setting:<key>"), so each has a view of its own, which knows only its own rows: the settings here,
 * the published sites ("setting:sites") in adminSitesRows.
 */
export const adminDocumentsRows: LiveRows = async (platform, session, keys) => ({
  ...Object.fromEntries(keys.map((k) => [k, null])),
  ...(await settingLiveRows(platform, session, keys, PAGE_SETTINGS.documents)),
});
export const adminSitesRows: LiveRows = async (platform, session, keys, origin) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  if (SITES in out) out[SITES] = { html: await sitesRow(platform, session, origin), sort: 0 };
  return out;
};
