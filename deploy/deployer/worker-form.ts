// The Worker's upload, as plain functions: its metadata (the release's bindings, made the target's own), where a target
// is deployed, and the static files' hashes and types. `bun erga deploy` on a machine (cloudflare.ts) and the deployer
// in the cloud (worker.ts) both use these, so both upload the same Worker.
//
// Trap: nothing here imports Effect, or a file that does: the deployer's Worker is small, and a test holds its size
// (tests/deployer.test.ts). Add only what both sides need.

import { bindingsProblem, passedBinding } from "./bindings";
import type { Release } from "./release-format";
import type { CloudflareTarget, Spec } from "./spec";

/** Bytes as base64, with padding. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Bytes as hex, in lower case. */
export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** What the steps read of an instance's spec (spec.ts): where it is, and the Worker's plain settings. */
export type CloudflareSpec = Pick<Spec, "settings"> & { target: CloudflareTarget };

/** The host that every document's pages share on workers.dev. */
export const sharedPagesHost = (t: Pick<CloudflareTarget, "worker" | "subdomain">) => `${t.worker}-pages.${t.subdomain}.workers.dev`;

/** The tag the deploy puts on the Workers it makes, so a second run knows them as its own. */
export const WORKER_TAG = "erga-deploy";

/** The name of an instance's deployer: a Worker beside the instance's own. And the tag of the Workers that setup made as one. */
export const deployerName = (worker: string) => `${worker}-deployer`;
export const DEPLOYER_TAG = "erga-deployer";

/** The deployer's code in a release (deploy/release.ts): one module, which a deploy gives the instance's deployer. */
export const DEPLOYER_MODULE = "deployer/worker.js";

/**
 * The deployer's own upload: its one module, and what the Worker gets (deploy/deployer/worker.ts says what each is
 * for). Setup makes it (deploy/pipeline/deployer.ts), and so does each deploy after: a machine's, and the deployer's
 * own, of itself. `key`: a new deployer's secret, which seals its token. None: the deployer that is there keeps its
 * secret, and so the token in its store.
 */
export function deployerForm(code: Uint8Array | string, account: string, worker: string, database: string, key?: string): FormData {
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2026-09-01",
      bindings: [
        { type: "d1", name: "DB", database_id: database, id: database },
        { type: "plain_text", name: "DATABASE", text: database },
        { type: "plain_text", name: "ACCOUNT", text: account },
        { type: "plain_text", name: "WORKER", text: worker },
        ...(key ? [{ type: "secret_text", name: "KEY", text: key }] : []),
        { type: "durable_object_namespace", name: "STATE", class_name: "DeployerState" },
        { type: "service", name: "INSTANCE", service: worker },
      ],
      ...(key ? {} : { keep_bindings: ["secret_text"] }),
      // The deployer's own store, as a declarative export (as the instance's Durable Objects: cloudflare.ts).
      exports: { DeployerState: { type: "durable-object", storage: "sqlite" } },
      // Each run says one line: Cloudflare keeps the lines, for a person who looks at the deployer.
      observability: { enabled: true, logs: { enabled: true, invocation_logs: true } },
      tags: [DEPLOYER_TAG],
    })
  );
  form.append("worker.js", new File([code as BlobPart], "worker.js", { type: "application/javascript+module" }));
  return form;
}

/** The build's file of headers for its static assets (Cloudflare's _headers): it goes in the Worker's config, not among the files. */
export const HEADERS_FILE = "/_headers";

/** The static assets as uploaded: all of the release's but its _headers. */
export const servedAssets = (release: Release) => Object.fromEntries(Object.entries(release.assets).filter(([p]) => p != HEADERS_FILE));

/**
 * The Worker's upload metadata: the build's bindings (cloudflare.config.ts
 * as `cf build` wrote it), each made the target's own: its database, its
 * text settings and where its pages run. `secrets`: setup's first deploy only (the Worker keeps its secrets after).
 * `upload`: a name of this upload's own, new at each one (ERGA_UPLOAD). `deployer`: the account has the instance's
 * deployer: the Worker binds it (DEPLOYER), to hand it the token that a person pastes (token.ts).
 */
