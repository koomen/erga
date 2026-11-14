// /admin/changes, the Change log.

import {
  type Access,
  ACCESS_LABEL,
  KIND_LABEL,
  ROLE_LABEL,
  type RuleKind,
  type SettingChange,
  type Settings,
  type SettingsVersion,
} from "../directory/index.ts";
import { inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { providerName } from "../../shared/sign-in.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine, SYSTEM, VIA } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { avatarHtml, shown } from "./parts.ts";
import { plural } from "../../shared/time.ts";
import { addressOf } from "../../document/names.ts";

/** How many changes the change log lists on a page. */
const CHANGES = 50;

/**
 * Who made a version, and how: the person's login, and, when they
 * acted through an agent or the factory, "via …" beside it. Never the agent alone.
 */
function byHtml(by: string, via: string | null | undefined, avatars: Record<string, string>): string {
  const chip = via ? viaChip(via) : null;
  return `<span class="who">${avatarHtml(by, avatars[by.toLowerCase()])}<span class="by">${esc(byLine(by))}</span>${chip ? ` <span class="via" data-via="${esc(via!)}" title="${esc(chip.title)}">${esc(chip.text)}</span>` : ""}</span>`;
}

/** A via as a short chip, with more on hover: "admin agent", "token" (its name on hover), "factory #12". */
function viaChip(via: string): { text: string; title: string } {
  if (via == VIA.agent) return { text: "their agent", title: `via ${via}` };
  if (via == VIA.admin) return { text: "admin agent", title: `via ${via}` };
  const token = /^a shared agent \((.*)\)$/.exec(via);
  if (token) return { text: "token", title: token[1] };
  const task = /^the factory \(task #(\d+)\)$/.exec(via);
  return { text: task ? `factory #${task[1]}` : via, title: `via ${via}` };
}

/** A change log line for something other than a setting: a factory task added or merged, main moved to production, a user or a token changed. */
function eventItem(c: SettingChange): string {
  const role = (r: string) => esc(ROLE_LABEL[r as keyof typeof ROLE_LABEL] ?? r);
  if (c.user) {
    const u = c.user;
    const what =
      u.event == "added"
        ? `added${u.role ? `: ${role(u.role)}` : ""}`
        : u.event == "removed"
          ? "removed"
          : u.event == "role"
            ? `role: ${role(u.role ?? "none")}`
            : `deploy role ${u.deploy ? "granted" : "revoked"}`;
    return `<li><span class="key">User</span> <span class="title">${esc(u.login)}</span> ${what}</li>`;
  }
  if (c.access) {
    const a = c.access,
      who =
        a.kind == "everybody" ? "Everybody" : `${esc(KIND_LABEL[a.kind as RuleKind] ?? a.kind)} <span class="title">${esc(a.value)}</span>`;
    const shown = (x?: string) => esc(ACCESS_LABEL[x as Access] ?? x ?? "");
    const what =
      a.event == "added" ? `added: ${shown(a.access)}` : a.event == "removed" ? "removed" : `${shown(a.from)} → ${shown(a.access)}`;
    return `<li><span class="key">Access</span> ${who} ${what}</li>`;
  }
  if (c.signIn) {
    const a = c.signIn;
    const name = esc(providerName(a.provider));
    if (a.event == "on" || a.event == "off") return `<li><span class="key">Sign-in</span> ${name} turned ${a.event}</li>`;
    const what =
      a.event == "set"
        ? `in use: client ID <code>${esc(a.clientId ?? "")}</code>`
        : a.event == "pending"
          ? `client ID <code>${esc(a.clientId ?? "")}</code> waits for a test sign-in`
          : a.event == "tested"
            ? `client ID <code>${esc(a.clientId ?? "")}</code> in use after a test sign-in`
            : a.event == "discarded"
              ? `new values discarded`
              : "cleared: the deploy's values again";
    return `<li><span class="key">Sign-in</span> the ${name} app ${what}</li>`;
  }
  if (c.token)
    return `<li><span class="key">Token</span> <span class="title">${esc(c.token.label)}</span> (${esc(c.token.of)}’s) revoked</li>`;
  const sha = (s: unknown) => `<code class="sha" title="${esc(String(s))}">${esc(String(s).slice(0, 7))}</code>`;
  if (c.task) {
    const what = c.task.event == "added" ? "added" : `merged into staging${c.task.commit ? ` as ${sha(c.task.commit)}` : ""}`;
    return `<li><span class="key">Task #${c.task.id}</span> ${what}: <span class="title">${esc(c.task.title)}</span></li>`;
  }
  if (c.stagingOverride)
    return `<li><span class="key">Staging</span> pushes allowed until ${esc(new Date(c.stagingOverride.until).toISOString().slice(11, 16))} UTC <span class="badge">staging rule overridden</span> <span class="title">${esc(c.stagingOverride.reason)}</span></li>`;
  const r = c.release!;
  const commits = r.commits.map((x) => `<li>${sha(x.sha)} ${esc(x.subject)}</li>`).join("");
  const more = r.total > r.commits.length ? `<li class="more">and ${r.total - r.commits.length} older</li>` : "";
  // Past the production gate (its tests hadn't passed): the admin's reason, and what the gate said.
  const override = r.override
    ? ` <span class="badge" title="${esc(r.override.gate)}">${c.key == "staging" ? "staging rule overridden" : "tests overridden"}</span> <span class="title">${esc(r.override.reason)}</span>`
    : "";
  // Folded, so the entry stays on its line: the commits open under it.
  const list = r.commits.length
    ? ` <details><summary>${plural(r.total, "commit")}</summary><ul class="commits">${commits}${more}</ul></details>`
    : "";
  return `<li><span class="key">${c.key == "staging" ? "Staging" : "Main"}</span> ${c.from ? sha(c.from) : "none"} <span class="to" aria-label="to">→</span> ${sha(c.to)}${override}${list}</li>`;
}

/**
 * One version of the settings in the change log: when, who, and each
 * setting's value from and to. `docs`: a document's address and title by id,
 * for a setting that names one.
 */
function changeRow(
  v: SettingsVersion,
  settings: Settings,
  docs: Map<string, { address: string; title: string }>,
  avatars: Record<string, string>
): string {
  const at = new Date(v.at).toISOString();
  const value = (key: string, x: unknown) => {
    const kind = settings[key]?.kind;
    const doc = kind == "document" && x != null ? docs.get(String(x)) : undefined;
    return `<span class="was">${esc(doc ? doc.address : shown(x, kind))}</span>`;
  };
  // A setting by its name on the admin page, its key on hover.
  const name = (key: string) => `<span class="key" title="${esc(key)}">${esc(settings[key]?.label ?? key)}</span>`;
  const what = v.changes
    .map((c) =>
      c.task || c.release || c.stagingOverride || c.user || c.token || c.signIn || c.access
        ? eventItem(c)
        : c.credential
          ? `<li><span class="key">API key</span> <code>${esc(c.key)}</code> ${esc(c.credential)}</li>`
          : `<li>${name(c.key)} ${value(c.key, c.from)} <span class="to" aria-label="to">→</span> ${value(c.key, c.to)}${c.reset ? ` <span class="badge">reset</span>` : ""}</li>`
    )
    .join("");
  return `  <li class="change" data-n="${v.n}" data-live="change:${v.n}" data-sort="${v.n}">
    ${byHtml(v.by, v.via, avatars)}<ul class="what">${what}</ul><time datetime="${at}" title="${at.slice(0, 16).replace("T", " ")} UTC">${at.slice(0, 16).replace("T", " ")}</time>
  </li>`;
}

/** These versions' rows, newest first: each setting that names a document shows it by its address now, as /admin/settings does. */
async function changeRows(platform: Platform, versions: SettingsVersion[]): Promise<{ n: number; html: string }[]> {
  const settings = platform.directory.config.settings as Settings;
  const ids = new Set(
    versions
      .flatMap((v) => v.changes.filter((c) => settings[c.key]?.kind == "document").flatMap((c) => [c.from, c.to]))
      .filter((x) => x != null)
      .map(String)
  );
  const docs = new Map(
    (
      await Promise.all(
        [...ids].map(async (id) => {
          const doc = await platform.directory.find(id);
          return doc ? [[id, { address: addressOf(doc), title: doc.title }] as const] : [];
        })
      )
    ).flat()
  );
  const avatars = await platform.directory.users.avatars(versions.map((v) => v.by).filter((by) => by && by != SYSTEM));
  return versions.map((v) => ({ n: v.n, html: changeRow(v, settings, docs, avatars) }));
}

/** /admin/changes: the change log, every change to the settings, factory task added or merged, and production deploy, newest first (`before`: only those older than version n). */
export async function changesPage(platform: Platform, session: Session, before?: number) {
  const history = await platform.directory.config.history(whoOf(session), { before, limit: CHANGES });
  const rows = await changeRows(platform, history.versions);
  const last = history.versions.at(-1);
  const older = last && last.n > 1 && history.versions.length == CHANGES;
  return adminPage({
    session,
    title: "Change log",
    here: "changes",
    ...(history.total ? { lede: plural(history.total, "change") } : {}),
    body: `
  <ol class="changes"${before ? "" : ` data-live-kind="change" data-live-view="changes" data-live-at="${Date.now()}"`}${rows.length ? "" : " hidden"}>
${rows.map((r) => r.html).join("\n")}
  </ol>
  <p class="changes-empty"${rows.length ? " hidden" : ""}>${before ? "No older changes." : "No changes yet."}</p>
  ${before || older ? `<p class="changes-more">${before ? `<a href="${esc(link("/admin/changes", session))}">Newest</a>` : ""}${before && older ? " · " : ""}${older ? `<a href="${esc(link(`/admin/changes?before=${last!.n}`, session))}">Older changes</a>` : ""}</p>` : ""}
<script>
  ${TIMES_SCRIPT}${before ? "" : inlineCall("admin-changes")}
</script>`,
  });
}

/** The rows of /admin/changes that `keys` name ("change:<n>"), among the newest, for an open page (server/news/). */
export const changesRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  const { versions } = await platform.directory.config.history(whoOf(session), { limit: CHANGES });
  for (const r of await changeRows(
    platform,
    versions.filter((v) => `change:${v.n}` in out)
  ))
    out[`change:${r.n}`] = { html: r.html, sort: r.n };
  return out;
};
