// The deploy pipeline: the one way any Erga server is deployed, through the
// Cloudflare API, with no CLI and no container. Each step below is a few
// plain API calls, so a page can show them one at a time, and the tests run
// every one against a mock Cloudflare.
//
// Its input is a target (Target: an account, a Worker, a database, its
// addresses, settings and secrets, and maybe a snapshot to copy in) and a
// release (deploy/release.ts: the Worker exactly as `cf build` builds it from
// cloudflare.config.ts, its static assets and the migrations). Its output is
// a live server, each step reported as it goes. Three kinds of targets use it:
//
//   - /deploy: a copy of Erga on
//     someone's own Cloudflare account, them its admin (targetOfPlan);
//   - production and staging: erga.dev and
//     staging.erga.dev, deployed by the server itself when their branch moves,
//    or from a machine;
//   - staging runs on a copy of production's data, frozen: a deploy keeps
//     it, and copies afresh only when asked (a Redeploy with a fresh copy)
//     or when staging has no copy yet (Target.snapshot: the "data" and
//     "documents" steps).
//
// The steps (ALL_STEPS): check the account, find or make the D1 database
// (for a snapshot, a new copy beside the one the Worker is on, or that one
// kept: Target.snapshot), copy the source's database into it, apply
// server/migrations/ to it (recorded in d1_migrations, as `cf d1 migrations apply`
// does), upload the static assets (direct upload), upload the Worker with its
// bindings, secrets and Durable Objects, give it its address (workers.dev,
// or a custom domain), give documents' pages theirs, wait for it to answer,
// copy the source's documents into it, and delete the old copies of the
// database (a snapshot's: only once the new version answers). A new server makes its own front
// page from the landing project built into it, the first time someone opens
// it, owned by its first admin.

import { runControlPipeline } from "./control-worker";
import { copyDocuments } from "./copy-documents";
import { Cloudflare, DeployError, Unhealthy, type Fetch } from "./cloudflare-api";
import type { Release } from "./release-format";
import { DB_NAME, type DeployPlan } from "./plan";
import {
  PAGES_PROXY,
  WORKER_TAG,
  checkHealth,
  d1,
  ensureBuckets,
  exportD1,
  findDatabase,
  importD1,
  listScripts,
  ownCredentials,
  restorePoint,
  servedAssets,
  uploadAssets,
  workerMetadata,
  zoneIdOf,
} from "./account";
import { sleep } from "../../shared/time";
export * from "./cloudflare-api";
export * from "./release-format";
export * from "./plan";
export * from "./account";
export * from "./domains";

/** The deploy page's steps, in order, as the page lists them (a /deploy target's: no copying of data). */
export const STEPS = [
  { id: "account", title: "Check your Cloudflare account" },
  { id: "database", title: "Make the database (D1)" },
  { id: "migrations", title: "Set up the database's tables" },
  { id: "assets", title: "Upload the editor's files" },
  { id: "worker", title: "Upload the Worker, with its settings and secrets" },
  { id: "address", title: "Give it its address" },
  { id: "pages", title: "Give documents' pages their own address" },
  { id: "live", title: "Wait for it to answer" },
] as const;

/** Every step the pipeline knows, in order: a target that copies another's data (staging) has all of them. */
export const ALL_STEPS = [
  STEPS[0], STEPS[1],
  { id: "data", title: "Copy production's database into it" },
  STEPS[2], STEPS[3],
  STEPS[4],
  STEPS[5], STEPS[6], STEPS[7],
  { id: "documents", title: "Copy production's documents into it" },
  { id: "cleanup", title: "Delete the old copies of the database" },
] as const;
export type StepId = (typeof ALL_STEPS)[number]["id"];

/** The control Worker's own steps (control/deploys/control-worker.ts): the account (and what it runs now), its upload, its health. */
export const CONTROL_STEPS = [STEPS[0], STEPS[4], STEPS[7]] as const;

/** A target's steps: the deploy page's, and the copying steps (and the old copies' cleanup) for one with a snapshot; the control Worker's own. */
export const stepsFor = (t: Pick<Target, "snapshot" | "control">): readonly { id: StepId; title: string }[] => t.control ? CONTROL_STEPS : ALL_STEPS.filter((s) =>
  t.snapshot || (s.id != "data" && s.id != "documents" && s.id != "cleanup"));

export type Report = (step: StepId, status: "running" | "done" | "skipped", detail?: string) => void;

/** What the deploy made: where the server is, and where its pages run. */
export interface Deployed { url: string; pages: string; database: string; worker: string }

// ------------------------------------------------------------------ the pipeline

/**
 * Where a deploy goes: everything the pipeline needs to know about it, in
 * any account. /deploy makes one from the page's plan (targetOfPlan); the
 * branch deploys make production's and staging's from deploy/targets.ts
 *.
 */
