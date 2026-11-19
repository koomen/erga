// /admin/feedback, the Feedback page: everything that governs "Send feedback". Its switch (off: nobody can send it, and
// the messages kept stay here) and where the messages go (the setting rows, ./settings.ts, and the deploy's token that
// opens the issues), then the feedback people sent, newest
// first, each with when, the page it came from, and its GitHub issue (or that it waits for one). Opening the page
// tries the waiting ones again (server/feedback.ts).

import { esc } from "../../shared/html.ts";
import { fileFeedback, issuesRepo } from "../feedback.ts";
import { inlineCall, TIMES_SCRIPT } from "../pages/index.ts";
import { type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import type { FeedbackRow } from "../directory/index.ts";
import { plural } from "../../shared/time.ts";
import { adminPage } from "./layout.ts";
import { chip, deploySection, PAGE_SETTINGS, settingLiveRows, settingsSection } from "./settings.ts";

/** One feedback's row. `link`: an issue's page, where the server opens issues. */
function feedbackRow(f: FeedbackRow, link: ((n: number) => string) | null): string {
  const at = new Date(f.at).toISOString();
  const issue =
    f.issue != null
      ? link
        ? `<a class="issue" href="${esc(link(f.issue))}" target="_blank" rel="noopener">#${f.issue}</a>`
        : `<span class="issue">#${f.issue}</span>`
      : `<span class="badge">No issue yet</span>`;
  return `  <li class="feedback-row" data-id="${esc(f.id)}">
    <p class="text">${esc(f.text)}</p>
    <p class="meta"><time datetime="${at}" title="${at.slice(0, 16).replace("T", " ")} UTC">${at.slice(0, 16).replace("T", " ")}</time>${f.page ? ` · <code class="page">${esc(f.page)}</code>` : ""} · <code class="id">${esc(f.id)}</code> · ${issue}</p>
  </li>`;
}

/** /admin/feedback. */
export async function feedbackPage(platform: Platform, session: Session) {
  const [rows, settings, deployed] = await Promise.all([
    platform.directory.feedback.list(whoOf(session)),
    settingsSection(platform, session, PAGE_SETTINGS.feedback, "feedback"),
    platform.directory.credentials.deployed(whoOf(session)),
  ]);
  const issues = platform.issues;
  const [on, repo] = await Promise.all([platform.directory.config.get("feedback"), issuesRepo(platform.directory, issues)]);
  const waiting = rows.filter((f) => f.issue == null).length;
  if (repo && waiting) platform.edge.background(fileFeedback(platform.directory, issues));
  const where = repo
    ? `Each message opens an issue in ${repo}.`
    : issues
      ? "No issues open: Feedback's repository is not set."
      : "No issues open: this server has no GITHUB_ISSUES_TOKEN.";
  return adminPage({
    session,
    title: "Feedback",
    here: "feedback",
    lede: `${on ? where : "Send feedback is off: nobody can send a message."}${rows.length ? ` ${plural(rows.length, "message")}${waiting ? `, ${waiting} with no issue yet` : ""}.` : ""}`,
    body: `
  <section aria-label="Where feedback goes">
    ${settings}
  </section>${deploySection(deployed, ["GITHUB_ISSUES_TOKEN"])}
  <h3 class="sub-head">Messages</h3>
  <ol class="feedback"${rows.length ? "" : " hidden"}>
${rows.map((f) => feedbackRow(f, issues && repo ? (n) => issues.link(repo, n) : null)).join("\n")}
  </ol>
  <p class="changes-empty"${rows.length ? " hidden" : ""}>No feedback yet.</p>
<script>${TIMES_SCRIPT}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}</script>`,
  });
}

/** The page's setting rows ("setting:<key>"), as they are now, for an open page (server/news/). */
export const feedbackRows: LiveRows = async (platform, session, keys) => ({
  ...Object.fromEntries(keys.map((k) => [k, null])),
  ...(await settingLiveRows(platform, session, keys, PAGE_SETTINGS.feedback)),
});
