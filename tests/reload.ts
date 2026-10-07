// Live reload (`bun start --reload`, dev/reload.ts) in
// headless Chrome: an open page reloads by itself, showing the change, when
// the Worker's front door changes (Vite restarts the server), when another
// Worker module changes (Vite reloads the Worker), and when the editor's own
// files change (site.sh rebuilds them), the page editor included. The edits are made in a throwaway
// copy of this checkout, never in it, so nothing else running here sees them.
// Also: a document's own frame gets no script, and without --reload no page does.
//
//   bun tests/reload.ts
// covers: dev/reload.ts

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Browser, ROOT } from "./cdp.ts";
import { freePort } from "./host.ts";

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail == null ? "" : ` (${typeof detail == "string" ? detail : JSON.stringify(detail)})`}`); if (!ok) failures++; };

// The copy: the checkout's files (committed or not, minus what git ignores), and its packages (a link to them).
const scratch = mkdtempSync(join(tmpdir(), "erga-reload-"));
const copy = join(scratch, "erga");
const files = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT }).stdout.toString().split("\0").filter(Boolean);
for (const f of files) { try { mkdirSync(dirname(join(copy, f)), { recursive: true }); cpSync(join(ROOT, f), join(copy, f)); } catch { /* deleted, not yet committed */ } }
symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules")); // read-only here, and copying it is slow
mkdirSync(join(scratch, "env"));
writeFileSync(join(scratch, "env", ".dev.vars"), `DEV_LOGIN=tester\nSESSION_SECRET=${crypto.randomUUID()}\n`);

const edit = (file: string, from: string, to: string) => {
  const path = join(copy, file), text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(path, text.replace(from, to));
};

/** `bun start` in the copy, with its own state, settings and cache; the editor built and watched (no ERGA_BUILT). */
async function start(port: number, reload: boolean) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ERGA_STATE_DIR: join(scratch, `state-${port}`), ERGA_ENV_DIR: join(scratch, "env"), ERGA_VITE_CACHE: join(scratch, `vite-${port}`), ERGA_INSPECTOR: "0", ANTHROPIC_API_KEY: "" };
  delete env.ERGA_BUILT;
  let output = "";
  const proc = Bun.spawn(["bun", join(copy, "dev.ts"), "--port", String(port), "--no-open", ...(reload ? ["--reload"] : [])], { cwd: copy, env, stdout: "pipe", stderr: "pipe", detached: true });
  for (const s of [proc.stdout, proc.stderr]) (async () => { for await (const c of s) output = (output + new TextDecoder().decode(c)).slice(-20000); })();
  for (let i = 0; i < 2400 && proc.exitCode == null; i++) {
    // Up, with the database's tables made (the docs page needs them).
    try { if ((await fetch(`http://127.0.0.1:${port}/docs`)).ok) break; } catch { /* not yet */ }
    await Bun.sleep(25);
  }
  return { proc, output: () => output, stop: async () => { proc.kill("SIGTERM"); await proc.exited; } };
}

const port = freePort();
const root = `http://127.0.0.1:${port}`;
const server = await start(port, true);
const browser = await Browser.launch();
try {
  const page = await browser.page();
  await page.open(`${root}/docs`, { width: 1100, height: 700 });
  await page.settle();
  check(await page.eval(`document.title`) == "Documents · Erga", "the docs page is open", await page.eval(`document.title`));

  /** Marks the page, makes `change`, and waits for a fresh page (no mark) for which `ready` holds. */
  const reloads = async (what: string, change: () => void, ready: string) => {
    await page.eval(`window.__before = true`);
    change();
    let fresh = false;
    for (let i = 0; i < 600 && !fresh; i++) {
      await Bun.sleep(50);
      fresh = await page.eval(`!window.__before && document.readyState == "complete" && (${ready})`).catch(() => false);
    }
    check(fresh, what, server.output().split("\n").slice(-8).join("\n"));
  };

  await reloads("the Worker's front door changes (front.ts: Vite restarts the server): the page reloads, showing it",
    () => edit("front.ts", "<title>${esc(title)} · Erga</title>", "<title>${esc(title)} · Erga, edited</title>"),
    `document.title == "Documents · Erga, edited"`);
  await reloads("another Worker module changes (worker/index.ts: Vite reloads the Worker): the page reloads",
    () => edit("worker/index.ts", "\n", "\n// edited\n"), "true");
  await reloads("the editor's own files change (style.css: site.sh rebuilds them): the page reloads, with them",
    () => edit("style.css", "\n", "\n.erga-reload-test { color: red; }\n"),
    `true`);
  check((await (await fetch(`${root}/style.css`)).text()).includes(".erga-reload-test"), "and the rebuilt files are what's served");
  // Both at once, as an agent's edit often is: the restart and the rebuild end in one good page, never an error page.
  await reloads("the front door and the editor's files change together: the page comes back, with both",
    () => { edit("front.ts", "· Erga, edited</title>", "· Erga, edited twice</title>"); edit("style.css", ".erga-reload-test {", ".erga-reload-test-2 {}\n.erga-reload-test {"); },
    `document.title == "Documents · Erga, edited twice"`);
  await Bun.sleep(1500);
  check(await page.eval(`document.title`) == "Documents · Erga, edited twice", "and stays there", await page.eval(`document.title`));

  // The page editor itself, on a new document: it reloads when its code changes (src/page/), on the same document.
  await page.navigate(`${root}/new`);
  for (let i = 0; i < 200 && !(await page.eval(`!!document.querySelector("iframe") && /^\\/tester\\//.test(location.pathname)`).catch(() => false)); i++) await Bun.sleep(50);
  const doc = await page.eval(`location.pathname`);
  check(/^\/tester\/./.test(doc), "a new document opens in the editor", doc);
  await reloads("the editor's code changes (src/page/main.ts): the editor reloads, on the same document",
    () => edit("src/page/main.ts", "\n", "\n// edited\n"), `location.pathname == ${JSON.stringify(doc)} && !!document.querySelector("iframe")`);

  // Pages for tabs get the script; a frame (a document's own HTML) and a fetch don't.
  const get = async (dest: string) => (await (await fetch(`${root}/docs`, { headers: { "sec-fetch-dest": dest } })).text()).includes("erga live reload");
  check(await get("document") && !(await get("iframe")) && !(await get("empty")), "only top-level pages get the reload script");
  check(page.errors.length == 0, "no errors in the page", page.errors);
} finally {
  browser.close();
  await server.stop();
}

// Without --reload, nothing is added.
const port2 = freePort();
const plain = await start(port2, false);
try {
  const html = await (await fetch(`http://127.0.0.1:${port2}/docs`, { headers: { "sec-fetch-dest": "document" } })).text();
  check(html.includes("<title>Documents") && !html.includes("erga live reload"), "without --reload, pages are left alone", html.slice(0, 300) + plain.output().slice(-600));
} finally {
  await plain.stop();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passing");
process.exit(failures ? 1 : 0);
