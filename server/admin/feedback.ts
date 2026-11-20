// /admin/feedback, the Feedback page: the switch of "Send feedback" (off: nobody can send it, and the messages kept
// stay here; the setting's row, ./settings.ts), then the feedback people sent, which only the admins read. The
// unresolved ones first, newest first, each with when, the page it came from and Resolve; under them the resolved
// ones, closed until an admin opens them, each with Reopen. A click saves the status by itself
// (client/inline/admin-feedback.ts).

import { esc } from "../../shared/html.ts";
import { inlineCall, TIMES_SCRIPT } from "../pages/index.ts";
import { type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import type { FeedbackRow } from "../directory/index.ts";
import { adminPage } from "./layout.ts";
import { chip, PAGE_SETTINGS, settingLiveRows, settingsSection } from "./settings.ts";

/** One feedback's row. */
function feedbackRow(f: FeedbackRow): string {
  const at = new Date(f.at).toISOString();
  return `  <li class="feedback-row" data-id="${esc(f.id)}" data-status="${f.status}" data-at="${f.at}">
    <p class="text">${esc(f.text)}</p>
    <p class="meta"><time datetime="${at}" title="${at.slice(0, 16).replace("T", " ")} UTC">${at.slice(0, 16).replace("T", " ")}</time>${f.page ? ` · <code class="page">${esc(f.page)}</code>` : ""} · <code class="id">${esc(f.id)}</code></p>
    <button type="button" class="pill resolve">${f.status == "resolved" ? "Reopen" : "Resolve"}</button>
  </li>`;
}

/** /admin/feedback. */
export async function feedbackPage(platform: Platform, session: Session) {
  const who = whoOf(session),
    feedback = platform.directory.feedback;
  const [unresolved, resolved, settings, on] = await Promise.all([
    feedback.list(who, "unresolved"),
    feedback.list(who, "resolved"),
    settingsSection(platform, session, PAGE_SETTINGS.feedback, "feedback"),
    platform.directory.config.get("feedback"),
  ]);
  return adminPage({
    session,
    title: "Feedback",
    here: "feedback",
    lede: on ? "Only the admins and their agents read the feedback people send." : "Send feedback is off: nobody can send a message.",
    body: `
  <section aria-label="Send feedback">
    ${settings}
  </section>
  <section class="feedback-lists" aria-label="Messages">
  <h3 class="sub-head">Unresolved</h3>
  <ol class="feedback" data-status="unresolved"${unresolved.length ? "" : " hidden"}>
${unresolved.map(feedbackRow).join("\n")}
  </ol>
  <p class="changes-empty"${unresolved.length ? " hidden" : ""}>No unresolved feedback.</p>
  <details class="resolved"${resolved.length ? "" : " hidden"}>
    <summary>Resolved (<span class="count">${resolved.length}</span>)</summary>
  <ol class="feedback" data-status="resolved">
${resolved.map(feedbackRow).join("\n")}
  </ol>
  </details>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}${inlineCall("admin-feedback")}</script>`,
  });
}

/** The page's setting rows ("setting:<key>"), as they are now, for an open page (server/news/). */
export const feedbackRows: LiveRows = async (platform, session, keys) => ({
  ...Object.fromEntries(keys.map((k) => [k, null])),
  ...(await settingLiveRows(platform, session, keys, PAGE_SETTINGS.feedback)),
});
