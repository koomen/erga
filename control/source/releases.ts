// Releases are tags: an annotated tag vX.Y.Z (a semantic version) on a
// commit of main. The tag is the release; the newest one is stable
// (control/deploys/releases.ts). Cut release on the Ops page (POST
// /api/source/release) makes one here; `git push erga vX.Y.Z` does the same
// (control/source/receive.ts). A release tag is never moved or deleted, each
// is newer than the last, and nothing but release tags is taken.

import { hashObject, isSha, parseCommit, parseTag, readPack, tagBytes, writePack, ZERO, type GitObject } from "./git.ts";
import { fetchPack, lsRefs, receivePack, type Remote } from "./remote.ts";
import { REF, SourceError, TAGS } from "./refs.ts";
import type { Actor, SourceRepo } from "./repo.ts";
import { byLine } from "../../shared/attribution.ts";

/** A release tag: a semantic version, v first. */
export const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export const isReleaseTag = (name: string) => RELEASE_TAG.test(name);
/** Semantic version order (newest last): vX.Y.Z by its numbers. */
export function compareVersions(a: string, b: string): number {
  const x = RELEASE_TAG.exec(a), y = RELEASE_TAG.exec(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) != Number(y[i])) return Number(x[i]) - Number(y[i]);
  return 0;
}
/** The version after `latest` (its patch number up), or the first. */
export const nextVersion = (latest: string | null) => { const m = latest ? RELEASE_TAG.exec(latest) : null; return m ? `v${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "v0.1.0"; };
/** A release: its tag, the commit it marks, who cut it and when, its message. */
export interface TagInfo { name: string; sha: string; commit: string; tagger: string; at: number; message: string }
/** A release cut: the tag, its commit, who did it. */
export interface Released { tag: string; commit: string; sha: string; by: string; via?: string | null; at: number; message: string }

export class Releases {
  constructor(private repo: SourceRepo) {}

  /** The release tags, newest version first. */
  tags(): TagInfo[] {
    return this.repo.deps.db
      .exec<{ name: string; sha: string; commit_sha: string; tagger: string; at: number; message: string }>(
        "SELECT name, sha, commit_sha, tagger, at, message FROM tags"
      )
      .map((r) => ({ name: r.name, sha: r.sha, commit: r.commit_sha, tagger: r.tagger, at: r.at, message: r.message }))
      .sort((a, b) => compareVersions(b.name, a.name));
  }

  /** Indexes the release tags Artifacts has that the index doesn't: each tag object (or plain tag's commit) fetched and read. */
  async syncTags(remote: Remote, tagRefs: Map<string, string>) {
    const known = new Set(this.repo.deps.db.exec<{ name: string }>("SELECT name FROM tags").map((r) => r.name));
    const missing = [...tagRefs].filter(([ref]) => isReleaseTag(ref.slice(TAGS.length)) && !known.has(ref.slice(TAGS.length)));
    if (!missing.length) return;
    const objects = await readPack(
      await fetchPack(remote, {
        wants: missing.map(([, sha]) => sha),
        haves: this.repo.heads().filter((s) => this.repo.known(s)),
        filter: "blob:none",
      }),
      (t) => t == "tag" || t == "commit"
    );
    for (const [sha, o] of objects) if (o.type == "commit") this.repo.index(sha, parseCommit(o.data));
    for (const [ref, sha] of missing) {
      const name = ref.slice(TAGS.length), o = objects.get(sha);
      if (o?.type == "tag") {
        const t = parseTag(o.data);
        this.repo.deps.db.exec(
          "INSERT OR IGNORE INTO tags (name, sha, commit_sha, tagger, at, message) VALUES (?, ?, ?, ?, ?, ?)",
          name,
          sha,
          t.object,
          t.tagger.name,
          t.tagger.time * 1000,
          t.message.trim()
        );
      } else if (this.repo.known(sha)) {
        const [c] = this.repo.rows([sha]);
        this.repo.deps.db.exec(
          "INSERT OR IGNORE INTO tags (name, sha, commit_sha, tagger, at, message) VALUES (?, ?, ?, ?, ?, ?)",
          name,
          sha,
          sha,
          c?.author ?? "",
          c?.committed ?? 0,
          ""
        );
      }
    }
  }

  /**
   * Cuts a release: an annotated tag `version` (the next one, if not given) on
   * main's head (or `commit`, one of main's commits), by `who`. Each release
   * is newer than the last. Returns the tag.
   */
  async release(who: Actor, o: { version?: string; notes?: string; commit?: string } = {}): Promise<Released> {
    if (o.commit != null && !isSha(o.commit)) throw new SourceError("Name the commit by its full id (40 hex digits).");
    return this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const [{ refs }, { refs: tagRefs }] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS)]);
      const main = refs.get(REF("main"));
      if (!main) throw new SourceError("main has no commits yet: nothing to release.", 409);
      await this.repo.sync(remote, [main]);
      await this.syncTags(remote, tagRefs);
      const tags = this.tags();
      const version = (o.version ?? "").trim() || nextVersion(tags[0]?.name ?? null);
      const wrong = this.checkVersion(version, tags[0]?.name ?? null, tagRefs);
      if (wrong) throw new SourceError(wrong, 409);
      const commit = o.commit ?? main;
      if (!this.repo.known(commit) || !this.repo.isAncestor(commit, main))
        throw new SourceError(`${commit.slice(0, 7)} isn't one of main's commits: a release is cut from main.`, 409);
      const message = (o.notes ?? "").trim() || `Release ${version}`;
      const time = Math.floor(this.repo.now() / 1000);
      const object: GitObject = { type: "tag", data: tagBytes({ object: commit, type: "commit", tag: version, tagger: { name: who.name || who.login, email: `${who.login}@users.noreply.github.com`, time, tz: "+0000" }, message }) };
      const sha = await hashObject(object);
      const r = await receivePack(remote, [{ ref: `${TAGS}${version}`, old: ZERO, new: sha }], await writePack([object]));
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(`${TAGS}${version}`) ?? "no answer";
      if (said != "ok") throw new SourceError(`Artifacts refused the tag: ${said}`, 409);
      const released: Released = { tag: version, commit, sha, by: who.login, via: who.via ?? null, at: this.repo.now(), message };
      this.recordRelease(released, who.name || who.login);
      return released;
    });
  }

  /** Why `version` can't be the next release, or null: the shape, and newer than the newest. */
  checkVersion(version: string, latest: string | null, tagRefs: Map<string, string>): string | null {
    if (!isReleaseTag(version)) return `A release is a version tag like v1.2.3 (numbers only, v first): "${version}" isn't one.`;
    if (tagRefs.has(`${TAGS}${version}`)) return `${version} is already a release.`;
    if (latest && compareVersions(version, latest) <= 0) return `${version} isn't newer than the newest release, ${latest}: the next is ${nextVersion(latest)} or more.`;
    return null;
  }

  recordRelease(r: Released, tagger: string) {
    this.repo.deps.db.exec(
      "INSERT OR REPLACE INTO tags (name, sha, commit_sha, tagger, at, message) VALUES (?, ?, ?, ?, ?, ?)",
      r.tag,
      r.sha,
      r.commit,
      tagger,
      r.at,
      r.message
    );
    this.repo.deps.released?.(r);
    this.repo.deps.changed();
    if (this.repo.github.githubLink()) this.repo.deps.background(this.repo.github.syncGithub(byLine(r.by, r.via)).catch(() => {}));
  }
}
