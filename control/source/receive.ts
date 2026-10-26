// Pushes: `git push` through Erga's /git endpoint. An admin pushes staging
// and main, and release tags. A push is staged before it lands: its objects
// go to Artifacts under a quarantine branch, Erga reads the new commits back
// and checks them, and only then moves the real branches, each only from
// where it was (Artifacts refuses a move whose old value is stale, so two
// pushes at once can't lose one), and drops the quarantine branches.

import {
  concat,
  emptyPack,
  FLUSH,
  isSha,
  parseTag,
  pkt,
  readPack,
  readPkts,
  text,
  toSideBand,
  utf8,
  writePack,
  ZERO,
  type GitObject,
} from "./git.ts";
import { lsRefs, receivePack, type RefUpdate } from "./remote.ts";
import { BRANCHES, isMergeBranch, QUARANTINE, REF, TAGS, type Branch } from "./refs.ts";
import { compareVersions, isReleaseTag } from "./releases.ts";
import type { Actor, SourceRepo } from "./repo.ts";

export class Pushes {
  constructor(private repo: SourceRepo) {}

  /**
   * The receive-pack advertisement Erga gives a pusher: only staging and main, and what Erga's receive-pack does.
   */
  async advertise(): Promise<Uint8Array> {
    const remote = await this.repo.deps.artifacts();
    const { refs } = await lsRefs(remote);
    const { refs: tagRefs } = await lsRefs(remote, TAGS);
    const caps = "report-status side-band-64k quiet ofs-delta delete-refs agent=erga";
    const names = BRANCHES.map(REF);
    const lines = [...names.filter((r) => refs.has(r)).map((r) => `${refs.get(r)} ${r}`), ...[...tagRefs].map(([r, sha]) => `${sha} ${r}`)];
    if (!lines.length) lines.push(`${ZERO} capabilities^{}`);
    return concat([pkt("# service=git-receive-pack\n"), FLUSH, ...lines.map((l, i) => pkt(`${l}${i == 0 ? `\0${caps}` : ""}\n`)), FLUSH]);
  }

