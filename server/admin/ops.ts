// /admin/ops, the Ops page: this server's own deploys, for this server only. It draws the view that the ops page of a
// machine draws for an instance (shared/ops-view.ts; `bun erga`): the last commits of the branch that the server
// tracks, with Deploy on a row and Roll back on the live one, each job's log, and the history. The facts are the
// instance's own (server/directory/deploys.ts): its job log, and what its deployer in the cloud wrote at its last
// look. The server deploys nothing: Deploy, Roll back and the Auto-deploy switch are the operation deploy
// (server/operations/deploys.ts), an ask that the deployer starts within a minute.
//
// A server with no deployer deploys from a machine: the page says so, and shows its jobs, with no commits and no
// button. The page's script (client/inline/admin-ops.ts) draws the live part again (GET /admin/ops/view) while the
// page is open.

import { esc } from "../../shared/html.ts";
import { type InstanceView, instanceHtml } from "../../shared/ops-view.ts";
import { timeAgo } from "../../shared/time.ts";
import type { DeployState } from "../directory/index.ts";
import { inlineCall } from "../pages/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";

/** How often the page asks again: while a job runs or an ask waits, and else. */
const BUSY_MS = 1000;
const IDLE_MS = 10_000;

/** What a server with no deployer says: here, and in the operations (server/operations/deploys.ts). */
export const noDeployer = (host: string) =>
  `No deployer in the cloud deploys ${host}: its deploys come from a machine (bun erga deploy ${host}).`;

/** The Auto-deploy switch, as a setting's row. */
const autoRow = (state: DeployState) =>
  `<ol class="rows" aria-label="Auto-deploy"><li class="setting" data-control="switch">
    <div class="about"><div class="head"><label class="key" for="auto-deploy">Auto-deploy</label></div><p class="desc">Each new release of ${esc(state.tracks?.branch ?? "the branch")} deploys by itself.</p></div>
    <div class="value"><label class="switch"><input type="checkbox" role="switch" id="auto-deploy"${state.auto ? " checked" : ""}><span class="track" aria-hidden="true"></span><span class="state" aria-hidden="true">${state.auto ? "On" : "Off"}</span></label></div>
    <p class="hint" role="status"></p>
  </li></ol>`;

/** The deployer's last look, in one line under the commits. */
function looked(look: NonNullable<DeployState["look"]>, now: number): string {
  const what = look.error
    ? `The deployer's look at GitHub, ${esc(timeAgo(look.at, now))}: <span class="s-err">${esc(look.error)}</span>`
    : `GitHub, by the deployer, ${esc(timeAgo(look.at, now))}`;
  const cls = look.error ? "bad" : "ok";
  return `<p class="checked" aria-label="Checks"><span>Checked:</span><span class="check ${cls}"><i class="light ${cls}"></i>${what}</span></p>`;
}

/** The page's live part: the Auto-deploy switch and the view, as they are now. */
export async function opsLive(platform: Platform, session: Session, url: URL, now = Date.now()): Promise<string> {
  const who = whoOf(session);
  const deploys = platform.directory.deploys;
  const state = await deploys.state(who, now);
  const host = url.host;
  if (!state.tracks)
    return `<p class="lede">${esc(host)} has no deploy spec yet: its next deploy from a machine writes it (bun erga deploy ${esc(host)}).</p>`;
  const tab = url.searchParams.get("tab") ?? "";
  const id = url.searchParams.get("job") ?? "";
  // Logs shows one job: the one named, else the one that runs, else the last one (shared/ops-view.ts, logs). Only its log is read.
  const shown =
    tab == "logs" ? (state.jobs.find((j) => String(j.id) == id) ?? state.jobs.find((j) => j.phase == "running") ?? state.jobs[0]) : null;
  const log = shown ? await deploys.log(who, shown.id) : null;
  const runs = platform.deploy.version;
  const ask = state.ask;
  const running = state.jobs.filter((j) => j.phase == "running");
  const view: InstanceView = {
    host,
    heading: false,
    repo: state.tracks.repo,
    branch: state.tracks.branch,
    commits: state.commits.length ? state.commits.map((c) => ({ sha: c.sha, subject: c.title, at: c.at, release: c.release })) : null,
    none: state.look ? (state.look.error ?? `The deployer has not seen the commits of ${state.tracks.branch} yet.`) : noDeployer(host),
    runs,
    lost: `${host} runs ${runs}, which is not one of the last ${state.commits.length} commits of ${state.tracks.branch}.`,
    jobs: state.jobs.map((j) => ({
      id: String(j.id),
      commit: j.commit,
      phase: j.phase,
      command: j.command,
      from: j.from,
      started: new Date(j.started).toISOString(),
      ...(j.phase == "running" ? {} : { ended: new Date(j.ended).toISOString() }),
      ...(j.error ? { error: j.error } : {}),
      out: j.id == shown?.id && log ? log.split("\n").slice(0, -1) : [],
    })),
    starting: ask
      ? {
          command: ask.kind == "deploy" ? `deploy ${ask.sha!.slice(0, 12)}` : "rollback",
          what: `asked by ${ask.by} · the deployer starts it at its next look`,
        }
      : null,
    failed: null,
    busy: running.length > 0 || !!ask,
    deploying: [...running.flatMap((j) => (j.kind == "deploy" && j.commit ? [j.commit] : [])), ...(ask?.sha ? [ask.sha] : [])],
    rolling: running.some((j) => j.kind == "rollback") || ask?.kind == "rollback",
    rollbackNote: "No branch moves. The next deploy goes forward again.",
    bottom: state.look ? looked(state.look, now) : "",
    href: (to, job) => `/admin/ops${to == "deploys" ? "" : `?tab=${to}${job ? `&job=${encodeURIComponent(job)}` : ""}`}`,
  };
  const wait = view.busy ? BUSY_MS : IDLE_MS;
  return `${state.look ? autoRow(state) : ""}<div class="ops-view" id="ops" data-wait="${wait}">${instanceHtml(view, tab, id, now)}</div>`;
}

/** /admin/ops. */
export async function opsPage(platform: Platform, session: Session, url: URL) {
  const runs = platform.deploy.version;
  return adminPage({
    session,
    title: "Ops",
    here: "ops",
    lede: `${url.host} runs ${runs ?? "no release that it knows"}.`,
    body: `
  <div id="ops-live">${await opsLive(platform, session, url)}</div>
<script>${inlineCall("admin-ops")}</script>`,
  });
}
