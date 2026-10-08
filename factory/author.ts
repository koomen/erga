// Who a factory commit is by (#68). Each task's commits (Claude Code's, and
// the merge's "Merge staging into task/…") are authored by the task's person:
// the admin who added it, on the board, through the factory's agent, or with
// their own agent's token. The merge into staging is authored by whoever
// pressed Merge (one squash commit: factory/vm/merge.ts). The factory is always the committer, so it's clear that it
// made the commit. worker/factory.ts gives each VM job the identities
// (GIT_AUTHOR_*, GIT_COMMITTER_*, FACTORY_MERGE_AUTHOR_*: factory/vm/merge.ts).
//
// A person's identity is their GitHub name and their GitHub noreply address,
// <id>+<login>@users.noreply.github.com, so the GitHub mirror links each
// commit to their profile.

import type { Users } from "../users";

export interface Identity { name: string; email: string }

/** The committer of every factory commit, and the author of a task's that has no person (one from before #68). */
export const FACTORY_IDENTITY: Identity = { name: "Erga factory", email: "factory@erga.dev" };

/** A person's commit identity: their GitHub name (their login if none), and their noreply address (with their id when known; without it, the older form, which GitHub links too). */
export function commitIdentity(login: string, name: string | null, githubId: number | null): Identity {
  login = login.toLowerCase();
  return { name: name?.trim() || login, email: githubId != null ? `${githubId}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com` };
}

/** GitHub's id for a login, from its public API (null if it doesn't answer in 5 s, or doesn't know them). */
export async function githubIdOf(login: string, get: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await get(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "erga.dev" }, signal: AbortSignal.timeout(5000) });
    const id = r.ok ? ((await r.json()) as { id?: unknown }).id : null;
    return typeof id == "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

/**
 * A person's identity, from their user row: the name and GitHub id their sign-in wrote. One who hasn't signed in since
 * the id was kept is asked of GitHub (`lookup`, never in local development, where logins aren't GitHub's), and kept.
 */
export async function personIdentity(users: Pick<Users, "get" | "setGithubId">, login: string, lookup: ((login: string) => Promise<number | null>) | null): Promise<Identity> {
  const user = await users.get(login).catch(() => null);
  let id = user?.githubId ?? null;
  // A bootstrap admin with no row yet (created 0) has nowhere to keep it.
  if (id == null && user && user.created != 0 && lookup) {
    id = await lookup(user.login);
    if (id != null) await users.setGithubId(user.login, id).catch(() => {});
  }
  return commitIdentity(login, user?.name ?? null, id);
}
