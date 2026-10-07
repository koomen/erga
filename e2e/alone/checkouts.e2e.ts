// Several checkouts, each with its own dev server, at once (dev.ts), from tests/checkouts.ts: two copies of this
// checkout run `bun start` with no port or state of their own given, as two agents' worktrees would, and share
// nothing. They take the ports dev.ts picks from their paths, so this file runs alone, with no other test's server
// beside it (e2e.alone.config.ts: one worker, after the rest).
//
// The copies share this checkout's node_modules (a link), as a worktree's may: Vite's cache is the checkout's own
// (.cloudflare/vite), not in there. Each test leaves both servers running, as it found them.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, until, withoutOutage, type Page } from "../fixtures";
import { cleanEnv } from "../env";
import { copyCheckout, startIn, tree, upAt, type Started } from "../checkout";

interface Checkout { dir: string; server: Started; url: string; port: number }
let scratch = "";
const co: Checkout[] = [];

/** `bun start` as an agent runs it: none of the tests' own settings, so the defaults are what's tested. */
async function start(c: Pick<Checkout, "dir">, args: string[] = []): Promise<Checkout> {
  const server = startIn(c.dir, ["--no-open", ...args]);
  const out = { dir: c.dir, server, url: "", port: 0 };
  // Up: its address in .dev-url, and the docs page (which reads the database) answering there.
  await upAt(server, () => {
    const file = join(c.dir, ".dev-url");
    if (!existsSync(file)) return null;
    out.url = readFileSync(file, "utf8").trim();
    out.port = Number(new URL(out.url).port);
    return `http://127.0.0.1:${out.port}/docs`;
  }, 150_000);
  return out;
}

test.beforeAll(async () => {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "erga-checkouts-"));
  const dirs = ["a", "b"].map((name) => {
    const dir = join(scratch, name, "erga");
    copyCheckout(dir);
    // Each checkout's own settings, as `bun start` makes them: signed in as tester, each with its own session secret.
    writeFileSync(join(dir, ".dev.vars"), `DEV_LOGIN=tester\nSESSION_SECRET=${crypto.randomUUID()}\n`);
    return dir;
  });
  co.push(...await Promise.all(dirs.map((dir) => start({ dir }, ["--reload"]))));
});

