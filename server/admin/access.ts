// /admin/access, the Access page: the group rules, and whether users can share content publicly
// (client/inline/admin-access.ts changes them).

import { type Access, ACCESS_LABEL, type AccessRule, KIND_LABEL } from "../directory/index.ts";
import { ICON, inlineCall, link } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";

/** The group rules on the Access page: each rule a row (who, and its access); a form adds one. */
function rulesSection(rules: AccessRule[], suggestions: { workspaces: string[]; orgs: string[] }, session: Session): string {
  const option = (v: Access, now: Access) => `<option value="${v}"${v == now ? " selected" : ""}>${ACCESS_LABEL[v]}</option>`;
  const row = (r: AccessRule) => `  <li data-id="${r.id}" data-kind="${r.kind}">
    <div class="who">${r.kind == "everybody" ? `<span class="title">Everybody</span><span class="note">anyone who signs in with a provider that's on</span>` : `<span class="kind">${esc(KIND_LABEL[r.kind])}</span><span class="title">${esc(r.value)}</span>`}</div>
    <select class="access" aria-label="Access for ${esc(r.kind == "everybody" ? "everybody" : r.value)}">${(["none", "read", "write"] as Access[]).map((v) => option(v, r.access)).join("")}</select>
    ${r.kind == "everybody" ? `<span></span>` : `<button type="button" class="act remove-rule" aria-label="Remove the rule for ${esc(r.value)}" title="Remove this rule">${ICON.delete}</button>`}
  </li>`;
  return `<section class="rules" aria-labelledby="rules-head">
    <h2 id="rules-head">Access</h2>
    <ol class="rows rules">
${rules.map(row).join("\n")}
    </ol>
    <form class="add-rule" method="post" action="${esc(link("/admin/access", session))}">
      <select name="kind" aria-label="Who">
        <option value="workspace">Google Workspace organization</option>
        <option value="github_org">GitHub organization</option>
      </select>
      <input class="input" name="value" list="suggest-workspace" placeholder="example.com" aria-label="The domain or the organization" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <select name="access" aria-label="Access"><option value="none">${ACCESS_LABEL.none}</option><option value="read">${ACCESS_LABEL.read}</option><option value="write" selected>${ACCESS_LABEL.write}</option></select>
      <button class="new">Add</button>
    </form>
    <datalist id="suggest-workspace">${suggestions.workspaces.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
    <datalist id="suggest-github_org">${suggestions.orgs.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
    <p class="hint" id="rules-hint" role="status"></p>
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
    body: `
  ${rulesSection(rules, suggestions, session)}
  <section class="public-sharing" aria-labelledby="public-head">
    <h2 id="public-head">Sharing</h2>
    <label class="switch public"><input type="checkbox" role="switch" id="public-sharing"${publicSharing ? " checked" : ""}><span class="track" aria-hidden="true"></span><span>Users can share content publicly</span></label>
    <p class="hint" id="public-hint" role="status"></p>
  </section>
<script>${inlineCall("admin-access", { action: link("/admin/access", session) })}</script>`,
  });
}