export interface Target {
  /** What to call it in the log ("staging", or the account's name). */
  label: string;
  accountId: string;
  /** The Worker's name: also its workers.dev address, <name>.<subdomain>.workers.dev. */
  workerName: string;
  /** The D1 database bound as DB: found by name, made if missing. */
  databaseName: string;
  /** The account's workers.dev subdomain: needed for a workers.dev app or shared pages host, checked (and made, with createSubdomain) when set. */
  subdomain?: string;
  createSubdomain?: boolean;
  /** The app's address: <name>.<subdomain>.workers.dev, or a hostname on one of the account's zones (a custom domain; the zone's id is looked up by name if not given). */
  app: { kind: "workers.dev" } | { kind: "domain"; zoneId?: string; zoneName: string; hostname: string };
  /**
   * Documents' pages: one origin per document under `domain` (default the
   * zone itself), with a wildcard route and DNS record on the zone; or
   * "shared", one origin for every document's pages at
   * <name>-pages.<subdomain>.workers.dev (workers.dev has no wildcards).
   */
  pages: { kind: "shared" } | { kind: "zone"; zoneId?: string; zoneName: string; domain?: string };
  /** Text bindings over the build's (cloudflare.config.ts as `cf build` wrote it). */
  vars: Record<string, string>;
  /** Secrets set with this upload. */
  secrets: Record<string, string>;
  /** Keep the Worker's other secrets from its last version (set once, deploy/setup.ts), as `cf deploy` does. */
  keepSecrets?: boolean;
  /** Service bindings, by binding name: the Worker, and its entrypoint if not the default (CONTROL → erga-control's App). */
  services?: Record<string, string | { service: string; entrypoint?: string }>;
  /**
   * The Artifacts namespace Erga's own source is in (deploy/targets.json's
   * source): a release's Artifacts binding goes up only to a target that
   * names it (production and staging). Elsewhere (/deploy, someone else's
   * account) it's left out, and the server has no Git endpoint.
   */
  artifacts?: string;
  /** Wait for this release's version to answer (GET /api/deploys/version), not only for the server to answer. */
  checkVersion?: boolean;
  /**
   * Copy another server's data in (staging: production's). The copy goes
   * into a new database of its own, `<databaseName>-<when, base 36>`
   * (copyName), made from the source database's D1 export (read-only on the
   * source), while the target's Worker stays on the database it has: the
   * Worker's upload binds the new one, and the old one is deleted only once
   * the new version answers (the cleanup step). So the target is never on a
   * deleted database, and a deploy that stops before its upload leaves it as
   * it was; the copies such a deploy leaves are deleted by the next one. Each
   * document's Durable Object is copied from the source server's snapshot
   * endpoint, authorized with `token`. Nothing is ever
   * written to the source.
   *
   * A deploy copies only when the target has no copy yet, or with `fresh`
   * (asked for: a Redeploy with a fresh copy): copyReason. Otherwise the
   * target keeps its database and documents as they are (staging's copy is
   * frozen), and new migrations run on that database in place.
   */
  snapshot?: { databaseName: string; origin: string; token: string; fresh?: boolean };
  /** This is production (erga.dev): only then may the target use production's names. */
  production?: boolean;
  /** Production's names (deploy/targets.ts PRODUCTION): a target that isn't production and uses one stops before it starts. */
  guard?: { worker: string; database: string; host: string; pages: string; accountId?: string };
  /** The control Worker itself (control/deploys/control-worker.ts): its own steps, from the release's control part; no database, no pages. */
  control?: boolean;
  /** An install's control Worker (control/deploys/fleet.ts): its objects declared, its settings sent again with each upgrade (control/install/install.ts). */
  install?: { vars: Record<string, string> };
}

/**
 * What runs on from one step to the next (and across a restart, control/deploys/branches.ts keeps it): the database, the version,
 * and the documents staging had before.
 */
export interface Carry {
  dbId?: string; version?: string; oldDocs?: string[]; existing?: boolean; copied?: boolean;
  /** The copy the target was on before a new one (its own API keys come from it). */
  ownDb?: string | null;
  /** What the target ran before this deploy changed anything (the migrations step records it): a rollback goes back to it. */
  restore?: RestorePoint;
  /** The control Worker's D1 databases, by binding name (its account step finds them by name). */
  d1?: Record<string, string>;
}

/**
 * Where a target was before a deploy: the Worker version that served (a
 * deployment of it again is a rollback, in seconds, with no build), the release it
 * ran, and the database's D1 Time Travel bookmark from before the deploy's
 * migrations (a restore to it loses everything written since: for a person
 * to decide, never automatic). Null where there was none to record (a new
 * Worker, a token that may not read it).
 */
export interface RestorePoint { versionId: string | null; version: string | null; bookmark: string | null; at: number }

