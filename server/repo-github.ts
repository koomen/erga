// Erga's repository on GitHub, read-only, for the repository API (server/repo-api.ts, Repository). It reads GitHub's
// REST API for a public repository (SOURCE_REPO, for example koomen/erga). With the sign-in app's client id and secret,
// GitHub allows 5,000 reads an hour for the app; without them, 60 an hour for the server's address. The API's edge
// cache keeps most reads from GitHub.

import type { Repository, SourceView } from "./repo-api.ts";

/** The most text of one file that the API gives (GitHub's contents API gives up to 1 MB). */
const MAX_TEXT = 512 * 1024;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface GitHubCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null; committer: { date: string } | null };
}
interface GitHubEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
  content?: string;
  encoding?: string;
  target?: string;
}

/** The repository `name` (owner/repo) on GitHub. `app`: the sign-in app's client id and secret, for GitHub's higher limit. */
export function githubRepository(name: string, app: { clientId: string; secret: string } | null, get: Fetch = fetch): Repository {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "erga",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (app?.clientId && app.secret) headers.Authorization = `Basic ${btoa(`${app.clientId}:${app.secret}`)}`;
  const api = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
    const r = await get(`https://api.github.com/repos/${name}${path}`, { headers });
    if (r.status == 404) return { status: 404, body: null };
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
    return { status: r.status, body: (await r.json()) as T };
  };
  const commits = async (branch: string) => {
    const { body } = await api<GitHubCommit[]>(`/commits?sha=${encodeURIComponent(branch)}&per_page=30`);
    if (!body) return null;
    return body.map((c) => ({
      sha: c.sha,
      subject: c.commit.message.split("\n")[0],
      author: c.commit.author?.name ?? "",
      at: Date.parse(c.commit.committer?.date ?? c.commit.author?.date ?? "") || 0,
    }));
  };
  return {
    clone: `https://github.com/${name}.git`,
    async branches() {
      const [main, staging, tags] = await Promise.all([
        commits("main"),
        commits("staging"),
        api<{ name: string; commit: { sha: string } }[]>("/tags?per_page=10"),
      ]);
      if (!main) throw new Error(`GitHub has no public repository ${name}`);
      const branches = [{ name: "main", commit: main[0]?.sha ?? null, commits: main }];
      if (staging) branches.push({ name: "staging", commit: staging[0]?.sha ?? null, commits: staging });
      return { branches, tags: (tags.body ?? []).map((t) => ({ name: t.name, commit: t.commit.sha, at: 0 })) };
    },
    async read(q) {
      const path = q.path.replace(/^\/+|\/+$/g, "");
      if (path.split("/").includes("..")) return { error: "A path can't go up (..)." };
      const [head, got] = await Promise.all([
        api<{ sha: string }>(`/commits/${encodeURIComponent(q.ref)}`),
        api<GitHubEntry | GitHubEntry[]>(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(q.ref)}`),
      ]);
      if (!head.body) return { error: `There's no branch ${q.ref}.` };
      if (!got.body) return { error: `There's no file or folder ${path}.` };
      return { commit: head.body.sha, view: viewOf(path, got.body) };
    },
  };
}

/** GitHub's answer for a path, as the API's view: a folder's entries, or a file's text (null: binary). */
export function viewOf(path: string, got: GitHubEntry | GitHubEntry[]): SourceView {
  if (Array.isArray(got))
    return { kind: "folder", path, entries: got.map((e) => ({ name: e.name, folder: e.type == "dir", size: e.size })) };
  if (got.type == "symlink") return { kind: "file", path, size: got.size, text: null, link: got.target ?? "" };
  const bytes = got.encoding == "base64" ? Uint8Array.from(atob((got.content ?? "").replace(/\n/g, "")), (c) => c.charCodeAt(0)) : null;
  // GitHub leaves out the content of a file over 1 MB; a NUL byte marks a binary file.
  if (!bytes || bytes.includes(0)) return { kind: "file", path, size: got.size, text: null, ...(bytes ? {} : { cut: true }) };
  const cut = bytes.length > MAX_TEXT;
  const text = new TextDecoder().decode(cut ? bytes.slice(0, MAX_TEXT) : bytes);
  return { kind: "file", path, size: got.size, text, ...(cut ? { cut: true } : {}) };
}
