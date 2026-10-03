#!/usr/bin/env bun
// Brings the directory's database up to date with migrations/ (the same
// files the local host applies to its SQLite file, directory-sqlite.ts).
//
//   bun migrate.ts --local    the local database vite dev uses (bun run db:local; dev:worker runs it)
//   bun migrate.ts            erga.dev's, making it first if there's none (site.sh runs this on
//                                    Workers Builds, before `cf deploy`)
//
// `cf d1 migrations apply` takes a database's id, not its name, and the
// config names production's database without one (cf deploy finds or makes
// it by name), so its id is looked up here by name, and the database made if
// it isn't there yet. Applying is idempotent: D1 records what's applied in
// d1_migrations. Migrations must keep working with the Worker that's still
// deployed while they run (add, don't rename or drop), since they land just
// before the new version does.

const NAME = "erga";
/** The local database's id, as in cloudflare.config.ts. */
const LOCAL_DB = "00000000-0000-4000-8000-00000000e29a";
const ROOT = new URL(".", import.meta.url).pathname;

/**
 * Runs cf and returns what it printed. Its answer is one JSON value; once
 * that has arrived, cf is given a few seconds to exit and then stopped,
 * because cf 1.0.0-beta.10's `d1 migrations apply --local` never exits by
 * itself after applying (it leaves its local runtime running), and a build
 * mustn't hang on that.
 */
async function cf(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bunx", "cf", ...args], { cwd: ROOT, env: { ...process.env, CF_QUIET: "1", NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  let out = "", answered = false, stopped = false;
  const deadline = setTimeout(() => { stopped = true; proc.kill(); }, 10 * 60_000);
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    out += decoder.decode(chunk, { stream: true });
    if (answered) continue;
    const start = out.search(/[[{]/);
    try { if (start >= 0) { JSON.parse(out.slice(start)); answered = true; } } catch { /* not all there yet */ }
    if (answered) setTimeout(() => { if (proc.exitCode == null) { stopped = true; proc.kill(); } }, 5000);
  }
  const code = await proc.exited;
  clearTimeout(deadline);
  if (stopped && !answered) throw new Error(`cf ${args.join(" ")} took too long:\n${out}`);
  if (code != 0 && !(stopped && answered)) throw new Error(`cf ${args.join(" ")} failed:\n${out}`);
  return out;
}

/** The first "uuid" of a database called NAME anywhere in cf's JSON answer. */
function uuidIn(json: string): string | null {
  let found: string | null = null;
  const walk = (v: unknown): void => {
    if (found || !v || typeof v != "object") return;
    const o = v as Record<string, unknown>;
    if (o.name == NAME && typeof o.uuid == "string") { found = o.uuid; return; }
    for (const child of Object.values(o)) walk(child);
  };
  try { walk(JSON.parse(json)); } catch { /* not JSON */ }
  return found;
}

if (process.argv.includes("--local")) {
  // Where vite dev keeps its local state (the cf CLI's own default is elsewhere).
  console.log(await cf(["d1", "migrations", "apply", LOCAL_DB, "--local", "--persist-to", ".cloudflare/state"]));
} else {
  let id = uuidIn(await cf(["d1", "list", "--name", NAME]));
  if (!id) {
    console.log(`No D1 database called "${NAME}" yet: making it.`);
    id = uuidIn(await cf(["d1", "create", "--name", NAME]));
    if (!id) throw new Error(`made the database "${NAME}", but couldn't read its id from cf's answer`);
  }
  console.log(`Applying migrations to D1 database "${NAME}" (${id}).`);
  console.log(await cf(["d1", "migrations", "apply", id]));
}
