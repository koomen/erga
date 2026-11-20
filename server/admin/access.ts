// /admin/access, the Access page: everything that governs who may use this server, and what they may do. Three
// sections: the groups (each rule: a group, and its access), the users with a role of their own (./users.ts), and
// everyone else: Anyone's level, whether users can share with anyone with the link, and the published sites, which are
// always public (client/inline/admin-access.ts and admin-users.ts change them). A person's access is the highest of
// their role, every group rule that matches them and Anyone's level (server/directory/access.ts).

import {
  ACCESS_LABEL,
  type AccessRule,
  type Anyone,
  ANYONE_LABEL,
  ANYONE_LEVELS,
  type ConfigEntry,
  KIND_LABEL,
  type RuleAccess,
  RULE_KINDS,
  type RuleKind,
  ruleKey,
  SETTINGS,
  sharingOn,
} from "../directory/index.ts";
import { SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { ICON, inlineCall, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";
import { usersSection } from "./users.ts";

/** A rule's place: the list's order (by kind and value: AccessRules.all). */
const ruleSort = (r: AccessRule) => `${RULE_KINDS.indexOf(r.kind)}:${r.value}`;

/** A group's access, as a menu's options: the two levels. */
const accessOptions = (now: RuleAccess) =>
  (["read", "write"] as const).map((v) => `<option value="${v}"${v == now ? " selected" : ""}>${ACCESS_LABEL[v]}</option>`).join("");

/** One group rule's row: who, and its access. */
function ruleRow(r: AccessRule): string {
  return `  <li data-id="${r.id}" data-kind="${r.kind}" data-live="${esc(ruleKey(r.kind, r.value))}" data-sort="${esc(ruleSort(r))}">
    <div class="who"><span class="title">${esc(r.value)}</span><span class="kind">${esc(KIND_LABEL[r.kind])}</span></div>
    <select class="access" aria-label="Access for ${esc(r.value)}">${accessOptions(r.access)}</select>
    <button type="button" class="act remove-rule" aria-label="Remove the rule for ${esc(r.value)}" title="Remove this rule">${ICON.delete}</button>
  </li>`;
}

/** What the deploy fixes: its control is off, and says why. */
const fixed = (e: ConfigEntry) => (e.locked ? ` disabled title="Fixed by the deploy"` : "");

/** Anyone's level: the anyone_access setting, as the Access page shows it. */
const anyoneRow = (e: ConfigEntry) =>
  `<li class="setting" data-live="setting:anyone_access" data-sort="0">
    <div class="about"><label class="key" for="anyone-access" title="anyone_access">${esc(SETTINGS.anyone_access.label!)}</label><p class="desc">${esc(SETTINGS.anyone_access.description!)}</p></div>
    <div class="value"><select class="access" id="anyone-access" aria-label="Access for anyone"${fixed(e)}>${ANYONE_LEVELS.map((v) => `<option value="${v}"${v == e.value ? " selected" : ""}>${ANYONE_LABEL[v]}</option>`).join("")}</select></div>
  </li>`;

/**
 * The switch for sharing with anyone with the link: the public_sharing setting, as the Access page shows it. With
 * Anyone at No access it is off, and can't turn on.
 */
const publicRow = (e: ConfigEntry, anyone: Anyone) => {
  const on = sharingOn(anyone, e.value === true),
    off = anyone == "none";
  return `<li class="setting${off ? " off" : ""}" data-live="setting:public_sharing" data-sort="1">
    <div class="about"><label class="key" for="public-sharing" title="public_sharing">${esc(SETTINGS.public_sharing.label!)}</label><p class="desc">${esc(SETTINGS.public_sharing.description!)}</p></div>
    <div class="value"><label class="switch"><input type="checkbox" role="switch" id="public-sharing"${on ? " checked" : ""}${off ? " disabled" : fixed(e)}><span class="track" aria-hidden="true"></span><span class="state" aria-hidden="true">${on ? "On" : "Off"}</span></label></div>
  </li>`;
};

/** A published document's row: no control. */
const PUBLISHED_ROW = `<li class="setting" data-sort="2">
    <div class="about"><p class="key">Published sites</p><p class="desc">A document that an admin publishes to a domain is public on that domain, always.</p></div>
    <div class="value"><span class="unit">Always public</span></div>
  </li>`;

/** A kind of group, in the form that adds a rule: its short name, an example, and what the server saw of it. */
const GROUP: Record<RuleKind, { name: string; like: string; seen: (s: { workspaces: string[]; orgs: string[] }) => string[] }> = {
  workspace: { name: "Google Workspace", like: "example.com", seen: (s) => s.workspaces },
  github_org: { name: "GitHub org", like: "my-org", seen: (s) => s.orgs },
};

/**
 * The group rules on the Access page: each rule a row (who, and its access); a form adds one, of the kinds of group
 * that this server's sign-in gives (`providers`: shared/sign-in.ts). A sign-in that gives no groups has no form.
 */
function rulesSection(rules: AccessRule[], suggestions: { workspaces: string[]; orgs: string[] }, providers: readonly string[]): string {
  const kinds = (Object.keys(GROUP) as (keyof typeof GROUP)[]).filter((k) =>
    providers.some((p) => SIGN_IN_PROVIDERS[p]?.groups?.kind == k)
  );
  const form = kinds.length
    ? `<form class="add-rule">
      <select name="kind" aria-label="Who">
        ${kinds.map((k) => `<option value="${k}" data-placeholder="${esc(GROUP[k].like)}">${esc(GROUP[k].name)}</option>`).join("\n        ")}
      </select>
      <input class="input" name="value" list="suggest-${kinds[0]}" placeholder="${esc(GROUP[kinds[0]].like)}" aria-label="The domain or the organization" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" required>
      <select name="access" aria-label="Access">${accessOptions("write")}</select>
      <button class="new">Add group</button>
    </form>
    ${kinds
      .map(
        (k) =>
          `<datalist id="suggest-${k}">${GROUP[k]
            .seen(suggestions)
            .map((v) => `<option value="${esc(v)}">`)
            .join("")}</datalist>`
      )
      .join("\n    ")}`
    : `<p class="note">This server's sign-in has no groups.</p>`;
  return `<section class="rules" aria-labelledby="rules-head">
    <h3 class="sub-head" id="rules-head">Groups</h3>
    <p class="lede">Grant access to everyone in your github or google workspace</p>
    ${form}
    <p class="hint" id="rules-hint" role="status"></p>
    <ol class="rows rules" data-live-kind="rule" data-live-view="access" data-live-order="asc" data-live-at="${Date.now()}">
${rules.map(ruleRow).join("\n")}
    </ol>
  </section>`;
}

/** /admin/access: the groups, the users, and everyone else. */
export async function accessPage(platform: Platform, session: Session) {
  const who = whoOf(session),
    { rules, config } = platform.directory;
  const [list, suggestions, anyone, sharing, users] = await Promise.all([
    rules.list(who),
    rules.suggestions(who),
    config.entry("anyone_access"),
    config.entry("public_sharing"),
    usersSection(platform, session),
  ]);
  return adminPage({
    session,
    title: "Access",
    here: "access",
    body: `
  ${rulesSection(list, suggestions, platform.directory.providers)}
  ${users}
  <section class="everyone" aria-labelledby="public-head">
    <h3 class="sub-head" id="public-head">Everyone else</h3>
    <p class="lede">The general public</p>
    <ol class="rows settings" data-live-kind="setting" data-live-view="access" data-live-order="asc" data-live-at="${Date.now()}">
    ${anyoneRow(anyone)}
    ${publicRow(sharing, anyone.value as Anyone)}
    ${PUBLISHED_ROW}
    </ol>
    <p class="hint" id="public-hint" role="status"></p>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-access")}${inlineCall("admin-users", { me: session.login.toLowerCase() })}</script>`,
  });
}

/** The rows of /admin/access that `keys` name ("rule:<kind>:<value>", "setting:anyone_access", "setting:public_sharing"), as they are now (server/news/). */
export const accessRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  const { rules, config } = platform.directory;
  // As the database has them now: the change was likely made in another isolate, whose memory this one doesn't share.
  rules.forget();
  config.forget();
  for (const r of await rules.list(whoOf(session))) {
    const key = ruleKey(r.kind, r.value);
    if (key in out) out[key] = { html: ruleRow(r), sort: ruleSort(r) };
  }
  const anyone = await config.entry("anyone_access");
  if ("setting:anyone_access" in out) out["setting:anyone_access"] = { html: anyoneRow(anyone), sort: 0 };
  if ("setting:public_sharing" in out)
    out["setting:public_sharing"] = { html: publicRow(await config.entry("public_sharing"), anyone.value as Anyone), sort: 1 };
  return out;
};