  /**
   * A `git push`: the receive-pack request's body in, the report out (in side-band if the client asked).
   * An admin pushes staging and main: only staging and main are Erga's branches. And release tags (vX.Y.Z, new, newer
   * than the newest, on a commit of main after this push's own moves): each is a release cut.
   */
  async receive(body: Uint8Array, who: Actor): Promise<Uint8Array> {
    const { pkts, end } = readPkts(body, 0, (p) => p.kind == "flush");
    const commands: RefUpdate[] = [];
    let caps = new Set<string>();
    for (const p of pkts) {
      if (p.kind != "data") continue;
      let line = text(p.data).replace(/\n$/, "");
      const nul = line.indexOf("\0");
      if (nul >= 0) { caps = new Set(line.slice(nul + 1).split(" ")); line = line.slice(0, nul); }
      const [old, sha, ref] = line.split(" ");
      if (isSha(old) && isSha(sha) && ref) commands.push({ old, new: sha, ref });
    }
    // Git asks with nothing first (a probe, before a big push): nothing to say.
    if (!commands.length) return new Uint8Array();
    const pack = body.subarray(end);
    const messages: string[] = [];
    const { unpack, statuses } = await this.repo.locked(async () => {
      const remote = await this.repo.deps.artifacts();
      const { refs } = await lsRefs(remote);
      const { refs: tagRefs } = await lsRefs(remote, TAGS);
      const statuses = new Map<string, string>();
      const accepted: (RefUpdate & { branch: Branch })[] = [];
      const tagging: RefUpdate[] = [];
      for (const c of commands) {
        const branch = BRANCHES.find((b) => REF(b) == c.ref);
        if (c.ref.startsWith(TAGS)) {
          const name = c.ref.slice(TAGS.length);
          if (!isReleaseTag(name)) statuses.set(c.ref, "Erga takes release tags only: a version like v1.2.3 (numbers only, v first)");
          else if (c.new == ZERO || tagRefs.has(c.ref)) statuses.set(c.ref, "a release tag is never moved or deleted");
          else tagging.push(c);
        }
        else if (!branch) statuses.set(c.ref, isMergeBranch(c.ref) ? "that branch is Erga's own (the merge that conflicted): merge in your checkout and push the result to staging" : "Erga has two branches, staging and main: push to one of those");
        else if (c.new == ZERO) statuses.set(c.ref, `${branch} can't be deleted`);
        else if ((refs.get(c.ref) ?? ZERO) != c.old) statuses.set(c.ref, "stale info: it moved since you fetched; fetch first");
        else accepted.push({ ...c, branch });
      }
      // Quarantine branches left by a push that stopped halfway go now too.
      const leftovers: RefUpdate[] = [...refs].filter(([r]) => r.startsWith(QUARANTINE)).map(([ref, sha]) => ({ ref, old: sha, new: ZERO }));
      let unpack = "ok";
      if (accepted.length) {
        const id = crypto.randomUUID().slice(0, 8);
        const staged = accepted.map((c) => ({ ...c, quarantine: `${QUARANTINE}${id}-${c.branch}` }));
        const first = await receivePack(remote, staged.map((c) => ({ ref: c.quarantine, old: ZERO, new: c.new })), pack.length ? pack : await emptyPack());
        if (first.unpack != "ok") {
          unpack = first.unpack;
          for (const c of staged) statuses.set(c.ref, `Artifacts couldn't take the objects: ${first.unpack}`);
        } else {
          const landed = staged.filter((c) => {
            const said = first.refs.get(c.quarantine) ?? "no answer";
            if (said != "ok") statuses.set(c.ref, `Artifacts refused it: ${said}`);
            return said == "ok";
          });
          await this.repo.sync(
            remote,
            landed.map((c) => c.new)
          );
          const moving = this.allowed(landed, refs, statuses);
          const drop = [...staged.filter((c) => first.refs.get(c.quarantine) == "ok").map((c) => ({ ref: c.quarantine, old: c.new, new: ZERO })), ...leftovers];
          const final = await receivePack(remote, [...moving.map(({ ref, old, new: sha }) => ({ ref, old, new: sha })), ...drop], moving.length ? await emptyPack() : null);
          for (const c of moving) {
            const said = final.refs.get(c.ref) ?? final.unpack;
            statuses.set(c.ref, said);
            if (said == "ok") {
              this.repo.recordMove({
                branch: c.branch,
                old: c.old,
                new: c.new,
                how: "push",
                by: who.login,
                via: who.via ?? null,
                at: this.repo.now(),
              });
              const before = c.old == ZERO ? null : this.repo.ancestors(c.old);
              const count = before ? [...this.repo.ancestors(c.new)].filter((s) => !before.has(s)).length : null;
              messages.push(`Erga: ${c.branch} is now ${c.new.slice(0, 7)}${count != null ? ` (${count} new commit${count == 1 ? "" : "s"})` : ""}.`);
            }
          }
        }
      } else if (leftovers.length) {
        await receivePack(remote, leftovers, null).catch(() => {});
      }
      // Release tags, after the branches moved: each must mark a commit of main (as it is now), be a new version, and
      // come as an annotated tag in the pack or point straight at the commit.
      if (tagging.length && unpack == "ok") {
        const main = accepted.find((c) => c.branch == "main" && statuses.get(c.ref) == "ok")?.new ?? refs.get(REF("main")) ?? ZERO;
        const objects = pack.length ? await readPack(pack, (t) => t == "tag") : new Map<string, GitObject>();
        await this.repo.releases.syncTags(remote, tagRefs);
        let latest = this.repo.releases.tags()[0]?.name ?? null;
        const seen = new Map(tagRefs);
        for (const c of tagging.sort((a, b) => compareVersions(a.ref, b.ref))) {
          const name = c.ref.slice(TAGS.length);
          const object = objects.get(c.new);
          const tag = object ? parseTag(object.data) : null;
          const commit = tag ? tag.object : c.new;
          const wrong =
            this.repo.releases.checkVersion(name, latest, seen) ??
            (tag && tag.type != "commit" ? "a release tag marks a commit" : null) ??
            (main == ZERO || !this.repo.known(commit) || !this.repo.isAncestor(commit, main)
              ? `${commit.slice(0, 7)} isn't one of main's commits: a release is cut from main (merge first)`
              : null);
          if (wrong) {
            statuses.set(c.ref, wrong);
            continue;
          }
          const r = await receivePack(remote, [{ ref: c.ref, old: ZERO, new: c.new }], await writePack(object ? [object] : []));
          const said = r.unpack != "ok" ? r.unpack : r.refs.get(c.ref) ?? "no answer";
          statuses.set(c.ref, said);
          if (said != "ok") continue;
          latest = name;
          seen.set(c.ref, c.new);
          const message = tag?.message.trim() || `Release ${name}`;
          this.repo.releases.recordRelease(
            { tag: name, commit, sha: c.new, by: who.login, via: who.via ?? null, at: this.repo.now(), message },
            tag?.tagger.name || who.name || who.login
          );
          messages.push(`Erga: release ${name} cut at ${commit.slice(0, 7)}.`);
        }
      }
      return { unpack, statuses };
    });
    if (messages.length && this.repo.github.githubLink()) messages.push("Erga: GitHub syncs in the background.");
    const report = concat([pkt(`unpack ${unpack}\n`), ...commands.map((c) => {
      const s = statuses.get(c.ref) ?? "not processed";
      return pkt(s == "ok" ? `ok ${c.ref}\n` : `ng ${c.ref} ${s}\n`);
    }), FLUSH]);
    if (!caps.has("side-band-64k") && !caps.has("side-band")) return report;
    const max = caps.has("side-band-64k") ? 65515 : 995;
    return concat([...messages.flatMap((m) => toSideBand(utf8(`${m}\n`), 2, max)), ...toSideBand(report, 1, max), FLUSH]);
  }
  /**
   * The strict model: two branches, staging always at or ahead of main, main
   * only following staging. Of these updates (whose commits are indexed),
   * the ones that keep it; the others get the reason in `statuses`.
   */
  private allowed<T extends RefUpdate & { branch: Branch }>(updates: T[], refs: Map<string, string>, statuses: Map<string, string>): T[] {
    let ok = [...updates];
    for (let round = 0; round < 3; round++) {
      const after = (b: Branch) => ok.find((u) => u.branch == b)?.new ?? refs.get(REF(b)) ?? ZERO;
      const next = ok.filter((u) => {
        if (u.branch == "main") {
          if (u.old != ZERO && !this.repo.isAncestor(u.old, u.new))
            return refuse(u, "main only moves forward (fast-forward): it follows staging");
          const staging = after("staging");
          if (staging == ZERO || !this.repo.isAncestor(u.new, staging))
            return refuse(
              u,
              "main only follows staging: push the commit to staging first (git push erga HEAD:staging), then merge it on the Ops page, or push both at once (git push erga HEAD:staging HEAD:main)"
            );
          return true;
        }
        const main = after("main");
        if (main != ZERO && !this.repo.isAncestor(main, u.new))
          return refuse(u, "staging is always at or ahead of main, and this would drop commits main has: rebase onto main and push again");
        return true;
      });
      if (next.length == ok.length) return ok;
      ok = next;
    }
    return ok;
    function refuse(u: T, why: string) { statuses.set(u.ref, why); return false; }
  }
}
