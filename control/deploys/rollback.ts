// Rollbacks of a branch deploy's target (control/deploys/branches.ts): one an admin asks for (rollback), and the one
// that undoes an unhealthy release by itself (undo). Each is one deployment of the Worker version a deploy's restore
// point names, in seconds, with no build.

import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { targetHost } from "./pipeline";
import { DeployError } from "./cloudflare-api";
import { checkHealth, liveVersion, rollbackTo } from "./account";
import type { BranchDeploys, Run, StepStatus, Stored, TargetStatus } from "./branches";
import type { DeployRecord } from "./history";
import { runWith } from "../clock";

/**
 * Rolls a target back to the Worker version it ran before its live deploy
 * (rollback): one deployment of that version, in
 * seconds, with no build. The database stays as it is (migrations only add).
 * Recorded as a deploy of its own, live, whose restore point is the version
 * it rolled back from (so a second rollback rolls forward again). The record
 * is written before the call, complete; then the target is asked until it
 * answers the older release, healthy.
 */
export async function rollback(
  d: BranchDeploys,
  name: string,
  trigger: string
): Promise<{ ok: true; status: TargetStatus } | { ok: false; error: string; status?: number }> {
  if (!d.fleet.has(name)) return { ok: false, error: `There's no deploy target called ${name}.`, status: 404 };
  const wrong = await d.notReady(name);
  if (wrong) return { ok: false, error: wrong, status: 409 };
  const s = await d.load(name);
  if (s.run || d.running == name)
    return {
      ok: false,
      error: `A deploy of ${name} is running: wait for it to end (or push again to replace it), then roll back.`,
      status: 409,
    };
  const list = await d.history.records(name);
  const live = list.find((r) => r.id == s.status.liveDeploy) ?? null;
  const restore = live?.restore;
  if (!live || !restore?.versionId)
    return {
      ok: false,
      error: live
        ? `The live deploy (${live.commit.slice(0, 12)}) has no restore point: it was made before restore points were recorded, or its Worker was new. Deploy an earlier commit instead.`
        : `${name} has no live deploy to roll back from.`,
      status: 409,
    };
  const cf = await d.cf();
  const target = d.targetFor(name);
  // What serves now, so the rollback can itself be undone.
  const from = await liveVersion(cf, target.accountId, target.workerName).catch(() => null);
  const deployId = `${d.now().toString(36)}-rollback`;
  const rec: DeployRecord = {
    id: deployId,
    target: name,
    commit: restore.commit ?? live.commit,
    state: "deployed",
    started: d.now(),
    ended: null,
    trigger: `${trigger}: back to ${restore.version ?? `version ${restore.versionId.slice(0, 8)}`}, undoing deploy ${live.id} (${live.commit.slice(0, 12)})`,
    error: null,
    rollbackOf: live.id,
    restore: {
      versionId: from,
      version: s.status.deployed ? s.status.deployed.slice(0, 12) : null,
      bookmark: null,
      at: d.now(),
      commit: live.commit,
    },
  };
  live.state = "rolled-back";
  live.rolledBackBy = deployId;
  live.ended ??= d.now();
  list.unshift(rec);
  await d.history.putRecords(name, list);
  const steps: StepStatus[] = [
    {
      id: "rollback",
      title: `Roll back to ${restore.version ? `release ${restore.version}` : `version ${restore.versionId.slice(0, 8)}`}`,
      status: "running",
    },
  ];
  s.status = { ...s.status, state: "deploying", commit: rec.commit, deployId, at: d.now(), error: null, steps };
  s.run = { deployId, commit: rec.commit, started: d.now(), cursor: null, carry: {} };
  await d.history.openLog(name, s.run, true);
  d.line(
    s,
    `rolling ${d.specOf(name).host} back to ${restore.version ? `release ${restore.version}` : `version ${restore.versionId.slice(0, 8)}`} (${rec.trigger})`,
    "rollback"
  );
  d.line(
    s,
    `the version before deploy ${live.id} (${live.commit.slice(0, 12)}) serves again; the database keeps its schema${restore.bookmark ? ` (its bookmark from before that deploy: ${restore.bookmark})` : ""}`,
    "rollback"
  );
  // Complete before the call.
  steps[0].status = "done";
  s.status = { ...s.status, state: "deployed", at: d.now(), deployed: rec.commit, liveDeploy: deployId };
  d.line(s, `rolled back: https://${d.specOf(name).host} serves ${rec.commit.slice(0, 12)}`, "rollback");
  s.run = null;
  await d.save(s);
  try {
    await rollbackTo(cf, target, restore.versionId, `Erga rollback: ${rec.trigger}`);
  } catch (e) {
    const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
    live.state = "deployed";
    delete live.rolledBackBy;
    rec.state = "failed";
    rec.error = message;
    rec.ended = d.now();
    await d.history.putRecords(name, list);
    steps[0].status = "failed";
    s.status = {
      ...s.status,
      state: "failed",
      at: d.now(),
      error: `Stopped at “${steps[0].title}”. ${message}`,
      deployed: live.commit,
      liveDeploy: live.id,
    };
    s.run = { deployId, commit: rec.commit, started: rec.started, cursor: null, carry: {} };
    d.line(s, `failed: ${message}`, "rollback");
    s.run = null;
    await d.save(s);
    return { ok: false, error: message, status: 502 };
  }
  // Then wait for it to answer, so the log says it did.
  // Asked every two seconds, at most 30 times.
  const h = await runWith(
    d.deps.sleep,
    checkHealth(d.deps.net, targetHost(target), restore.version).pipe(
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), times: 29, until: (h) => h.ok })
    )
  );
  d.line(
    s,
    h.ok
      ? `https://${d.specOf(name).host} answers ${restore.version ?? "the older version"}, healthy (${h.summary})`
      : `https://${d.specOf(name).host} hasn't answered the older version yet: check it`,
    "rollback"
  );
  await d.save(s);
  return { ok: true, status: (await d.load(name)).status };
}

