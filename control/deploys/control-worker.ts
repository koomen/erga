// The control Worker's own deploy (deploy/targets.ts CONTROL: erga-control,
// at ops.erga.dev, control/). It follows main, after production: the release
// the build container makes carries its bundle (deploy/release.ts, from
// control/wrangler.jsonc), and the pipeline uploads that with the same
// restore point, health check and rollback as the app's targets, through the
// same API: no wrangler, no Docker. Three steps (CONTROL_STEPS): the account
// (is the Worker there, what it runs now: the restore point), the upload,
// and its health (GET /api/health on its own host answers the new release).
//
// The upload keeps what only wrangler makes: the Worker's secrets
// (keep_bindings), each Durable Object class's namespace (matched by class
// name, as wrangler does without a migration), and the container application
// of a class that has one (metadata.containers names the class; the image
// stays). So a new class, or a new image, still needs `bun deploy/setup.ts
// --control`; the account step says so when a class has no namespace yet.
//
// The Worker deploys itself: after its upload, the pipeline's object may
// restart into the new version part way (control/deploys/branches.ts carries on at
// the step after the upload), and a rollback of it restarts the object into
// the older one (the deploy's record is written before the call).

import { checkHealth, CONTROL_STEPS, DeployError, findDatabase, liveVersion, targetHost, Unhealthy, workerVersion, WORKER_TAG, type Carry, type Cloudflare, type Fetch, type Release, type Report, type RestorePoint, type StepId, type Target } from "./pipeline";
import { CONTROL } from "../../deploy/targets";

/** The control Worker as a target of the pipeline: its own steps, secrets kept, in the account. */
export function controlTarget(env: { CLOUDFLARE_ACCOUNT_ID?: string }): Target {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  return {
    label: "control", accountId, workerName: CONTROL.worker, databaseName: "",
    app: { kind: "domain", zoneName: CONTROL.zone, hostname: CONTROL.host },
    pages: { kind: "zone", zoneName: CONTROL.zone },
    vars: {}, secrets: {}, keepSecrets: true, checkVersion: true, control: true,
  };
}

/**
 * The control Worker's upload metadata, from the release's control part:
 * its bindings as control/wrangler.jsonc declares them, the release's
 * version (ERGA_VERSION: what /api/health answers, and what a restore point
 * records), the account, its secrets kept, its containers' classes.
 */
export function controlMetadata(release: Release, target: Pick<Target, "accountId" | "secrets">, d1: Record<string, string>) {
  const c = release.control;
  if (!c) throw new DeployError(`This release (${release.version}) has no control Worker in it: it is from before the control Worker deployed itself. Deploy a newer commit, or run bun deploy/setup.ts --control.`);
  const cfg = c.config;
  const bindings: Record<string, unknown>[] = [];
  for (const d of cfg.durableObjects) bindings.push({ type: "durable_object_namespace", name: d.name, class_name: d.className });
  for (const d of cfg.d1) {
    const id = d1[d.name];
    if (!id) throw new DeployError(`The account has no D1 database called ${d.databaseName} (the control Worker's ${d.name}): deploy again.`);
    bindings.push({ type: "d1", name: d.name, database_id: id, id });
  }
  for (const a of cfg.artifacts) bindings.push({ type: "artifacts", name: a.name, namespace: a.namespace });
  for (const b of cfg.r2 ?? []) bindings.push({ type: "r2_bucket", name: b.name, bucket_name: b.bucketName });
  if (cfg.versionMetadata) bindings.push({ type: "version_metadata", name: cfg.versionMetadata });
  const text: Record<string, string> = { ...cfg.vars, ERGA_VERSION: release.version, CLOUDFLARE_ACCOUNT_ID: target.accountId };
  for (const [name, value] of Object.entries(text)) bindings.push({ type: "plain_text", name, text: value });
  for (const [name, value] of Object.entries(target.secrets)) bindings.push({ type: "secret_text", name, text: value });
  return {
    main_module: c.mainModule,
    compatibility_date: cfg.compatibilityDate,
    compatibility_flags: cfg.compatibilityFlags,
    bindings,
    // Its secrets stay from version to version (set once: deploy/setup.ts).
    keep_bindings: ["secret_text", "secret_key"],
    // The classes with a container, as wrangler sends them (the application's name and the class): each keeps the application (and image) the Worker has for it.
    containers: cfg.containers.map((c) => ({ name: c.name, class_name: c.className })),
    observability: { enabled: cfg.observability.enabled, logs: { enabled: cfg.observability.logs.enabled, invocation_logs: cfg.observability.logs.invocationLogs } },
  };
}

