// /admin/access, the Access page: the group rules, and whether users can share content publicly
// (client/inline/admin-access.ts changes them).

import { type Access, ACCESS_LABEL, type AccessRule, KIND_LABEL, RULE_KINDS, ruleKey, SETTINGS } from "../directory/index.ts";
import { ICON, inlineCall } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";

/** A rule's place: the list's order (everybody's first, then by kind and value: AccessRules.all). */
const ruleSort = (r: AccessRule) => `${RULE_KINDS.indexOf(r.kind)}:${r.value}`;

/** One group rule's row: who, and its access. */
function ruleRow(r: AccessRule): string {
  const option = (v: Access, now: Access) => `<option value="${v}"${v == now ? " selected" : ""}>${ACCESS_LABEL[v]}</option>`;
  return `  <li data-id="${r.id}" data-kind="${r.kind}" data-live="${esc(ruleKey(r.kind, r.value))}" data-sort="${esc(ruleSort(r))}">
    <div class="who">${r.kind == "everybody" ? `<span class="title">Everybody</span><span class="kind">Anyone who signs in with a provider that is on</span>` : `<span class="title">${esc(r.value)}</span><span class="kind">${esc(KIND_LABEL[r.kind])}</span>`}</div>
    <select class="access" aria-label="Access for ${esc(r.kind == "everybody" ? "everybody" : r.value)}">${(["none", "read", "write"] as Access[]).map((v) => option(v, r.access)).join("")}</select>
    ${r.kind == "everybody" ? `<span></span>` : `<button type="button" class="act remove-rule" aria-label="Remove the rule for ${esc(r.value)}" title="Remove this rule">${ICON.delete}</button>`}
  </li>`;
}

/** The switch for sharing content publicly: the public_sharing setting, as the Access page shows it. */
const publicRow = (on: boolean) =>
  `<li class="setting" data-live="setting:public_sharing" data-sort="0">
    <div class="about"><label class="key" for="public-sharing" title="public_sharing">${esc(SETTINGS.public_sharing.label!)}</label><p class="desc">${esc(SETTINGS.public_sharing.description)}</p></div>
    <div class="value"><label class="switch"><input type="checkbox" role="switch" id="public-sharing"${on ? " checked" : ""}><span class="track" aria-hidden="true"></span><span class="state" aria-hidden="true">${on ? "On" : "Off"}</span></label></div>
  </li>`;

/** The group rules on the Access page: each rule a row (who, and its access); a form adds one. */
function rulesSection(rules: AccessRule[], suggestions: { workspaces: string[]; orgs: string[] }): string {
  return `<section class="rules" aria-labelledby="rules-head">
    <h3 class="sub-head" id="rules-head">Groups</h3>
    <form class="add-rule">
      <select name="kind" aria-label="Who">
        <option value="workspace">Google Workspace</option>
        <option value="github_org">GitHub org</option>
      </select>
      <input class="input" name="value" list="suggest-workspace" placeholder="example.com" aria-label="The domain or the organization" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <select name="access" aria-label="Access"><option value="none">${ACCESS_LABEL.none}</option><option value="read">${ACCESS_LABEL.read}</option><option value="write" selected>${ACCESS_LABEL.write}</option></select>
      <button class="new">Add group</button>
    </form>
    <datalist id="suggest-workspace">${suggestions.workspaces.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
    <datalist id="suggest-github_org">${suggestions.orgs.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
    <p class="hint" id="rules-hint" role="status"></p>
    <ol class="rows rules" data-live-kind="rule" data-live-view="access" data-live-order="asc" data-live-at="${Date.now()}">
${rules.map(ruleRow).join("\n")}
    </ol>
  </section>`;
}

/** /admin/access: the access rules, one list, and whether users can share content publicly. */
export async function accessPage(platform: Platform, session: Session) {
  const who = whoOf(session);
  const [rules, suggestions, publicSharing] = await Promise.all([
    platform.directory.rules.list(who),
    platform.directory.rules.suggestions(who),
    platform.directory.config.get("public_sharing"),
  ]);
  return adminPage({
    session,
    title: "Access",
    here: "access",
    lede: "Who can sign in by group, and what they can do. Each user's own role is on Users.",
    body: `
  ${rulesSection(rules, suggestions)}
  <section class="public-sharing" aria-labelledby="public-head">
    <h3 class="sub-head" id="public-head">Sharing</h3>
    <ol class="rows settings" data-live-kind="setting" data-live-view="access" data-live-at="${Date.now()}">
    ${publicRow(publicSharing)}
    </ol>
    <p class="hint" id="public-hint" role="status"></p>
  </section>
<script>${inlineCall("admin-access")}</script>`,
  });
}

/** The rows of /admin/access that `keys` name ("rule:<kind>:<value>", "setting:public_sharing"), as they are now (server/news/). */
export const accessRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  // As the database has them now: the change was likely made in another isolate, whose memory this one doesn't share.
  platform.directory.rules.forget();
  platform.directory.config.forget();
  for (const r of await platform.directory.rules.list(whoOf(session))) {
    const key = ruleKey(r.kind, r.value);
    if (key in out) out[key] = { html: ruleRow(r), sort: ruleSort(r) };
  }
  if ("setting:public_sharing" in out)
    out["setting:public_sharing"] = { html: publicRow(!!(await platform.directory.config.get("public_sharing"))), sort: 0 };
  return out;
};
