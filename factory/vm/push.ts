#!/usr/bin/env bun
// The factory's image on Cloudflare: built for Cloudflare's machines
// (linux/amd64), pushed to the account's container registry
// (registry.cloudflare.com/<account>/erga-factory:<tag>), and prepared for
// Containers (Cloudflare copies it to its network once, before a VM can
// start from it). deploy/targets.json names it (factory.image), and the
// deploy pipeline declares it on the Worker's version (deploy/cloudflare.ts,
// the "factory" step).
//
//   CLOUDFLARE_ACCOUNT_ID=<id> bun factory/vm/push.ts      build (or find) the image, push it unless the registry
//                                                         has it, prepare it; prints its reference
//
// With Docker running, and this machine's own credential (deploy/credential.ts:
// CLOUDFLARE_API_TOKEN, else the cf CLI's login), which must be allowed to
// use Containers (the cf login asks for containers:write). The registry's
// password is a 15-minute one, used through a Docker config folder of its own
// (deleted afterwards): this machine's ~/.docker/config.json isn't touched.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloudflare, DeployError } from "../../deploy/cloudflare.ts";
import { imageRef, prepareImage, REGISTRY, registryCredentials, registryHas } from "../../deploy/containers.ts";
import { dockerUp, ensureImage, imageTag } from "./build.ts";

/** Cloudflare's machines. */
export const PLATFORM = "linux/amd64";

/** Docker's own endpoint for this machine's current context (so a Docker config folder of our own still finds it). */
function dockerHost(): string | undefined {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const r = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" });
  return r.status == 0 ? r.stdout.trim() || undefined : undefined;
}

/** Builds the image for Cloudflare and pushes it, unless the registry has it; its reference. */
export async function pushImage(cf: Cloudflare, accountId: string, log: (line: string) => void = (l) => console.error(l)): Promise<string> {
  const image = imageTag();
  const ref = imageRef(accountId, image);
  if (await registryHas(cf, accountId, image)) { log(`${ref}: the registry has it already`); return ref; }
  if (!dockerUp()) throw new DeployError(`The registry doesn't have ${image} yet, and Docker isn't running here to build it. Start Docker and deploy again.`);
  const local = await ensureImage((l) => { if (/^#\d+ (DONE|\[)/.test(l) || /building/.test(l)) log(l); }, PLATFORM);
  const config = mkdtempSync(join(tmpdir(), "erga-docker-"));
  const env = { ...process.env, DOCKER_CONFIG: config, ...(dockerHost() ? { DOCKER_HOST: dockerHost() } : {}) };
  try {
    const { username, password } = await registryCredentials(cf, accountId, ["push", "pull"]);
    const login = spawnSync("docker", ["login", "--username", username, "--password-stdin", REGISTRY], { input: password, env, encoding: "utf8" });
    if (login.status != 0) throw new DeployError(`docker login to ${REGISTRY} failed: ${login.stderr.trim()}`);
    if (spawnSync("docker", ["tag", local, ref], { env }).status != 0) throw new DeployError(`docker tag ${local} ${ref} failed`);
    log(`pushing ${ref} (about 2 GB the first time; then only changed layers)`);
    const code = await new Promise<number>((resolve) => {
      const p = spawn("docker", ["push", ref], { env, stdio: ["ignore", "pipe", "pipe"] });
      const take = (c: Buffer) => { for (const l of c.toString().split("\n")) if (/digest|Pushed|error/i.test(l)) log(l.trim()); };
      p.stdout.on("data", take);
      p.stderr.on("data", take);
      p.on("close", (c) => resolve(c ?? 1));
    });
    if (code != 0) throw new DeployError(`docker push ${ref} failed (exit ${code})`);
    return ref;
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { machineCredential } = await import("../../deploy/credential.ts");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const cred = machineCredential();
  if (!/^[0-9a-f]{32}$/.test(accountId) || !cred) { console.error("Set CLOUDFLARE_ACCOUNT_ID, and log in (bunx cf auth login) or set CLOUDFLARE_API_TOKEN."); process.exit(1); }
  const cf = new Cloudflare(cred.token);
  const ref = await pushImage(cf, accountId);
  console.error(`preparing ${ref} for Containers`);
  await prepareImage(cf, accountId, ref);
  console.log(ref);
}
