// The Ops page's script (control/source/page.ts, adminSourcePage): the git log with each environment's deploys, Merge,
// Update from upstream, the domains, GitHub, and their live updates. It runs on the app's /admin/ops and on the
// control Worker alike, inside the admin pages' one page (window.ergaView). Each action is an operation
// (control/operations.ts), run over POST /api/tools/<name> where the page is: the same ones the admin agent has.

import { esc as escText } from "../../shared/html";
import { runTool } from "../common/tools";

// The answers of the API are typed loosely (any): this page reads what the server sends and shows it.
type Json = any;

export default function ops(): void {
  // The admin pages are one page: what keeps running stops when another admin page is shown.
  const pageView = window.ergaView;
  const setInterval = (f: () => void, ms: number) => {
    const t = window.setInterval(f, ms);
    pageView.onLeave(() => clearInterval(t));
    return t;
  };
  const esc = (s: unknown) => escText(String(s ?? ""));
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
  const ago = (t: number) => {
    if (!t) return "";
    const s = (t - Date.now()) / 1000;
    if (s > -60) return "just now";
    if (s > -3600) return rtf.format(Math.round(s / 60), "minute");
    if (s > -86400) return rtf.format(Math.round(s / 3600), "hour");
    if (s > -30 * 86400) return rtf.format(Math.round(s / 86400), "day");
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const TARGETS = ["staging", "production", "control"];
  /** When staging is far ahead of main: how many of its newest commits show above the break, and how many of main's below it. */
  const GAP_TOP = 11,
    GAP_MAIN = 6;
  let view: Json = null,
    deploys: Json = null,
    deploysKnown = false,
    busy = false,
    drawn = false;
  const drawnRows = new WeakMap<HTMLElement, string>();
  const grid = byId("grid");
  const running = (state: string | undefined) => state == "building" || state == "deploying";
  const short = (t: number) => {
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    if (s < 30 * 86400) return Math.round(s / 86400) + "d";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const took = (r: Json) => {
    const ms = (r.ended ?? Date.now()) - r.started;
    return ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
  };
  const targetOf = (name: string): Json => deploys?.targets?.find((t: Json) => t.name == name) ?? null;
  /** A target's deploys by commit, newest first. */
  function byCommit(name: string) {
    const m = new Map<string, Json[]>();
    for (const r of targetOf(name)?.history ?? []) {
      if (!m.has(r.commit)) m.set(r.commit, []);
      m.get(r.commit)!.push(r);
    }
    return m;
  }
  /** The one deploy a commit shows in a target's column: the running one, else the live one, else the newest. */
  function shown(list: Json[]) {
    if (running(list[0].state)) return list[0];
    return list.find((r) => r.live) ?? list[0];
  }
  const WORD: Record<string, string> = {
    building: "building",
    deploying: "deploying",
    deployed: "deployed",
    failed: "failed",
    cancelled: "cancelled",
    "rolled-back": "rolled back",
  };
  function badge(name: string, r: Json) {
    const t = targetOf(name);
    const tip =
      (r.live ? "Live on " + (t?.host ?? name) + ". " : "") +
      r.state[0].toUpperCase() +
      r.state.slice(1) +
      " · " +
      r.commit.slice(0, 7) +
      " · " +
      r.trigger +
      "\n" +
      "Started " +
      new Date(r.started).toLocaleString() +
      (r.ended ? ", took " + took(r) : ", running for " + took(r)) +
      (r.error ? "\n" + r.error : "") +
      "\nClick for its log.";
    return (
      '<button class="dep ' +
      esc(r.state) +
      (r.live ? " live" : "") +
      '" type="button" data-target="' +
      name +
      '" data-deploy="' +
      esc(r.id) +
      '" title="' +
      esc(tip) +
      '">' +
      '<span class="w">' +
      esc(r.live ? "live" : WORD[r.state] || r.state) +
      '</span><span class="at">' +
      short(r.started) +
      "</span></button>"
    );
  }
  /** What a target shows on a commit's row: one deploy, or nothing. */
  function deployCell(name: string, sha: string, groups: Map<string, Json[]>) {
    const list = groups.get(sha);
    if (list) return badge(name, shown(list));
    // A server that sends no history: whether the commit is live.
    const t = targetOf(name);
    if (t && !t.history && (t.deployed ?? (t.state == "deployed" ? t.commit : null)) == sha)
      return '<span class="dep live" title="Live on ' + esc(t.host) + '"><span class="w">live</span><span class="at"></span></span>';
    return "";
  }

  /** A commit's release marks: its version tag (stable on the newest), and edge on the newest commit of main the store has; "yours" on a downstream's own commit. */
  function marks(sha: string, own: boolean) {
    const tags = (view.tags || []).filter((t: Json) => t.commit == sha);
    const out: string[] = [];
    if (own) out.push('<span class="rel own" title="' + esc("This instance's own commit: not on " + upstreamName()) + '">yours</span>');
    for (const t of tags) {
      const stable = t.name == view.release;
      out.push(
        '<span class="rel" title="' +
          esc(
            "Release " +
              t.name +
              (t.tagger ? " · " + t.tagger : "") +
              (t.at ? " · " + new Date(t.at).toLocaleString() : "") +
              (t.message && t.message != "Release " + t.name ? "\n" + t.message : "") +
              (stable ? "\nstable: what other installs follow" : "")
          ) +
          '">' +
          esc(t.name) +
          (stable ? '<span class="chan stable">stable</span>' : "") +
          "</span>"
      );
    }
    if (channels && channels.edge && channels.edge.latest && sha.startsWith(channels.edge.latest) && !tags.length)
      out.push('<span class="rel edge-only" title="edge: the newest commit of main in the release store">edge</span>');
    return out.join("");
  }
  const upstreamName = () =>
    String(view?.upstream?.origin || "upstream")
      .replace(/^https?:\/\//, "")
      .replace(/^ops\./, "");
  function render() {
    if (!view) return;
    const staging = view.branches.find((b: Json) => b.name == "staging"),
      main = view.branches.find((b: Json) => b.name == "main");
    const up = view.upstream || null;
    // Staging far ahead of main: its head and the GAP_TOP - 1 commits before it, a break that counts the commits left out,
    // the commits just after main's head (afterMain), then main's head and the GAP_MAIN - 1 behind it, so the list shows
    // where production is. The break only when commits are left out; else staging's log, as always.
    const recent: Json[] = staging?.commits ?? [],
      ahead: number = staging?.ahead ?? 0,
      after: Json[] = staging?.afterMain ?? [];
    const only = recent.filter((x) => !x.inMain),
      top = only.slice(0, GAP_TOP);
    const hidden = Math.max(0, ahead - top.length - after.length);
    const ours =
      hidden && after.length
        ? [
            ...top,
            ...after.map((x) => ({ ...x, inMain: false })),
            ...(main?.commits ?? []).slice(0, GAP_MAIN).map((x: Json) => ({ ...x, inMain: true })),
          ]
        : recent;
    // A downstream: upstream's commits it doesn't have first, as their own kind of row, then the line that counts them.
    const theirs = (up?.commits ?? []).map((x: Json) => ({ ...x, upstream: true }));
    const commits: Json[] = [...theirs, ...ours];
    byId("loading")?.remove();
    const groups = Object.fromEntries(TARGETS.map((n) => [n, byCommit(n)]));
    // One row per commit, kept: a new commit fades in at the top, the oldest goes at the bottom.
    const rows = new Map([...grid.querySelectorAll<HTMLElement>(".row")].map((r) => [r.dataset.sha, r]));
    const want = new Set(commits.map((x) => x.sha));
    for (const [sha, r] of rows) if (!want.has(sha)) r.remove();
    grid.querySelector(".none.empty")?.remove();
    grid.querySelector(".gap")?.remove();
    if (!commits.length) {
      grid.insertAdjacentHTML("beforeend", '<div class="none empty">No commits yet. Push one: git push erga HEAD:staging</div>');
    }
    let prev: HTMLElement | null = null;
    commits.forEach((x, i) => {
      let r = rows.get(x.sha);
      if (!r) {
        r = document.createElement("div");
        r.dataset.sha = x.sha;
      }
      const kind = x.upstream ? "upstream" : x.inMain ? "on-main" : "staging-only";
      const next = commits[i + 1];
      r.className = "row " + kind;
      const above = i > 0,
        down = !!next || x.parents.length > 0,
        gapAfter = hidden && after.length && i == theirs.length + top.length - 1,
        lineAfter = x.upstream && i == theirs.length - 1;
      const where = x.upstream
        ? " · on " + upstreamName() + (up.version ? " (" + up.version + ")" : "") + ", not here yet"
        : x.inMain
          ? " · on main"
          : " · only on staging";
      const title =
        x.subject +
        "\n" +
        x.sha.slice(0, 10) +
        " · " +
        x.author +
        " · " +
        new Date(x.at).toLocaleString() +
        where +
        (x.own ? " · this instance's own" : "");
      const tail =
        '<span class="who">' +
        esc(x.author) +
        '</span><code class="sha">' +
        x.sha.slice(0, 7) +
        '</code><time datetime="' +
        new Date(x.at).toISOString() +
        '">' +
        ago(x.at) +
        "</time>";
      const html =
        '<span class="rail ' +
        (above ? "up " : "") +
        (down ? "down " : "") +
        kind +
        '"><i class="dot ' +
        kind +
        '" title="' +
        (x.upstream ? "On " + esc(upstreamName()) + ", not merged here yet" : x.inMain ? "On main (and staging)" : "Only on staging") +
        '"></i></span>' +
        '<span class="subj" title="' +
        esc(title) +
        '"><span>' +
        esc(x.subject) +
        "</span>" +
        marks(x.sha, !!x.own) +
        (x.inMain || x.upstream
          ? ""
          : '<button class="here" type="button" data-merge="' +
            x.sha +
            '" title="Move main forward to this commit: production deploys it">Merge to here</button>') +
        "</span>" +
        tail +
        TARGETS.map(
          (n) => '<span class="deps" data-target="' + n + '">' + (x.upstream ? "" : deployCell(n, x.sha, groups[n])) + "</span>"
        ).join("");
      // Only a row that changed is drawn again: a button with focus, or under the pointer, stays as it is.
      if (drawnRows.get(r) != html) {
        r.innerHTML = html;
        drawnRows.set(r, html);
      }
      grid.insertBefore(r, prev ? prev.nextSibling : byId("target-" + TARGETS[TARGETS.length - 1]).parentElement!.nextSibling);
      prev = r;
      if (lineAfter) {
        const g = document.createElement("div");
        g.className = "gap upstream-line";
        g.innerHTML =
          '<span class="rail"></span><span class="gap-text" title="Above: ' +
          esc(upstreamName()) +
          "'s commits this instance does not have yet. Update from " +
          esc(upstreamName()) +
          ' brings them into staging.">' +
          esc(positionText(up)) +
          "</span>";
        grid.insertBefore(g, prev.nextSibling);
        prev = g;
      }
      if (gapAfter) {
        const g = document.createElement("div");
        g.className = "gap";
        const n = hidden.toLocaleString() + " more commit" + (hidden == 1 ? "" : "s");
        g.innerHTML =
          '<span class="rail"></span><span class="gap-text" title="' +
          n +
          ' only on staging, not shown. Below: the commit main is at, which production deploys.">… ' +
          n +
          " only on staging …</span>";
        grid.insertBefore(g, prev.nextSibling);
        prev = g;
      }
    });
    renderUpstream(up);
    drawn = true;
    const mergeBtn = byId<HTMLButtonElement>("merge");
    // The Merge row is always there (it is how production deploys): disabled, and saying so, when main is at staging.
    // While a merge runs the button stays, disabled.
    byId("merge-row").hidden = !staging?.commit;
    byId("ahead").textContent = !staging?.commit
      ? ""
      : ahead
        ? ahead + " commit" + (ahead == 1 ? "" : "s") + " to merge"
        : "staging and production are the same";
    if (!busy) mergeBtn.disabled = !ahead;
    mergeBtn.title = ahead
      ? "Moves main to staging's head: production deploys it."
      : "Nothing to merge: main is at staging's head. Push to staging first.";
    // Cut release: when main has a commit; a downstream's releases are upstream's.
    const rp = byId("release-pill");
    if (rp) {
      rp.hidden = !main?.commit || !!up;
      rp.textContent = view.release ? "Cut release (" + view.release + " is stable)" : "Cut release";
    }
    renderGithub(view.github);
    renderConflict(view.conflict);
  }
  const conflictCount = (n: number) => (n == 1 ? "1 file conflicts" : n + " files conflict");
  /** "erga.dev: 12 commits (v0.15.0) that you do not have · 3 commits of your own". */
  function positionText(up: Json) {
    const n = (k: number, w: string) => k + " commit" + (k == 1 ? "" : "s") + w;
    const behind = up.behind
      ? upstreamName() + ": " + n(up.behind, " (" + (up.version || up.channel) + ") that you do not have")
      : "up to date with " + upstreamName() + (up.version ? " " + up.version : "");
    return behind + " · " + (up.own ? n(up.own, " of your own") : "no commits of your own");
  }
  /** The Update row, from the view's upstream (a downstream only). */
  function renderUpstream(up: Json) {
    const row = byId("update-row"),
      legend = byId("legend-upstream");
    row.hidden = !up;
    legend.hidden = !up;
    if (!up) return;
    const btn = byId<HTMLButtonElement>("update"),
      count = byId("upstream-count");
    const waiting = !!(view && view.conflict);
    count.textContent = up.error ? upstreamName() + " did not answer: " + up.error : positionText(up);
    if (!updating) btn.disabled = !up.behind || waiting;
    btn.title = waiting
      ? "A merge is waiting on conflicts: resolve or drop it first."
      : up.behind
        ? "Brings " +
          upstreamName() +
          "'s " +
          (up.version || "newest") +
          " into staging: a fast-forward, or a merge commit. Production follows through Merge."
        : "Nothing to update: staging has everything " + upstreamName() + "'s " + up.channel + " channel has.";
  }
  /** The merge waiting on conflicts (from upstream, or from GitHub): the files, and the two ways out. */
  function renderConflict(c: Json) {
    const box = byId("conflict-box");
    box.hidden = !c;
    if (!c) return;
    const gh = c.kind == "github";
    byId("conflict-title").textContent = gh ? "The sync from GitHub stopped" : "Update from " + upstreamName() + " stopped";
    byId("conflict-count").textContent = conflictCount(c.files.length);
    byId("conflict-intro").innerHTML = gh
      ? "GitHub's staging (<b>" +
        esc(c.target.slice(0, 7)) +
        "</b>) and staging here have each moved, and the merge conflicts in these files."
      : "The merge of <b>" + esc(c.version) + "</b> into staging conflicts in these files.";
    byId("conflict-branch").textContent = c.branch;
    byId("conflict-ask").textContent = gh ? "resolve the merge from GitHub" : "resolve the update from " + upstreamName();
    byId("conflict-how").textContent = gh
      ? "In a checkout of the GitHub repository, merge Erga's staging, resolve, and push to GitHub's staging (the sync brings it here):"
      : "In a checkout, merge " + upstreamName() + "'s commit, resolve, and push to staging:";
    byId("conflict-files").innerHTML = c.files
      .map((f: Json) => "<li><code>" + esc(f.path) + "</code> <span class='soft'>(" + esc(f.kind) + ")</span></li>")
      .join("");
    byId("conflict-git").textContent = (
      gh
        ? [
            "git fetch erga staging   # erga: this Erga's Git address, above",
            "git checkout staging      # GitHub's",
            "git merge FETCH_HEAD      # resolve the conflicts, then commit",
            "git push origin staging",
          ]
        : [
            "git fetch erga erga-upstream/main",
            "git checkout -B update erga/staging",
            "git merge FETCH_HEAD   # resolve the conflicts, then commit",
            "git push erga HEAD:staging",
          ]
    ).join("\n");
  }
  /** GitHub's card: the repository connected, the sync's state and its last error; Connect (a popup), Sync now, Disconnect. */
  function renderGithub(g: Json) {
    const card = byId("env-github");
    if (!g) return;
    const link = g.link;
    const busy = g.state == "syncing";
    card.className = "env github " + (!g.connected ? "" : g.error ? "failed" : "deployed");
    card.querySelector(".st i")!.className = busy ? "busy" : "";
    const repo = byId<HTMLAnchorElement>("github-repo");
    repo.hidden = !link;
    if (link) {
      repo.textContent = link.repo.fullName;
      repo.href = link.repo.htmlUrl;
    }
    byId("github-state").textContent = !g.connected
      ? "not connected"
      : busy
        ? "syncing…"
        : g.error
          ? "the last sync stopped"
          : g.lastSyncAt
            ? "in sync · " + ago(g.lastSyncAt) + (g.lastSyncBy ? ", for " + g.lastSyncBy : "")
            : "connected" + (link && link.by ? " by " + link.by : "");
    const why = byId("github-why");
    why.hidden = g.connected && !g.error;
    why.textContent = !g.connected
      ? "Connect a repository on GitHub: staging, main and the releases go there, and a push there comes back here."
      : g.error || "";
    const connect = byId("github-connect");
    connect.hidden = g.connected && !g.error;
    connect.textContent = link ? "Connect GitHub again" : "Connect GitHub";
    byId("github-sync").hidden = !g.connected;
    byId<HTMLButtonElement>("github-sync").disabled = busy;
    byId("github-disconnect").hidden = !g.connected;
    if (g.connected && githubAsked) githubConnected({ ok: true, repo: link ? link.repo.fullName : "" });
  }
  let updating = false;
  const updateHint = byId("update-hint");
  byId("update").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    updating = true;
    btn.disabled = true;
    updateHint.className = "hint";
    updateHint.textContent = "Updating from " + upstreamName() + "…";
    try {
      const body = await runTool("update_from_upstream");
      updateHint.textContent =
        body.result == "up-to-date"
          ? "Nothing to update: staging has everything."
          : body.result == "conflicts"
            ? "Stopped: " + conflictCount(body.conflict.files.length) + ". Staging is unchanged; see below."
            : (body.result == "fast-forward" ? "Fast-forwarded" : "Merged") +
              " " +
              body.version +
              " into staging (" +
              body.brought +
              " commit" +
              (body.brought == 1 ? "" : "s") +
              "): staging deploys it. Merge to production when it's good.";
      if (body.result == "conflicts") updateHint.className = "hint error";
    } catch (err) {
      updateHint.className = "hint error";
      updateHint.textContent = (err as Error).message;
    }
    updating = false;
    await load();
  });
  byId("conflict-drop").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement,
      hint = byId("conflict-hint");
    if (btn.dataset.armed != "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to drop it";
      setTimeout(() => {
        if (btn.dataset.armed == "1") {
          btn.dataset.armed = "";
          btn.textContent = "Drop this merge";
        }
      }, 8000);
      return;
    }
    btn.dataset.armed = "";
    btn.textContent = "Drop this merge";
    btn.disabled = true;
    hint.textContent = await runTool("drop_waiting_merge").then(
      () => "",
      (e: Error) => e.message
    );
    btn.disabled = false;
    await load();
  });

  // Each environment's domains (its Worker's custom domains), with Add and remove.
  let domains: Json = null;
  async function loadDomains() {
    const body = await runTool("list_domains").catch(() => null);
    if (pageView.signal.aborted) return;
    domains = body;
    renderDomains();
  }
  function renderDomains() {
    for (const n of TARGETS) {
      const el = byId("domains-" + n);
      const list: Json[] | undefined = domains && domains.targets && domains.targets[n];
      el.hidden = !list;
      if (!list) continue;
      el.innerHTML =
        list
          .map(
            (d) =>
              '<span class="dom' +
              (d.primary ? " primary" : "") +
              '" title="' +
              esc(d.hostname + (d.zone ? " · zone " + d.zone : "") + (d.primary ? " · the environment's own address" : "")) +
              '"><span>' +
              esc(d.hostname) +
              "</span>" +
              (d.primary
                ? ""
                : '<button type="button" data-remove="' +
                  esc(d.hostname) +
                  '" data-target="' +
                  n +
                  '" title="Remove this domain from ' +
                  n +
                  '" aria-label="Remove ' +
                  esc(d.hostname) +
                  '">×</button>') +
              "</span>"
          )
          .join("") +
        '<button class="add" type="button" data-add="' +
        n +
        '">+ Add domain</button>';
    }
  }
  const domDlg = byId<HTMLDialogElement>("domain-dlg");
  byId("status").addEventListener("click", async (e) => {
    const at = e.target as Element;
    const add = at.closest<HTMLButtonElement>("button[data-add]"),
      rm = at.closest<HTMLButtonElement>("button[data-remove]"),
      retry = at.closest<HTMLButtonElement>("button[data-retry]");
    if (retry) {
      retry.disabled = true;
      await runTool("redeploy", { target: retry.dataset.retry }).catch((e: Error) => {
        retry.disabled = false;
        retry.title = e.message;
        retry.textContent = "Retry (failed)";
      });
      await loadDeploys();
    }
    if (add) {
      domDlg.dataset.target = add.dataset.add;
      byId("domain-env").textContent = add.dataset.add!;
      byId<HTMLInputElement>("domain-host").value = "";
      byId("domain-status").textContent = "";
      byId("domain-status").className = "";
      byId<HTMLButtonElement>("domain-go").disabled = false;
      if (!domDlg.open) domDlg.showModal();
      byId("domain-host").focus();
    }
    if (rm) {
      if (rm.dataset.armed != "1") {
        rm.dataset.armed = "1";
        rm.textContent = "remove?";
        rm.parentElement!.style.borderColor = "var(--bad)";
        setTimeout(() => {
          if (rm.dataset.armed == "1") {
            rm.dataset.armed = "";
            rm.textContent = "×";
            rm.parentElement!.style.borderColor = "";
          }
        }, 6000);
        return;
      }
      rm.disabled = true;
      const failed = await runTool("remove_domain", { target: rm.dataset.target, hostname: rm.dataset.remove }).then(
        () => null,
        (e: Error) => e.message
      );
      if (failed) {
        rm.disabled = false;
        rm.title = failed;
        rm.textContent = "!";
        return;
      }
      await loadDomains();
    }
  });
  byId("domain-cancel").addEventListener("click", () => domDlg.close());
  byId("domain-go").addEventListener("click", async (e) => {
    const go = e.currentTarget as HTMLButtonElement;
    const status = byId("domain-status"),
      hostname = byId<HTMLInputElement>("domain-host").value.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
      status.className = "error";
      status.textContent = "A hostname looks like docs.example.com.";
      return;
    }
    go.disabled = true;
    status.className = "";
    status.textContent = "Adding " + hostname + "…";
    try {
      await runTool("add_domain", { target: domDlg.dataset.target, hostname });
      status.textContent = "Added. Cloudflare makes its DNS record and certificate in a minute or two.";
      await loadDomains();
      setTimeout(() => domDlg.close(), 1200);
    } catch (err) {
      status.className = "error";
      status.textContent = (err as Error).message;
      go.disabled = false;
    }
  });

  // The control Worker's Cloudflare credential, fixed here: Connect Cloudflare opens the consent in a popup, on the
  // control Worker's origin (data-connect). The popup posts its outcome back (and the event stream says the
  // credential changed); this page never leaves.
  const cf = byId("env-cloudflare"),
    cfNote = byId("cloudflare-note");
  const consentOrigin = new URL(cf.dataset.connect!, location.href).origin;
  let consentAsked = false;
  const note = (text: string, bad?: boolean) => {
    cfNote.hidden = !text;
    cfNote.textContent = text || "";
    cfNote.className = "cf-note" + (bad ? " bad" : "");
  };
  byId("cloudflare-connect").addEventListener("click", () => {
    const w = window.open(cf.dataset.connect, "erga-cloudflare-consent", "popup,width=600,height=760");
    if (!w) {
      note("The browser blocked the Cloudflare window. Allow pop-ups for this page, then click Connect Cloudflare again.", true);
      return;
    }
    consentAsked = true;
    note("Waiting for Cloudflare: finish the consent in the window that opened.");
  });
  function consented(m: Json) {
    consentAsked = false;
    if (m.ok)
      note(
        ["Connected." + (m.warnings && m.warnings.length ? "" : " A deploy that waited goes now; Retry starts one that failed.")]
          .concat(m.warnings || [])
          .join(" "),
        !!(m.warnings && m.warnings.length)
      );
    else note(m.error || "Cloudflare didn't connect.", true);
    loadDeploys();
  }
  window.addEventListener(
    "message",
    (e) => {
      if (!e.data || e.data.type != "erga-deploy-credential" || (e.origin != consentOrigin && e.origin != location.origin)) return;
      consented(e.data);
    },
    { signal: pageView.signal }
  );
  try {
    const bc = new BroadcastChannel("erga-deploy-credential");
    bc.onmessage = (e) => {
      if (e.data && e.data.type == "erga-deploy-credential") consented(e.data);
    };
    pageView.onLeave(() => bc.close());
  } catch {}
  byId("cloudflare-disconnect").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.dataset.armed != "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to disconnect";
      setTimeout(() => {
        if (btn.dataset.armed == "1") {
          btn.dataset.armed = "";
          btn.textContent = "Disconnect";
        }
      }, 8000);
      return;
    }
    btn.dataset.armed = "";
    btn.textContent = "Disconnect";
    btn.disabled = true;
    const failed = await runTool("disconnect_deploy_credential").then(
      () => null,
      (e: Error) => e.message
    );
    btn.disabled = false;
    note(failed ?? "Disconnected: the grant is revoked.", !!failed);
    loadDeploys();
  });
  function renderCredential() {
    const cred = deploys && deploys.credential;
    cf.className = "env cloudflare " + (!cred ? "" : cred.connected ? "deployed" : "failed");
    byId("cloudflare-state").textContent = !cred
      ? deploysKnown
        ? "unknown"
        : "…"
      : cred.connected
        ? "connected" + (cred.by ? " by " + cred.by : "")
        : "Nothing deploys: " + (cred.by ? "Cloudflare refused the grant." : "not connected.");
    // Cloudflare's own words: its answer to the last refresh, or why there's none.
    const why = byId("cloudflare-why");
    why.hidden = !cred || cred.connected;
    why.textContent = !cred || cred.connected ? "" : cred.error ? "Cloudflare said: " + cred.error : cred.problem || "";
    const connect = byId("cloudflare-connect");
    connect.hidden = !cred || cred.connected;
    connect.textContent = cred && cred.by ? "Connect Cloudflare again" : "Connect Cloudflare";
    byId("cloudflare-disconnect").hidden = !cred || !cred.connected;
    // Connected while the popup was out (the event stream heard it first, or the popup couldn't reach this page).
    if (cred && cred.connected && consentAsked) consented({ ok: true });
  }

  function renderTargets() {
    // Status: the control Worker's Cloudflare credential (an admin's OAuth grant), and each environment's state.
    renderCredential();
    for (const n of TARGETS) {
      const e = byId("env-" + n),
        t = targetOf(n);
      // A deploy that waits (for the credential): the target says so, with Cloudflare's reason in its tooltip.
      const waits = !!(t && t.pending && !running(t.state) && t.error);
      e.className = "env " + (t ? (waits ? "failed" : t.state) : "");
      const what = !t
        ? deploysKnown
          ? "not set up"
          : "…"
        : waits
          ? "waiting to deploy " + t.pending.slice(0, 7)
          : (
              {
                idle: "idle",
                building: "building",
                deploying: "deploying",
                deployed: "live",
                failed: "failed",
                cancelled: "cancelled",
              } as Record<string, string>
            )[t.state] || t.state;
      e.querySelector(".st span")!.textContent = what + (t?.at ? " · " + ago(t.at) : "");
      e.querySelector<HTMLElement>(".st")!.title = t?.error || "";
      e.querySelector(".env-commit")!.textContent = t?.deployed ? t.deployed.slice(0, 7) : "";
      e.querySelector<HTMLElement>(".env-log")!.hidden = !t;
      // Retry: a failed deploy, or one that waits while nothing stops it now.
      const retry = e.querySelector<HTMLButtonElement>(".env-retry")!;
      retry.hidden = !t || !(t.state == "failed" || (waits && deploys.credential && deploys.credential.connected));
      if (retry.hidden) retry.disabled = false;
      // The environment's own address, as the deploys know it (a fork's are its own, not erga.dev's).
      if (t?.host) {
        const a = e.querySelector<HTMLAnchorElement>(".env-top .host")!;
        a.textContent = t.host;
        a.href = "https://" + t.host;
        const h = document.querySelector("#target-" + n + " .host");
        if (h) h.textContent = t.host;
      }
    }
    for (const n of TARGETS) {
      const b = byId<HTMLButtonElement>("target-" + n),
        t = targetOf(n);
      b.className = "target " + (t ? t.state : "");
      b.disabled = !t;
      b.title = t
        ? t.host +
          ": " +
          t.state +
          (t.deployed ? ", live on " + t.deployed.slice(0, 7) : "") +
          (t.error ? " (" + t.error + ")" : "") +
          ". Click for the latest deploy's log."
        : deploysKnown
          ? "Deploys aren't set up yet"
          : "Loading";
      const what = !t
        ? deploysKnown
          ? "not set up"
          : "…"
        : (
            {
              idle: "idle",
              building: "building",
              deploying: "deploying",
              deployed: "live",
              failed: "failed",
              cancelled: "cancelled",
            } as Record<string, string>
          )[t.state] || t.state;
      b.querySelector(".st span")!.textContent = what + (t?.at ? " · " + ago(t.at) : "");
    }
    render();
  }

  async function load() {
    try {
      const body = await runTool("list_branches");
      if (pageView.signal.aborted) return;
      view = body;
      render();
    } catch (e) {
      const l = byId("loading");
      if (l) l.textContent = (e as Error).message;
    }
  }
  // Each change is an event, many while a deploy runs: the status and history are asked for at most every half second.
  let asking: Promise<void> | null = null,
    again = false;
  async function loadDeploys(): Promise<void> {
    if (asking) {
      again = true;
      return asking;
    }
    asking = (async () => {
      // A call that hangs ends: else it would hold every later status back (they wait for this one).
      const body = await Promise.race([
        runTool("list_deploys", { history: 100 }).catch(() => null),
        new Promise((ok) => setTimeout(() => ok(null), 15000)),
      ]);
      if (pageView.signal.aborted) return;
      // No answer (a server restarting into its new version, say): keep what's shown, and the poll below asks again.
      deploysKnown = true;
      if (body) deploys = body;
      renderTargets();
      if (open && !open.pinned) {
        const t = targetOf(open.target);
        if (t?.deployId && t.deployId != open.deployId) refreshLog(false);
      }
      await new Promise((ok) => setTimeout(ok, 500));
    })();
    await asking;
    asking = null;
    if (again) {
      again = false;
      loadDeploys();
    }
  }

  // A deploy's log: the latest one's from a column's head (it follows the next deploy), or any one's from its badge.
  const dlg = byId<HTMLDialogElement>("deploy-log"),
    pre = byId("log-lines");
  /** The log shown: its target, its deploy, pinned (a chosen deploy), the lines shown, its state, heard (when an event last came). */
  let open: { target: string; deployId: string | null; pinned: boolean; shown: number; state: string | null; heard: number } | null = null;
  const line = (l: Json) =>
    '<span class="t">' +
    esc(new Date(l.at).toLocaleTimeString()) +
    "</span> " +
    (l.step ? '<span class="s">[' + esc(l.step) + "]</span> " : "") +
    esc(l.text) +
    "\n";
  function append(lines: Json[]) {
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.insertAdjacentHTML("beforeend", lines.map(line).join(""));
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
  async function openLog(name: string, deployId?: string) {
    const t = targetOf(name);
    byId("log-title").textContent = (t?.host ?? name) + " deploy log";
    byId("log-meta").textContent = "";
    pre.textContent = "Loading…";
    open = { target: name, deployId: deployId ?? null, pinned: !!deployId, shown: 0, state: null, heard: 0 };
    if (!dlg.open) dlg.showModal();
    await refreshLog(true);
  }
  /** The log as the server has it now: what's new since what's shown (or all of it, for another deploy). */
  async function refreshLog(first: boolean) {
    if (!open) return;
    const name = open.target,
      want = open.pinned ? open.deployId : null;
    let missing = "";
    const log = await runTool("deploy_log", { target: name, ...(want ? { deploy: want } : {}), lines: 0 }).catch((e: Error) => {
      missing = e.message;
      return null;
    });
    if (pageView.signal.aborted) return;
    if (!open || open.target != name) return;
    if (!log || !log.deployId) {
      if (first) pre.textContent = want && missing ? "This deploy isn't in the history any more." : "No deploy log yet.";
      return;
    }
    const lines = log.lines || [];
    if (first || log.deployId != open.deployId) {
      pre.textContent = "";
      open.shown = 0;
    }
    open.deployId = log.deployId;
    open.state = log.state;
    const meta = byId("log-meta");
    meta.innerHTML = [
      log.commit ? "<b>" + esc(log.commit.slice(0, 7)) + "</b>" : "",
      log.live
        ? '<span class="live-on">live</span>'
        : '<span class="' + (log.state == "failed" ? "bad" : "") + '">' + esc(log.state) + "</span>",
      log.trigger ? esc(log.trigger) : "",
      log.started ? esc(new Date(log.started).toLocaleString()) + (log.ended ? " · took " + took(log) : "") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    meta.title = log.error || "";
    // Roll back: on the live deploy's log, when it has a restore point and nothing runs. Two clicks: the first arms it.
    const t = targetOf(name);
    const rb = byId<HTMLButtonElement>("log-rollback"),
      restore = log.restore || null;
    const can = !!(log.live && restore && restore.versionId && !running(log.state) && !running(t?.state));
    if (can && rb.dataset.deploy != log.deployId) {
      rb.dataset.armed = "";
      rb.textContent = "Roll back";
      rb.disabled = false;
    }
    rb.hidden = !can;
    rb.dataset.target = name;
    rb.dataset.deploy = log.deployId || "";
    rb.dataset.to = can ? (restore.version ? "release " + restore.version : "version " + restore.versionId.slice(0, 8)) : "";
    rb.title = can
      ? "Puts back what " +
        (t?.host ?? name) +
        " ran before this deploy (" +
        rb.dataset.to +
        "), in seconds, with no build. The database keeps its schema."
      : "";
    if (lines.length > open.shown) {
      append(lines.slice(open.shown));
      open.shown = lines.length;
    }
    if (first) pre.scrollTop = pre.scrollHeight;
  }
  byId("log-rollback").addEventListener("click", async (e) => {
    const rb = e.currentTarget as HTMLButtonElement;
    if (rb.dataset.armed != "1") {
      rb.dataset.armed = "1";
      rb.textContent = "Click again to roll back to " + rb.dataset.to;
      setTimeout(() => {
        if (rb.dataset.armed == "1") {
          rb.dataset.armed = "";
          rb.textContent = "Roll back";
        }
      }, 8000);
      return;
    }
    rb.disabled = true;
    rb.textContent = "Rolling back…";
    const meta = byId("log-meta");
    try {
      await runTool("rollback", { target: rb.dataset.target });
      // The log follows the target's latest deploy now: the rollback's.
      if (open) open.pinned = false;
      rb.hidden = true;
      rb.dataset.armed = "";
      rb.textContent = "Roll back";
      rb.disabled = false;
      loadDeploys();
      refreshLog(false);
    } catch (err) {
      meta.innerHTML = '<span class="bad">' + esc((err as Error).message) + "</span>";
      rb.dataset.armed = "";
      rb.textContent = "Roll back";
      rb.disabled = false;
    }
  });
  // Live lines come as events from the server running the deploy, passed on by the other server only while someone
  // listens there: while the deploy shown runs and no events arrive, ask for the log every two seconds.
  setInterval(() => {
    if (!open || !dlg.open) return;
    const t = targetOf(open.target);
    if (!(running(open.state ?? undefined) || (!open.pinned && running(t?.state)))) return;
    if (Date.now() - open.heard < 2500) return;
    refreshLog(false);
  }, 2000);
  for (const n of TARGETS) byId("target-" + n).addEventListener("click", () => openLog(n));
  for (const b of document.querySelectorAll<HTMLElement>(".env-log[data-target]"))
    b.addEventListener("click", () => openLog(b.dataset.target!));
  byId("log-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => {
    open = null;
  });
  grid.addEventListener("click", (e) => {
    const d = (e.target as Element).closest<HTMLElement>("button[data-deploy]");
    if (d) {
      openLog(d.dataset.target!, d.dataset.deploy);
      return;
    }
  });

  const hint = byId("merge-hint"),
    mergeBtn = byId<HTMLButtonElement>("merge");
  async function merge(commit: string | null | undefined) {
    busy = true;
    mergeBtn.disabled = true;
    hint.className = "hint";
    hint.textContent = "Merging…";
    try {
      await runTool("deploy_production", commit ? { commit } : {});
      hint.textContent = "";
    } catch (e) {
      hint.className = "hint error";
      hint.textContent = (e as Error).message;
    }
    busy = false;
    await load();
  }
  mergeBtn.addEventListener("click", () => merge(null));
  grid.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button[data-merge]");
    if (b) return merge(b.dataset.merge);
  });
  // GitHub, fixed here too: Connect GitHub opens the App's install page in a popup, on the control Worker's origin
  // (data-connect); the popup posts its outcome back (and the event stream says the repository changed).
  const gh = byId("env-github"),
    ghNote = byId("github-note");
  const ghOrigin = new URL(gh.dataset.connect!, location.href).origin;
  let githubAsked = false;
  const ghSay = (text: string, bad?: boolean) => {
    ghNote.hidden = !text;
    ghNote.textContent = text || "";
    ghNote.className = "cf-note" + (bad ? " bad" : "");
  };
  byId("github-connect").addEventListener("click", () => {
    const w = window.open(gh.dataset.connect, "erga-github-connect", "popup,width=720,height=820");
    if (!w) {
      ghSay("The browser blocked the GitHub window. Allow pop-ups for this page, then click Connect GitHub again.", true);
      return;
    }
    githubAsked = true;
    ghSay("Waiting for GitHub: pick the account and the repository in the window that opened.");
  });
  function githubConnected(m: Json) {
    githubAsked = false;
    if (m.ok)
      ghSay("Connected" + (m.repo ? " to " + m.repo : "") + "." + (m.warning ? " " + m.warning : " The first sync runs now."), !!m.warning);
    else ghSay(m.error || "GitHub didn't connect.", true);
    load();
  }
  window.addEventListener(
    "message",
    (e) => {
      if (!e.data || e.data.type != "erga-github" || (e.origin != ghOrigin && e.origin != location.origin)) return;
      githubConnected(e.data);
    },
    { signal: pageView.signal }
  );
  try {
    const bc = new BroadcastChannel("erga-github");
    bc.onmessage = (e) => {
      if (e.data && e.data.type == "erga-github") githubConnected(e.data);
    };
    pageView.onLeave(() => bc.close());
  } catch {}
  byId("github-sync").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    ghSay("Syncing…");
    let failed = "";
    const body = await runTool("sync_github").catch((e: Error) => {
      failed = e.message;
      return null;
    });
    btn.disabled = false;
    const g = body && body.github;
    ghSay(failed || (g && g.error) || "In sync.", !!(failed || (g && g.error)));
    await load();
  });
  byId("github-disconnect").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.dataset.armed != "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to disconnect";
      setTimeout(() => {
        if (btn.dataset.armed == "1") {
          btn.dataset.armed = "";
          btn.textContent = "Disconnect";
        }
      }, 8000);
      return;
    }
    btn.dataset.armed = "";
    btn.textContent = "Disconnect";
    btn.disabled = true;
    const failed = await runTool("disconnect_github").then(
      () => null,
      (e: Error) => e.message
    );
    btn.disabled = false;
    ghSay(failed ?? "Disconnected: the App is uninstalled from the account; the repository on GitHub stays.", !!failed);
    await load();
  });

  // The store's channels, for the marks on the log: edge's latest, and stable.
  let channels: Json = null;
  async function loadReleases() {
    const body = await runTool("list_releases").catch(() => null);
    if (pageView.signal.aborted) return;
    channels = body;
    render();
  }
  // Cut release: the next version suggested, the notes as the tag's message.
  const relDlg = byId<HTMLDialogElement>("release-dlg");
  function nextVersion(latest: string | undefined) {
    const m = latest && /^v(\d+)\.(\d+)\.(\d+)$/.exec(latest);
    return m ? "v" + m[1] + "." + m[2] + "." + (Number(m[3]) + 1) : "v0.1.0";
  }
  byId("release-pill")?.addEventListener("click", () => {
    const main = view?.branches.find((b: Json) => b.name == "main");
    byId("release-head").textContent = main?.commit ? main.commit.slice(0, 10) + " · " + (main.commits[0]?.subject ?? "") : "";
    byId<HTMLInputElement>("release-version").value = nextVersion(view?.release);
    byId<HTMLTextAreaElement>("release-notes").value = "";
    byId("release-status").textContent = view?.release ? "The newest release is " + view.release + "." : "The first release.";
    byId("release-status").className = "";
    byId<HTMLButtonElement>("release-go").disabled = false;
    if (!relDlg.open) relDlg.showModal();
  });
  byId("release-cancel").addEventListener("click", () => relDlg.close());
  byId("release-go").addEventListener("click", async (e) => {
    const go = e.currentTarget as HTMLButtonElement;
    const status = byId("release-status");
    const version = byId<HTMLInputElement>("release-version").value.trim(),
      notes = byId<HTMLTextAreaElement>("release-notes").value.trim();
    if (!/^v\d+\.\d+\.\d+$/.test(version)) {
      status.className = "error";
      status.textContent = "A version looks like v1.2.3.";
      return;
    }
    go.disabled = true;
    status.className = "";
    status.textContent = "Cutting " + version + "…";
    try {
      const body = await runTool("cut_release", { version, ...(notes ? { notes } : {}) });
      status.textContent =
        "Release " + body.tag + " cut at " + body.commit.slice(0, 10) + ". It goes on stable once its build is in the store.";
      await load();
      loadReleases();
      setTimeout(() => relDlg.close(), 1500);
    } catch (err) {
      status.className = "error";
      status.textContent = (err as Error).message;
      go.disabled = false;
    }
  });

  // Live: an event says what changed; a reconnect reloads everything. The events come over a WebSocket, not an
  // EventSource: over HTTP/1.1 an EventSource holds one of the browser's six connections to the host for as long as
  // the tab is open, and with a few admin tabs open the page's own requests (the git log, the statuses) wait for minutes.
  let heard = 0,
    opened = false;
  function listen() {
    if (pageView.signal.aborted) return;
    const events = new WebSocket((location.protocol == "https:" ? "wss://" : "ws://") + location.host + "/api/events");
    let closed = false;
    pageView.onLeave(() => {
      closed = true;
      events.close();
    });
    // The first open needs no reload: the page asked for everything as it started, beside it.
    events.onopen = () => {
      if (opened) {
        load();
        loadDeploys();
        loadReleases();
        loadDomains();
      }
      opened = true;
    };
    events.onclose = () => {
      if (!closed) setTimeout(listen, 3000);
    };
    events.onmessage = (e) => {
      let ev: Json;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type == "source") {
        // A move starts a deploy, here or on another server.
        load();
        loadDeploys();
      }
      if (ev.type == "deploys") {
        heard = Date.now();
        loadDeploys();
      }
      if (ev.type == "releases") loadReleases();
      if (ev.type == "domains") loadDomains();
      if (ev.type == "deploy-log" && open && ev.target == open.target) {
        if (ev.deployId == open.deployId) {
          open.heard = Date.now();
          append(ev.lines || []);
          open.shown += (ev.lines || []).length;
        } else if (!open.pinned) {
          open.heard = Date.now();
          refreshLog(false);
        }
      }
    };
  }
  load();
  loadDeploys();
  loadReleases();
  loadDomains();
  listen();
  // Events don't tell everything: the other server's events can fail to come (it doesn't
  // answer), and a server that deploys itself cuts the stream and can miss its last change. So while
  // a deploy shows running (or the status didn't load) and no event came lately, ask for the status every two seconds.
  setInterval(() => {
    if (asking || Date.now() - heard < 2500) return;
    if (!deploys || deploys.targets?.some((t: Json) => running(t.state) || t.history?.some((r: Json) => running(r.state)))) loadDeploys();
  }, 2000);
  // A downstream reads its position against upstream again now and then (upstream moves without an event here).
  setInterval(() => {
    if (view?.upstream) load();
    else render();
    renderTargets();
  }, 30000);
}
