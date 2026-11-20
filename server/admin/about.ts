// /admin/about, the About page: the version that this server runs. The repository and the branch that it tracks (its
// deploy spec), the commit (the deploy's ERGA_VERSION; its full name from the job log, its title and date where the
// deployer's last look saw it), and the release: the repository's tag (vX.Y.Z, `bun erga release`) at that commit.
// The server keeps no tags: it reads git's own list of the repository's refs at GitHub (what `git ls-remote` reads, as
// the deployer does: deploy/deployer/github.ts), with no credential, so only for a public repository (in the tests
// and in local development, the pretend GitHub's: dev/github-mock.ts). What the server does not know, it says is not
// known. The read of the settings (server/operations/admin.ts) gives the same facts.

import { esc } from "../../shared/html.ts";
import type { Who } from "../directory/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { adminPage } from "./layout.ts";
import { setAt } from "./parts.ts";

export interface About {
  /** github.com/<owner>/<name>, and the branch whose commits the server runs; null: it has no deploy spec. */
  repo: string | null;
  branch: string | null;
  /** The commit it runs: its full name where the job log or the deployer's look has it, else the deploy's short one. null: no deploy named one. */
  commit: { sha: string; title: string | null; at: number | null } | null;
  /** The release's tag at that commit; "none": the commit has no release; null: not known. */
  release: string | null;
}

const NOT_KNOWN = "not known";
/** A repository as the spec names it, and no other text: it goes into an address. */
const REPO = /^github\.com\/[\w.-]+\/[\w.-]+$/;
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;
/** How long the page waits for GitHub's list of the tags. */
const WAIT_MS = 3000;

/**
 * The newest release tag (vX.Y.Z) at the commit `sha` (its full name, or the start of it) in git's list of a
 * repository's refs: one line for each ref, the commit, a space and the ref's name. null: the commit has none.
 */
export function releaseAt(refs: string, sha: string): string | null {
  const at = new Map<string, string>();
  for (const line of refs.split("\n")) {
    // A tag with a message has two lines: the tag's own name, then its commit's ("^{}"), which wins.
    const ref = /([0-9a-f]{40}) refs\/tags\/([^^\s]+)(?:\^\{\})?$/.exec(line.split("\0")[0]);
    if (ref && RELEASE.test(ref[2])) at.set(ref[2], ref[1]);
  }
  const parts = (tag: string) => RELEASE.exec(tag)!.slice(1).map(Number);
  const here = [...at].filter(([, commit]) => commit.startsWith(sha)).map(([tag]) => parts(tag));
  here.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return here[0] ? `v${here[0].join(".")}` : null;
}

/** What this server runs (admins only). */
export async function aboutOf(platform: Platform, who: Who): Promise<About> {
  const state = await platform.directory.deploys.state(who);
  const runs = platform.deploy.version;
  const seen = runs ? state.commits.find((c) => c.sha.startsWith(runs)) : undefined;
  const sha = runs && (seen?.sha ?? state.jobs.find((j) => j.commit?.startsWith(runs))?.commit ?? runs);
  const repo = state.tracks && REPO.test(state.tracks.repo) ? state.tracks.repo : null;
  // (GitHub's stand-in, where the sign-in has one.)
  const github = (platform.signIn.mode == "oauth" && platform.signIn.origins.github) || "https://github.com";
  const refs =
    repo && sha
      ? await fetch(`${github}${repo.slice("github.com".length)}.git/info/refs?service=git-upload-pack`, {
          headers: { "User-Agent": "erga" },
          signal: AbortSignal.timeout(WAIT_MS),
        }).then(
          (r) => (r.ok ? r.text() : null),
          () => null
        )
      : null;
  return {
    repo,
    branch: repo ? state.tracks!.branch : null,
    commit: sha ? { sha, title: seen?.title ?? null, at: seen?.at ?? null } : null,
    release: refs == null ? null : (releaseAt(refs, sha!) ?? "none"),
  };
}

/** The same facts, as the read of the settings gives them. */
export const aboutRead = (a: About) => ({
  repository: a.repo ?? NOT_KNOWN,
  branch: a.branch ?? NOT_KNOWN,
  commit: a.commit
    ? {
        hash: a.commit.sha,
        ...(a.commit.title != null ? { title: a.commit.title } : {}),
        ...(a.commit.at != null ? { date: new Date(a.commit.at).toISOString() } : {}),
      }
    : NOT_KNOWN,
  release: a.release == null ? NOT_KNOWN : a.release == "none" ? "no release" : a.release,
});

/** /admin/about. */
export async function aboutPage(platform: Platform, session: Session) {
  const a = await aboutOf(platform, whoOf(session));
  const web = a.repo && `https://${a.repo}`;
  const out = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  const none = (why: string) => `${NOT_KNOWN}<span class="src">${esc(why)}</span>`;
  const noSpec = "This server has no deploy spec yet: its next deploy writes it.";
  const c = a.commit;
  const short = c && `<code>${esc(c.sha.slice(0, 12))}</code>`;
  const row = (name: string, value: string) => `<dt>${name}</dt><dd data-about="${name.toLowerCase()}">${value}</dd>`;
  return adminPage({
    session,
    title: "About",
    here: "about",
    body: `
  <section class="server" aria-label="Version"><dl>
    ${row("Repository", web ? out(web, esc(a.repo!)) : none(noSpec))}
    ${row("Branch", web ? out(`${web}/tree/${encodeURIComponent(a.branch!)}`, esc(a.branch!)) : NOT_KNOWN)}
    ${row(
      "Commit",
      c
        ? `${web ? out(`${web}/commit/${c.sha}`, short!) : short}${c.title != null ? `<span>${esc(c.title)}</span>` : ""}${c.at != null ? `<span class="src">${setAt(c.at)}</span>` : ""}`
        : none("No deploy named the commit that this server runs.")
    )}
    ${row(
      "Release",
      a.release == null
        ? none(web && c ? "GitHub did not give the repository's tags." : "It needs the repository and the commit.")
        : a.release == "none"
          ? `no release<span class="src">The commit has no release tag.</span>`
          : out(`${web}/releases/tag/${a.release}`, esc(a.release))
    )}
  </dl></section>`,
  });
}
