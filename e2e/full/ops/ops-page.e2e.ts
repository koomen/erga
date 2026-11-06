// `bun erga` (deploy/cli/ops-page.ts) as Pete runs it, in a clone with a config file and a job record: the page shows
// the primary with its staging instance, the job that runs, and "live" at the commit each instance answers. An entry
// that another terminal adds to the file shows at once, with no reload. A row's Deploy button shows only in the cell
// under the mouse, or in the cell whose button has the focus. After a click, "Deploying…" or "Merging…" stays shown
// until its job ends (fake jobs: fake-jobs.ts), and a tab that loaded older styles reloads.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, until } from "../../helpers/fixtures";

const CLI = new URL("../../../deploy/cli/main.ts", import.meta.url).pathname;
const DEPLOY = new URL("../../../deploy/cli/deploy.ts", import.meta.url).pathname;
const FACTS = { account: "acc", worker: "w", database: "d", app: { kind: "workers.dev" }, pages: { kind: "shared" }, vars: {} };

/** A clone with three commits: main at the first, staging at the third, and a feature branch on top. */
function clone() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-ops-page-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet");
  for (const n of [1, 2, 3])
    git("-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "--allow-empty", "-m", `Change ${n}`);
  git("update-ref", "refs/remotes/origin/main", "HEAD~2");
  git("update-ref", "refs/remotes/origin/staging", "HEAD");
  git("-c", "user.name=Pete", "-c", "user.email=p@example.com", "commit", "--quiet", "--allow-empty", "-m", "A feature");
  git("update-ref", "refs/remotes/origin/a-feature", "HEAD");
  return { dir, sha: (ref: string) => git("rev-parse", ref) };
}

/** One fake instance on two names: 127.0.0.1 answers main's commit, localhost answers staging's. */
async function instance(main: string, staging: string) {
  const server = createServer((req, res) => {
    const json = (v: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.url == "/api/health") return json({ ok: true });
    if (req.url != "/api/ops" || req.headers.authorization != "Bearer erga_ops_test") return json({ error: "no" }, 401);
    const host = req.headers.host ?? "";
    json({ version: (host.startsWith("localhost") ? staging : main).slice(0, 12), target: null, host, deploy: null });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as { port: number }).port };
}

/** `bun erga` in the clone, and the page's address. */
async function opsPage(dir: string) {
  const cli = spawn("bun", [CLI, "--no-open", "--port", "0"], { cwd: dir });
  let out = "";
  const url = await new Promise<string>((done, fail) => {
    cli.stdout.on("data", (c) => {
      out += c;
      const m = /The ops page: (\S+)/.exec(out);
      if (m) done(m[1]);
    });
    cli.on("close", () => fail(new Error(`bun erga stopped: ${out}`)));
  });
  return { cli, url };
}

