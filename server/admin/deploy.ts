// /admin/deploy, the Deploy page: this server's own deploys, for this server only. It draws the view that the ops page of a
// machine draws for an instance (shared/ops-view.ts; `bun erga`): the last commits of the branch that the server
// tracks, with Deploy on a row and Roll back on the live one, each job's log, and the history. The facts are the
// instance's own (server/directory/deploys.ts): its job log, and what its deployer in the cloud wrote at its last
// look. The server deploys nothing: Deploy, Roll back and the Auto-deploy switch are the operation deploy
// (server/operations/deploys.ts), an ask that the deployer starts within a minute.
//
// The deployer holds a token for this server's Worker and its own, which a person gives it: on a new server's setup page, and
// here after that (tokenSection, POST /admin/deploy/token: server/admin/routes.ts). The server hands the token to the
// deployer and keeps nothing of it; the deployer checks it, and the page shows its answer.
//
// Where the deployer is now is one value (shared/deployer.ts, deployerNow): the Auto-deploy row, each button and the
// token's section all come from it, so they agree. With no token the deployer looks at GitHub and deploys nothing:
// the row says that it waits for a token, with the saved mode still shown, and the control and the buttons are off.
//
// A server with no deployer deploys from a machine: the page says so, and what it knows of that machine's
// auto-deploy, and shows its jobs, with no commits and no button. The page's script (client/inline/admin-deploy.ts)
// draws the live part and the token section's words again (GET /admin/deploy/view) while the page is open.

import { autoText, blocked, AWAY, type Deployer, deployerOf, deploys, NO_TOKEN, tokenText } from "../../shared/deployer.ts";
import { esc } from "../../shared/html.ts";
import { type InstanceView, instanceHtml } from "../../shared/ops-view.ts";
import { timeAgo } from "../../shared/time.ts";
import type { AutoDeployMode, DeployState } from "../directory/index.ts";
import { TOKEN_FIELD, tokenSteps } from "../identity/index.ts";
import { inlineCall, link } from "../pages/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";

/** How often the page asks again: while a job runs or an ask waits, and else. */
const BUSY_MS = 1000;
const IDLE_MS = 10_000;

const AUTO_OPTIONS: readonly { mode: AutoDeployMode; label: string }[] = [
  { mode: "off", label: "Off" },
  { mode: "releases", label: "Releases only" },
  { mode: "commits", label: "Every commit" },
];

/**
 * Where the server's deployer is now: the one value that this page and the operations (server/operations/deploys.ts)
 * decide with. `looked`: a deployer looked at GitHub lately (DeployState, look). It asks the deployer about its token.
 */
export const deployerNow = async (platform: Platform | undefined, looked: boolean): Promise<Deployer> =>
  deployerOf(looked, platform?.deploy.deployer ? await platform.deploy.deployer.ask() : null);

/**
 * Where auto-deploy runs for a server with no deployer, here and in the read (server/operations/deploys.ts). It is
 * then a machine's (`bun erga --auto-deploy`), which the server can't ask: all that the server knows is where its
 * last deploy came from (its job log).
 */
export function machineAuto(jobs: DeployState["jobs"], now: number): string {
  const last = jobs.find((j) => j.kind == "deploy");
  const how = "Install the cloud deployer to control it here (bun erga setup, with --deploys cloud).";
  if (last?.from == "auto-deploy")
    return `Auto-deploy: on at the last deploy (${timeAgo(last.started, now)}), from a machine (bun erga --auto-deploy). This server can't know whether it is on now. ${how}`;
  const from = last?.from == "page" ? "the ops page of a machine" : last?.from.startsWith("app") ? "the app" : `a ${last?.from}`;
  const seen = last ? `its last deploy came from ${from}, ${timeAgo(last.started, now)}` : "its job log has no deploy";
  return `Auto-deploy: not known. It runs on a machine (bun erga --auto-deploy), which this server can't ask: ${seen}. ${how}`;
}

/**
 * The Auto-deploy setting row: Off, Releases only, or Every commit. With a deployer that can't deploy, the control is
 * off, the saved mode stays marked, and the row says what the deployer waits for.
 */