/** A copy of another server's data, by when it was made: `<base>-<ms since the epoch, base 36>` (Target.snapshot). */
export const copyName = (base: string, at: number) => `${base}-${at.toString(36)}`;
/** When a database by that name was made, if it's one of `base`'s copies (the base name itself: one from before, of no known age). */
export function copyMade(base: string, name: string): number | null | undefined {
  if (name == base) return null;
  const m = name.startsWith(`${base}-`) ? /^[0-9a-z]{8,10}$/.exec(name.slice(base.length + 1)) : null;
  if (!m) return undefined;
  const at = parseInt(m[0], 36);
  return at > 1.5e12 && at < 1e13 ? at : undefined;
}
/**
 * Why a deploy copies the source's data afresh, or null: the target keeps its
 * copy, however old, and a new migration runs on it in place.
 */
export function copyReason(o: { fresh?: boolean; live: unknown | null }): string | null {
  if (o.fresh) return "a fresh copy was asked for";
  if (!o.live) return "there's no copy yet";
  return null;
}

/** The databases that are `base`'s copies (its own name, and copyName's), with when each was made. */
export async function copiesOf(cf: Cloudflare, acc: string, base: string): Promise<{ uuid: string; name: string; made: number | null }[]> {
  const all = (await cf.call<{ uuid: string; name: string }[]>("GET", `${acc}/d1/database?per_page=1000`, "list your D1 databases")) ?? [];
  return all.flatMap((d) => { const made = copyMade(base, d.name); return made === undefined ? [] : [{ uuid: d.uuid, name: d.name, made }]; });
}

/** The database a Worker's DB binding names now, or null (no Worker, no binding). */
export async function boundDatabase(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
  const settings = await cf.call<{ bindings?: { name: string; type: string; id?: string; database_id?: string }[] }>("GET", `${acc}/workers/scripts/${worker}/settings`, `read ${worker}'s settings`, undefined, { allow404: true });
  const b = settings?.bindings?.find((x) => x.type == "d1" && x.name == "DB");
  return b?.database_id ?? b?.id ?? null;
}

/**
 * Deletes a target's copies of the source's data but `keep` (and, unless null, the one its Worker is bound to):
 * the ones a failed or cancelled deploy left, or the one a new version took the place of. What it deleted.
 */
export async function dropCopies(cf: Cloudflare, target: Target, keep: string | null): Promise<string[]> {
  const acc = `/accounts/${target.accountId}`;
  const bound = await boundDatabase(cf, acc, target.workerName);
  // Not knowing which one the Worker is on, and told to keep none: delete nothing.
  if (!bound && !keep) return [];
  const gone: string[] = [];
  for (const c of await copiesOf(cf, acc, target.databaseName)) {
    if (c.uuid == keep || c.uuid == bound) continue;
    // Never production's, whatever its name (copiesOf matches the target's names only; this is a second lock).
    if (target.guard && c.name == target.guard.database) continue;
    await cf.call("DELETE", `${acc}/d1/database/${c.uuid}`, `delete ${c.name}, an old copy`);
    gone.push(c.name);
  }
  return gone;
}

/**
 * The steps a target with a snapshot (staging) runs while its commit builds: they need no
 * release (the snapshot's database step decides by copyReason, not from the release). They change nothing the
 * target runs on: a new copy goes beside the database its Worker is on.
 */
export const BEFORE_BUILD: readonly StepId[] = ["account", "database", "data"];

export const targetHost = (t: Pick<Target, "app" | "workerName" | "subdomain">) => (t.app.kind == "domain" ? t.app.hostname : `${t.workerName}.${t.subdomain}.workers.dev`);
export const targetSharedPagesHost = (t: Pick<Target, "workerName" | "subdomain">) => `${t.workerName}-pages.${t.subdomain}.workers.dev`;
export const targetPagesShown = (t: Pick<Target, "pages" | "workerName" | "subdomain">) =>
  t.pages.kind == "zone" ? `*.${t.pages.domain ?? t.pages.zoneName}` : targetSharedPagesHost(t);

/** How a new server's people sign in: Erga's GitHub App (its client id), through erga.dev's callback (the relay: control/source/github.ts). */
export interface SignInVia { clientId: string; relay: string; googleClientId?: string }

/** The /deploy page's plan as a pipeline target: a new server in someone's own account, them its admin, its own secrets. */
export function targetOfPlan(plan: DeployPlan, sessionSecret: string, signIn?: SignInVia): Target {
  return {
    label: plan.accountId, accountId: plan.accountId, workerName: plan.workerName, databaseName: DB_NAME,
    subdomain: plan.subdomain, createSubdomain: plan.createSubdomain, app: plan.app, pages: plan.pages,
    vars: {
      ADMINS: plan.admin.toLowerCase(),
      // Sign-in: Erga's GitHub App, through erga.dev (no app of the install's own, nothing pasted).
      GITHUB_CLIENT_ID: signIn?.clientId ?? "",
      SIGN_IN_RELAY: signIn?.relay ?? "",
      // And Erga's Google OAuth client (its id), through the same relay; none: Google stays unset on the install.
      ...(signIn?.googleClientId ? { GOOGLE_CLIENT_ID: signIn.googleClientId } : {}),
      SERVER_CONFIG: "{}",
      // erga.dev's own deploy page needs erga.dev's OAuth client; the new server has none (the token link still works).
      CLOUDFLARE_OAUTH_CLIENT_ID: "",
      // Not one of Erga's own branch-deploy targets.
      DEPLOY_TARGET: "",
    },
    secrets: { SESSION_SECRET: sessionSecret, ...(plan.anthropicKey?.trim() ? { ANTHROPIC_API_KEY: plan.anthropicKey.trim() } : {}) },
  };
}

