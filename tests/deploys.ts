#!/usr/bin/env bun
// Branch deploys in the real Worker (workerd, under the dev server), against
// the mock Cloudflare's copy of Erga's account (ERGA_DEPLOY_MOCK=1,
// deploy/mock.ts): nothing real is deployed, and no production data is read.
// The dev server plays staging (ERGA_DEPLOY_TARGET=staging). A push to the
// staging branch reaches it the way production passes one on (POST
// /api/deploys/staging/hook, with the shared secret); its Pipeline Durable
// Object builds (the mock builder) and deploys it, copying production's
// database and documents in; GET /api/deploys and the events on
// /api/events follow it, and GET /api/deploys/staging/log has the whole log,
// whose lines also arrive live as {type: "deploy-log"} events; Redeploy runs
// it again; a build that fails says why, and the next push deploys.
// /admin/deploys goes to /source (task #39's dashboard). Who may see and do
// what last.
//
//   bun tests/deploys.ts [--keep]     (--keep leaves the server running, with a deploy done)

import { existsSync } from "fs";
import { join } from "path";
import { ROOT } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const keep = process.argv.includes("--keep");
const HOOK = "mock-hook-secret-0123456789abcdef";
const SHA1 = "5e7a9e1c0ffee5e7a9e1c0ffee5e7a9e1c0ffee5", SHA2 = "0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad", SHA3 = "c0de5e7a9e1c0de5e7a9e1c0de5e7a9e1c0de5e7";

// The release the mock builder stands in with (deploy/release.ts), made if this checkout has none.
if (!existsSync(join(ROOT, ".site/release/release.json"))) {
  if (!existsSync(join(ROOT, ".site/page.js"))) expect(Bun.spawnSync([join(ROOT, "site.sh")], { cwd: ROOT }).exitCode == 0, "site.sh");
  const made = Bun.spawnSync(["bun", join(ROOT, "deploy/release.ts")], { cwd: ROOT });
  expect(made.exitCode == 0, "the release builds", made.stderr.toString());
}

