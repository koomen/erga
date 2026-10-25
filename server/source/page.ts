// The Ops page, /admin/ops, for admins with admin access: the one place to
// manage Erga's environments, its Cloudflare credential, its own source and
// its deploys. It has the layout every admin page shares: the breadcrumb,
// Share with agent, the admin's agent and the sidebar. /admin/ops,
// /source, /admin/factory and /admin/deploys redirect here.
//
// Status, at the top: one card for each environment (production, staging,
// the control Worker): its state, when, the commit that is live, and its
// latest deploy's log, and Retry when its deploy failed. And the control
// Worker's Cloudflare credential, fixed in place: when it is missing or
// Cloudflare refused it, the card shows Cloudflare's own words and Connect
// Cloudflare, a consent in a popup (control/routes.ts, /install/start?popup=1:
// on the control Worker's origin, which may not be this page's). The popup
// tells this page when it's done, and the event stream says so too; the
// deploys that waited for the credential go by themselves. Disconnect
// (POST /api/deploys/credential/disconnect) revokes it. No link elsewhere.
//
// Git Repository, below: how to clone and push, Merge
// and Cut release, then the git log:
//
// One list: staging's history, newest first (staging is always at or ahead
// of main, so it holds every commit main has). When staging is far ahead, a
// break ("… N more commits only on staging …") leaves commits out: above it,
// staging's head and the 10 before it; below it, the 5 commits just after
// main's head, then main's head and the 5 before it. The break shows only
// when it leaves at least one commit out (17 or more ahead). Beside it, one dot column,
// with no header: every commit listed is on staging; a solid green circle is
// on main too, a hollow orange circle only on staging. Then two deploy
// columns, staging and production: each target's deploys (GET
// /api/deploys?history=100), one beside each commit it deployed: its state
// as plain text (live, deployed, failed, cancelled, or running) and when.
// A commit deployed more than once shows one deploy: the running one, else
// the live one, else the newest (a redeploy cancels the attempt before it).
// Only the live deploy has a background. Each target's status is in its column's head. Any deploy opens
// its log, past or live (GET /api/deploys/<name>/log?deploy=<id>, then
// { type: "deploy-log" } events). Merge moves main forward to staging's
// head, or to the commit a row's "Merge to here" names. Above the log, how to clone and
// push. GitHub's card in Status says which repository is connected and how
// the sync stands (Connect GitHub, a popup; Sync now; Disconnect). Releases are tags:
// a tagged commit's row carries its version, "stable" on the newest release
// tag, and "edge" on the newest commit of main the store has (GET
// /api/releases). Cut release (beside Merge) cuts the next one: a dialog with
// the version (the next patch version, which the admin may change) and short
// notes, the tag's message (POST /api/source/release). It follows the
// system's light or dark.
//
// A downstream (an Erga on its own domain, forked from erga.dev's: the
// repository's `upstream`) sees its own environments and hosts, and where it
// stands against erga.dev: upstream's commits it doesn't have yet come first
// in the log, as their own kind of row (a hollow blue dot, no deploys), then a
// line says how many ("erga.dev: 12 commits (v0.15.0) that you do not have ·
// 3 commits of your own"); its own commits (not on erga.dev) carry "yours".
// Update from erga.dev (POST /api/source/update) merges upstream's channel
// into staging; when files conflict, a box lists them and the two ways out
// (the admin agent, or a merge in a checkout pushed to staging), and Drop.
// Each environment's card lists its domains (GET /api/domains), with Add and
// remove (POST and DELETE), through the instance's own Cloudflare grant.
//
// It updates by itself, with no reload: /api/events (a WebSocket) says what changed (a push
// or a merge, the sync with GitHub, each step of a deploy, a redeploy, its log lines),
// for this server and for Erga's other server too (deploy/relay.ts passes each
// server's events to the other). Only rows that changed are drawn again, so
// the scroll, an open log or dialog, and the focus stay.

import { SOURCE_SCRIPT } from "./page-script.ts";
import { esc, page as plainPage } from "../pages/index.ts";
import type { Session } from "../platform";
import { adminResponse, type AdminLayout } from "../admin/index.ts";
import { CONTROL, SOURCE, TARGETS } from "../../deploy/targets.ts";

export interface SourcePageConfig {
  session: Session;
  admin: boolean;
  /** Whether this server has a repository (an Artifacts binding, or local development's stand-in). */
  ready: boolean;
  /** The control Worker's origin: the Git address, and where the consents (Connect Cloudflare, Connect GitHub) open. */
  origin: string;
  /** Each environment's hostname, as the fleet has them (deploy/fleet.ts): erga.dev's own (deploy/targets.json) unless given. */
  hosts?: Record<"production" | "staging" | "control", string>;
  /** A downstream: where upstream is (the page names it on Update, and in the clone box). */
  upstream?: string;
  /** The page's shell: the admin layout (the app, in local development), or the control Worker's own (control/routes.ts). */
  layout?: (o: AdminLayout) => Response;
}

