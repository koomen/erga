// Reading Erga's own source, for the admin's agent (agents/person/agent.ts,
// `sourceTools`): list a folder, read a file (or some of its lines) and search
// the code, in one commit's files as Artifacts sent them (SourceRepo.read,
// control/source/repo.ts, which also answers the log). Read-only: nothing here
// writes, and the answers are text the agent takes as information.
//
// Platform-neutral and synchronous: a snapshot is a commit's files in memory.

import * as Schema from "effect/Schema";
import { isTreeMode, parseCommit, parseTree, text, type GitObject } from "./git.ts";
import { isBinary } from "./merge.ts";

export interface SnapshotFile { mode: string; size: number; data: Uint8Array }
/** One commit's files, by path, and its folders. */
export interface Snapshot { commit: string; files: Map<string, SnapshotFile>; dirs: Set<string>; bytes: number }

/** A commit's snapshot, from a pack that holds it, its tree and every blob (fetchPack with `deepen: 1`). */
export function snapshotOf(commit: string, objects: Map<string, GitObject>): Snapshot {
  const c = objects.get(commit);
  if (!c || c.type != "commit") throw new Error(`no commit ${commit.slice(0, 7)} in the pack`);
  const files = new Map<string, SnapshotFile>(), dirs = new Set<string>([""]);
  let bytes = 0;
  const walk = (tree: string, at: string) => {
    const t = objects.get(tree);
    if (!t) throw new Error(`no tree ${tree.slice(0, 7)} in the pack`);
    for (const e of parseTree(t.data)) {
      const path = at ? `${at}/${e.name}` : e.name;
      if (isTreeMode(e.mode)) { dirs.add(path); walk(e.sha, path); }
      else if (e.mode != "160000") {
        const data = objects.get(e.sha)?.data ?? new Uint8Array();
        files.set(path, { mode: e.mode, size: data.length, data });
        bytes += data.length;
      }
    }
  };
  walk(parseCommit(c.data).tree, "");
  return { commit, files, dirs, bytes };
}

/** What the tools ask (the admin's agent → SourceHost → SourceRepo.read). Each one names a branch or commit; staging if not. */
export type SourceRead =
  | { op: "list"; ref?: string; path?: string; recursive?: boolean }
  | { op: "read"; ref?: string; path: string; from?: number; to?: number }
  | { op: "search"; ref?: string; query: string; regex?: boolean; ignoreCase?: boolean; path?: string; glob?: string; limit?: number }
  | { op: "log"; ref?: string; limit?: number; skip?: number }
  | { op: "view"; ref?: string; path?: string };

/** A tool's answer: what was read, from where. A "view" (the public source page's) has `view` too, and no text. */
export interface SourceAnswer { ref: string; commit: string; text: string; view?: SourceView }

/** A folder's entries, or a file's text (null: binary), as the public source page (public.ts) shows them. */
export type SourceView =
  | { kind: "folder"; path: string; entries: { name: string; folder: boolean; size: number }[] }
  | { kind: "file"; path: string; size: number; text: string | null; link?: string; cut?: boolean };

export class BrowseError extends Schema.TaggedError<BrowseError>()("BrowseError", { message: Schema.String }) {}

/** At most this many entries in a listing, lines in one read, and matches in a search. */
export const MAX_LIST = 1000, MAX_LINES = 2000, MAX_MATCHES = 500;
/** At most this many characters of a read's answer, and of one line in a search's. */
const MAX_TEXT = 100_000, MAX_LINE = 300;
/** Files larger than this aren't searched (a built bundle, say). */
const SEARCH_MAX_FILE = 2_000_000;

/** A path as asked ("/src/", "./a.ts"), as the snapshot keeps it ("src", "a.ts"); never outside the repository. */
export function cleanPath(p: string | undefined): string {
  const parts = (p ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s != ".");
  if (parts.includes(".."))
    throw new BrowseError({ message: "A path can't go up (..): give it from the repository's root, e.g. client/shell/main.ts." });
  return parts.join("/");
}