const host = await startHost(null, { env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" }, port: keep ? Number(process.env.PORT || 0) || undefined : undefined });
const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${host.root}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const push = (commit: string) => api("/api/deploys/staging/hook", { method: "POST", headers: { Authorization: `Bearer ${HOOK}`, "Content-Type": "application/json" }, body: JSON.stringify({ branch: "staging", commit }) });
const stagingOf = async () => ((await api("/api/deploys")).body.targets as any[]).find((t) => t.name == "staging");

try {
  // ---------------------------------------------------------------- the status, before anything
  // The dev server migrates its database as it starts: until then, its first answers can be errors.
  let first = await api("/api/deploys");
  await until(async () => (first = await api("/api/deploys")).status == 200, 20_000, "the server answers");
  expect(first.status == 200 && first.body.targets.map((t: any) => t.name).join() == "production,staging", "GET /api/deploys: both targets", first);
  const [prod0, stag0] = first.body.targets;
  expect(prod0.host == "erga.dev" && prod0.branch == "main" && !prod0.self && stag0.host == "staging.erga.dev" && stag0.branch == "staging" && stag0.self && stag0.state == "idle", "staging is this server's; production another's", first.body);
  for (const k of ["name", "host", "branch", "state", "commit", "at", "error", "log"]) expect(k in stag0, `a target has ${k} (the contract)`);
  expect((await api("/api/deploys/version")).body.target == "staging", "GET /api/deploys/version says which target this is");
  ok("GET /api/deploys: production and staging, as the contract has them");

  // ---------------------------------------------------------------- the events
  const events: string[] = [];
  const logEvents: { target: string; deployId: string; lines: { at: number; text: string; step?: string }[] }[] = [];
  const stream = await fetch(`${host.root}/api/events`);
  expect(stream.status == 200 && stream.headers.get("content-type")?.startsWith("text/event-stream"), "GET /api/events is an event stream", stream.status);
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      for (const m of buf.split("\n\n").slice(0, -1)) {
        const d = /^data: (.*)$/m.exec(m)?.[1];
        if (!d) continue;
        const e = JSON.parse(d);
        events.push(e.type);
        if (e.type == "deploy-log") logEvents.push(e);
      }
      buf = buf.split("\n\n").pop() ?? "";
    }
  })().catch(() => {});
  await until(() => events.includes("hello"), 10_000, "the stream says hello");

  // ---------------------------------------------------------------- a push to staging
  const r = await push(SHA1);
  expect(r.status == 200 && r.body.ok, "the push is taken (POST /api/deploys/staging/hook)", r);
  await until(async () => (await stagingOf()).state == "deployed", 60_000, "staging builds and deploys itself", async () => JSON.stringify(await stagingOf(), null, 1));
  const done = await stagingOf();
  expect(done.commit == SHA1 && done.deployed == SHA1 && done.error == null, "the commit is live", done);
  expect(done.steps.map((s: any) => s.id).join() == "build,account,database,data,migrations,assets,worker,address,pages,live,documents" && done.steps.every((s: any) => s.status == "done"), "every step done, copying production's data included", done.steps);
  expect(done.steps.find((s: any) => s.id == "documents").detail.includes("3 documents copied"), "production's documents copied", done.steps);
  expect(done.log.some((l: string) => l.includes("build: $ bun install --frozen-lockfile")) && done.log.at(-1).includes(`deployed ${SHA1.slice(0, 12)}`), "the log says what happened, step by step", done.log);
  await until(() => events.filter((e) => e == "deploys").length > 8, 5000, "an event on each change", () => events.join());
  ok(`a push deploys staging: built, every step, production's data copied; ${events.filter((e) => e == "deploys").length} events`);

  // ---------------------------------------------------------------- the deploy's log, whole and live
  const log = (await api("/api/deploys/staging/log")).body;
  expect(log.commit == SHA1 && log.state == "deployed" && log.deployId.includes(SHA1.slice(0, 7)), "GET /api/deploys/staging/log: the latest deploy", log);
  expect(log.lines.every((l: any) => typeof l.at == "number" && typeof l.text == "string"), "each line with its time", log.lines.slice(0, 3));
  const steps = new Set(log.lines.map((l: any) => l.step).filter(Boolean));
  expect(["build", "account", "database", "data", "migrations", "assets", "worker", "address", "pages", "live", "documents"].every((x) => steps.has(x)), "and its step", [...steps]);
  await until(() => logEvents.flatMap((e) => e.lines).length >= log.lines.length, 5000, "the same lines came as events");
  expect(logEvents.every((e) => e.target == "staging" && e.deployId == log.deployId), "{type: \"deploy-log\", target, deployId, lines}", logEvents[0]);
  expect(JSON.stringify(logEvents.flatMap((e) => e.lines)) == JSON.stringify(log.lines), "in order, none missing", { events: logEvents.flatMap((e) => e.lines).length, log: log.lines.length });
  expect((await api("/api/deploys/nowhere/log")).status == 404, "a target that isn't one: not found");
  ok(`the deploy's log: ${log.lines.length} lines, each with its time and step, the same lines live in ${logEvents.length} events`);

  // Redeploy: a new deploy, a new log, its lines live as they come.
  logEvents.length = 0;
  const again = await api("/api/deploys/staging", { method: "POST", headers: { Origin: host.root } });
  expect(again.status == 200 && again.body.ok, "POST /api/deploys/staging redeploys", again);
  await until(() => logEvents.length > 0, 15_000, "the new deploy's lines arrive while it runs");
  const midway = (await stagingOf()).state;
  await until(async () => (await stagingOf()).state == "deployed", 60_000, "and it finishes");
  const second = (await api("/api/deploys/staging/log")).body;
  expect(second.deployId != log.deployId && logEvents.every((e) => e.deployId == second.deployId), "with a deploy id of its own", second.deployId);
  expect(["building", "deploying", "deployed"].includes(midway), "(seen running)", midway);
  ok("Redeploy: a new deploy with its own log, its lines live");

  // ---------------------------------------------------------------- the dashboard is /source
  const to = await fetch(`${host.root}/admin/deploys`, { redirect: "manual" });
  expect(to.status == 302 && to.headers.get("location") == "/source", "/admin/deploys goes to /source", to.status);
  ok("/admin/deploys redirects to /source, the source and deploys dashboard");

  // ---------------------------------------------------------------- a build that fails, then the next push
  await push(SHA2);
  await until(async () => (await stagingOf()).state == "failed", 60_000, "a build that fails shows failed");
  const failed = await stagingOf();
  expect(failed.commit == SHA2 && failed.deployed == SHA1 && /^Stopped at “Build the commit”\. .*lockfile is frozen/.test(failed.error), "saying where and why; the last good commit stays live", failed);
  expect((await api("/api/deploys/version")).status == 200, "the server keeps answering");
  const failedLog = (await api("/api/deploys/staging/log")).body;
  expect(failedLog.state == "failed" && failedLog.lines.at(-1).step == "build" && failedLog.lines.at(-1).text.includes("lockfile is frozen"), "its log ends with why, on the build step", failedLog.lines.at(-1));
  await push(SHA3);
  await until(async () => (await stagingOf()).deployed == SHA3, 60_000, "the next push deploys");
  ok("a failed build says where and why; the next push deploys");

  // ---------------------------------------------------------------- who may
  const signIn = async (login: string) => {
    const res = await fetch(`${host.root}/auth/github?as=${login}&next=/`, { redirect: "manual" });
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="))!;
  };
  const bo = await signIn("bo");
  expect((await api("/api/deploys", { headers: { Cookie: bo } })).status == 403, "someone who isn't an admin can't read the status");
  expect((await fetch(`${host.root}/api/events`, { headers: { Cookie: bo } })).status == 403, "nor the events");
  expect((await api("/api/deploys/staging/log", { headers: { Cookie: bo } })).status == 403, "nor a deploy's log");
  expect((await api("/api/deploys/staging", { method: "POST", headers: { Cookie: bo, Origin: host.root } })).status == 403, "nor redeploy");
  expect((await api("/api/deploys/staging", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status == 403, "an admin's redeploy from another site is refused");
  expect((await api("/api/deploys/production", { method: "POST", headers: { Origin: host.root } })).status == 409, "staging can't redeploy production");
  expect((await api("/api/deploys/staging/hook", { method: "POST", body: JSON.stringify({ branch: "staging", commit: SHA1 }) })).status == 404, "a push without the shared secret isn't taken");
  expect((await api("/api/deploys/status")).status == 404, "nor a status request");
  expect((await api("/api/snapshot/docs", { method: "POST", body: "{}" })).status == 404, "the snapshot endpoints aren't there without SNAPSHOT_TOKEN");
  ok("admins only (status, log, events, redeploy); server-to-server only with the secret");

  if (keep) {
    console.log(`\nkept running: ${host.root}/api/deploys/staging/log`);
    await new Promise(() => {});
  }
} finally {
  if (!keep) await host.dispose();
}