/** The control Worker's pipeline: runPipeline hands a control target here (same report, carry and checkpoint). */
export async function runControlPipeline(cf: Cloudflare, release: Release | null, target: Target, opts: {
  report: Report; site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number;
  from?: StepId; carry?: Carry; checkpoint?: (done: StepId, carry: Carry) => Promise<void> | void; until?: StepId; signal?: AbortSignal;
}): Promise<{ url: string; pages: string; database: string; worker: string }> {
  const { report, signal } = opts;
  const site = opts.site ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const carry: Carry = opts.carry ?? {};
  const acc = `/accounts/${target.accountId}`;
  const host = targetHost(target);
  const steps: StepId[] = CONTROL_STEPS.map((s) => s.id);
  const start = opts.from ? steps.indexOf(opts.from) : 0;
  if (start < 0) throw new DeployError(`The control Worker's deploy has no step "${opts.from}".`);
  const end = opts.until ? steps.indexOf(opts.until) + 1 : steps.length;
  if (end < 1) throw new DeployError(`The control Worker's deploy has no step "${opts.until}".`);
  const needRelease = () => {
    if (!release) throw new DeployError("This step needs the build, which is gone (the server restarted part way): deploy again.");
    if (!release.control) throw new DeployError(`This release (${release.version}) has no control Worker in it: it is from before the control Worker deployed itself. Deploy a newer commit, or run bun deploy/setup.ts --control.`);
    return release;
  };
  if (release) carry.version = release.version;

  const run: Record<StepId, () => Promise<string | undefined>> = {
    // The Worker must be there (wrangler made it, with its container and namespaces), and what it runs now is the restore point.
    async account() {
      const rel = needRelease();
      const settings = await cf.call<{ tags?: string[]; bindings?: { type: string; class_name?: string; script_name?: string }[] }>("GET", `${acc}/workers/scripts/${target.workerName}/settings`, `read ${target.workerName}'s settings`, undefined, { allow404: true });
      if (!settings) throw new DeployError(target.install ? `The control Worker (${target.workerName}) isn't in the account: install again from upstream.` : `The control Worker (${target.workerName}) isn't in the account yet: bun deploy/setup.ts --control deploys it the first time (its container image needs Docker). Then it deploys itself.`);
      if (target.install) {
        // An install's: made by the install (control/install/install.ts), its objects declared with each upload.
        if (!settings.tags?.includes(WORKER_TAG)) throw new DeployError(`${target.workerName} isn't the control Worker the install made (it has no erga-deploy tag): stopped.`);
      } else {
        const classes = new Set((settings.bindings ?? []).filter((b) => b.type == "durable_object_namespace" && !b.script_name).map((b) => b.class_name));
        const missing = rel.control!.config.durableObjects.map((d) => d.className).filter((c) => !classes.has(c));
        if (missing.length) throw new DeployError(`The control Worker has no Durable Object namespace for ${missing.join(", ")} yet: a new class needs bun deploy/setup.ts --control (wrangler makes the namespace); after that it deploys itself again.`);
      }
      carry.existing = true;
      // Its databases, by name (production's: who is an admin, the admin-scope tokens).
      const d1: Record<string, string> = {};
      for (const d of rel.control!.config.d1) {
        // Erga's own: production's database, by its name; an install's: the app's, by the install's name for it.
        const name = target.install ? target.databaseName : d.databaseName;
        const id = await findDatabase(cf, acc, name);
        if (!id) throw new DeployError(`The account has no D1 database called ${name} (the control Worker's ${d.name} binding): ${target.install ? "the app's database is gone" : "it is production's, which deploy/setup.ts makes"}.`);
        d1[d.name] = id;
      }
      carry.d1 = d1;
      const point: RestorePoint = { versionId: null, version: null, bookmark: null, at: Date.now() };
      const why: string[] = [];
      try { point.versionId = await liveVersion(cf, target.accountId, target.workerName); if (!point.versionId) why.push("the Worker has no deployment yet"); } catch (e) { why.push(`the Worker's deployments couldn't be read: ${(e as Error).message}`); }
      try { point.version = await workerVersion(cf, target.accountId, target.workerName); } catch { /* the version id is what a rollback needs */ }
      carry.restore = point;
      console.log(`restore point of ${target.workerName}: version ${point.versionId ?? "none"}, release ${point.version ?? "unknown"}${why.length ? ` (${why.join("; ")})` : ""}`);
      return `${target.workerName} is there, running ${point.version ? `release ${point.version}` : "a release before this pipeline (deployed with wrangler)"}; ${point.versionId ? `restore point: version ${point.versionId.slice(0, 8)}` : `no restore point (${why.join("; ")})`}`;
    },

    // The Worker: its modules and metadata, secrets kept, containers and namespaces matched by class.
    async worker() {
      const rel = needRelease();
      const form = new FormData();
      if (!carry.d1) throw new DeployError("The account step didn't run first (its databases aren't known): deploy again.");
      form.set("metadata", JSON.stringify(target.install ? installControlMetadata(rel, { accountId: target.accountId, dbId: carry.d1.DB, vars: target.install.vars, secrets: target.secrets }) : controlMetadata(rel, target, carry.d1)));
      for (const [name, bytes] of Object.entries(rel.control!.modules)) form.append(name, new File([new Uint8Array(bytes)], name, { type: "application/javascript+module" }));
      await cf.call("PUT", `${acc}/workers/scripts/${target.workerName}`, "upload the control Worker", form);
      return `${target.workerName}, release ${rel.version}`;
    },

    // Up: its own health check answers this release, and says it works; unhealthy three times over ten seconds rolls back.
    // The check is shallow (?self=1): this very object runs the deploy, and a request from here back into it can loop
    // ("Subrequest depth limit exceeded", 2026-10-14); that the deploy goes on at all says the object answers. A new
    // version of this Worker has taken more than three minutes to answer (2026-10-14): ten minutes, before giving up.
    async live() {
      const until = Date.now() + (opts.waitMs ?? 600_000);
      const want = carry.version;
      if (!want) throw new DeployError("This deploy doesn't know which release it uploaded: deploy again.");
      let seen = "";
      for (let tries = 0; ; tries++) {
        const r = await site(`https://${host}/api/health?self=1`).catch(() => null);
        const body = r ? ((await r.json().catch(() => null)) as { version?: string } | null) : null;
        if (body?.version == want) {
          let h = await checkHealth(site, host, want, { query: "self=1" });
          for (let again = 0; !h.ok && again < 2; again++) { await sleep(5000); h = await checkHealth(site, host, want, { query: "self=1" }); }
          if (!h.ok) throw new Unhealthy(`Release ${want} is up at https://${host}, but its health check fails: ${h.why}`, h.why);
          return `https://${host}, release ${want}, healthy (${h.summary})`;
        }
        if (body?.version) seen = body.version;
        if (Date.now() > until) throw new DeployError(`The control Worker is uploaded, but https://${host} hasn't answered with release ${want} yet${seen ? ` (it still says ${seen})` : ""}. Check it in a little while; if it still doesn't answer, deploy again.`);
        await sleep(Math.min(5000, 1000 + tries * 500));
      }
    },
  } as Record<StepId, () => Promise<string | undefined>>;

  for (const id of steps.slice(start, end)) {
    signal?.throwIfAborted();
    report(id, "running");
    const detail = await run[id]();
    report(id, "done", detail);
    await opts.checkpoint?.(id, carry);
  }
  return { url: `https://${host}`, pages: "", database: "", worker: target.workerName };
}

