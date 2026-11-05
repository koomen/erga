// `bun erga` (deploy/cli/ops-page.ts) as Pete runs it, in a clone with a config file and a job record: the page shows
// the primary with its staging instance, the job that runs, and "live" at the commit each instance answers. An entry
// that another terminal adds to the file shows at once, with no reload.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, until } from "../../helpers/fixtures";

const CLI = new URL("../../../deploy/cli/main.ts", import.meta.url).pathname;
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
  const command = `bun erga deploy ${sha("origin/staging").slice(0, 8)} ${staging}`;
  writeFileSync(
    join(dir, ".erga/jobs/2026-11-05T10-00-00-000Z-localhost-1.jsonl"),
    `${JSON.stringify({ command, host: staging, from: "terminal", pid: process.pid, started: "2026-11-05T10:00:00.000Z" })}\n`
  );
  const cli = spawn("bun", [CLI, "--no-open", "--port", "0"], { cwd: dir });
  try {
    let out = "";
    const url = await new Promise<string>((done, fail) => {
      cli.stdout.on("data", (c) => {
        out += c;
        const m = /The ops page: (\S+)/.exec(out);
        if (m) done(m[1]);
      });
      cli.on("close", () => fail(new Error(`bun erga stopped: ${out}`)));
    });
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