/**
 * An unhealthy release rolled back by itself: one deployment of the Worker version the deploy's restore point names.
 * The deploy stays failed, its record says it was undone, and the target's live deploy is the one before, as it was.
 * On this server's own target the deployment restarts this object into the older version: the record is written first.
 */
export async function undo(d: BranchDeploys, s: Stored, run: Run): Promise<void> {
  const name = s.status.name;
  const restore = run.carry.restore;
  const to = restore?.version ? `release ${restore.version}` : restore?.versionId ? `version ${restore.versionId.slice(0, 8)}` : null;
  console.log(
    `deploy ${run.deployId} of ${name} is unhealthy: ${restore?.versionId ? `rolling back to ${to}` : "no restore point to roll back to"}`
  );
  if (!restore?.versionId || !to) {
    d.line(
      s,
      "not rolled back by itself: this deploy has no restore point (a new Worker, or one whose deployments couldn't be read)",
      "rollback"
    );
    s.run = null;
    await d.save(s);
    return;
  }
  const note = `Rolled back to ${to} by itself.`;
  s.status = {
    ...s.status,
    error: `${s.status.error ?? ""} ${note}`.trim(),
    steps: [...s.status.steps, { id: "rollback", title: `Roll back to ${to}`, status: "done" }],
  };
  d.line(s, `unhealthy: rolling ${d.specOf(name).host} back to ${to} (what it ran before this deploy)`, "rollback");
  // Written whole before the call: the record (its error says it was undone), the log, no run left to resume.
  s.run = null;
  await d.save(s);
  const list = await d.history.records(name);
  const rec = list.find((r) => r.id == run.deployId);
  if (rec) {
    rec.error = s.status.error;
    await d.history.putRecords(name, list);
  }
  try {
    // Cloudflare's side can fail for a moment (a 500 from its token endpoint refreshing the credential, 2026-10-14): three
    // tries, five seconds apart, unless Cloudflare refused it (a 4xx).
    const versionId = restore.versionId;
    const again = (e: unknown) => !(e instanceof DeployError && e.status >= 400 && e.status < 500);
    let tries = 0;
    const roll = Effect.tryPromise({
      try: async () =>
        rollbackTo(await d.cf(), d.targetFor(name), versionId, `Erga: ${run.commit.slice(0, 12)} failed its health check; back to ${to}`),
      catch: (e) => e,
    }).pipe(
      Effect.tapError((e) =>
        Effect.sync(() => {
          if (++tries < 3 && again(e)) d.line(s, `the rollback didn't go through (${(e as Error).message}): trying again`, "rollback");
        })
      )
    );
    await runWith(d.deps.sleep, roll.pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 2, while: again })));
  } catch (e) {
    const message = e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`;
    console.log(`the rollback of ${name} failed: ${message}`);
    const undone = `${note} That failed too: ${message} Roll back by hand (Cloudflare's dashboard, or deployments create).`;
    if (rec) {
      rec.error = rec.error!.replace(note, undone);
      await d.history.putRecords(name, list);
    }
    s.status = { ...s.status, error: s.status.error!.replace(note, undone) };
    for (const x of s.status.steps) if (x.id == "rollback") x.status = "failed";
    await d.history.appendTo(name, run.deployId, `the rollback failed: ${message}`);
    await d.save(s);
  }
}