/** Why a target mustn't be deployed, or null: one that isn't production may not touch production's names (nor put its pages under production's), and a snapshot never goes into its own source. */
export function guardTarget(t: Target): string | null {
  const g = t.guard;
  const host = t.app.kind == "domain" ? t.app.hostname.toLowerCase() : null;
  const pages = t.pages.kind == "zone" ? (t.pages.domain ?? t.pages.zoneName).toLowerCase() : null;
  if (g && !t.production) {
    if (host == g.host || pages == g.pages) return `This deploy (${t.label}) would put a server on production's address (${host == g.host ? g.host : `*.${g.pages}`}). It stops here: production is deployed only as production.`;
    // Pages under production's (*.x.erga-pages.dev): a route on production's pages zone, which only production uses.
    if (pages?.endsWith(`.${g.pages}`)) return `This deploy (${t.label}) would put documents' pages under production's pages domain (*.${pages}, in ${g.pages}). It stops here: give it a pages domain of its own.`;
    const sameAccount = !g.accountId || g.accountId == t.accountId;
    if (sameAccount && t.workerName == g.worker) return `This deploy (${t.label}) would replace production's Worker (${g.worker}). It stops here.`;
    if (sameAccount && t.databaseName == g.database) return `This deploy (${t.label}) would use production's database (${g.database}). It stops here.`;
  }
  if (t.snapshot) {
    if (t.production) return "Production never takes a copy of another server's data.";
    if (t.snapshot.databaseName == t.databaseName) return `A snapshot can't go into the database it's copied from (${t.databaseName}).`;
    if (g && (t.databaseName == g.database || t.workerName == g.worker)) return `A snapshot is made afresh in the target's database, which is deleted first: never production's (${g.database}).`;
    // The target's copies (copyName) are made and deleted by their names: production's must never look like one.
    if (g && copyMade(t.databaseName, g.database) !== undefined) return `Production's database (${g.database}) has a name like a copy of ${t.databaseName}'s: copies are deleted by name, so this stops here.`;
    if (copyMade(t.databaseName, t.snapshot.databaseName) !== undefined) return `The snapshot's source (${t.snapshot.databaseName}) has a name like a copy of ${t.databaseName}'s: this stops here.`;
  }
  return null;
}

/**
 * The deploy pipeline: puts `release` on `target`, step by step, reporting
 * each as it starts and ends. The one pipeline for every deploy: /deploy's
 * (another person's account), production's and staging's (control/deploys/branches.ts,
 * from inside the server itself, or deploy/run.ts from a machine). Every step
 * is safe to run again.
 *
 * `from` starts at a later step (after a restart: a server that deploys
 * itself is restarted by its own new version, control/deploys/branches.ts), with the
 * `carry` the earlier steps left; `checkpoint` hears of each finished step,
 * to keep that. `release` is needed only up to the Worker's upload.
 */
