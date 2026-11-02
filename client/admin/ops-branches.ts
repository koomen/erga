// The Ops page's feature branches (control/source/page.ts; control/source/features.ts): one row for each branch, with
// its commits ahead of and behind staging, its last commit, and whether it merges cleanly into staging. Merge opens a
// dialog with the squash commit's message (merge_feature_branch); Delete drops the branch (delete_feature_branch).
// The Ops page's script (client/inline/ops.ts) calls `render` with list_branches' `features` each time it loads.

import { esc } from "../../shared/html";
import { plural, timeAgo } from "../../shared/time";
import { runTool } from "../common/tools";

// list_branches' answer, typed loosely: this page reads what the server sends and shows it.
type Json = any;

/** Wires the box and the dialog; `reload` asks list_branches again. Returns the box's `render`. */
export function featureBranches(reload: () => Promise<void>): (features: Json[] | undefined) => void {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const box = byId("features"),
    list = byId("feature-list"),
    hint = byId("feature-hint"),
    dlg = byId<HTMLDialogElement>("feature-dlg"),
    message = byId<HTMLTextAreaElement>("feature-message"),
    status = byId("feature-status"),
    go = byId<HTMLButtonElement>("feature-go");
  let shown: Json[] = [],
    drawn = "",
    merging: string | null = null;
  const say = (text: string, bad = false) => {
    hint.textContent = text;
    hint.className = bad ? "hint error" : "hint";
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
    return `<span class="f-state conflicts">Couldn't check: ${esc(m.error)}</span>`;
  };
  const row = (f: Json) =>
    `<li class="feature" data-branch="${esc(f.name)}">
      <div class="f-top"><code class="f-name">${esc(f.name)}</code><span class="f-count">${plural(f.ahead, "commit")} ahead · ${f.behind} behind staging</span>${state(f)}</div>
      ${f.last ? `<div class="f-last"><span class="f-subject">${esc(f.last.subject)}</span> · ${esc(f.last.author)} · <span class="f-time">${esc(timeAgo(f.last.at))}</span> · <code>${esc(f.commit.slice(0, 7))}</code></div>` : ""}
      <div class="f-actions"><button class="new" type="button" data-feature-merge="${esc(f.name)}"${f.merge.state == "clean" ? "" : ` disabled title="Only a branch that merges cleanly into staging can be merged"`}>Merge</button><button class="pill" type="button" data-feature-delete="${esc(f.name)}">Delete</button></div>
    </li>`;

  list.addEventListener("click", async (e) => {
    const target = e.target as Element;
    const merge = target.closest<HTMLButtonElement>("button[data-feature-merge]");
    if (merge) {
      const f = shown.find((x) => x.name == merge.dataset.featureMerge);
      if (!f) return;
      merging = f.name;
      byId("feature-name").textContent = f.name;
      message.value = f.message;
      status.textContent = "";
      status.className = "";
      go.disabled = false;
      dlg.showModal();
      message.focus();
      return;
    }
    const del = target.closest<HTMLButtonElement>("button[data-feature-delete]");
    if (!del) return;
    const name = del.dataset.featureDelete!;
    del.disabled = true;
    say("Deleting " + name + "…");
    try {
      const r = await runTool("delete_feature_branch", { branch: name });
      say(
        `Deleted ${r.branch}. It was at ${r.commit.slice(0, 10)}: git push erga ${r.commit.slice(0, 10)}:refs/heads/${r.branch} brings it back.`
      );
    } catch (err) {
      say((err as Error).message, true);
      del.disabled = false;
    }
    await reload();
  });
  byId("feature-cancel").addEventListener("click", () => dlg.close());
  go.addEventListener("click", async () => {
    if (!merging) return;
    const text = message.value.trim();
    if (!text) {
      status.className = "error";
      status.textContent = "Write the commit's message.";
      return;
    }
    go.disabled = true;
    status.className = "";
    status.textContent = "Merging " + merging + "…";
    try {
      const r = await runTool("merge_feature_branch", { branch: merging, message: text });
      dlg.close();
      say(`Merged ${r.branch} into staging as ${r.commit.slice(0, 10)}: staging deploys it.`);
      await reload();
    } catch (err) {
      status.className = "error";
      status.textContent = (err as Error).message;
      go.disabled = false;
    }
  });

  return (features) => {
    // A control Worker one release behind (it deploys from main) doesn't list feature branches yet: no box.
    box.hidden = !features;
    if (!features) return;
    shown = features;
    const html = features.length
      ? features.map(row).join("")
      : `<li class="feature-none">No feature branches. Push one: <code>git push erga HEAD:&lt;name&gt;</code>.</li>`;
    if (html == drawn) return;
    drawn = html;
    list.innerHTML = html;
  };
}
