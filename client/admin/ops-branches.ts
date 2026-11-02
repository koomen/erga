// The Ops page's feature branches (control/source/page.ts; control/source/features.ts): one row for each branch, with
// its commits ahead of and behind staging, its last commit, and whether it merges cleanly into staging. Merge opens a
// dialog with the squash commit's message (feature_branch merge); Delete drops the branch (feature_branch delete);
// Check again checks once more whether it merges cleanly (feature_branch check), above all after a check that failed.
// The Ops page's script (client/inline/ops.ts) calls `render` with branches' `features` and `featureActions` each
// time it loads, and `heard` with each {type: "feature"} event.
//
// A merge takes seconds: the dialog closes at once, and the branch's row says what runs, then how it ended. The row
// takes what this page did, else what the server says (featureActions, the events): so another Ops page open, and
// this one loaded again, show it too. A control Worker one release behind sends neither: then only this page knows.

import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import { runTool } from "../common/tools";

// branches' answer, typed loosely: this page reads what the server sends and shows it.
type Json = any;
/** A Merge or Delete of a branch (control/source/features.ts, FeatureAction), or this page's Check again. */
interface Action {
  branch: string;
  action: "merge" | "delete" | "check";
  state: "running" | "done" | "failed";
  commit?: string;
  head?: string;
  error?: string;
}

