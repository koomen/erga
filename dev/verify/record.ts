// The instance's own record of its deploys (deploy/deployer/instance.ts: its spec, its lock and its job log, in its
// database), on a run's real instance, through the platform's own API: D1's on Cloudflare, Systems Manager on AWS.
// The suite's own deploy writes no record (it runs the pipeline's steps alone), so these rows write one: the run's
// spec, and one job with a log that needs several writes and several reads.

import * as Effect from "effect/Effect";
import { CHUNK, openJob, readJobs, readLog, readSpec, type Sql, writeSpec } from "../../deploy/deployer/instance.ts";
import type { Spec } from "../../deploy/deployer/spec.ts";
import type { Report } from "./run.ts";

const run = Effect.runPromise;
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

/** `spec`: the run's instance as a spec (deploy/cli/instance.ts, specOf). `through`: the platform's API, in words. */
export async function recordChecks(report: Report, sql: Sql, spec: Spec, through: string): Promise<void> {
  let at = Date.now();
  const read = await run(Effect.flatMap(writeSpec(sql, spec), () => readSpec(sql))).catch((e: Error) => e);
  report.add(
    `The instance holds its spec: written and read back the same, through ${through}`,
    !(read instanceof Error) && JSON.stringify(read) == JSON.stringify(spec),
    read instanceof Error
      ? read.message
      : `${spec.target.kind}, ${Object.keys(spec.settings).length} settings, ${spec.secrets.length} secrets' names; ${seconds(at)}`
  );

  at = Date.now();
  // Text that would end a statement or a script, were it not a value; and enough of it for more than one write.
  const lines = Array.from(
    { length: 2 + Math.ceil(CHUNK / 80) },
    (_, i) => `line ${i}: é 😀 'quote' "double" $(id) \`x\` \\ ; -- ${"x".repeat(60)}`
  );
  const text = `${lines.join("\n")}\n`;
  const said = await (async () => {
    const job = await run(openJob(sql, { kind: "deploy", command: "bun erga verify: the record's check", source: "verify" }));
    if (job.id() == null) return "the database has no table for the jobs";
    const second = await run(Effect.flip(openJob(sql, { kind: "rollback", command: "a second job", source: "verify" }))).catch(() => null);
    job.commit("0".repeat(40));
    for (const line of lines) job.line(line);
    const lacks = await job.end({ at: "done" });
    if (lacks) return `the job's row lacks something: ${lacks}`;
    if (!second?.message.includes("Another job runs on the instance: bun erga verify: the record's check"))
      return `a second job did not stop at the lock: ${second?.message ?? "it started"}`;
    const row = (await run(readJobs(sql))).find((j) => j.id == job.id());
    if (row?.state.at != "done" || row.sha != "0".repeat(40)) return `the job's row: ${JSON.stringify(row)}`;
    const parts: Uint8Array[] = [];
    const have = () => parts.reduce((n, p) => n + p.length, 0);
    for (let part = await run(readLog(sql, row.id, 0)); part.length; part = await run(readLog(sql, row.id, have()))) parts.push(part);
    const log = new TextDecoder().decode(Buffer.concat(parts));
    return log == text && row.size == have()
      ? null
      : `the log read back is not the log written: ${log.length} of ${text.length} characters`;
  })().catch((e: Error) => e.message);
  report.add(
    `A job on the instance: its row is the lock (a second job stops), and its log reads back whole, through ${through}`,
    said == null,
    said ?? `${lines.length} lines, ${Buffer.byteLength(text)} bytes, in parts of ${CHUNK}; ${seconds(at)}`
  );
}