const autoRow = (state: DeployState, at: Deployer["at"], branch: string) => {
  const off = deploys(at) ? "" : " disabled";
  const buttons = AUTO_OPTIONS.map(
    (o) => `<button type="button" role="radio" aria-checked="${state.auto == o.mode}" data-auto-mode="${o.mode}"${off}>${o.label}</button>`
  ).join("");
  return `<ol class="rows" aria-label="Auto-deploy"><li class="setting" data-control="auto-mode" data-deployer="${at}">
    <div class="about"><div class="head"><span class="key" id="auto-deploy-label">Auto-deploy</span></div><p class="desc" data-auto-desc data-branch="${esc(branch)}">${esc(autoText(at, state.auto, branch))}</p></div>
    <div class="value"><div class="seg" id="auto-deploy" role="radiogroup" aria-labelledby="auto-deploy-label">${buttons}</div></div>
    <p class="hint" role="status"></p>
  </li></ol>`;
};

/** The deployer's last look, in one line under the commits. */
function looked(look: NonNullable<DeployState["look"]>, now: number): string {
  const what = look.error
    ? `The deployer's look at GitHub, ${esc(timeAgo(look.at, now))}: <span class="s-err">${esc(look.error)}</span>`
    : `GitHub, by the deployer, ${esc(timeAgo(look.at, now))}`;
  const cls = look.error ? "bad" : "ok";
  return `<p class="checked" aria-label="Checks"><span>Checked:</span><span class="check ${cls}"><i class="light ${cls}"></i>${what}</span></p>`;
}

/** The label of the token's form, which the page's script sets again with the words (data-give). */
const give = (at: Deployer["at"]) => (at == "ready" ? "Give the deployer another token" : "Give the deployer a token");

/**
 * The token section's words, for a server that has a deployer to ask: whether it holds a token, and what it does with
 * the saved mode. The page's script draws them again, and sets the mode's words (data-token-does) at a click.
 */
function tokenLede(d: Deployer, mode: AutoDeployMode, branch: string): string {
  const does = `<span data-token-does>${esc(tokenText(d.at, mode, branch))}</span>`;
  const says =
    d.at == "ready"
      ? `The deployer holds a token${d.head ? `, and is at <code>${esc(d.head.slice(0, 12))}</code>` : ""}. ${does}`
      : d.at == "waits"
        ? `<b>${NO_TOKEN}</b> Give it one below. ${does}`
        : esc(d.at == "silent" ? d.why : AWAY);
  return `<p class="lede" data-deployer="${d.at}" data-give="${give(d.at)}">${says}</p>`;
}

