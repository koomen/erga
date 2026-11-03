// The Ops page's box for a merge that waits on conflicts (client/inline/ops.ts): from upstream (Update), or from
// GitHub (the sync). It lists the files, and the two ways out.

import { esc } from "../../shared/html";

// branches' `conflict`, typed loosely: this page reads what the server sends and shows it.
type Json = any;
const byId = (id: string) => document.getElementById(id) as HTMLElement;

export const conflictCount = (n: number) => (n == 1 ? "1 file conflicts" : n + " files conflict");

/** The merge waiting on conflicts (from upstream, or from GitHub): the files, and the two ways out. `upstream`: its name. */
export function renderConflict(c: Json, upstream: string) {
  const box = byId("conflict-box");
  box.hidden = !c;
  if (!c) return;
  const gh = c.kind == "github";
  byId("conflict-title").textContent = gh ? "The sync from GitHub stopped" : "Update from " + upstream + " stopped";
  byId("conflict-count").textContent = conflictCount(c.files.length);
  byId("conflict-intro").innerHTML = gh
    ? "GitHub's staging (<b>" +
      esc(c.target.slice(0, 7)) +
      "</b>) and staging here have each moved, and the merge conflicts in these files."
    : "The merge of <b>" + esc(c.version) + "</b> into staging conflicts in these files.";
  byId("conflict-branch").textContent = c.branch;
  byId("conflict-ask").textContent = gh ? "resolve the merge from GitHub" : "resolve the update from " + upstream;
  byId("conflict-how").textContent = gh
    ? "In a checkout of the GitHub repository, merge Erga's staging, resolve, and push to GitHub's staging (the sync brings it here):"
    : "In a checkout, merge " + upstream + "'s commit, resolve, and push to staging:";
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
