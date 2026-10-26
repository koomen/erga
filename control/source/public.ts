// Erga's source, for anyone: a read-only page with no sign-in (control/routes.ts
// serves it on ops.erga.dev; erga.dev/git redirects there).
//
//   /git, /git/erga.git (a browser's GET)   main's root folder
//   /git/tree/<branch or commit>/<path>     a folder's entries, or a file's text
//
// The page shows how to clone, the two branches (main, which erga.dev runs, and
// staging), the branch's recent commits, and its files. Nothing else of the
// Ops page: no merge, deploys, logs, mirror or settings. Git itself (clone,
// fetch) is routes.ts's sourceGit, which also needs no sign-in.

import { appPage, crumbs, inlineStyle, TIMES_SCRIPT } from "../../server/pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import type { Platform } from "../../server/platform.ts";
import type { SourceView } from "./browse.ts";

/** The page's paths (a GET of /git/erga.git itself is the page; Git asks only for paths under it). */
export const isPublicSourcePath = (path: string) => {
  const p = path.replace(/\/+$/, ""); // with or without a slash at the end ("/git/": the app checks paths as they came)
  return p == "/git" || p == "/git/erga.git" || p == "/git/tree" || p.startsWith("/git/tree/");
};

const BRANCHES = [
  { name: "main", about: "what production runs" },
  { name: "staging", about: "the changes that come next" },
];

const html = (body: string, status = 200, cache = "public, max-age=30") =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache } });

/** The page, for anyone. `app`: Erga's address, for the clone command and the links back. */
export async function publicSourcePage(platform: Platform, url: URL, app: string): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  let ref = "main", at = "";
  if (path.startsWith("/git/tree")) {
    const parts = path.slice("/git/tree".length).split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    ref = parts[0] || "main";
    at = parts.slice(1).join("/");
  }
  const remote = `${app}/git/erga.git`;
  const source = platform.source;
  if (!source) return html(shell(app, "Source", `<p class="src-note">This server has no repository.</p>`), 503, "no-store");
  const [view, branches] = await Promise.all([
    source.object.read(url.origin, { op: "view", ref, path: at }),
    source.object.branches(url.origin).then((b) => b.branches, () => []),
  ]);
  if ("error" in view || !view.view) {
    // A path or branch that isn't there says so; the repository's own trouble stays on the server.
    const broken = !("error" in view) || /^Erga couldn't/.test(view.error);
    const why = broken ? "Erga couldn't read its repository just now. Try again in a minute." : view.error;
    return html(shell(app, "Source", `${head(remote)}<p class="src-note">${esc(why)} <a href="/git">Erga's source</a></p>`), broken ? 502 : 404, "no-store");
  }
  const branch = branches.find((b) => b.name == view.ref);
  const tabs = BRANCHES.map((b) => `<a href="/git/tree/${b.name}${at ? `/${pathHref(at)}` : ""}"${b.name == view.ref ? ` aria-current="page"` : ""} title="${esc(b.about)}">${b.name}</a>`).join("");
  const top = branch?.commits[0];
  const where = `<p class="src-at">${branch ? `${esc(BRANCHES.find((b) => b.name == view.ref)?.about ?? "")}: ` : "commit "}<code>${view.commit.slice(0, 10)}</code>${top && top.sha == view.commit ? ` ${esc(top.subject)}` : ""}</p>`;
  const commits = branch?.commits.length
    ? `<aside class="src-commits" aria-labelledby="commits-head"><h3 id="commits-head">Recent commits on ${esc(view.ref)}</h3><ol>${branch.commits
        .slice(0, 25)
        .map(
          (c) =>
            `<li><span class="subject">${esc(c.subject)}</span><span class="meta"><code>${c.sha.slice(0, 7)}</code> ${esc(c.author)} · ${dateTag(c.at)}</span></li>`
        )
        .join("")}</ol></aside>`
    : "";
  const body = `${head(remote)}
  <div class="src-branch"><nav class="src-tabs" aria-label="Branches">${tabs}</nav>${where}</div>
  <div class="src-grid">
    <section class="src-files" aria-label="Files">${trail(view.ref, view.view.path, view.view.kind == "file")}${viewHtml(view.ref, view.view)}</section>
    ${commits}
  </div>`;
  const title = view.view.path ? `${view.view.path} · Source` : "Source";
  return html(shell(app, title, body));
}

/** Each part of a path, encoded for a link. */
const pathHref = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const treeHref = (ref: string, p: string) => `/git/tree/${encodeURIComponent(ref)}${p ? `/${pathHref(p)}` : ""}`;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function head(remote: string): string {
  return `<div class="src-head">
    <h2>Erga's source</h2>
    <p>Anyone can read and clone Erga. Only its admins can push.</p>
    <div class="src-clone"><code id="clone">git clone ${esc(remote)}</code><button type="button" class="pill" id="copy" aria-label="Copy the clone command">Copy</button></div>
  </div>`;
}

/** erga / server / source / page.ts: each folder a link. */
function trail(ref: string, path: string, file: boolean): string {
  const parts = path ? path.split("/") : [];
  const steps = [`<a href="${treeHref(ref, "")}">erga</a>`, ...parts.map((p, i) =>
    i == parts.length - 1 ? `<span aria-current="${file ? "page" : "location"}">${esc(p)}</span>` : `<a href="${treeHref(ref, parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`)];
  return `<nav class="src-path" aria-label="Path">${steps.join(`<span class="sep">/</span>`)}</nav>`;
}

function viewHtml(ref: string, v: SourceView): string {
  if (v.kind == "folder") {
    if (!v.entries.length) return `<p class="src-note">This folder is empty.</p>`;
    const up = v.path ? `<li><a href="${treeHref(ref, v.path.split("/").slice(0, -1).join("/"))}"><span class="icon">↰</span><span class="name">..</span></a></li>` : "";
    return `<ul class="src-list">${up}${v.entries.map((e) => {
      const p = v.path ? `${v.path}/${e.name}` : e.name;
      return `<li><a href="${treeHref(ref, p)}"><span class="icon ${e.folder ? "folder" : "file"}" aria-hidden="true"></span><span class="name">${esc(e.name)}${e.folder ? "/" : ""}</span>${e.folder ? "" : `<span class="size">${size(e.size)}</span>`}</a></li>`;
    }).join("")}</ul>`;
  }
  if (v.link != null) return `<p class="src-note">A link to <code>${esc(v.link)}</code>.</p>`;
  if (v.text == null) return `<p class="src-note">A binary file (${size(v.size)}): it can't be shown as text.</p>`;
  const lines = v.text.split("\n");
  if (lines.at(-1) == "") lines.pop();
  const cut = v.cut ? `<p class="src-note">The first ${size(v.text.length)} of ${size(v.size)}. Clone the repository for the rest.</p>` : "";
  return `<div class="src-file"><div class="src-file-head">${lines.length} lines · ${size(v.size)}</div><pre><code>${lines.map((l) => `<span>${esc(l)}\n</span>`).join("")}</code></pre></div>${cut}`;
}

function shell(app: string, title: string, body: string): string {
  return appPage(title, inlineStyle("source"), `${crumbs(null, [{ label: "Source" }], "h1", app)}
<main class="src">
  ${body}
</main>
<script>
${TIMES_SCRIPT}
  const copy = document.getElementById("copy");
  copy?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(document.getElementById("clone").textContent); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500); } catch {}
  });
</script>`, false);
}

