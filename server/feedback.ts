// Feedback becomes an issue in a repository on GitHub: the setting feedback_repository (owner/name), which an admin
// sets on the Settings page (empty: no issues). The server keeps the feedback first (dir.feedback,
// server/directory/feedback.ts), then opens an issue for it: its title the start of the text, its body the text and
// "Feedback <id>", the label "feedback" (and "staging" on a staging instance). Never a name, a login, an email or the page: a
// page's address names its owner.
//
// The issue needs that setting and a GitHub token that may open issues there (GITHUB_ISSUES_TOKEN, a Worker secret:
// a fine-grained token with only Issues: read and write on the repository). Without them the feedback stays, with no
// issue. If GitHub fails, the feedback stays too, and the next feedback, or an admin who opens
// /admin/feedback, tries it again (`fileFeedback`). Each server opens issues only for the feedback sent to it: a staging
// instance has a copy of its primary's rows, and never opens their issues.

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { Directory, FeedbackRow } from "./directory/index.ts";
import type { Platform } from "./platform.ts";

/** An issue to open. */
export interface Issue {
  title: string;
  body: string;
  labels: string[];
}

/** GitHub's issues, with the server's token: the call that opens one in `repo` (answers its number), and an issue's page. */
export interface Issues {
  open(repo: string, issue: Issue): Promise<number>;
  link(repo: string, n: number): string;
}

declare module "./platform.ts" {
  interface Platform {
    /** GitHub's issues, where the server has GITHUB_ISSUES_TOKEN; absent elsewhere. */
    issues?: Issues;
  }
}

/** GitHub refused or failed to open an issue. */
export class IssueError extends Schema.TaggedError<IssueError>()("IssueError", { message: Schema.String }) {}

/**
 * The server a feedback was sent to, as its row keeps it: "staging" on a staging instance (the deploy named its
 * primary), "" on any other. A staging instance's copy holds its primary's rows, which are not its own.
 */
export const feedbackTarget = (p: Pick<Platform, "deploy">) => (p.deploy.primary ? "staging" : "");

/** The longest title an issue gets from its text. */
const TITLE = 60;

/** The issue for feedback `f`, sent to the server `target` (decides only: no IO). */
export function issueOf(f: Pick<FeedbackRow, "id" | "text">, target: string): Issue {
  const line = f.text.trim().split("\n")[0].replace(/\s+/g, " ").trim();
  const title = line.length > TITLE ? `${line.slice(0, TITLE - 1).trimEnd()}…` : line;
  return {
    title: title || "Feedback",
    body: `${f.text.trim()}\n\n---\nFeedback ${f.id}`,
    labels: target == "staging" ? ["feedback", "staging"] : ["feedback"],
  };
}

const Opened = Schema.Struct({ number: Schema.Number });

/** GitHub's issues: opened at the REST API `api` with `token`, each with its page on `web`. */
export function githubIssues(o: { api: string; web: string; token: string }, fetch: typeof globalThis.fetch = globalThis.fetch): Issues {
  const open = (repo: string, issue: Issue) =>
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        // A network error, a 5xx or a 429: twice more, a second apart and then two.
        HttpClient.retryTransient({ schedule: Schedule.exponential("1 second"), times: 2 })
      );
      const request = HttpClientRequest.post(`${o.api.replace(/\/+$/, "")}/repos/${repo}/issues`).pipe(
        HttpClientRequest.bearerToken(o.token),
        HttpClientRequest.setHeaders({
          Accept: "application/vnd.github+json",
          "User-Agent": "erga",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
        HttpClientRequest.bodyJsonUnsafe(issue)
      );
      const opened = yield* HttpClientResponse.schemaBodyJson(Opened)(yield* client.execute(request));
      return opened.number;
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.mapError((e) => new IssueError({ message: `GitHub didn't open the issue: ${e.message}` }))
    );
  return { open: (repo, issue) => Effect.runPromise(open(repo, issue)), link: (repo, n) => `${o.web}/${repo}/issues/${n}` };
}

/** The repository where feedback opens issues (the setting feedback_repository), if the server can open them there. */
export async function issuesRepo(dir: Directory, issues: Issues | undefined): Promise<string | null> {
  return (issues && (await dir.config.get("feedback_repository"))) || null;
}

/**
 * Opens an issue in feedback_repository for each feedback of the server `target` that has none yet (a few at a time,
 * oldest first), and keeps each one's number. A failure leaves the feedback for the next try, and is logged.
 */
export async function fileFeedback(dir: Directory, issues: Issues | undefined, target: string): Promise<void> {
  const repo = await issuesRepo(dir, issues);
  if (!issues || !repo) return;
  for (const f of await dir.feedback.claim(target)) {
    try {
      await dir.feedback.filed(f.id, await issues.open(repo, issueOf(f, target)));
    } catch (e) {
      console.log(`feedback ${f.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