test("the ops page shows the config's instances, the job that runs and the live commits; a new entry shows with no reload", async ({
  tab,
}) => {
  const { page } = tab;
  const { dir, sha } = clone();
  const { server, port } = await instance(sha("origin/main"), sha("origin/staging"));
  const primary = `127.0.0.1:${port}`,
    staging = `localhost:${port}`;
  const entry = (host: string, more = {}) => ({ host, ...FACTS, token: "erga_ops_test", ...more });
  const config = (instances: unknown[]) => writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances }));
  mkdirSync(join(dir, ".erga/jobs"), { recursive: true });
  config([entry(primary), entry(staging, { stagingOf: primary })]);
  const command = `bun erga deploy ${sha("origin/staging").slice(0, 8)} ${primary}`;
  const job = join(dir, ".erga/jobs/2026-11-05T10-00-00-000Z-localhost-1.jsonl");
  writeFileSync(
    job,
    `${JSON.stringify({ command, host: primary, from: "terminal", pid: process.pid, started: "2026-11-05T10:00:00.000Z" })}\n`
  );
  const { cli, url } = await opsPage(dir);
  try {
    await page.goto(url);
    /** The text of what `selector` picks, once it has `text`. */
    const shows = (selector: string, text: string) =>
      until(async () => (await page.locator(selector).first().textContent())?.includes(text), 5000, `${selector} shows ${text}`);
    await shows(".side .group.sel .primary", primary);
    await shows(".side .group.sel .staging", staging);
    // The job line, under the tabs: a light that pulses, the command, and where it came from.
    await shows(".tabs + .job.running code", command);
    await shows(".job.running", "from a terminal");
    await shows(".feature .f-name", "a-feature");
    // "live" at the commit each instance answers, in its column.
    await shows(`.row[data-sha="${sha("origin/staging")}"] .dep.live[data-host="${staging}"]`, "live");
    await shows(`.row[data-sha="${sha("origin/main")}"] .dep.live[data-host="${primary}"]`, "live");

    // A row's Deploy shows only in the cell under the mouse, or the cell whose button has the focus.
    const row = page.locator(`.row[data-sha="${sha("origin/staging~1")}"]`);
    const shown = () =>
      row
        .locator(".deps.here .tip")
        .evaluateAll((tips) => tips.map((t) => `${t.querySelector("button")?.dataset.host}:${getComputedStyle(t).opacity}`));
    await expect.poll(shown).toEqual([`${staging}:0`, `${primary}:0`]);
    await row.locator(".deps.here").first().hover();
    await expect.poll(shown).toEqual([`${staging}:1`, `${primary}:0`]);
    await row.locator(".deps.here").last().hover();
    await expect.poll(shown).toEqual([`${staging}:0`, `${primary}:1`]);
    // The job ends: the buttons take the focus again (a disabled one can't).
    appendFileSync(job, `${JSON.stringify({ result: "ok", ended: "2026-11-05T10:01:00.000Z" })}\n`);
    await expect.poll(() => row.locator(`[data-deploy][data-host="${staging}"]`).isEnabled()).toBe(true);
    await page.mouse.move(0, 0);
    await row.locator(`[data-deploy][data-host="${staging}"]`).focus();
    await expect.poll(shown).toEqual([`${staging}:1`, `${primary}:0`]);
    await page.locator("body").focus();

    // Another terminal registers a second primary: the page shows it, with no reload.
    await page.evaluate(() => ((window as unknown as { before: boolean }).before = true));
    config([entry(primary), entry(staging, { stagingOf: primary }), entry("erga.example.test")]);
    await shows(".side .group >> nth=1", "erga.example.test");
    expect(await page.evaluate(() => (window as unknown as { before?: boolean }).before)).toBe(true);
  } finally {
    cli.kill();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that another process starts: the page switches to its primary and shows its log as it comes", async ({ tab }) => {
  const { page } = tab;
  const { dir } = clone();
  const entry = (host: string) => ({ host, ...FACTS, token: "erga_ops_test" });
  mkdirSync(join(dir, ".erga/jobs"), { recursive: true });
  // No instance answers: the job, not the instances, is what the page shows here.
  writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances: [entry("127.0.0.1:9"), entry("localhost:9")] }));
  const { cli, url } = await opsPage(dir);
  let job: ReturnType<typeof spawn> | null = null;
  try {
    await page.goto(`${url}#127.0.0.1:9/logs`);
    const shows = (selector: string, text: string) =>
      until(async () => (await page.locator(selector).first().textContent())?.includes(text), 8000, `${selector} shows ${text}`);
    await shows(".main .title", "127.0.0.1:9");
    await shows(".tab-body", "No job yet.");
    // Another process: a job on the second primary, which writes a line, waits for a file, writes one more and ends.
    const go = join(dir, "go");
    job = spawn(
      "bun",
      [
        "-e",
        `const { startJob } = await import(${JSON.stringify(DEPLOY)});
         const { existsSync } = await import("node:fs");
         const job = startJob(${JSON.stringify(join(dir, ".erga"))}, { command: "bun erga rollback localhost:9", host: "localhost:9", print: () => {} });
         job.log("Roll back to the version from before...");
         while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 50));
         job.log("Rolled back: healthy.");
         job.end("ok");`,
      ],
      { cwd: dir, stdio: "inherit" }
    );
    // The page switches to the job's primary, on the same tab, and shows the job line and the job's output.
    await shows(".main .title", "localhost:9");
    expect(page.url()).toContain("#localhost:9/logs");
    await shows(".tabs + .job.running code", "bun erga rollback localhost:9");
    await shows(".logs .log", "Roll back to the version from before...");
    writeFileSync(go, "");
    await shows(".logs .log", "Rolled back: healthy.");
    await shows(".logs .state", "done");
    // History lists it; its row opens its log.
    await page.click('.tabs .tab:has-text("History")');
    await shows(".history .h-row.ok .h-cmd", "bun erga rollback localhost:9");
    await page.click(".history .h-row.ok");
    await shows(".logs .log", "Rolled back: healthy.");
  } finally {
    job?.kill();
    cli.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a click, Deploying… and Merging… stay shown, with no hover and through a draw, until the job ends; an old tab reloads", async ({
  tab,
}) => {
  const { page } = tab;
  const { dir, sha } = clone();
  const entry = (host: string, more = {}) => ({ host, ...FACTS, token: "erga_ops_test", ...more });
  mkdirSync(join(dir, ".erga/jobs"), { recursive: true });
  writeFileSync(
    join(dir, ".erga/config.json"),
    JSON.stringify({ instances: [entry("127.0.0.1:9"), entry("localhost:9", { stagingOf: "127.0.0.1:9" })] })
  );
  // The page with fake jobs: each runs until the file `end` says how it ends.
  const cli = spawn("bun", [new URL("./fake-jobs.ts", import.meta.url).pathname, dir]);
  const url = await new Promise<string>((done, fail) => {
    let out = "";
    cli.stdout.on("data", (c) => {
      out += c;
      const m = /The ops page: (\S+)/.exec(out);
      if (m) done(m[1]);
    });
    cli.on("close", () => fail(new Error(`the page stopped: ${out}`)));
  });
  const end = (result: "ok" | "failed") => writeFileSync(join(dir, "end"), result);
  /** Waits until the page draws again: its old content is gone. */
  const drawn = async () => {
    await page.evaluate(() => document.querySelector("#ops .main")?.setAttribute("data-old", ""));
    await expect.poll(() => page.locator("#ops .main[data-old]").count()).toBe(0);
  };
  try {
    await page.goto(url);
    const row = page.locator(`.row[data-sha="${sha("origin/staging~1")}"]`);
    const cell = row.locator('.deps.here:has([data-host="localhost:9"])');
    /** The cell's button: its text, and whether it shows. */
    const state = () =>
      cell.evaluate((c) => `${c.querySelector("button")?.textContent}:${getComputedStyle(c.querySelector(".tip")!).opacity}`);
    await cell.hover();
    await cell.locator("button").click();
    await page.click('#deploy-confirm [data-go]:has-text("Deploy to localhost:9")');
    await page.mouse.move(0, 0);
    await expect.poll(state).toBe("Deploying…:1");
    await drawn();
    expect(await state()).toBe("Deploying…:1");
    // The job fails: the cell shows Deploy again, on hover only.
    end("failed");
    await expect.poll(state).toBe("Deploy:0");

    // Merge: its form, then Merging… until the job ends.
    const merge = page.locator('.feature[data-branch="a-feature"]');
    await merge.locator("[data-merge]").click();
    await merge.locator(".f-merge button:not([data-cancel])").click();
    await page.mouse.move(0, 0);
    const label = () => merge.locator(".f-top [data-merge]").textContent();
    await expect.poll(label).toBe("Merging…");
    await drawn();
    expect(await label()).toBe("Merging…");
    end("ok");
    await expect.poll(label).toBe("Merge");

    // A tab that loaded other styles (bun erga ran again, after a pull) reloads at its next draw, and has the new ones.
    await page.evaluate(() => {
      document.querySelector('meta[name="ops-code"]')?.setAttribute("content", "old");
      (window as unknown as { before: boolean }).before = true;
    });
    await page.evaluate(() => (location.hash = "#127.0.0.1:9/history"));
    await expect.poll(() => page.evaluate(() => (window as unknown as { before?: boolean }).before ?? false)).toBe(false);
  } finally {
    cli.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
