// Several checkouts, each with its own dev server, at once (dev.ts): two
// copies of this checkout run `bun start` with no port or state of their own
// given, as two agents' worktrees would, and share nothing.
//
//   - Both come up, on different ports (each from its path, the same each
//     time), and each writes its address to .dev-url (bun start --print-url).
//   - One browser, signed in on both: signing in or out on one leaves the
//     other's person as it was (cookies named for the port, worker/cookies.ts).
//   - One restarting (an edit to its front.ts, with --reload) or stopping
//     leaves the other running, and its tabs where they were.
//   - No fixed port is bound (4400, the factory's 4401, the inspector's 9229),
//     and the two bind none in common.
//
// The copies share this checkout's node_modules (a link), as a worktree's
// may: Vite's cache is the checkout's own (.cloudflare/vite), not in there.
//
//   bun tests/checkouts.ts
// covers: dev.ts vite.config.ts worker/cookies.ts worker/auth.ts

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Browser, ROOT, type Page } from "./cdp.ts";
import { killLeftovers } from "./host.ts";

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail == null ? "" : ` (${typeof detail == "string" ? detail : JSON.stringify(detail)})`}`); if (!ok) failures++; };

// The copies: the checkout's files (committed or not, minus what git ignores), and its packages (a link to them).
const scratch = mkdtempSync(join(tmpdir(), "erga-checkouts-"));
const files = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT }).stdout.toString().split("\0").filter(Boolean);
const copy = (name: string) => {
  const dir = join(scratch, name, "erga");
  for (const f of files) { try { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(ROOT, f), join(dir, f)); } catch { /* deleted, not yet committed */ } }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  // Each checkout's own settings, as `bun start` makes them: signed in as tester, each with its own session secret.
  writeFileSync(join(dir, ".dev.vars"), `DEV_LOGIN=tester\nSESSION_SECRET=${crypto.randomUUID()}\n`);
  return dir;
};

// `bun start` as an agent runs it: none of the test harness's own settings (tests/host.ts), so the defaults are what's tested.
const env: Record<string, string> = { ...process.env as Record<string, string>, ANTHROPIC_API_KEY: "" };
for (const k of ["ERGA_BUILT", "ERGA_STATE_DIR", "ERGA_ENV_DIR", "ERGA_VITE_CACHE", "ERGA_INSPECTOR", "ERGA_PORT", "PORT"]) delete env[k];

interface Server { dir: string; proc: ReturnType<typeof Bun.spawn>; url: string; port: number; output(): string }

async function start(dir: string, extra: string[] = []): Promise<Server> {
  let output = "";
  const proc = Bun.spawn(["bun", join(dir, "dev.ts"), "--no-open", ...extra], { cwd: dir, env, stdout: "pipe", stderr: "pipe", detached: true });
  for (const s of [proc.stdout, proc.stderr]) (async () => { for await (const c of s) output = (output + new TextDecoder().decode(c)).slice(-20000); })();
  return { dir, proc, url: "", port: 0, output: () => output };
}

/** Up: its address in .dev-url, and the docs page (which reads the database) answering there. */
async function up(s: Server): Promise<Server> {
  const file = join(s.dir, ".dev-url");
  for (const until = Date.now() + 150_000; Date.now() < until && s.proc.exitCode == null;) {
    if (existsSync(file)) {
      s.url = readFileSync(file, "utf8").trim();
      s.port = Number(new URL(s.url).port);
      try { if ((await fetch(`http://127.0.0.1:${s.port}/docs`)).ok) return s; } catch { /* not yet */ }
    }
    await Bun.sleep(50);
  }
  throw new Error(`${s.dir} didn't come up:\n${s.output()}`);
}

const serves = (port: number) => fetch(`http://127.0.0.1:${port}/style.css`).then((r) => r.ok, () => false);