export async function runPipeline(cf: Cloudflare, release: Release | null, target: Target, opts: {
  report: Report; site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number;
  from?: StepId; carry?: Carry; checkpoint?: (done: StepId, carry: Carry) => Promise<void> | void;
  /** Stops after this step (staging's steps before the build: BEFORE_BUILD); the next run starts after it, with the same carry. */
  until?: StepId;
  /** Stops the run between steps, throwing the signal's reason: a step that has begun always ends first. */
  signal?: AbortSignal;
}): Promise<Deployed> {
  if (target.control) return runControlPipeline(cf, release, target, opts);
  const { report, signal } = opts;
  const site = opts.site ?? globalThis.fetch;
  const wait = opts.sleep ?? sleep;
  const carry: Carry = opts.carry ?? {};
  const acc = `/accounts/${target.accountId}`;
  const host = targetHost(target);
  const pagesHost = target.pages.kind == "shared" ? targetSharedPagesHost(target) : null;
  const wrong = guardTarget(target);
  if (wrong) throw new DeployError({ message: wrong });
  const steps = stepsFor(target).map((s) => s.id);
  const start = opts.from ? steps.indexOf(opts.from) : 0;
  if (start < 0) throw new DeployError({ message: `This deploy has no step "${opts.from}".` });
  const needRelease = () => {
    if (!release)
      throw new DeployError({ message: "This step needs the build, which is gone (the server restarted part way): deploy again." });
    return release;
  };
  const end = opts.until ? steps.indexOf(opts.until) + 1 : steps.length;
  if (end < 1) throw new DeployError({ message: `This deploy has no step "${opts.until}".` });
  if (release) carry.version = release.version;

  /** The Worker's upload: its modules, and its metadata. */
  const uploadWorker = async (rel: Release, assetsJwt: string) => {
    // Whether the Worker was there: the account step's answer, kept in the carry (it may have run in an earlier call, before the build).
    await ensureBuckets(cf, acc, rel, target);
    const metadata = workerMetadata(rel, target, { dbId: carry.dbId!, assetsJwt, pagesHost, existing: !!carry.existing });
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    for (const [name, bytes] of Object.entries(rel.modules)) form.append(name, new File([new Uint8Array(bytes)], name, { type: "application/javascript+module" }));
    await cf.call("PUT", `${acc}/workers/scripts/${target.workerName}`, "upload the Worker", form);
  };

  const run: Record<StepId, () => Promise<string | undefined>> = {
    // The account, its workers.dev subdomain (made if it has none and the target names one), and whether the Worker is Erga's.
    async account() {
      // A narrow credential (the control Worker's OAuth grant, control/deploys/credential.ts) may not read the account itself: its id is enough.
      const account = await cf.call<{ id: string; name: string }>("GET", acc, "read your account").catch((e) => {
        if (target.keepSecrets && e instanceof DeployError && e.status == 403) return null;
        throw e;
      });
      if (target.subdomain) {
        let sub = (await cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true }).catch(() => null))?.subdomain ?? null;
        if (!sub) {
          if (!target.createSubdomain)
            throw new DeployError({ message: "Your account has no workers.dev subdomain yet. Go back, choose one, and deploy again." });
          sub =
            (
              await cf.call<{ subdomain: string }>(
                "PUT",
                `${acc}/workers/subdomain`,
                `make your workers.dev subdomain (${target.subdomain})`,
                { subdomain: target.subdomain }
              )
            )?.subdomain ?? target.subdomain;
        } else if (sub != target.subdomain)
          throw new DeployError({
            message: `Your workers.dev subdomain is ${sub}, not ${target.subdomain}: reload the page and deploy again.`,
          });
      }
      const scripts = await listScripts(cf, acc, target);
      const found = scripts.find((s) => s.id == target.workerName);
      // Ours: tagged by an earlier run (or, failing that, Erga's own Durable Object among its exports).
      const ours = (s: (typeof scripts)[number]) => !!s.tags?.includes(WORKER_TAG) || !!s.named_handlers?.some((h) => h.name == "DocumentObject");
      if (found && !ours(found)) {
        throw new DeployError({
          message: `Your account already has a Worker called ${target.workerName} that isn't Erga. So it isn't overwritten, the deploy stops here: delete or rename that Worker, then deploy again.`,
        });
      }
      carry.existing = !!found;
      return `${account?.name ?? target.accountId}${found ? `; ${target.workerName} is already there and will be replaced${target.keepSecrets ? "" : " (everyone signs in again)"}` : ""}`;
    },

    // The database: the one by this name if it's Erga's, else a new one. With a snapshot, the target's copy, or a new
    // copy beside it (Target.snapshot): the Worker stays on the one it has until its upload.
    async database() {
      if (target.snapshot) {
        const copies = await copiesOf(cf, acc, target.databaseName);
        const boundId = await boundDatabase(cf, acc, target.workerName);
        const live = copies.find((c) => c.uuid == boundId) ?? null;
        // Copies a failed or cancelled deploy left (any but the one the Worker is on): gone first.
        const left = live ? copies.filter((c) => c != live) : [];
        for (const c of left) await cf.call("DELETE", `${acc}/d1/database/${c.uuid}`, `delete ${c.name}, a copy an earlier deploy left`);
        const leftNote = left.length ? `; ${left.length} left by an earlier deploy deleted (${left.map((c) => c.name).join(", ")})` : "";
        const why = copyReason({ fresh: target.snapshot.fresh, live });
        if (!why && live) {
          carry.dbId = live.uuid;
          carry.copied = false;
          const age = live.made ? `, made ${new Date(live.made).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
          return `kept "${live.name}" (${live.uuid}${age}): its copy of the data is frozen; only a Redeploy with a fresh copy replaces it${leftNote}`;
        }
        if (live) {
          // Which documents it has, so their Durable Objects are emptied too (the documents step).
          const old = await d1(cf, acc, live.uuid, "SELECT id FROM documents", [], `read which documents ${live.name} has`).catch(() => []);
          carry.oldDocs = [...new Set([...(carry.oldDocs ?? []), ...(old ?? []).map((r) => String(r.id))])];
        }
        // A copy that isn't bound (the Worker isn't there, or is on another database): kept until the cleanup, in case it is in use.
        let at = Date.now();
        const names = new Set(copies.map((c) => c.name));
        while (names.has(copyName(target.databaseName, at))) at++;
        const name = copyName(target.databaseName, at);
        if (target.guard && name == target.guard.database)
          throw new DeployError({ message: `A copy can't be called ${name}: that's production's database.` });
        const made = await cf.call<{ uuid: string }>("POST", `${acc}/d1/database`, "make the database", { name });
        if (!made?.uuid)
          throw new DeployError({ message: "Cloudflare made the database but didn't say its id. Deploy again: the next one deletes it." });
        carry.dbId = made.uuid;
        carry.copied = true;
        carry.ownDb = live?.uuid ?? null;
        return `"${name}" (${carry.dbId}), a new copy beside ${live ? `"${live.name}", which ${target.workerName} stays on until its upload` : "nothing (there's no copy yet)"}: ${why}${leftNote}`;
      }
      const found = await findDatabase(cf, acc, target.databaseName)
        // A target that takes copies, deployed without one (deploy/run.ts --no-snapshot): the copy its Worker is on.
        ?? await (async () => { const b = await boundDatabase(cf, acc, target.workerName).catch(() => null); return b && (await copiesOf(cf, acc, target.databaseName)).some((c) => c.uuid == b) ? b : null; })();
      if (found) {
        // Erga's if it has Erga's first migration; usable if it's empty (made by a run that stopped before its tables).
        const tables = ((await d1(cf, acc, found, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", [], "look inside the database")) ?? []).map((r) => String(r.name));
        const applied = tables.includes("d1_migrations") ? await d1(cf, acc, found, "SELECT name FROM d1_migrations", [], "read the database's migrations") : [];
        const first = release ? Object.keys(release.migrations).sort()[0] : "0001_erga.sql";
        const ours = !!applied?.some((r) => r.name == first) || tables.every((t) => t == "d1_migrations");
        if (!ours)
          throw new DeployError({
            message: `Your account already has a D1 database called "${target.databaseName}" that isn't Erga's. So nothing of yours is lost, the deploy stops here: rename or delete that database, then deploy again.`,
          });
        carry.dbId = found;
        return `using Erga's database from before (${found})`;
      }
      const made = await cf.call<{ uuid: string }>("POST", `${acc}/d1/database`, "make the database", { name: target.databaseName });
      if (!made?.uuid)
        throw new DeployError({ message: "Cloudflare made the database but didn't say its id. Deploy again: the next run will find it." });
      carry.dbId = made.uuid;
      return `"${target.databaseName}" (${carry.dbId})`;
    },

    // Production's database, exported (D1's export: read-only on it) and loaded into the new one (D1's import).
    async data() {
      const snap = target.snapshot!;
      if (carry.copied === false) return "skipped: the target keeps its copy (the database step says why)";
      const source = await findDatabase(cf, acc, snap.databaseName);
      if (!source) throw new DeployError({ message: `There's no database called ${snap.databaseName} to copy.` });
      if (source == carry.dbId) throw new DeployError({ message: "The snapshot's source and target are the same database: stopped." });
      const sql = await exportD1(cf, acc, source, snap.databaseName, site, wait);
      await importD1(cf, acc, carry.dbId!, target.databaseName, sql, site, wait);
      return `${snap.databaseName} (${source}) → ${target.databaseName}: ${sql.length} bytes of SQL`;
    },

    // server/migrations/, each once, recorded in d1_migrations as the cf CLI does (on a new copy, the ones production hasn't had yet; on a kept one, the ones it hasn't).
    // First, the restore point: the last thing before the deploy changes what the target runs on.
    async migrations() {
      const rel = needRelease();
      const db = carry.dbId!;
      const restore = await restorePoint(cf, target, { dbId: db, existing: !!carry.existing });
      carry.restore = restore.point;
      const noted = restore.point.versionId || restore.point.bookmark ? `restore point: ${restore.point.versionId ? `version ${restore.point.versionId.slice(0, 8)}${restore.point.version ? ` (release ${restore.point.version})` : ""}` : "no version"}, ${restore.point.bookmark ? `database bookmark ${restore.point.bookmark}` : "no database bookmark"}` : `no restore point (${restore.why})`;
      await d1(cf, acc, db, "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)", [], "set up the database");
      const done = new Set(((await d1(cf, acc, db, "SELECT name FROM d1_migrations", [], "read the database's migrations")) ?? []).map((r) => String(r.name)));
      const pending = Object.keys(rel.migrations).sort().filter((n) => !done.has(n));
      for (const name of pending) {
        // The file and its record in d1_migrations, in one /query call (statements run as one batch, so all or nothing), as wrangler's `d1 migrations apply --remote` sends it.
        const sql = rel.migrations[name].trim();
        await d1(cf, acc, db, `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`, [], `apply the database migration ${name}`);
      }
      const did = `${pending.length ? `applied ${pending.join(", ")}` : "already up to date"}; ${noted}`;
      // A new copy has production's API keys, which don't open on the target (its FACTORY_KEY is its own): its own come back.
      return target.snapshot && carry.copied ? `${did}; ${await ownCredentials(cf, acc, carry.ownDb ?? null, db)}` : did;
    },

    // The static assets: the manifest, then each bucket Cloudflare asks for.
    async assets() {
      const rel = needRelease();
      const files = servedAssets(rel);
      (carry as Carry & { assetsJwt?: string }).assetsJwt = await uploadAssets(cf, acc, target.workerName, files);
      return `${Object.keys(files).length} files`;
    },

    // The Worker: modules, bindings (from the build's config, made the target's own), secrets, its Durable Objects.
    async worker() {
      const rel = needRelease();
      const assetsJwt = (carry as Carry & { assetsJwt?: string }).assetsJwt;
      if (!assetsJwt) throw new DeployError({ message: "The editor's files weren't uploaded first: deploy again." });
      await uploadWorker(rel, assetsJwt);
      delete (carry as Carry & { assetsJwt?: string }).assetsJwt;
      return `${target.workerName}, release ${rel.version}`;
    },

    // Its address.
    async address() {
      if (target.app.kind == "workers.dev") {
        await cf.call("POST", `${acc}/workers/scripts/${target.workerName}/subdomain`, "turn on its workers.dev address", { enabled: true, previews_enabled: false });
      } else {
        const app = target.app;
        const zoneId = app.zoneId ?? (await zoneIdOf(cf, target.accountId, app.zoneName));
        // There already (Erga's own targets: the setup made it), nothing to change. The address itself says so: it
        // answers as this target (a deploy token can't read the account's custom domains: Cloudflare has no per-zone
        // read for them).
        if (target.checkVersion && target.vars.DEPLOY_TARGET) {
          const r = await site(`https://${app.hostname}/api/deploys/version`).catch(() => null);
          const said = r?.ok ? ((await r.json().catch(() => null)) as { target?: string } | null)?.target : null;
          if (said == target.vars.DEPLOY_TARGET) return `https://${host} (already its address)`;
        }
        const there = await cf.call<{ hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${encodeURIComponent(app.hostname)}`, `read ${app.hostname}'s custom domain`).catch(() => null);
        const mine = there?.find((d) => d.hostname == app.hostname);
        if (mine && mine.service != target.workerName)
          throw new DeployError({
            message: `${app.hostname} is already the address of another Worker (${mine.service}). Remove it there, or pick another address.`,
          });
        if (mine) return `https://${host} (already its address)`;
        await cf.call("PUT", `${acc}/workers/domains`, `put it on ${target.app.hostname} (a custom domain)`, { hostname: target.app.hostname, service: target.workerName, zone_id: zoneId });
      }
      return `https://${host}`;
    },

    // Documents' pages: a wildcard on their own zone, or the shared workers.dev host (a small Worker handing every request to the app).
    async pages() {
      if (target.pages.kind == "zone") {
        const zoneId = target.pages.zoneId ?? (await zoneIdOf(cf, target.accountId, target.pages.zoneName));
        const zone = `/zones/${zoneId}`, name = target.pages.domain ?? target.pages.zoneName, pattern = `*.${name}/*`;
        const records = (await cf.call<{ id: string }[]>("GET", `${zone}/dns_records?type=AAAA&name=${encodeURIComponent(`*.${name}`)}`, `read ${target.pages.zoneName}'s DNS records`)) ?? [];
        if (!records.length) await cf.call("POST", `${zone}/dns_records`, `add the wildcard DNS record *.${name}`, { type: "AAAA", name: `*.${name}`, content: "100::", proxied: true, comment: "Erga: documents' pages" });
        const routes = (await cf.call<{ pattern: string; script?: string }[]>("GET", `${zone}/workers/routes`, `read ${target.pages.zoneName}'s Worker routes`)) ?? [];
        const route = routes.find((r) => r.pattern == pattern);
        if (route && route.script != target.workerName)
          throw new DeployError({
            message: `${pattern} already sends requests to another Worker (${route.script ?? "none"}). Remove that route, or pick another domain for pages.`,
          });
        if (!route)
          await cf.call("POST", `${zone}/workers/routes`, `route ${pattern} to the Worker`, { pattern, script: target.workerName });
        return `https://<document>.${name}`;
      }
      const rel = needRelease();
      const proxy = new FormData();
      const name = `${target.workerName}-pages`;
      proxy.set("metadata", JSON.stringify({
        main_module: "pages.js", compatibility_date: rel.worker.compatibilityDate, tags: [WORKER_TAG],
        bindings: [{ type: "service", name: "APP", service: target.workerName }],
      }));
      proxy.append("pages.js", new File([PAGES_PROXY], "pages.js", { type: "application/javascript+module" }));
      await cf.call("PUT", `${acc}/workers/scripts/${name}`, "upload the pages Worker", proxy);
      await cf.call("POST", `${acc}/workers/scripts/${name}/subdomain`, "turn on the pages address", { enabled: true, previews_enabled: false });
      return `https://${pagesHost} (shared by every document)`;
    },

    // Up: a new workers.dev address or certificate can take a minute or two. With checkVersion, until this release is the
    // one answering, and then its health check says it works (GET /api/health: the database, a document).
    async live() {
      const until = Date.now() + (opts.waitMs ?? 180_000);
      const want = carry.version;
      let seen = "";
      for (let tries = 0; ; tries++) {
        if (target.checkVersion && want) {
          const r = await site(`https://${host}/api/deploys/version`).catch(() => null);
          const v = r?.ok ? ((await r.json().catch(() => null)) as { version?: string } | null)?.version ?? "" : "";
          if (v == want) {
            // Healthy, or unhealthy three times over ten seconds (one slow cold start isn't a broken release).
            let h = await checkHealth(site, host, want);
            for (let again = 0; !h.ok && again < 2; again++) {
              await wait(5000);
              h = await checkHealth(site, host, want);
            }
            if (!h.ok) throw new Unhealthy(`Release ${want} is up at https://${host}, but its health check fails: ${h.why}`, h.why);
            return `https://${host}, release ${want}, healthy (${h.summary})`;
          }
          if (v) seen = v;
        } else {
          const r = await site(`https://${host}/logo.png`).catch(() => null);
          if (r?.ok) break;
        }
        if (Date.now() > until)
          throw new DeployError({
            message: `The Worker is deployed, but https://${host} hasn't answered${seen ? ` with release ${want} yet (it still says ${seen})` : " yet"} (a new address can take a few minutes). Open it in a little while; if it still doesn't answer, deploy again.`,
          });
        await wait(Math.min(5000, 1000 + tries * 500));
      }
      return `https://${host}${target.checkVersion && want ? `, release ${want}` : ""}`;
    },

    // Each document's Durable Object: production's storage, read through its snapshot endpoint, written into the new server's.
    async documents() {
      const snap = target.snapshot!;
      if (carry.copied === false) return "skipped: the target keeps its documents, as it keeps its copy of the database";
      const ids = ((await d1(cf, acc, carry.dbId!, "SELECT id FROM documents", [], "list the documents in the copy")) ?? []).map((r) => String(r.id));
      const result = await copyDocuments({ ids, wipe: (carry.oldDocs ?? []).filter((id) => !ids.includes(id)), from: snap.origin, to: `https://${host}`, token: snap.token, fetch: site });
      if (result.unsupported) return `skipped: ${snap.origin} doesn't serve snapshots yet (it needs this version, and SNAPSHOT_TOKEN set); the documents are listed but empty`;
      carry.oldDocs = [];
      const failed = result.failed.length ? `; ${result.failed.length} couldn't be read, and are empty here: ${result.failed.slice(0, 5).map((f) => `${f.id} (${f.error})`).join(", ")}${result.failed.length > 5 ? ", ..." : ""}` : "";
      return `${result.copied} documents copied${result.missing ? `, ${result.missing} gone from production since the database's copy` : ""}${result.wiped ? `, ${result.wiped} old ones emptied` : ""}${failed}`;
    },

    // The copies the new version doesn't use: the one it took the place of, and any a stopped deploy left. Only now,
    // with the new version up and answering (the live step): until then the old one is what the target runs on.
    async cleanup() {
      const gone = await dropCopies(cf, target, carry.dbId ?? null);
      return gone.length ? `deleted ${gone.join(", ")}` : "none to delete";
    },
  };

  for (const id of steps.slice(start, end)) {
    signal?.throwIfAborted();
    report(id, "running");
    const detail = await run[id]();
    const skipped = (id == "documents" || id == "data") && !!detail?.startsWith("skipped");
    report(id, skipped ? "skipped" : "done", detail);
    await opts.checkpoint?.(id, carry);
  }
  return { url: `https://${host}`, pages: targetPagesShown(target), database: carry.dbId ?? "", worker: target.workerName };
}

/**
 * The deploy page's deploy: `release` by `plan` with `cf` (a target in the
 * person's own account, through the same pipeline). `sessionSecret`: the new
 * server's SESSION_SECRET (made by the caller, new for each deploy). Throws a
 * DeployError saying what went wrong.
 */
export async function deploy(cf: Cloudflare, release: Release, plan: DeployPlan, opts: { sessionSecret: string; report: Report; site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number }): Promise<Deployed> {
  const { sessionSecret, ...rest } = opts;
  return runPipeline(cf, release, targetOfPlan(plan, sessionSecret), rest);
}