/** The page's parts that change by themselves: `html`, the Auto-deploy row and the view; `token`, the token section's words (null: no deployer to give one). */
export async function deployLive(
  platform: Platform,
  session: Session,
  url: URL,
  now = Date.now()
): Promise<{ html: string; token: string | null; deployer: Deployer }> {
  const who = whoOf(session);
  const jobs = platform.directory.deploys;
  const state = await jobs.state(who, now);
  const deployer = await deployerNow(platform, !!state.look);
  const at = deployer.at;
  const host = url.host;
  const token = platform.deploy.deployer ? tokenLede(deployer, state.auto, state.tracks?.branch ?? "its branch") : null;
  if (!state.tracks)
    return {
      html: `<p class="lede">${esc(host)} has no deploy spec yet: its next deploy from a machine writes it (bun erga deploy ${esc(host)}).</p>`,
      token,
      deployer,
    };
  const tab = url.searchParams.get("tab") ?? "";
  const id = url.searchParams.get("job") ?? "";
  // Logs shows one job: the one named, else the one that runs, else the last one (shared/ops-view.ts, logs). Only its log is read.
  const shown =
    tab == "logs" ? (state.jobs.find((j) => String(j.id) == id) ?? state.jobs.find((j) => j.phase == "running") ?? state.jobs[0]) : null;
  const log = shown ? await jobs.log(who, shown.id) : null;
  const runs = platform.deploy.version;
  const ask = state.ask;
  const running = state.jobs.filter((j) => j.phase == "running");
  const latest = state.latestRelease;
  const runsLatest = !!(runs && latest && latest.sha.startsWith(runs));
  const view: InstanceView = {
    host,
    heading: false,
    repo: state.tracks.repo,
    branch: state.tracks.branch,
    autoMode: state.look ? state.auto : undefined,
    latestRelease: latest,
    tracksMore: latest ? ` Latest release <code>${esc(latest.tag)}</code>.` : "",
    commits: state.commits.length
      ? state.commits.map((c) => ({ sha: c.sha, subject: c.title, at: c.at, release: c.release, ...(c.tag ? { tag: c.tag } : {}) }))
      : null,
    none: state.look
      ? (state.look.error ?? `The deployer has not seen the commits of ${state.tracks.branch} yet.`)
      : (blocked(at, host) ?? ""),
    runs,
    lost: runsLatest
      ? `${host} runs ${latest!.tag} (${runs}), which is older than the last ${state.commits.length} commits of ${state.tracks.branch}.`
      : `${host} runs ${runs}, which is not one of the last ${state.commits.length} commits of ${state.tracks.branch}.`,
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
    ...(deploys(at) ? {} : { off: blocked(at, host)! }),
    deploying: [...running.flatMap((j) => (j.kind == "deploy" && j.commit ? [j.commit] : [])), ...(ask?.sha ? [ask.sha] : [])],
    rolling: running.some((j) => j.kind == "rollback") || ask?.kind == "rollback",
    rollbackNote: "No branch moves. The next deploy goes forward again.",
    bottom: state.look ? looked(state.look, now) : "",
    href: (to, job) => `/admin/deploy${to == "deploys" ? "" : `?tab=${to}${job ? `&job=${encodeURIComponent(job)}` : ""}`}`,
  };
  const wait = view.busy ? BUSY_MS : IDLE_MS;
  const auto = at == "none" ? `<p class="lede">${esc(machineAuto(state.jobs, now))}</p>` : autoRow(state, at, state.tracks.branch);
  return { html: `${auto}<div class="ops-view" id="ops" data-wait="${wait}">${instanceHtml(view, tab, id, now)}</div>`, token, deployer };
}

/**
 * The deployer's token: `lede`, whether the deployer holds one and what it does (tokenLede, drawn again by the page's
 * script), and the form that gives it one, or another one. `refused`: why the deployer took no token just now, shown
 * at the field. The form is not drawn again: a field that a person types in stays as it is.
 */
function tokenSection(
  deployer: NonNullable<Platform["deploy"]["deployer"]>,
  at: Deployer["at"],
  lede: string,
  session: Session,
  refused?: string
) {
  return `
  <section class="deployer-token" aria-labelledby="token-head">
    <h3 class="sub-head" id="token-head">The deployer's token</h3>
    <div id="token-live">${lede}</div>
    <details${at != "ready" || refused ? " open" : ""}>
      <summary>${give(at)}</summary>
      ${tokenSteps(deployer.account, deployer.worker)}
      ${refused ? `<p class="failed" role="alert">${esc(refused)}</p>` : ""}
      <form method="post" action="${esc(link("/admin/deploy/token", session))}">
        ${TOKEN_FIELD}
        <button class="pill">Check the token</button>
      </form>
    </details>
  </section>`;
}

/** /admin/deploy. `refused`: why the deployer took no token just now (status 400). */
export async function deployPage(platform: Platform, session: Session, url: URL, refused?: string) {
  const runs = platform.deploy.version;
  const bound = platform.deploy.deployer;
  const { html, token, deployer } = await deployLive(platform, session, url);
  return adminPage(
    {
      session,
      title: "Deploy",
      here: "deploy",
      lede: `${url.host} runs ${runs ?? "no release that it knows"}.`,
      body: `
  <div id="deploy-live">${html}</div>${bound && token ? tokenSection(bound, deployer.at, token, session, refused) : ""}
<script>${inlineCall("admin-deploy")}</script>`,
    },
    refused ? 400 : 200
  );
}
