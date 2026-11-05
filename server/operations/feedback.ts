// Feedback: a person sends it from any page (the account menu's Send feedback) or asks their agent to (send_feedback);
// the admins read it (feedback, and /admin/feedback). The server keeps it, then opens a GitHub issue for it with no name
// (server/feedback.ts).

import * as Schema from "effect/Schema";
import { FEEDBACK_MAX } from "../directory/index.ts";
import { fileFeedback, issuesRepo } from "../feedback.ts";
import { type Caller, iso, type Operation, OperationError, platformOf, str } from "./operation.ts";

/** The path of the page it was sent from: a path on this site, short; a URL gives its path. */
export function pageOf(page: unknown): string | null {
  if (typeof page != "string" || !page.trim()) return null;
  let path = page.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    /* a path already */
  }
  return path.startsWith("/") ? path.slice(0, 300) : null;
}

/** Opens the issues that wait, after the answer (the request's background work). */
function fileLater(caller: Caller) {
  const platform = platformOf(caller);
  platform.edge.background(fileFeedback(caller.dir, platform.issues, platform.deploy.target ?? ""));
}

export const FEEDBACK_OPERATIONS: Operation[] = [
  {
    name: "send_feedback",
    ui: "The account menu (every page): Send feedback",
    label: "Send feedback",
    activity: "sending feedback",
    wide: true,
    description: "Sends feedback about Erga to its makers: an issue on GitHub, without your name.",
    parameters: Schema.Struct({
      text: str(`The feedback, in the person's words (at most ${FEEDBACK_MAX} characters).`),
      page: Schema.optionalKey(str("The page it is about (a path or URL); your own agent may leave it out: the open one.")),
    }),
    run: async (args, caller) => {
      const text = String(args.text ?? "").trim();
      if (!text) throw new OperationError({ message: "Write the feedback first.", status: 400 });
      if (text.length > FEEDBACK_MAX)
        throw new OperationError({ message: `Feedback is at most ${FEEDBACK_MAX} characters: this is ${text.length}.`, status: 400 });
      const platform = platformOf(caller);
      const id = await caller.dir.feedback.add(caller.who, {
        text,
        page: pageOf(args.page ?? caller.here),
        target: platform.deploy.target ?? "",
      });
      fileLater(caller);
      return { sent: true, id, message: "Thanks, sent. It goes to Erga's issues on GitHub, without your name." };
    },
  },
  {
    name: "feedback",
    ui: "Feedback (/admin/feedback)",
    label: "Read the feedback",
    activity: "reading the feedback",
    admin: true,
    description: "The feedback people sent, newest first, with each one's GitHub issue (none yet: it waits).",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
      const rows = await caller.dir.feedback.list(caller.who);
      const issues = caller.platform?.issues;
      const repo = await issuesRepo(caller.dir, issues);
      if (caller.platform) fileLater(caller);
      return {
        issues:
          repo ?? (issues ? "off: the setting feedback_repository is empty (set_setting)" : "off: the server has no GITHUB_ISSUES_TOKEN"),
        feedback: rows.map((f) => ({
          id: f.id,
          text: f.text,
          page: f.page,
          at: iso(f.at),
          issue: f.issue,
          ...(f.issue != null && issues && repo ? { url: issues.link(repo, f.issue) } : {}),
        })),
      };
    },
  },
];
