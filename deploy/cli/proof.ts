// `bun erga proof`: a branch's proof page, which Pete looks at before he merges. The task's agent makes it as its last
// step, after `bun erga push`: one sentence that says what changed, a picture of the screen before and after the
// change at desktop width and at phone width, the result of the tests, and the changed files. The pictures come from
// `bun run look` (e2e/look.ts): the same arguments run in this folder (after) and in a scratch folder at the commit
// the branch started from (before). A task with nothing to show says which tests prove it (--no-picture).
//
// The page is a folder in the main clone, .erga/proofs/<branch>/ (index.html, the pictures, proof.json). The ops page
// serves it at /proof/<branch>/ and links it beside the branch's Merge button (ops-page.ts, ops-view.ts). It is not an
// Erga document: the CLI has no token that makes documents, and an agent never makes one.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { esc } from "../../shared/html";
import { branchRefusal } from "./flow";
import { sh } from "./observe";

export const WIDTHS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** One picture: its file in the proof's folder, or why there is none. */
export type Shot = { file: string } | { error: string };

export interface Proof {
  branch: string;
  sha: string;
  at: string;
  /** What changed, in one sentence. */
  sentence: string;
  /** The tests' result for this commit, in words. */
  tests: string;
  files: string[];
  /** Each `--look`: its arguments, and its pictures at each width. */
  views: { look: string; shots: { width: string; before: Shot; after: Shot }[] }[];
  /** With no picture: why, and which tests prove the change. */
  noPicture?: string;
}

/** A branch's name as a folder's: its slashes become "~", which no branch name has. */
export const proofName = (branch: string) => branch.replaceAll("/", "~");
export const proofDir = (dir: string, branch: string) => join(dir, "proofs", proofName(branch));

/** A `--look` text as arguments: words, and quoted texts as one. */
export const lookArgs = (text: string) => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** Why `bun erga proof` must not go on, or null. */
export function proofRefusal(o: {
  branch: string | null;
  sentence: string | undefined;
  looks: number;
  noPicture: string | undefined;
}): string | null {
  const no = branchRefusal(o.branch);
  if (no) return no;
  if (!o.sentence?.trim()) return 'Say what changed, in one sentence: bun erga proof "<sentence>" --look "<bun run look arguments>".';
  if (!o.looks && !o.noPicture?.trim())
    return 'Give a picture (--look "<bun run look arguments>", for example --look "--path /docs"), or say which tests prove a change with nothing to show (--no-picture "<the tests>").';
  return null;
}

const shot = (s: Shot, label: string) =>
  "file" in s
    ? `<a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="${esc(label)}" loading="lazy"></a>`
    : `<p class="none">No picture: ${esc(s.error)}</p>`;

/** The proof page. */
export function proofHtml(p: Proof): string {
  const views = p.views
    .map(
      (v) =>
        `<section><h2><code>bun run look ${esc(v.look)}</code></h2>${v.shots
          .map(
            (s) =>
              `<div class="pair ${esc(s.width)}"><figure><figcaption>Before · ${esc(s.width)}</figcaption>${shot(s.before, `Before, ${s.width}`)}</figure><figure><figcaption>After · ${esc(s.width)}</figcaption>${shot(s.after, `After, ${s.width}`)}</figure></div>`
          )
          .join("")}</section>`
    )
    .join("");
  const none = p.noPicture ? `<section><h2>No picture</h2><p>${esc(p.noPicture)}</p></section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proof · ${esc(p.branch)}</title>
<style>
:root { color-scheme: light dark; --fg: #1c1c1f; --soft: #6b6b73; --bg: #fff; --rule: #e6e6ea; --ok: #16794c; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --soft: #8f8f99; --bg: #17171a; --rule: #2f2f35; --ok: #4cc38a; } }
body { margin: 0 auto; padding: 28px 20px 60px; max-width: 1500px; font: 15px/1.5 Inter, system-ui, sans-serif; color: var(--fg); background: var(--bg); }
.kicker { margin: 0; font-size: 13px; color: var(--soft); }
h1 { margin: 4px 0 14px; font-size: 24px; line-height: 1.25; max-width: 900px; }
h2 { margin: 30px 0 10px; font-size: 14px; font-weight: 600; }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.tests { margin: 0 0 6px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; align-items: start; }
.pair.phone { max-width: 820px; }
figure { margin: 0; min-width: 0; }
figcaption { margin-bottom: 5px; font-size: 12.5px; color: var(--soft); }
img { display: block; width: 100%; border: 1px solid var(--rule); border-radius: 8px; }
.none { margin: 0; padding: 18px; border: 1px dashed var(--rule); border-radius: 8px; color: var(--soft); font-size: 13.5px; overflow-wrap: anywhere; }
ul { margin: 0; padding-left: 20px; font-size: 13.5px; }
@media (max-width: 700px) { .pair { grid-template-columns: 1fr; } }
</style></head><body>
<p class="kicker">Proof of the branch <b>${esc(p.branch)}</b> at <code>${esc(p.sha.slice(0, 12))}</code> · ${esc(p.at.slice(0, 16).replace("T", " "))} UTC</p>
<h1>${esc(p.sentence)}</h1>
<p class="tests">Tests: ${esc(p.tests)}</p>
${views}${none}
<section><h2>Changed files (${p.files.length})</h2><ul>${p.files.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul></section>
</body></html>
`;
}