/** The source pane: the commits with their deploys, Merge, how to clone; or how to set it up. */
function sourceMarkup(c: SourcePageConfig): string {
  if (!c.ready) {
    return `<div class="pane-head"><h2>Git Repository</h2></div>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. The steps:</p>
  <ol><li>Make the Artifacts repo <code>${esc(SOURCE.repo)}</code> in the namespace <code>${esc(SOURCE.namespace)}</code> (deploy/targets.json: source).</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=${esc(SOURCE.namespace)}</code>, which adds the binding.</li><li>Push the history in: <code>bun server/source/import.ts</code>.</li></ol></div>`;
  }
  const remote = `${c.origin}/git/erga.git`;
  const hosts = c.hosts ?? { production: TARGETS.production.host, staging: TARGETS.staging.host, control: CONTROL.host };
  const upstreamName = c.upstream ? esc(c.upstream.replace(/^https?:\/\//, "").replace(/^ops\./, "")) : "upstream";
  const target = (name: string, label: string, host: string) => `<div class="head deploy"><button class="target" type="button" id="target-${name}" data-target="${name}" disabled title="Loading"><b>${label}</b><span class="host">${esc(host)}</span><span class="st"><i></i><span>…</span></span></button></div>`;
  const env = (name: string, label: string, host: string) => `<div class="env" id="env-${name}" data-target="${name}"><div class="env-top"><b>${label}</b><a class="host" href="https://${esc(host)}" target="_blank" rel="noopener">${esc(host)}</a></div><span class="st"><i></i><span>…</span></span><span class="env-more"><code class="env-commit"></code><button class="env-retry" type="button" data-retry="${name}" hidden title="Deploys this environment's branch head again">Retry</button><button class="env-log" type="button" data-target="${name}" hidden>Log</button></span><div class="env-domains" id="domains-${name}" hidden></div></div>`;
  return `
  <section class="ops-section" id="status" aria-labelledby="status-head">
    <h2 id="status-head">Status</h2>
    <h3>Environments</h3>
    <div class="envs">${env("production", "Production", hosts.production)}${env("staging", "Staging", hosts.staging)}${env("control", "Control", hosts.control)}</div>
    <h3>Cloudflare and GitHub</h3>
    <div class="services">
    <div class="env cloudflare" id="env-cloudflare" data-connect="${esc(`${c.origin}/install/start?popup=1`)}"><div class="env-top"><b>Deploy credential</b></div><span class="st"><i></i><span id="cloudflare-state">…</span></span><p class="cf-why" id="cloudflare-why" hidden></p><span class="env-more"><button class="new cf-connect" type="button" id="cloudflare-connect" hidden>Connect Cloudflare</button><button class="env-log" type="button" id="cloudflare-disconnect" hidden title="Revokes the grant on Cloudflare. Nothing deploys until an admin connects again.">Disconnect</button></span><p class="cf-note" id="cloudflare-note" role="status" hidden></p></div>
    <div class="env github" id="env-github" data-connect="${esc(`${c.origin}/github/connect?popup=1`)}"><div class="env-top"><b>GitHub</b><a class="host" id="github-repo" href="#" target="_blank" rel="noopener" hidden></a></div><span class="st"><i></i><span id="github-state">…</span></span><p class="cf-why" id="github-why" hidden></p><span class="env-more"><button class="new cf-connect" type="button" id="github-connect" hidden>Connect GitHub</button><button class="env-log" type="button" id="github-sync" hidden title="Syncs now: what GitHub has comes in, what it lacks goes out.">Sync now</button><button class="env-log" type="button" id="github-disconnect" hidden title="Forgets the repository and uninstalls Erga's GitHub App from the account. The repository on GitHub stays.">Disconnect</button></span><p class="cf-note" id="github-note" role="status" hidden></p></div>
    </div>
  </section>
  <section class="ops-section" id="repo" aria-labelledby="repo-head">
  <div class="pane-head">
    <div class="head-title"><h2 id="repo-head">Git Repository</h2></div>
  </div>
  <p class="repo-note">${c.upstream ? `This Erga's source repository is a fork of ${upstreamName}'s, stored in a <a href="https://developers.cloudflare.com/artifacts/" target="_blank" rel="noopener">Cloudflare Artifact</a>: it can have commits of its own, and Update brings ${upstreamName}'s in.` : `Erga's source repository is self-managed and stored in a <a href="https://developers.cloudflare.com/artifacts/" target="_blank" rel="noopener">Cloudflare Artifact</a>.`}</p>
  <div class="box conflict" id="conflict-box" hidden>
    <h2><span id="conflict-title">Update from ${upstreamName} stopped</span>: <span id="conflict-count"></span></h2>
    <p><span id="conflict-intro">The merge of <b id="conflict-version"></b> into staging conflicts in these files.</span> Staging is unchanged. The merge, with Git's conflict markers, waits on the branch <code id="conflict-branch"></code>.</p>
    <ul id="conflict-files"></ul>
    <div class="ways">
      <div><h3>Your admin agent resolves it</h3><p>Ask it, on any admin page: <i id="conflict-ask">resolve the update from ${upstreamName}</i>. It reads each file on that branch, writes the resolution, and finishes the merge: staging deploys it.</p></div>
      <div><h3>Your own coding agent resolves it</h3><p id="conflict-how">In a checkout, merge ${upstreamName}'s commit, resolve, and push to staging:</p><pre><code id="conflict-git"></code></pre></div>
    </div>
    <div class="buttons"><button class="pill" id="conflict-drop" type="button" title="Drops the waiting merge and its branch. Staging stays as it is.">Drop this merge</button><span class="hint" id="conflict-hint" role="status"></span></div>
  </div>
  <div class="repo-tools">
  <div class="box clone" id="clone">
    <h2>Clone and push</h2>
    <pre><code>git remote add erga ${esc(remote)}
git fetch erga
git push erga HEAD:staging</code></pre>
    <p>Password: an agent token from <a href="/settings">Settings</a> (admins only), any username. main only follows staging: merge here.</p>
  </div>
  <div class="box actions"><h2>Branches and releases</h2>
    <div class="head-actions"><button class="pill" id="release-pill" type="button" hidden title="Cut a release: a version tag on main's head. The newest release tag is stable, what other installs follow.">Cut release</button><div class="merge-row" id="merge-row" hidden><span class="count" id="ahead"></span><button class="new" id="merge" disabled>Merge staging into main</button></div></div>
    <p class="hint" id="merge-hint" role="status"></p>
    <div class="update-row" id="update-row" hidden><span class="count" id="upstream-count"></span><button class="new" id="update" disabled title="Brings ${upstreamName}'s newest release into staging: a fast-forward, or a merge commit. Production follows through Merge.">Update from ${upstreamName}</button></div>
    <p class="hint" id="update-hint" role="status"></p>
  </div>
  </div>
  <section class="card" aria-label="Commits">
    <div class="legend"><span class="up-only" id="legend-upstream" hidden><i class="dot upstream"></i>on ${upstreamName}, not here yet</span><span><i class="dot staging-only"></i>only on staging</span><span><i class="dot on-main"></i>on main too</span></div>
    <div class="grid" id="grid">
      <div class="head"></div>
      <div class="head" style="padding-left:6px">Commit</div><div class="head who-h"></div><div class="head sha-h"></div><div class="head time-h"></div>
      ${target("staging", "staging", TARGETS.staging.host)}${target("production", "production", TARGETS.production.host)}${target("control", "control", CONTROL.host)}
      <div class="none" id="loading">Loading…</div>
    </div>
  </section>
  </section>
  <dialog id="domain-dlg" aria-labelledby="domain-title">
    <h2 id="domain-title">Add a domain</h2>
    <p>A hostname on one of this account's Cloudflare zones, for <b id="domain-env"></b>. Cloudflare routes it to the environment's Worker and makes its DNS record and certificate (a minute or two).</p>
    <label>Hostname<input id="domain-host" autocomplete="off" spellcheck="false" placeholder="docs.example.com"></label>
    <div class="buttons"><span id="domain-status" role="status" aria-live="polite"></span><button type="button" id="domain-cancel">Cancel</button><button type="button" class="primary" id="domain-go">Add</button></div>
  </dialog>
  <dialog id="release-dlg" aria-labelledby="release-title">
    <h2 id="release-title">Cut a release</h2>
    <p>A release is a version tag on main's head: <code id="release-head"></code>. The newest release tag is <b>stable</b>, what other installs of Erga follow; they upgrade to it once its build is in the store. <code>git push erga vX.Y.Z</code> does the same.</p>
    <label>Version<input id="release-version" autocomplete="off" spellcheck="false"></label>
    <label>Notes (the tag's message; optional)<textarea id="release-notes" placeholder="What this release brings, in a few lines"></textarea></label>
    <div class="buttons"><span id="release-status" role="status" aria-live="polite"></span><button type="button" id="release-cancel">Cancel</button><button type="button" class="primary" id="release-go">Cut release</button></div>
  </dialog>
  <dialog id="deploy-log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill rollback" type="button" id="log-rollback" hidden>Roll back</button><button class="pill close" type="button" id="log-close">Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>
`;
}

/** /admin/ops: the source and deploy dashboard (admins). */
export function adminSourcePage(c: SourcePageConfig): Response {
  if (!c.admin) return plainPage("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  return (c.layout ?? adminResponse)({ session: c.session, title: "Ops", here: "ops", wide: true, body: `
  <div class="panes">
    <section class="pane" id="source-pane" aria-label="Ops">${sourceMarkup(c)}</section>
  </div>
${c.ready ? `<script>${SOURCE_SCRIPT}</script>` : ""}` });
}
