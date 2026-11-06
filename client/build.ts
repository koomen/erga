#!/usr/bin/env bun
// Builds the client: everything the Worker serves as static assets, into
// .build/ at the repo's root (gitignored). Usage: bun client/build.ts (or bun run build);
// --sizes also prints what the editor loads before it takes input, raw, gzip and brotli.
//
//   _erga/             every file of the editor's, named by its content's hash, so the browser keeps it for a
//                      year and never asks again (_headers): the scripts (ES modules, split in chunks that
//                      load when they're needed), the stylesheet, the editor's page and the typeface
//     main-<h>.js        page.js: the page editor's shell (main.ts), which the viewer adds when you edit
//     tools-<h>.js       tools.js: Erga's page tools (client/page-tools/tools.ts: the live page's tools: page_log,
//                        page_input), on each document's own origin too, built with frame.js
//     frame-<h>.js       frame.js: the editor itself (frame.ts), which runs on each document's own origin, loaded
//                        from here (one address for every document, so one copy in the browser's cache)
//     steps-<h>.js       steps.js: erga/steps (libs/steps/ui/library.ts), a presentation's bar and list of steps, which the
//                        page imports itself; it works outside Erga too
//     settings-<h>.js    document settings (settings.ts), imported when the gear is reached for
//     pages-tree-<h>.js  a document's pages (pages-tree.ts), imported when someone opens the tree
//     agent-<h>.js                each person's agent panel, on every page (client/agent/person-agent.ts)
//     admin-share-<h>.js, admin-nav-<h>.js   the admin pages' Share and navigation
//     live-<h>.js        open pages across a redeploy (live.ts), on every page of the site's own
//     chunk-<h>.js       code two of them share, or that one of them imports only when it needs it (the source
//                        view's CodeMirror and languages, the agent's screenshots)
//     style-<h>.css, editor-<h>.html, inter-<h>.css, fonts/inter-...-<h>.woff2
//     admin-<h>.css      the admin pages' one stylesheet (client/styles/admin.css)
//   manifest.json      each file's address by its name, the chunks each script needs first, their integrity
//                      hashes and the typeface's @font-face rules (shared/assets.ts): the Worker reads it and
//                      names the files in the pages it makes (server/pages/assets.ts). Not served.
//   _headers           the hashed files' headers, on Cloudflare's static assets (the Worker sets them again: serveAsset; the deploy sends it as the
//                      Worker's assets config: deploy/pipeline/pipeline.ts)
//   logo.png           Erga's logo (assets/logo/logo.png), public at /logo.png: a square 512 px PNG for
//                      places that want one (an OAuth client's logo)
//
// And, into the repository: server/pages/inline-code.ts, the scripts and styles the server puts in its pages inline
// (each file of client/inline/; the scripts type-checked as the client is), as text. It's committed, so the server
// needs no build to run; tests/inline-code.test.ts checks it's up to date. Usage: bun client/build.ts --inline makes only it.
//
// The build writes into a folder of its own, then moves each file into .build/
// and writes the manifest last, so a server never names a file that isn't there,
// even with two builds at once. The files of the last build stay beside the new
// ones (an open page may still import one of its chunks); older ones go.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { ASSET_PREFIX, type AssetManifest } from "../shared/assets";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".build");
const DIR = ASSET_PREFIX.slice(1, -1);

/** The scripts, by name, and their sources. */
export const ENTRIES: Record<string, string> = {
  "page.js": "client/shell/main.ts",
  "frame.js": "libs/text/ui/frame.ts",
  "steps.js": "libs/steps/ui/library.ts",
  "tools.js": "client/page-tools/tools.ts",
  "settings.js": "client/pages/settings.ts",
  "pages-tree.js": "client/pages/pages-tree.ts",
  "agent.js": "client/agent/person-agent.ts",
  "admin-share.js": "client/admin/admin-share.ts",
  "admin-nav.js": "client/admin/admin-nav.ts",
  "live.js": "client/live/live.ts",
};