export function workerMetadata(
  release: Release,
  spec: CloudflareSpec,
  o: { dbId: string; assetsJwt: string; upload: string; secrets?: Record<string, string>; deployer?: boolean }
) {
  const w = release.worker;
  const target = spec.target;
  // Which release this is, and where it is deployed: the CLI reads both from the version's bindings (liveRelease).
  const text: Record<string, string> = {
    ERGA_VERSION: release.version,
    // This upload's own name: the server's health route says it, so the deployer knows which version answers.
    ERGA_UPLOAD: o.upload,
    ERGA_DEPLOY: JSON.stringify(deployFacts(target, spec.settings)),
    ...spec.settings,
  };
  const secrets = o.secrets ?? {};
  const bindings: Record<string, unknown>[] = [];
  const named = new Set<string>();
  for (const [name, b] of Object.entries(w.env)) {
    named.add(name);
    if (b.type == "durable-object") bindings.push({ type: "durable_object_namespace", name, class_name: b.exportName });
    else if (b.type == "d1") bindings.push({ type: "d1", name, database_id: o.dbId, id: o.dbId });
    else if (b.type == "assets") bindings.push({ type: "assets", name });
    else if (b.type == "text") bindings.push({ type: "plain_text", name, text: text[name] ?? b.value ?? "" });
    else if (b.type == "secret") {
      if (secrets[name] != null) bindings.push({ type: "secret_text", name, text: secrets[name] });
    }
    // A bucket of the target's own (documents' files: FILES), made before the upload if it isn't there (ensureBuckets).
    else if (b.type == "r2") bindings.push({ type: "r2_bucket", name, bucket_name: bucketName(target.worker, name) });
    // Any other kind is the same on every target: the release's own metadata for it, sent as it is (bindings.ts).
    else {
      const passed = passedBinding(release, name);
      if (!passed) throw new Error(bindingsProblem(release)!);
      bindings.push(passed);
    }
  }
  // Settings and secrets the build doesn't declare (the version, the deploy facts).
  for (const [name, value] of Object.entries(text))
    if (!named.has(name)) {
      bindings.push({ type: "plain_text", name, text: value });
      named.add(name);
    }
  for (const [name, value] of Object.entries(secrets))
    if (!named.has(name)) {
      bindings.push({ type: "secret_text", name, text: value });
      named.add(name);
    }
  if (o.deployer) bindings.push({ type: "service", name: "DEPLOYER", service: deployerName(target.worker) });
  // Where documents' pages run: a domain of their own, or the shared host.
  if (target.pages.kind == "zone")
    bindings.push({ type: "plain_text", name: "PAGES_DOMAIN", text: target.pages.domain ?? target.pages.zoneName });
  else bindings.push({ type: "plain_text", name: "PAGES_HOST", text: sharedPagesHost(target) });
  // Durable Objects as declarative exports, as `cf deploy` sends them: the platform makes each namespace on the first
  // deploy and matches it after, with no migration tags, so a deploy run again (or retried) is the same deploy.
  const exports = Object.fromEntries(
    Object.entries(w.exports ?? {})
      .filter(([, e]) => e.type == "durable-object")
      .map(([n, e]) => [n, { type: "durable-object", storage: e.storage ?? "sqlite" }])
  );
  return {
    main_module: release.mainModule,
    compatibility_date: w.compatibilityDate,
    compatibility_flags: w.compatibilityFlags ?? [],
    bindings,
    // Secrets set once on the Worker stay from version to version, as with `cf deploy`.
    keep_bindings: ["secret_text", "secret_key"],
    assets: {
      jwt: o.assetsJwt,
      config: {
        html_handling: w.assets?.htmlHandling ?? "auto-trailing-slash",
        not_found_handling: w.assets?.notFoundHandling ?? "none",
        run_worker_first: w.assets?.runWorkerFirst ?? false,
        // The headers Cloudflare gives the files it serves without the Worker (the build's _headers, client/build.ts).
        ...(release.assets[HEADERS_FILE] ? { _headers: new TextDecoder().decode(release.assets[HEADERS_FILE]) } : {}),
      },
    },
    observability: {
      enabled: !!w.observability?.enabled,
      logs: { enabled: !!w.observability?.logs?.enabled, invocation_logs: !!w.observability?.logs?.invocationLogs },
    },
    ...(Object.keys(exports).length ? { exports } : {}),
    tags: [WORKER_TAG],
  };
}

/**
 * Where a target is deployed, as its Worker holds it (the binding ERGA_DEPLOY) and its entry in .erga/config.json: the
 * target's own names and its plain settings (vars). `bun erga register` reads it from Cloudflare (liveRelease), so a
 * machine can deploy the instance again with no list of instances in the code. Never a secret: the secrets stay on the
 * Worker.
 */
export const deployFacts = (t: CloudflareTarget, settings: Spec["settings"]) => ({
  account: t.account,
  worker: t.worker,
  database: t.database,
  ...(t.subdomain ? { subdomain: t.subdomain } : {}),
  app: t.app,
  pages: t.pages,
  ...(t.domains?.length ? { domains: t.domains } : {}),
  vars: settings,
});

/**
 * The R2 bucket a target binds as `binding`: one of its own, named after its
 * Worker (FILES on the Worker example is example-files), so no two targets share one.
 */
export const bucketName = (worker: string, binding: string) => `${worker}-${binding.toLowerCase().replace(/_/g, "-")}`;

/** The static assets' 32-hex hash, as Cloudflare's direct upload takes it: SHA-256 of the base64 contents and the extension. */
export async function assetHash(path: string, bytes: Uint8Array): Promise<string> {
  const ext = /\.([^./]+)$/.exec(path)?.[1] ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(toBase64(bytes) + ext));
  return toHex(new Uint8Array(digest)).slice(0, 32);
}

const TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain",
  md: "text/markdown",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  xml: "application/xml",
  mp4: "video/mp4",
  webmanifest: "application/manifest+json",
};
export const typeOf = (path: string) => TYPES[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";
