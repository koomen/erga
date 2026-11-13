// /admin/feedback, the Feedback page: the feedback people sent, newest first, each with when, the page it came from,
// and its GitHub issue (or that it waits for one). Opening the page tries the waiting ones again (server/feedback.ts).

import { esc } from "../../shared/html.ts";
import { fileFeedback, issuesRepo } from "../feedback.ts";
import { TIMES_SCRIPT } from "../pages/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import type { FeedbackRow } from "../directory/index.ts";
import { plural } from "../../shared/time.ts";
import { adminPage } from "./layout.ts";

/** One feedback's row. `target`: this server's; `link`: an issue's page, where the server opens issues. */
function feedbackRow(f: FeedbackRow, target: string, link: ((n: number) => string) | null): string {
  const at = new Date(f.at).toISOString();
  const issue =
    f.issue != null
      ? link
        ? `<a class="issue" href="${esc(link(f.issue))}" target="_blank" rel="noopener">#${f.issue}</a>`
        : `<span class="issue">#${f.issue}</span>`
      : f.target != target
        ? `<span class="badge" title="Each server opens issues only for its own feedback">Sent on ${esc(f.target || "another server")}</span>`
        : `<span class="badge">No issue yet</span>`;
  return `  <li class="feedback-row" data-id="${esc(f.id)}">
    <p class="text">${esc(f.text)}</p>
    <p class="meta"><time datetime="${at}" title="${at.slice(0, 16).replace("T", " ")} UTC">${at.slice(0, 16).replace("T", " ")}</time>${f.page ? ` · <code class="page">${esc(f.page)}</code>` : ""} · <code class="id">${esc(f.id)}</code> · ${issue}</p>
  </li>`;
}

/** /admin/feedback. */
export async function feedbackPage(platform: Platform, session: Session) {
  const rows = await platform.directory.feedback.list(whoOf(session));
  const target = platform.deploy.target ?? "";
  const issues = platform.issues;
  const repo = await issuesRepo(platform.directory, issues);
  const waiting = rows.filter((f) => f.issue == null && f.target == target).length;
  if (repo && waiting) platform.edge.background(fileFeedback(platform.directory, issues, target));
  const where = repo
    ? `Each message opens an issue in ${repo}.`
    : issues
      ? "No issues open: Feedback's repository is not set."
      : "No issues open: this server has no GITHUB_ISSUES_TOKEN.";
  return adminPage({
    session,
    title: "Feedback",
    here: "feedback",
    lede: `${where}${rows.length ? ` ${plural(rows.length, "message")}${waiting ? `, ${waiting} with no issue yet` : ""}.` : ""}`,
    body: `
  <ol class="feedback"${rows.length ? "" : " hidden"}>
${rows.map((f) => feedbackRow(f, target, issues && repo ? (n) => issues.link(repo, n) : null)).join("\n")}
  </ol>
  <p class="changes-empty"${rows.length ? " hidden" : ""}>No feedback yet.</p>
<script>${TIMES_SCRIPT}</script>`,
  });
}