/** The headers of the hashed files: kept for a year, and loadable from a document's own origin (the frame's scripts and fonts). */
export const HEADERS = `${ASSET_PREFIX}*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
  Cross-Origin-Resource-Policy: cross-origin
  X-Content-Type-Options: nosniff
`;

/**
 * The frame's build: @codemirror/view as an inert stand-in (libs/text/ui/frame-view.ts). The frame has no CodeMirror view
 * (bridge.ts), but CodeMirror's language, history and Markdown modules import the view's for their view parts.
 */
export const FRAME_VIEW: import("bun").BunPlugin = {
  name: "erga:frame-view",
  setup(b) {
    b.onResolve({ filter: /^@codemirror\/view$/ }, () => ({ path: join(ROOT, "libs/text/ui/frame-view.ts") }));
  },
};

const sha = (bytes: Uint8Array, alg = "sha256") => new Bun.CryptoHasher(alg as "sha256").update(bytes);
const hashOf = (bytes: Uint8Array) => sha(bytes).digest("hex").slice(0, 10);
const integrityOf = (bytes: Uint8Array) => `sha384-${new Bun.CryptoHasher("sha384").update(bytes).digest("base64")}`;

/** Where the inline scripts and styles go, as text (see above). */
export const INLINE_OUT = join(ROOT, "server/pages/inline-code.ts");

/**
 * The inline code's file: each script of client/inline/ (a default-exported function) built alone and minified, as
 * the text of an expression whose value is the function, which the server calls in the page (server/pages/inline.ts);
 * and each stylesheet of client/inline/, without its comments, as the text for a <style>.
 */