/** Every process under `pid`. */
function tree(pid: number): number[] {
  const out = [pid];
  for (const line of Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n")) if (Number(line)) out.push(...tree(Number(line)));
  return out;
}

/** The TCP ports a server's processes listen on. */
function listening(s: Server): number[] {
  const pids = tree(s.proc.pid).join(",");
  const out = Bun.spawnSync(["lsof", "-nP", "-a", "-p", pids, "-iTCP", "-sTCP:LISTEN", "-Fn"]).stdout.toString();
  return [...new Set(out.split("\n").filter((l) => l.startsWith("n")).map((l) => Number(l.split(":").pop())))].sort((a, b) => a - b);
}

/** Who a server says this tab's browser is: the login in its corner, or null when signed out (sent to sign in). */
const who = (p: Page, s: Server) => p.eval<string | null>(`fetch(${JSON.stringify(`${s.url}/docs`)}, { redirect: "manual", credentials: "include" }).then(async (r) =>
  r.type == "opaqueredirect" ? null : (/avatars\\.githubusercontent\\.com\\/([\\w-]+)\\?s=64/.exec(await r.text()) ?? [])[1] ?? "?")`);

const servers: Server[] = [];
let browser: Browser | null = null;
try {
  const [dirA, dirB] = [copy("a"), copy("b")];
  servers.push(await start(dirA, ["--reload"]), await start(dirB, ["--reload"]));
  const [a, b] = await Promise.all(servers.map(up));

  // ---------------------------------------------------------------- both up, apart
  check(a.port != b.port, "two checkouts' servers come up at once, with no flags, on different ports", [a.url, b.url]);
  check([a, b].every((s) => s.port >= 4410 && s.port <= 4999), "each on a port from its path (4410-4999)", [a.port, b.port]);
  check([a, b].every((s) => s.output().includes(`Erga is running at ${s.url}`)), "each prints its address", a.output().slice(-600));
  const printed = Bun.spawnSync(["bun", join(dirA, "dev.ts"), "--print-url"], { cwd: dirA, env }).stdout.toString().trim();
  check(printed == a.url, "bun start --print-url prints the checkout's address", printed);
  const again = Bun.spawnSync(["bun", join(dirA, "dev.ts"), "--no-open"], { cwd: dirA, env, timeout: 30_000 });
  check(again.exitCode == 2 && again.stderr.toString().includes(`already running at ${a.url}`), "a second bun start in the same checkout says where the first is, and stops", again.stderr.toString());
  check([dirA, dirB].every((d) => existsSync(join(d, ".cloudflare/state")) && existsSync(join(d, ".cloudflare/vite"))), "each keeps its state and Vite's cache in its own checkout");

  const ports = { a: listening(a), b: listening(b) };
  const fixed = [4400, 4401, 9229];
  check(![...ports.a, ...ports.b].some((p) => fixed.includes(p)), "no fixed port is bound (4400, 4401, 9229)", ports);
  check(!ports.a.some((p) => ports.b.includes(p)), "the two bind no port in common", ports);
  check(ports.a.includes(a.port + 10000) && ports.b.includes(b.port + 10000), "each Worker's debugger is beside its server (port + 10000)", ports);

  // ---------------------------------------------------------------- one browser, two sessions
  browser = await Browser.launch();
  const tabA = await browser.page(), tabB = await browser.page();
  await tabA.open(`${a.url}/docs`, { width: 1000, height: 700 });
  await tabB.open(`${b.url}/docs`, { width: 1000, height: 700 });
  check(await who(tabA, a) == "tester" && await who(tabB, b) == "tester", "at first, both are DEV_LOGIN", [await who(tabA, a), await who(tabB, b)]);
  await tabA.navigate(`${a.url}/auth/github?as=ada&next=/docs`);
  await tabB.navigate(`${b.url}/auth/github?as=bo&next=/docs`);
  check(await who(tabA, a) == "ada", "signed in as ada on one, she stays ada after the other signs in", await who(tabA, a));
  check(await who(tabB, b) == "bo", "and bo on the other is bo", await who(tabB, b));
  const jar = (await tabA.send("Network.getAllCookies")).cookies as { name: string; domain: string }[];
  check(jar.some((c) => c.name == `erga_session_${a.port}`) && jar.some((c) => c.name == `erga_session_${b.port}`), "the browser holds a session cookie for each port", jar.map((c) => c.name));
  await tabB.eval(`fetch("/auth/logout", { method: "POST", redirect: "manual" }).then(() => true)`);
  check(await who(tabB, b) == null, "signing out of one signs it out", await who(tabB, b));
  check(await who(tabA, a) == "ada", "and leaves the other signed in, as the same person", await who(tabA, a));

  // ---------------------------------------------------------------- one restarts, then stops
  await tabA.navigate(`${a.url}/docs`);
  // Signed out, /docs signs this browser in again as DEV_LOGIN (local development), on that server only.
  await tabB.navigate(`${b.url}/docs`);
  const bWho = await who(tabB, b);
  check(bWho == "tester" && await who(tabA, a) == "ada", "back on the other, it signs in as DEV_LOGIN, and ada stays ada", [bWho, await who(tabA, a)]);
  await tabA.eval(`window.__before = true`);
  await tabB.eval(`window.__before = true`);
  const bPid = b.proc.pid;
  // A change to the Worker's front door: Vite restarts that server, and its tabs reload (dev/reload.ts).
  const front = join(dirA, "front.ts");
  writeFileSync(front, readFileSync(front, "utf8").replace("<title>${esc(title)} · Erga</title>", "<title>${esc(title)} · Erga, edited</title>"));
  let reloaded = false;
  for (let i = 0; i < 600 && !reloaded; i++) {
    await Bun.sleep(50);
    reloaded = await tabA.eval<boolean>(`!window.__before && document.title.endsWith("edited")`).catch(() => false);
  }
  check(reloaded, "one server restarts (its front.ts edited), and its tab reloads", a.output().split("\n").slice(-8).join("\n"));
  await Bun.sleep(1500);
  check(await tabB.eval<boolean>(`window.__before === true && !document.title.endsWith("edited")`), "the other's tab doesn't reload");
  check(b.proc.exitCode == null && b.proc.pid == bPid && await serves(b.port), "and the other server runs on, the same process");

  a.proc.kill("SIGTERM");
  await a.proc.exited;
  check(!existsSync(join(dirA, ".dev-url")), "a server stopped removes its .dev-url");
  check(!(await serves(a.port)), "and no longer answers");
  check(b.proc.exitCode == null && await serves(b.port) && existsSync(join(dirB, ".dev-url")), "the other runs on, its .dev-url in place");
  check(await tabB.eval<boolean>(`window.__before === true`) && await who(tabB, b) == bWho, "its tab is where it was, as the same person");
  const printedGone = Bun.spawnSync(["bun", join(dirA, "dev.ts"), "--print-url"], { cwd: dirA, env });
  check(printedGone.exitCode == 1, "bun start --print-url in a checkout with no server running exits 1", printedGone.stderr.toString());

  // ---------------------------------------------------------------- the same port again
  servers[0] = await up(await start(dirA));
  check(servers[0].port == a.port, "started again, a checkout's server is on the same port as before", [a.port, servers[0].port]);
} catch (e) {
  check(false, "the test ran", (e as Error).stack);
} finally {
  browser?.close();
  for (const s of servers) if (s.proc.exitCode == null) { s.proc.kill("SIGTERM"); await Promise.race([s.proc.exited, Bun.sleep(10_000)]); }
  for (const s of servers) for (const p of tree(s.proc.pid)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  killLeftovers(scratch);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