const kib = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** A folder's entries ("name/" for a folder, then each file and its size), or every file under it with `recursive`. */
export function list(s: Snapshot, path: string, recursive = false): string {
  if (s.files.has(path)) throw new BrowseError({ message: `${path} is a file: source with action read reads it.` });
  if (!s.dirs.has(path)) throw new BrowseError({ message: `There's no folder ${path}.${hint(s, path)}` });
  const prefix = path ? `${path}/` : "";
  const out: string[] = [];
  if (recursive) {
    for (const [p, f] of s.files) if (p.startsWith(prefix)) out.push(`${p.slice(prefix.length)}  (${kib(f.size)})`);
  } else {
    const seen = new Set<string>();
    for (const d of s.dirs) if (d.startsWith(prefix) && d != path && !d.slice(prefix.length).includes("/")) seen.add(`${d.slice(prefix.length)}/`);
    out.push(...[...seen].sort());
    const files = [...s.files].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).sort(([a], [b]) => (a < b ? -1 : 1));
    out.push(...files.map(([p, f]) => `${p.slice(prefix.length)}  (${f.mode == "120000" ? `a link to ${text(f.data)}` : kib(f.size)})`));
  }
  if (!out.length) return `${path || "The repository"} is empty.`;
  const more = out.length > MAX_LIST ? `\n… and ${out.length - MAX_LIST} more: list a folder inside it.` : "";
  return `${path ? `${path}/` : "The repository's root"}: ${out.length} ${recursive ? "files" : "entries"}\n${out.slice(0, MAX_LIST).join("\n")}${more}`;
}

/** A file's lines, numbered, `from` to `to` (1-based, both included; the whole file, up to MAX_LINES, by default). */
export function read(s: Snapshot, path: string, from?: number, to?: number): string {
  if (!path) throw new BrowseError({ message: "Which file? Give its path, e.g. README.md." });
  const f = s.files.get(path);
  if (!f)
    throw new BrowseError({
      message: s.dirs.has(path) ? `${path} is a folder: source with action list lists it.` : `There's no file ${path}.${hint(s, path)}`,
    });
  if (f.mode == "120000") return `${path} is a link to ${text(f.data)}.`;
  if (isBinary(f.data)) return `${path} is a binary file (${kib(f.size)}): it can't be shown as text.`;
  const lines = text(f.data).split("\n");
  if (lines.at(-1) == "") lines.pop();
  const total = lines.length;
  if (!total) return `${path} is empty.`;
  const start = Math.max(1, Math.floor(from ?? 1));
  if (start > total) throw new BrowseError({ message: `${path} has ${total} lines: from must be 1 to ${total}.` });
  let end = Math.min(total, Math.floor(to ?? total), start + MAX_LINES - 1);
  if (end < start) throw new BrowseError({ message: "to must be at or after from." });
  const width = String(end).length;
  const out: string[] = [];
  let size = 0;
  for (let n = start; n <= end; n++) {
    const line = `${String(n).padStart(width)}  ${lines[n - 1]}`;
    if (size + line.length > MAX_TEXT && out.length) { end = n - 1; break; }
    out.push(line);
    size += line.length + 1;
  }
  const head = start == 1 && end == total ? `${path}: ${total} lines` : `${path}: lines ${start} to ${end} of ${total}`;
  const more = end < total ? `\n… ${total - end} more lines: read again with from ${end + 1}.` : "";
  return `${head}\n${out.join("\n")}${more}`;
}

/** At most this many bytes of a file in a view. */
const MAX_VIEW = 512 * 1024;

/** A folder (folders first, then files, each by name) or a file, for the public source page. */
export function view(s: Snapshot, path: string): SourceView {
  const f = s.files.get(path);
  if (f) {
    if (f.mode == "120000") return { kind: "file", path, size: f.size, text: null, link: text(f.data) };
    if (isBinary(f.data)) return { kind: "file", path, size: f.size, text: null };
    return { kind: "file", path, size: f.size, text: text(f.data.subarray(0, MAX_VIEW)), ...(f.size > MAX_VIEW ? { cut: true } : {}) };
  }
  if (!s.dirs.has(path)) throw new BrowseError({ message: `There's no file or folder ${path}.` });
  const prefix = path ? `${path}/` : "";
  const folders = [...s.dirs].filter((d) => d.startsWith(prefix) && d != path && !d.slice(prefix.length).includes("/")).map((d) => ({ name: d.slice(prefix.length), folder: true, size: 0 }));
  const files = [...s.files].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map(([p, f]) => ({ name: p.slice(prefix.length), folder: false, size: f.size }));
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);
  return { kind: "folder", path, entries: [...folders.sort(byName), ...files.sort(byName)] };
}

