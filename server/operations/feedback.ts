// Feedback: a person sends it from any page (the account menu's Send feedback) or asks their agent to (send_feedback),
// while the setting feedback is on: only someone signed in, and it is theirs, with their name. The server keeps it, and
// only the admins and their agents read it (feedback, and /admin/feedback), also when the setting is off: each one is
// unresolved until an admin says that it is resolved (set_feedback, the page's Resolve). While the setting
// feedback_context is on, a feedback that the person's own agent sends from the editor keeps what the editor said of
// the open page with their message (Caller.page: its address, its HTML near the caret, the last keys): the admins and
// their agents read it with the feedback, and repair the problem with no question. The answer tells the sender.

import * as Schema from "effect/Schema";
import { ANYONE, contextOf, FEEDBACK_MAX, FEEDBACK_STATUSES, type FeedbackRow, type FeedbackStatus } from "../directory/index.ts";
import { iso, type Operation, OperationError, said, str } from "./operation.ts";

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

const STATUS = Schema.Literals(FEEDBACK_STATUSES);

/** What the sender hears when their feedback went with its context. */
export const WITH_CONTEXT =
  "With it went the open page's address, its HTML near your caret, the keys you pressed last and the problems the editor showed.";

/** The status an admin gave (`or`: when they gave none), or the reason it is not one. */
function statusOf(status: unknown, or?: FeedbackStatus): FeedbackStatus {
  const found = status == null ? or : FEEDBACK_STATUSES.find((s) => s == status);
  if (!found) throw new OperationError({ message: `status: ${FEEDBACK_STATUSES.join(" or ")}.`, status: 400 });
  return found;
}

/** A feedback as an admin's agent reads it, with who sent it (`from` null: sent before the admins saw names). */
const answerOf = (f: FeedbackRow) => ({
  id: f.id,
  text: f.text,
  from: f.login ? { login: f.login, name: f.name ?? f.login, ...(f.via ? { via: f.via } : {}) } : null,
  page: f.page,
  at: iso(f.at),
  status: f.status,
  ...(f.context ? { context: f.context } : {}),
});

export const FEEDBACK_OPERATIONS: Operation[] = [
  {
    name: "send_feedback",
    ui: "The account menu (every page): Send feedback",
    label: "Send feedback",
    activity: "sending feedback",
    wide: true,
    off: async (caller) => ((await caller.dir.config.get("feedback")) ? null : "Feedback is off on this server."),
    description: "Sends feedback about Erga to this server's admins, who see that it is from you.",
    parameters: Schema.Struct({
      text: str(`The feedback, in the user's words (at most ${FEEDBACK_MAX} characters).`),
      page: Schema.optionalKey(str("The page it is about (a path or URL); your own agent may leave it out: the open one.")),
    }),
    run: async (args, caller) => {
      // (Every caller is someone signed in, or their agent: the API takes no other. This holds it here too.)
      if (!caller.who.login || caller.who.login == ANYONE) throw new OperationError({ message: "Sign in to send feedback.", status: 401 });
      const text = String(args.text ?? "").trim();
      if (!text) throw new OperationError({ message: "Write the feedback first.", status: 400 });
      if (text.length > FEEDBACK_MAX)
        throw new OperationError({ message: `Feedback is at most ${FEEDBACK_MAX} characters: this is ${text.length}.`, status: 400 });
      const context = (await caller.dir.config.get("feedback_context")) ? contextOf(caller.page) : null;
      const id = await caller.dir.feedback.add(caller.who, {
        text,
        page: pageOf(args.page ?? context?.page ?? caller.here),
        context,
      });
      return {
        sent: true,
        id,
        message: `Thanks, sent. This server's admins read it, and see that it is from you.${context ? ` ${WITH_CONTEXT}` : ""}`,
      };
    },
  },
  {
    name: "feedback",
    ui: "Feedback (/admin/feedback)",
    label: "Read the feedback",
    activity: "reading the feedback",
    admin: true,
    description: "The feedback people sent, newest first, each with who sent it and its context: the unresolved ones, or the resolved.",
    parameters: Schema.Struct({
      status: Schema.optionalKey(STATUS.annotate({ description: "Which ones: unresolved (the default) or resolved." })),
    }),
    run: async (args, caller) => ({
      feedback: (await caller.dir.feedback.list(caller.who, statusOf(args.status, "unresolved"))).map(answerOf),
    }),
  },
  {
    name: "set_feedback",
    ui: "Feedback (/admin/feedback): Resolve, Reopen",
    label: "Resolve feedback",
    activity: "changing a feedback's status",
    admin: true,
    description: "Marks one feedback as resolved, or as unresolved again.",
    asks: (args) => `Mark the feedback ${said(args.id)} as ${said(args.status)}`,
    parameters: Schema.Struct({
      id: str("The feedback's id (feedback lists them), e.g. fb-a1b2c3d4."),
      status: STATUS.annotate({ description: "Its new status." }),
    }),
    run: async (args, caller) => answerOf(await caller.dir.feedback.setStatus(caller.who, String(args.id ?? ""), statusOf(args.status))),
  },
];
