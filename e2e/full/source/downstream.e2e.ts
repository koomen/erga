// A downstream's Ops page (an Erga on its own domain, forked from erga.dev's):
// two dev servers, one as erga.dev (upstream), one as the downstream whose
// repository knows it (ERGA_UPSTREAM). Where it stands against upstream:
// upstream's commits it doesn't have as their own rows, the line that counts
// them, "yours" on its own commits; Update from upstream (a merge commit),
// a conflict that stops with the files and the ways out, and Drop; each
// environment's domains, added and removed. The page's screenshot, for the
// report: ERGA_SHOTS names the folder.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, type Server } from "../../helpers/server";
import { beforeTests, expect, servers, test } from "../../helpers/fixtures";
import { newToken } from "../../helpers/new-token";

const up = () => servers.of("downstream-up", { env: { ERGA_DEPLOY_MOCK: "1" } });
let down: Server | undefined;
await beforeTests(async () => { down = await startServer({ env: { ERGA_DEPLOY_MOCK: "1", ERGA_UPSTREAM: (await up()).root } }); });
test.afterAll(() => { down?.dispose(); down = undefined; });

/** An admin token of a server, and a git helper for a checkout of its repository. */
async function admin(server: Server, label: string) {
  const token = (await newToken(server.root, { label, scope: "admin" })).token;
  expect(token).toBeTruthy();
  const remote = `${server.root.replace("://", `://x:${token}@`)}/git/erga.git`;
  const api = (path: string, body: unknown) => fetch(`${server.root}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { token: token!, remote, api };
}
const gitIn = (dir: string) => (...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("the position against upstream, Update with a merge, a conflict and its ways out, and the environments' domains", { timeout: 90_000 }, async ({ tab }) => {
  const upstream = await up(), server = down!, { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const count = (sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const hidden = (id: string) => page.evaluate((i) => (document.getElementById(i) as HTMLElement).hidden, id);
  const upAdmin = await admin(upstream, "Downstream test: upstream"), downAdmin = await admin(server, "Downstream test: downstream");
  // Upstream's history: three commits on main and staging, the first release tagged.
  const u = join(server.scratch, `up-${Date.now()}`); mkdirSync(u);
  const ug = gitIn(u);
  ug("init", "-q", "-b", "main");
  writeFileSync(join(u, "a.txt"), "one\ntwo\nthree\nfour\n"); writeFileSync(join(u, "README.md"), "# Erga\n");
  ug("add", "."); ug("commit", "-qm", "First");
  writeFileSync(join(u, "b.txt"), "bee\n"); ug("add", "."); ug("commit", "-qm", "Second");
  writeFileSync(join(u, "a.txt"), "one\ntwo\nthree\nfour\nfive\n"); ug("add", "."); ug("commit", "-qm", "Third");
  ug("push", "-q", upAdmin.remote, "HEAD:staging", "HEAD:main");
  expect((await upAdmin.api("/api/tools/cut_release", { version: "v0.1.0", notes: "First" })).status).toBe(200);
  // The downstream: a fork at that point.
  const d = join(server.scratch, `down-${Date.now()}`); mkdirSync(d);
  const dg = gitIn(d);
  dg("clone", "-q", u, "."); dg("push", "-q", downAdmin.remote, "HEAD:staging", "HEAD:main");

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${server.root}/admin/ops`);
  await expect.poll(() => text("#grid .row"), { timeout: 10_000 }).toContain("Third");
  const upName = upstream.root.replace(/^https?:\/\//, "");
  // Level with upstream: the Update row says so, the button is off, the legend names upstream's rows.
  await expect.poll(() => text("#upstream-count")).toBe(`up to date with ${upName} v0.1.0 · no commits of your own`);
  expect(await page.evaluate(() => (document.getElementById("update") as HTMLButtonElement).disabled)).toBe(true);
  expect(await hidden("legend-upstream")).toBe(false);
  expect(await hidden("release-pill")).toBe(true);
  // The clone box and the page name upstream.
  expect(await text("#update")).toBe(`Update from ${upName}`);

  // Upstream moves on by two commits, the second released: two upstream rows above the downstream's, and the line between.
  writeFileSync(join(u, "c.txt"), "sea\n"); ug("add", "."); ug("commit", "-qm", "Fourth, upstream");
  writeFileSync(join(u, "b.txt"), "bee\nwasp\n"); ug("add", "."); ug("commit", "-qm", "Fifth, upstream");
  ug("push", "-q", upAdmin.remote, "HEAD:staging", "HEAD:main");
  expect((await upAdmin.api("/api/tools/cut_release", { version: "v0.2.0" })).status).toBe(200);
  // The downstream's own commit: "yours".
  writeFileSync(join(d, "o.txt"), "our own\n"); dg("add", "."); dg("commit", "-qm", "Our own change"); dg("push", "-q", downAdmin.remote, "HEAD:staging");
  await expect.poll(() => text("#upstream-count"), { timeout: 15_000 }).toBe(`${upName}: 2 commits (v0.2.0) that you do not have · 1 commit of your own`);
  expect(await count("#grid .row.upstream")).toBe(2);
  expect(await text("#grid .row.upstream .subj span")).toBe("Fifth, upstream");
  expect(await text("#grid .gap.upstream-line .gap-text")).toBe(`${upName}: 2 commits (v0.2.0) that you do not have · 1 commit of your own`);
  expect(await count("#grid .row.upstream .deps .dep")).toBe(0);
  expect(await text("#grid .row:not(.upstream) .subj .rel.own")).toBe("yours");
  // The rows' order: upstream's first, then the line, then the downstream's (its own on top).
  const order = await page.evaluate(() => [...document.querySelectorAll("#grid .row, #grid .gap")].slice(0, 4).map((e) => e.className.split(" ")[0] + ":" + (e.querySelector(".subj span, .gap-text")?.textContent ?? "").split(":")[0]));
  expect(order).toEqual(["row:Fifth, upstream", "row:Fourth, upstream", `gap:${upName.split(":")[0]}`, "row:Our own change"]);
  const shots = process.env.ERGA_SHOTS;
  if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, "downstream-ops.png"), fullPage: true }); }

  // Update: a merge commit (own commits and upstream's), staging deploys it; upstream's rows are gone.
  await page.click("#update");
  await expect.poll(() => text("#update-hint"), { timeout: 20_000 }).toContain("Merged v0.2.0 into staging (2 commits)");
  await expect.poll(() => text("#upstream-count"), { timeout: 10_000 }).toBe(`up to date with ${upName} v0.2.0 · 2 commits of your own`);
  expect(await count("#grid .row.upstream")).toBe(0);
  expect(await text("#grid .row .subj span")).toBe(`Update from ${upName} v0.2.0`);
  await expect.poll(() => text(`#grid .row .deps[data-target="staging"] .dep`), { timeout: 20_000 }).toMatch(/live|deployed|building|deploying/);
  dg("fetch", "-q", "origin"); // the local clone's origin is the upstream checkout; the downstream's remote is downAdmin.remote
  dg("fetch", "-q", downAdmin.remote, "staging");
  expect(dg("log", "-1", "--format=%P", "FETCH_HEAD").split(" ").length).toBe(2);

  // A conflict: both sides change a.txt's first line; the box lists the file and the ways out; Drop ends it.
  dg("reset", "-q", "--hard", "FETCH_HEAD");
  writeFileSync(join(d, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\n"); dg("add", "."); dg("commit", "-qm", "Our edit"); dg("push", "-q", downAdmin.remote, "HEAD:staging");
  writeFileSync(join(u, "a.txt"), "uno\ntwo\nthree\nfour\nfive\n"); ug("add", "."); ug("commit", "-qm", "Sixth, upstream, conflicting"); ug("push", "-q", upAdmin.remote, "HEAD:staging", "HEAD:main");
  expect((await upAdmin.api("/api/tools/cut_release", { version: "v0.3.0" })).status).toBe(200);
  // Upstream moved with no event here: the page reads its position again every 30 s; a reload does it now.
  await page.reload();
  await expect.poll(() => text("#upstream-count"), { timeout: 15_000 }).toContain("1 commit (v0.3.0) that you do not have");
  await page.click("#update");
  await expect.poll(() => text("#update-hint"), { timeout: 20_000 }).toContain("Stopped: 1 file conflicts");
  await expect.poll(() => hidden("conflict-box")).toBe(false);
  expect(await text("#conflict-count")).toBe("1 file conflicts");
  expect(await text("#conflict-title")).toContain("Update from");
  expect(await text("#conflict-intro")).toContain("v0.3.0");
  expect(await text("#conflict-branch")).toBe("upstream-merge/v0.3.0");
  expect(await text("#conflict-files")).toContain("a.txt");
  expect(await text("#conflict-git")).toContain("git push erga HEAD:staging");
  expect(await page.evaluate(() => (document.getElementById("update") as HTMLButtonElement).disabled)).toBe(true);
  // The branch is there for a checkout, with the markers.
  dg("fetch", "-q", downAdmin.remote, "upstream-merge/v0.3.0");
  expect(dg("show", "FETCH_HEAD:a.txt")).toContain("<<<<<<< staging");
  await page.click("#conflict-drop");
  await page.click("#conflict-drop");
  await expect.poll(() => hidden("conflict-box"), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (document.getElementById("update") as HTMLButtonElement).disabled)).toBe(false);

  // Each environment's domains: its own address first; one added to staging, then removed.
  // (Staging's Worker is there once its deploy is live: a domain goes on the Worker.)
  await expect.poll(() => text("#env-staging .st"), { timeout: 30_000 }).toContain("live");
  await expect.poll(() => text("#domains-staging"), { timeout: 10_000 }).toContain("staging.erga.dev");
  expect(await text("#domains-staging .dom.primary")).toBe("staging.erga.dev");
  await page.click('#domains-staging button[data-add="staging"]');
  await page.fill("#domain-host", "docs.erga.dev");
  await page.click("#domain-go");
  await expect.poll(() => text("#domain-status"), { timeout: 10_000 }).toContain("Added");
  await expect.poll(() => text("#domains-staging"), { timeout: 10_000 }).toContain("docs.erga.dev");
  expect(await count("#domains-staging .dom")).toBe(2);
  // A hostname on no zone of the account: refused, with the zones named.
  await page.click('#domains-staging button[data-add="staging"]');
  await page.fill("#domain-host", "docs.elsewhere.org");
  await page.click("#domain-go");
  await expect.poll(() => text("#domain-status"), { timeout: 10_000 }).toContain("isn't on one of this account's zones");
  await page.click("#domain-cancel");
  // Remove: two clicks.
  await page.click('#domains-staging button[data-remove="docs.erga.dev"]');
  await page.click('#domains-staging button[data-remove="docs.erga.dev"]');
  await expect.poll(() => count("#domains-staging .dom"), { timeout: 10_000 }).toBe(1);
});