/** Wires the box and the dialog; `reload` asks branches again. */
export function featureBranches(reload: () => Promise<void>): {
  render: (features: Json[] | undefined, actions: Action[] | undefined) => void;
  heard: (action: Action) => void;
} {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const box = byId("features"),
    list = byId("feature-list"),
    dlg = byId<HTMLDialogElement>("feature-dlg"),
    message = byId<HTMLTextAreaElement>("feature-message"),
    status = byId("feature-status"),
    go = byId<HTMLButtonElement>("feature-go");
  let shown: Json[] | undefined,
    drawn = "",
    merging: Json = null;
  /** What this page did, and what the server says, by branch. */
  const mine = new Map<string, Action>(),
    theirs = new Map<string, Action>();
  const actionOf = (name: string) => {
    const a = mine.get(name),
      b = theirs.get(name);
    if (!a || !b) return a ?? b;
    return a.state != "running" && b.state == "running" ? b : a;
  };

  const state = (f: Json) => {
    const m = f.merge;
    if (m.state == "clean") return `<span class="f-state clean">Merges cleanly</span>`;
    if (m.state == "merged") return `<span class="f-state merged">On staging already</span>`;
    if (m.state == "checking") return `<span class="f-state">Checking…</span>`;
    if (m.state == "conflicts") {
      const files = m.files.map((x: Json) => x.path).join(", ");
      return `<span class="f-state conflicts" title="${esc(files)}">Conflicts in ${plural(m.files.length, "file")}: ${esc(files)}</span>`;
    }
    return `<span class="f-state conflicts">The check failed (not a conflict): ${esc(m.error)}</span>`;
  };
  /** What an action shows in its row. */
  const said = (a: Action) => {
    const sha = (a.commit ?? "").slice(0, 7);
    if (a.state == "running")
      return `<span class="f-state busy"><i></i>${{ merge: "Merging into staging…", delete: "Deleting…", check: "Checking again…" }[a.action]}</span>`;
    if (a.state == "failed")
      return `<span class="f-state conflicts">Couldn't ${a.action == "check" ? "check again" : a.action}: ${esc(a.error ?? "")}</span>`;
    if (a.action == "merge")
      return `<span class="f-state clean">Merged into staging as <code>${esc(sha)}</code>: staging deploys it.</span>`;
    return `<span class="f-state">Deleted. It was at <code>${esc(sha)}</code>: <code>git push erga ${esc(sha)}:refs/heads/${esc(a.branch)}</code> brings it back.</span>`;
  };
  const ended = (a: Action) =>
    `<li class="feature" data-branch="${esc(a.branch)}"><div class="f-top"><code class="f-name">${esc(a.branch)}</code>${said(a)}</div></li>`;
  const row = (f: Json) => {
    const a = actionOf(f.name);
    // A Merge or Delete that ended took this head: the row says so until the list drops the branch.
    if (a?.state == "done" && (!a.head || a.head == f.commit)) return ended(a);
    const busy = a?.state == "running",
      checkable = !busy && f.merge.state != "checking" && f.merge.state != "merged";
    return `<li class="feature" data-branch="${esc(f.name)}">
      <div class="f-top"><code class="f-name">${esc(f.name)}</code><span class="f-count">${plural(f.ahead, "commit")} ahead · ${f.behind} behind staging</span>${busy ? said(a) : state(f)}</div>
      ${f.last ? `<div class="f-last"><span class="f-subject">${esc(f.last.subject)}</span> · ${esc(f.last.author)} · <span class="f-time">${esc(timeAgo(f.last.at))}</span> · <code>${esc(f.commit.slice(0, 7))}</code></div>` : ""}
      ${a?.state == "failed" ? `<div class="f-note">${said(a)}</div>` : ""}
      <div class="f-actions">${checkable ? `<button class="pill" type="button" data-feature-check="${esc(f.name)}">Check again</button>` : ""}<button class="new" type="button" data-feature-merge="${esc(f.name)}"${busy ? " disabled" : f.merge.state == "clean" ? "" : ` disabled title="Only a branch that merges cleanly into staging can be merged"`}>Merge</button><button class="pill" type="button" data-feature-delete="${esc(f.name)}"${busy ? " disabled" : ""}>Delete</button></div>
    </li>`;
  };

  function draw() {
    // A control Worker one release behind (it deploys from main) doesn't list feature branches yet: no box.
    box.hidden = !shown;
    if (!shown) return;
    const names = new Set(shown.map((f) => f.name));
    // A branch merged or deleted is gone from the list: its row stays, and says how it ended.
    const gone = [...new Set([...mine.keys(), ...theirs.keys()])]
      .filter((n) => !names.has(n))
      .map((n) => actionOf(n)!)
      .filter((a) => a.state == "done");
    const html =
      shown.length || gone.length
        ? gone.map(ended).join("") + shown.map(row).join("")
        : `<li class="feature-none">No feature branches. Push one: <code>git push erga HEAD:&lt;name&gt;</code>.</li>`;
    if (html == drawn) return;
    drawn = html;
    list.innerHTML = html;
  }

  /** Runs a Merge or Delete: the row says it runs at once, then how it ended. */
  async function act(f: Json, action: Action["action"], run: () => Promise<Json>) {
    const branch = f.name;
    mine.set(branch, { branch, action, state: "running" });
    draw();
    try {
      const r = await run();
      if (action == "check") {
        // The row shows the new state at once; the list loaded again keeps it.
        mine.delete(branch);
        if (r.commit == f.commit) f.merge = r.merge;
      } else mine.set(branch, { branch, action, state: "done", commit: r.commit, head: f.commit });
    } catch (err) {
      mine.set(branch, { branch, action, state: "failed", error: (err as Error).message });
    }
    draw();
    await reload();
  }

  list.addEventListener("click", (e) => {
    const target = e.target as Element;
    const merge = target.closest<HTMLButtonElement>("button[data-feature-merge]");
    const del = target.closest<HTMLButtonElement>("button[data-feature-delete]");
    const check = target.closest<HTMLButtonElement>("button[data-feature-check]");
    const f = shown?.find((x) => x.name == (merge?.dataset.featureMerge ?? del?.dataset.featureDelete ?? check?.dataset.featureCheck));
    if (!f) return;
    if (check) {
      act(f, "check", () => runTool("feature_branch", { action: "check", branch: f.name }));
      return;
    }
    if (del) {
      act(f, "delete", () => runTool("feature_branch", { action: "delete", branch: f.name }));
      return;
    }
    merging = f;
    byId("feature-name").textContent = f.name;
    message.value = f.message;
    status.textContent = "";
    status.className = "";
    dlg.showModal();
    message.focus();
  });
  byId("feature-cancel").addEventListener("click", () => dlg.close());
  go.addEventListener("click", () => {
    const f = merging;
    if (!f) return;
    const text = message.value.trim();
    if (!text) {
      status.className = "error";
      status.textContent = "Write the commit's message.";
      return;
    }
    dlg.close();
    act(f, "merge", () => runTool("feature_branch", { action: "merge", branch: f.name, message: text }));
  });

  return {
    render(features, actions) {
      shown = features;
      if (actions) {
        theirs.clear();
        for (const a of actions) theirs.set(a.branch, a);
      }
      draw();
    },
    heard(a) {
      theirs.set(a.branch, a);
      draw();
    },
  };
}