/** A glob ("*.ts", "src/**\/*.css") as a regular expression: on the file's name, or on its whole path if it has a "/". */
function globRe(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*|\?/g, (m) => (m == "?" ? "[^/]" : m == "*" ? "[^/]*" : "(?:.*/)?"));
  return new RegExp(`^${re}$`);
}

/** The lines that match `query` (as text, or as a regular expression), in every text file under `path` that `glob` takes: "path:line: text". */
export function search(s: Snapshot, o: { query: string; regex?: boolean; ignoreCase?: boolean; path?: string; glob?: string; limit?: number }): string {
  if (!o.query) throw new BrowseError({ message: "What to search for? Give a query." });
  let re: RegExp;
  try {
    re = new RegExp(o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.ignoreCase ? "i" : "");
  } catch (e) {
    throw new BrowseError({ message: `That isn't a regular expression JavaScript takes: ${(e as Error).message}` });
  }
  const path = cleanPath(o.path);
  if (path && !s.dirs.has(path) && !s.files.has(path))
    throw new BrowseError({ message: `There's no file or folder ${path}.${hint(s, path)}` });
  const glob = o.glob ? globRe(o.glob) : null;
  const limit = Math.max(1, Math.min(MAX_MATCHES, Math.floor(o.limit ?? 100)));
  const out: string[] = [];
  let files = 0, more = false;
  const skipped: string[] = [];
  for (const p of [...s.files.keys()].sort()) {
    if (path && p != path && !p.startsWith(`${path}/`)) continue;
    if (glob && !glob.test(o.glob!.includes("/") ? p : p.slice(p.lastIndexOf("/") + 1))) continue;
    const f = s.files.get(p)!;
    if (f.mode == "120000" || isBinary(f.data)) continue;
    if (f.size > SEARCH_MAX_FILE) { skipped.push(p); continue; }
    const lines = text(f.data).split("\n");
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      // Very long lines (minified code) are searched in their first part only, so a regular expression can't take long.
      const line = lines[i].length > 10_000 ? lines[i].slice(0, 10_000) : lines[i];
      if (!re.test(line)) continue;
      if (out.length >= limit) { more = true; break; }
      hit = true;
      const shown = line.trim();
      out.push(`${p}:${i + 1}: ${shown.length > MAX_LINE ? `${shown.slice(0, MAX_LINE)}…` : shown}`);
    }
    if (hit) files++;
    if (more) break;
  }
  const notes = [
    ...(more ? [`There are more matches than ${limit}: narrow the search (path, glob), or raise limit (at most ${MAX_MATCHES}).`] : []),
    ...(skipped.length ? [`Not searched, too large: ${skipped.join(", ")}.`] : []),
  ];
  if (!out.length) return [`No matches for ${o.regex ? "/" + o.query + "/" : JSON.stringify(o.query)}${path ? ` in ${path}` : ""}${o.glob ? ` (${o.glob})` : ""}.`, ...notes].join("\n");
  return [`${out.length} matches in ${files} files:`, ...out, ...notes].join("\n");
}

/** A hint for a path that isn't there: the nearest folder that is, and what it holds. */
function hint(s: Snapshot, path: string): string {
  let up = path;
  do up = up.includes("/") ? up.slice(0, up.lastIndexOf("/")) : ""; while (up && !s.dirs.has(up));
  const near = [...s.dirs].filter((d) => d && d.startsWith(up ? `${up}/` : "") && !d.slice(up ? up.length + 1 : 0).includes("/")).map((d) => `${d.slice(up ? up.length + 1 : 0)}/`);
  const files = [...s.files.keys()].filter((p) => p.startsWith(up ? `${up}/` : "") && !p.slice(up ? up.length + 1 : 0).includes("/")).map((p) => p.slice(up ? up.length + 1 : 0));
  const all = [...near.sort(), ...files.sort()];
  return all.length ? ` ${up || "The root"} has: ${all.slice(0, 20).join(", ")}${all.length > 20 ? ", and more" : ""}.` : "";
}