export async function inlineCode(): Promise<string> {
  const dir = join(ROOT, "client/inline");
  const files = readdirSync(dir).sort();
  const scripts: string[] = [];
  for (const f of files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) {
    const result = await Bun.build({ entrypoints: [join(dir, f)], target: "browser", format: "esm", minify: true, splitting: false });
    if (!result.success) {
      for (const l of result.logs) console.error(l);
      throw new Error(`client/inline/${f} didn't build`);
    }
    const js = (await result.outputs[0].text()).trim();
    const m = /export\s*\{\s*([\w$]+)\s+as\s+default\s*\};?$/.exec(js);
    if (!m) throw new Error(`client/inline/${f} has no default export (a function)`);
    const code = js.slice(0, m.index).trim();
    // One function and nothing else is the function itself; anything more goes in a closure that answers it.
    let alone = false;
    try {
      alone = code.startsWith(`function ${m[1]}(`) && typeof new Function(`return (${code})`)() == "function";
    } catch {}
    const text = alone ? `(${code})` : `(()=>{${code};return ${m[1]}})()`;
    scripts.push(`  ${JSON.stringify(f.replace(/\.ts$/, ""))}: ${JSON.stringify(text)},`);
  }
  const styles: string[] = [];
  for (const f of files.filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(join(dir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\n\s*/g, "\n")
      .trim();
    if (/<\/style/i.test(css)) throw new Error(`client/inline/${f} holds </style>`);
    styles.push(`  ${JSON.stringify(f.replace(/\.css$/, ""))}: ${JSON.stringify(css)},`);
  }
  return `// Made by client/build.ts from client/inline/: don't edit it, edit those and run bun client/build.ts --inline.
// tests/inline-code.test.ts checks it's up to date. For server/pages/inline.ts: each script is the text of a function,
// each style the text of a stylesheet.
/* biome-ignore-all format: made by client/build.ts */

export const SCRIPTS = {
${scripts.join("\n")}
} as const;

export const STYLES = {
${styles.join("\n")}
} as const;
`;
}

/** Writes the inline code's file, if it changed. */
async function writeInline(): Promise<void> {
  const text = await inlineCode();
  const was = (() => {
    try {
      return readFileSync(INLINE_OUT, "utf8");
    } catch {
      return "";
    }
  })();
  if (text != was) writeFileSync(INLINE_OUT, text);
}

async function build(): Promise<void> {
  // The server settings the deploy locks (deploy/locked-settings.ts): a bad one stops the build here.
  const check = Bun.spawnSync(["bun", "deploy/locked-settings.ts"], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  if (check.exitCode != 0) process.exit(check.exitCode || 1);

  await writeInline();
  const tmp = join(OUT, `.next-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  const at = join(tmp, DIR);
  mkdirSync(join(at, "fonts"), { recursive: true });
  /** Each file written, by its address (/_erga/...). */
  const made = new Map<string, Uint8Array>();
  const put = (name: string, bytes: Uint8Array) => { writeFileSync(join(at, name), bytes); made.set(ASSET_PREFIX + name, bytes); return ASSET_PREFIX + name; };

  // The scripts, in two builds. The frame's alone: it runs on each document's own origin, and the browser keeps what a
  // document's frame loads apart from what the shell loads (Chrome's cache is keyed by the frame's site too), so a chunk
  // shared with the shell would be fetched twice anyway; and alone, it has only what the frame uses of each module (with
  // the shell, it would have what either uses: the source view's languages). Then the rest, together: what two of them
  // share is one chunk. In both, what a script imports later (import()) is a chunk of its own.
  const files: Record<string, string> = {};
  const imports = new Map<string, { path: string; kind: string }[]>();
  const scripts = async (names: string[], plugins: import("bun").BunPlugin[]) => {
    const result = await Bun.build({
      entrypoints: names.map((n) => join(ROOT, ENTRIES[n])), outdir: at, splitting: true, format: "esm", target: "browser", minify: true, sourcemap: "none",
      naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]" }, metafile: true, plugins,
    } as Bun.BuildConfig);
    if (!result.success) { for (const l of result.logs) console.error(l); process.exit(1); }
    const meta = (result as unknown as { metafile: { outputs: Record<string, { imports: { path: string; kind: string }[]; entryPoint?: string }> } }).metafile;
    for (const [out, o] of Object.entries(meta.outputs)) {
      const url = ASSET_PREFIX + out.replace(/^\.\//, "");
      made.set(url, new Uint8Array(readFileSync(join(at, out))));
      imports.set(url, o.imports.filter((i) => i.path.startsWith("./")).map((i) => ({ path: ASSET_PREFIX + i.path.slice(2), kind: i.kind })));
      const name = o.entryPoint && names.find((n) => resolve(ROOT, ENTRIES[n]) == resolve(ROOT, o.entryPoint!) || o.entryPoint!.endsWith(ENTRIES[n]));
      if (name) files[name] = url;
    }
  };
  const PAGE_SCRIPTS = ["frame.js", "steps.js", "tools.js"];
  await scripts(PAGE_SCRIPTS, [FRAME_VIEW]);
  await scripts(
    Object.keys(ENTRIES).filter((n) => !PAGE_SCRIPTS.includes(n)),
    []
  );
  for (const name of Object.keys(ENTRIES)) if (!files[name]) throw new Error(`the build made no ${name}`);
  /** The scripts `url` imports, and theirs: only the static ones, or the later ones too. */
  const closure = (url: string, later: boolean) => {
    const seen = new Set<string>([url]), queue = [url];
    while (queue.length) for (const i of imports.get(queue.shift()!) ?? []) if ((later || i.kind == "import-statement") && !seen.has(i.path)) { seen.add(i.path); queue.push(i.path); }
    return [...seen];
  };
  const deps = Object.fromEntries(Object.entries(files).map(([name, url]) => [name, closure(url, false).slice(1)]));

  // The typeface: each file by its hash, and its @font-face rules naming them so.
  const fontDir = join(ROOT, "client/fonts");
  const fontUrl = new Map<string, string>();
  for (const f of readdirSync(fontDir).filter((n) => n.endsWith(".woff2")).sort()) {
    const bytes = new Uint8Array(readFileSync(join(fontDir, f)));
    fontUrl.set(f, put(`fonts/${f.replace(/\.woff2$/, "")}-${hashOf(bytes)}.woff2`, bytes));
  }
  const fontCss = readFileSync(join(fontDir, "inter.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\(([^)]+)\)/g, (_, f: string) => { const u = fontUrl.get(f.replace(/["']/g, "")); if (!u) throw new Error(`inter.css names ${f}, which isn't in client/fonts`); return `url(${u})`; })
    .replace(/\s*\n\s*/g, "").replace(/\s*([{};:,])\s*/g, "$1").replace(/;}/g, "}");
  const latin = fontUrl.get("inter-latin-normal.woff2");
  if (!latin) throw new Error("client/fonts has no inter-latin-normal.woff2");
  const enc = (s: string) => new TextEncoder().encode(s);
  files["inter.css"] = put(`inter-${hashOf(enc(fontCss))}.css`, enc(fontCss));

  const style = new Uint8Array(readFileSync(join(ROOT, "client/style.css")));
  files["style.css"] = put(`style-${hashOf(style)}.css`, style);
  // The admin pages' one stylesheet (client/styles/admin.css): the same file on every admin page.
  const admin = enc(readFileSync(join(ROOT, "client/styles/admin.css"), "utf8"));
  files["admin.css"] = put(`admin-${hashOf(admin)}.css`, admin);

  // The editor's page, naming the files of this build: the typeface's rules and its own styles in it (no stylesheet to
  // wait for), its stylesheet, and its script as a module.
  let editor = readFileSync(join(ROOT, "client/editor.html"), "utf8");
  const swap = (from: string, to: string) => {
    if (!editor.includes(from)) throw new Error(`client/editor.html has no ${from}`);
    editor = editor.replace(from, () => to);
  };
  swap(`<link rel="stylesheet" href="/fonts/inter.css">`, `<style id="erga-fonts">${fontCss}</style>`);
  swap(`<link rel="stylesheet" href="/bars.css">`, `<style>${readFileSync(join(ROOT, "client/inline/bars.css"), "utf8")}</style>`);
  swap(`<link rel="stylesheet" href="/editor.css">`, `<style>${readFileSync(join(ROOT, "client/styles/editor.css"), "utf8")}</style>`);
  swap(`<link rel="stylesheet" href="/glass.css">`, `<style>${readFileSync(join(ROOT, "client/styles/glass.css"), "utf8")}</style>`);
  swap(`<link rel="stylesheet" href="/style.css">`, `<link rel="stylesheet" href="${files["style.css"]}">`);
  swap(`<script src="/page.js"></script>`, `<script type="module" src="${files["page.js"]}"></script>`);
  // (Not fetched by any page: the server puts the shell into the document's page, below. Its address names this build of
  // the shell, which live.ts compares with the server's.)
  files["editor.html"] = put(`editor-${hashOf(enc(editor))}.html`, enc(editor));

  const manifest: AssetManifest = {
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    deps,
    frame: [...new Set(PAGE_SCRIPTS.flatMap((n) => closure(files[n], true)))],
    integrity: Object.fromEntries([...made].filter(([u]) => u.endsWith(".js")).sort(([a], [b]) => a.localeCompare(b)).map(([u, b]) => [u, integrityOf(b)])),
    fonts: { css: fontCss, preload: latin },
    shell: editorShell(editor, new TextDecoder().decode(style)),
  };

  // Into place: the files, then the manifest that names them, then what neither this build nor the last one names.
  mkdirSync(join(OUT, DIR, "fonts"), { recursive: true });
  for (const url of made.keys()) renameSync(join(tmp, url), join(OUT, url));
  const place = (name: string, bytes: string | Uint8Array) => { const t = join(OUT, `.${name}.${process.pid}`); writeFileSync(t, bytes); renameSync(t, join(OUT, name)); };
  place("logo.png", readFileSync(join(ROOT, "assets/logo/logo.png")));
  place("_headers", HEADERS);
  const last = (() => { try { return JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")) as AssetManifest; } catch { return null; } })();
  place("manifest.json", JSON.stringify(manifest, null, 1) + "\n");
  rmSync(tmp, { recursive: true, force: true });
  const keep = new Set([...made.keys(), ...(last ? namedBy(last) : [])]);
  for (const f of readdirSync(join(OUT, DIR), { recursive: true }) as string[]) {
    const url = ASSET_PREFIX + f.split("\\").join("/");
    if (!keep.has(url) && statSync(join(OUT, url)).isFile()) rmSync(join(OUT, url), { force: true });
  }
  // What builds from before the hashed files left at the top.
  for (const old of ["page.js", "frame.js", "settings.js", "pages-tree.js", "admin-agent.js", "admin-share.js", "admin-nav.js", "live.js", "style.css", "editor.html", "build.json", "fonts"]) rmSync(join(OUT, old), { recursive: true, force: true });

  const size = (url: string) => made.get(url)!.length;
  const first = [...new Set([files["page.js"], ...deps["page.js"], files["frame.js"], ...deps["frame.js"]])];
  console.log(`built ${made.size} files: page.js ${size(files["page.js"])} bytes (+${deps["page.js"].length} chunks), frame.js ${size(files["frame.js"])} bytes (+${deps["frame.js"].length} chunks); the editor's scripts before it takes input: ${first.reduce((n, u) => n + size(u), 0)} bytes`);
  if (process.argv.includes("--sizes")) sizes(manifest, made);
}

/**
 * The editor's shell as the server puts it into a document's page (server/pages/viewer.ts): its styles as one sheet
 * (the stylesheet's rules, then the page's own), and its controls (the page's body without the frame, which the
 * viewer has, and without the scripts). No file to fetch and no stylesheet to wait for.
 */
export function editorShell(editor: string, styleCss: string): { style: string; body: string } {
  const head = editor.slice(0, editor.indexOf("</head>")), body = /<body[^>]*>([\s\S]*)<\/body>/.exec(editor)?.[1];
  if (body == null) throw new Error("client/editor.html has no <body>");
  const own = [...head.matchAll(/<style(?![^>]*id="erga-fonts")[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const css = [styleCss, ...own].join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s+/g, "\n");
  if (/<\/style/i.test(css)) throw new Error("the editor's styles hold </style>");
  const controls = body.replace(/<iframe id="frame"[^>]*><\/iframe>/, "").replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (/<\/template/i.test(controls)) throw new Error("the editor's controls hold </template>");
  return { style: css, body: controls };
}

/** Every file a manifest names. */
function namedBy(m: AssetManifest): string[] {
  const out = new Set<string>([...Object.values(m.files), ...Object.values(m.deps).flat(), ...m.frame, ...Object.keys(m.integrity)]);
  for (const u of m.fonts.css.matchAll(/url\(([^)]+)\)/g)) out.add(u[1]);
  return [...out];
}

/** What the editor loads before it takes input (the shell's and the frame's scripts, its page and stylesheet), raw, gzip and brotli. */
function sizes(m: AssetManifest, made: Map<string, Uint8Array>) {
  const row = (label: string, urls: string[]) => {
    let raw = 0, gz = 0, br = 0;
    for (const u of urls) {
      const b = made.get(u)!;
      raw += b.length; gz += gzipSync(b, { level: 9 }).length;
      br += brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    }
    console.log(`${label.padEnd(34)}${String(raw).padStart(9)}${String(gz).padStart(9)}${String(br).padStart(9)}  (${urls.length} files)`);
  };
  const shell = [m.files["page.js"], ...m.deps["page.js"]], frame = [m.files["frame.js"], ...m.deps["frame.js"]];
  console.log(`${"".padEnd(34)}${"raw".padStart(9)}${"gzip".padStart(9)}${"brotli".padStart(9)}`);
  row("page.js and its chunks", shell);
  row("frame.js and its chunks", frame);
  row("editor.html", [m.files["editor.html"]]);
  row("style.css", [m.files["style.css"]]);
  row("all of it, once", [...new Set([...shell, ...frame, m.files["editor.html"], m.files["style.css"]])]);
  row("later: every other chunk", [...made.keys()].filter((u) => u.endsWith(".js") && !shell.includes(u) && !frame.includes(u)));
}

if (import.meta.main) await (process.argv.includes("--inline") ? writeInline() : build());