test.afterAll(async () => {
  await Promise.all(co.map((c) => c.server.stop()));
  // What a server's tree left behind, by its folder.
  if (scratch) spawnSync("pkill", ["-9", "-f", scratch], { timeout: 10_000 });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const serves = (port: number) => fetch(`http://127.0.0.1:${port}/style.css`).then((r) => r.ok, () => false);
const bun = (dir: string, args: string[], timeout = 30_000) => spawnSync("bun", [join(dir, "dev.ts"), ...args], { cwd: dir, env: cleanEnv(), encoding: "utf8", timeout });

/** The TCP ports a server's processes listen on. */
function listening(c: Checkout): number[] {
  const out = spawnSync("lsof", ["-nP", "-a", "-p", tree(c.server.proc.pid!).join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8", timeout: 30_000 }).stdout ?? "";
  return [...new Set(out.split("\n").filter((l) => l.startsWith("n")).map((l) => Number(l.split(":").pop())))].sort((x, y) => x - y);
}

/** Who a server says this tab's browser is: the login in its corner, or null when signed out (sent to sign in). */
const who = (p: Page, c: Checkout) => p.evaluate(`fetch(${JSON.stringify(`${c.url}/docs`)}, { redirect: "manual", credentials: "include" }).then(async (r) =>
  r.type == "opaqueredirect" ? null : (/avatars\\.githubusercontent\\.com\\/([\\w-]+)\\?s=64/.exec(await r.text()) ?? [])[1] ?? "?")`) as Promise<string | null>;

test("two checkouts' servers come up at once, with no flags, each on a port from its path, and say where", async () => {
  const [a, b] = co;
  expect(a.port).not.toBe(b.port);
  for (const c of co) {
    expect(c.port).toBeGreaterThanOrEqual(4410);
    expect(c.port).toBeLessThanOrEqual(4999);
    expect(c.server.output()).toContain(`Erga is running at ${c.url}`);
    // Each keeps its state and Vite's cache in its own checkout.
    expect(existsSync(join(c.dir, ".cloudflare/state")) && existsSync(join(c.dir, ".cloudflare/vite"))).toBe(true);
  }
  expect(bun(a.dir, ["--print-url"]).stdout.trim()).toBe(a.url);
  // A second bun start in the same checkout says where the first is, and stops.
  const again = bun(a.dir, ["--no-open"]);
  expect(again.status).toBe(2);
  expect(again.stderr).toContain(`already running at ${a.url}`);
});

test("no fixed port is bound (4400, 4401, 9229), the two bind none in common, and each Worker's debugger is beside its server", async () => {
  const [a, b] = co;
  const ports = { a: listening(a), b: listening(b) };
  expect([...ports.a, ...ports.b].filter((p) => [4400, 4401, 9229].includes(p))).toEqual([]);
  expect(ports.a.filter((p) => ports.b.includes(p))).toEqual([]);
  expect(ports.a).toContain(a.port + 10000);
  expect(ports.b).toContain(b.port + 10000);
});

test("one browser signed in on both: signing in or out on one leaves the other's person as it was", async ({ tab }) => {
  tab.strict = true;
  const [a, b] = co;
  const tabA = tab.page, tabB = await tab.page.context().newPage();
  await tabA.goto(`${a.url}/docs`);
  await tabB.goto(`${b.url}/docs`);
  expect([await who(tabA, a), await who(tabB, b)]).toEqual(["tester", "tester"]);
  await tabA.goto(`${a.url}/auth/github?as=ada&next=/docs`);
  await tabB.goto(`${b.url}/auth/github?as=bo&next=/docs`);
  expect(await who(tabA, a)).toBe("ada");
  expect(await who(tabB, b)).toBe("bo");
  const jar = (await tab.page.context().cookies()).map((c) => c.name);
  expect(jar).toContain(`erga_session_${a.port}`);
  expect(jar).toContain(`erga_session_${b.port}`);
  await tabB.evaluate(`fetch("/auth/logout", { method: "POST", redirect: "manual" }).then(() => true)`);
  expect(await who(tabB, b)).toBe(null);
  expect(await who(tabA, a)).toBe("ada");
  // Signed out, /docs signs this browser in again as DEV_LOGIN (local development), on that server only.
  await tabB.goto(`${b.url}/docs`);
  expect(await who(tabB, b)).toBe("tester");
  expect(await who(tabA, a)).toBe("ada");
});

// Vite restarts the server (seconds; more on a busy machine) before the tab can reload.
test("one server restarting (its front.ts edited, with --reload) reloads its tabs, and leaves the other's server and tabs alone", { timeout: 45_000 }, async ({ tab }) => {
  tab.strict = true;
  const [a, b] = co;
  const tabA = tab.page, tabB = await tab.page.context().newPage();
  await tabA.goto(`${a.url}/docs`);
  await tabB.goto(`${b.url}/docs`);
  for (const t of [tabA, tabB]) await t.evaluate(`window.__before = true`);
  const bPid = b.server.proc.pid, bOutput = b.server.output().length;
  const front = join(a.dir, "front.ts"), mark = `edited ${crypto.randomUUID().slice(0, 6)}`;
  writeFileSync(front, readFileSync(front, "utf8").replace(/<title>\$\{esc\(title\)\} · Erga[^<]*<\/title>/, `<title>\${esc(title)} · Erga, ${mark}</title>`));
  await until(() => tabA.evaluate(`!window.__before && document.title.endsWith(${JSON.stringify(mark)})`).catch(() => false), 30_000, "the edited server's tab reloads", () => a.server.output().split("\n").slice(-8).join("\n"));
  // The other server was never told to reload a tab, nor restarted (which would reload its tabs): its tab is as it was.
  expect(b.server.output().slice(bOutput)).not.toMatch(/reloading|restart/i);
  expect(b.server.alive() && b.server.proc.pid == bPid && await serves(b.port)).toBe(true);
  expect(await tabB.evaluate(`window.__before === true && !document.title.includes("edited")`) as boolean).toBe(true);
  withoutOutage(tab.errors);
});

// A server stopped and started again: a few seconds each, more on a busy machine.
test("one server stopping leaves the other running and its tab as it was; started again, it's on the same port", { timeout: 90_000 }, async ({ tab }) => {
  tab.strict = true;
  const [a, b] = co;
  const tabB = tab.page;
  await tabB.goto(`${b.url}/docs`);
  await tabB.evaluate(`window.__before = true`);
  const bWho = await who(tabB, b);
  await a.server.stop();
  expect(existsSync(join(a.dir, ".dev-url"))).toBe(false);
  expect(await serves(a.port)).toBe(false);
  expect(b.server.alive() && await serves(b.port) && existsSync(join(b.dir, ".dev-url"))).toBe(true);
  expect(await tabB.evaluate(`window.__before === true`) as boolean).toBe(true);
  expect(await who(tabB, b)).toBe(bWho);
  // bun start --print-url in a checkout with no server running exits 1.
  expect(bun(a.dir, ["--print-url"]).status).toBe(1);
  co[0] = await start(a, ["--reload"]);
  expect(co[0].port).toBe(a.port);
});