/** Each branch's proof in .erga/proofs/: its commit and its time, by branch. */
export function readProofs(dir: string): Record<string, { sha: string; at: string }> {
  const at = join(dir, "proofs");
  const out: Record<string, { sha: string; at: string }> = {};
  if (!existsSync(at)) return out;
  for (const name of readdirSync(at)) {
    try {
      const p = JSON.parse(readFileSync(join(at, name, "proof.json"), "utf8")) as Proof;
      out[p.branch] = { sha: p.sha, at: p.at };
    } catch {}
  }
  return out;
}

/** `bun run look <args>` in a checkout, at a size, into `out`: null when the picture is there, else why not. */
export type Look = (cwd: string, args: string[], size: { width: number; height: number }, out: string) => string | null;

const look: Look = (cwd, args, size, out) => {
  const r = sh(["bun", "e2e/look.ts", ...args, "--width", String(size.width), "--height", String(size.height), "--out", out, "--keep"], {
    cwd,
  });
  return r.ok && existsSync(out) ? null : (`${r.err}\n${r.out}`.trim().split("\n")[0] || `bun run look: exit ${r.code}`).slice(0, 300);
};

/**
 * Makes the proof of the branch of the checkout at `root`, in .erga/proofs/ (`dir`: .erga/). The result: the proof.
 * An error says what stopped it. `look` is for the tests.
 */
export function makeProof(o: {
  dir: string;
  root: string;
  sentence: string | undefined;
  looks: string[];
  noPicture?: string;
  log: (line: string) => void;
  look?: Look;
}): Proof {
  const at = (...args: string[]) => sh(["git", ...args], { cwd: o.root });
  const head = at("symbolic-ref", "--quiet", "--short", "HEAD");
  const branch = head.ok ? head.out : null;
  const no = proofRefusal({ branch, sentence: o.sentence, looks: o.looks.length, noPicture: o.noPicture });
  if (no) throw new Error(no);
  const sha = at("rev-parse", "HEAD").out;
  const base = at("merge-base", "HEAD", "origin/staging").out;
  if (!base) throw new Error("This branch has no commit in common with origin/staging. git fetch origin staging");
  // bun erga push pushes only a commit whose tests passed: a pushed head is a tested one.
  const pushed = at("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).out == sha;
  const dirty = at("status", "--porcelain").out != "";
  const tests = dirty
    ? "not known: the folder has changes that no commit has."
    : pushed
      ? "all passing. bun erga push tested this commit, and pushed it."
      : "not known: this commit is not pushed yet (bun erga push).";
  const out = proofDir(o.dir, branch!);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const take = o.look ?? look;
  let before = "";
  const views: Proof["views"] = [];
  try {
    if (o.looks.length) {
      // The commit the branch started from, in a scratch folder with its own packages.
      before = join(tmpdir(), `erga-proof-${process.pid}`);
      const add = at("worktree", "add", "--quiet", "--detach", before, base);
      const install = add.ok && !o.look ? sh(["bun", "install", "--frozen-lockfile"], { cwd: before }) : null;
      const broke = !add.ok
        ? `git worktree add failed: ${add.err}`
        : install && !install.ok
          ? `bun install failed: ${install.err.slice(-200)}`
          : null;
      o.looks.forEach((text, i) => {
        const args = lookArgs(text);
        const shots = WIDTHS.map((w) => {
          const one = (side: "before" | "after", cwd: string): Shot => {
            const file = `${i + 1}-${w.name}-${side}.png`;
            const error = side == "before" && broke ? broke : take(cwd, args, w, join(out, file));
            o.log(`${error ? "NOTE " : "PASS "} ${side}, ${w.name}: bun run look ${text}${error ? `: no picture (${error})` : ""}`);
            return error ? { error } : { file };
          };
          return { width: w.name, before: one("before", before), after: one("after", o.root) };
        });
        views.push({ look: text, shots });
      });
    }
  } finally {
    if (!o.look) for (const cwd of [before, o.root]) if (cwd && existsSync(cwd)) sh(["bun", "e2e/look.ts", "--stop"], { cwd });
    if (before) at("worktree", "remove", "--force", before);
  }
  if (o.looks.length && !views.some((v) => v.shots.some((s) => "file" in s.after)))
    throw new Error("No picture of the change came out. Run the arguments yourself first: bun run look <arguments>");

  const proof: Proof = {
    branch: branch!,
    sha,
    at: new Date().toISOString(),
    sentence: o.sentence!.trim(),
    tests,
    files: at("diff", "--name-only", `${base}..HEAD`).out.split("\n").filter(Boolean),
    views,
    ...(o.noPicture?.trim() ? { noPicture: o.noPicture.trim() } : {}),
  };
  writeFileSync(join(out, "index.html"), proofHtml(proof));
  writeFileSync(join(out, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  return proof;
}