/**
 * The control Worker's upload metadata for an install (control/install/install.ts, and its upgrades,
 * control/deploys/fleet.ts): the release's control part (control/wrangler.jsonc as the
 * release has it), with only what an install has. Its Durable Objects are declared as exports (a new Worker has
 * no namespaces; wrangler made erga.dev's), so a second install run matches
 * them. No container, no Artifacts, no bucket.
 */
export function installControlMetadata(release: Release, o: { accountId: string; dbId: string; vars: Record<string, string>; secrets: Record<string, string> }) {
  const c = release.control;
  if (!c) throw new DeployError(`This release (${release.version}) has no control Worker in it: pick a newer one.`);
  const cfg = c.config;
  const bindings: Record<string, unknown>[] = [];
  const classes = cfg.durableObjects.filter((d) => d.name != "BUILDS");
  for (const d of classes) bindings.push({ type: "durable_object_namespace", name: d.name, class_name: d.className });
  for (const d of cfg.d1) bindings.push({ type: "d1", name: d.name, database_id: o.dbId, id: o.dbId });
  if (cfg.versionMetadata) bindings.push({ type: "version_metadata", name: cfg.versionMetadata });
  for (const [name, value] of Object.entries({ ERGA_VERSION: release.version, ...o.vars })) bindings.push({ type: "plain_text", name, text: value });
  for (const [name, value] of Object.entries(o.secrets)) bindings.push({ type: "secret_text", name, text: value });
  return {
    main_module: c.mainModule,
    compatibility_date: cfg.compatibilityDate,
    compatibility_flags: cfg.compatibilityFlags,
    bindings,
    keep_bindings: ["secret_text", "secret_key"],
    exports: Object.fromEntries(classes.map((d) => [d.className, { type: "durable-object", storage: "sqlite" }])),
    observability: { enabled: cfg.observability.enabled, logs: { enabled: cfg.observability.logs.enabled, invocation_logs: cfg.observability.logs.invocationLogs } },
    tags: [WORKER_TAG],
  };
}


