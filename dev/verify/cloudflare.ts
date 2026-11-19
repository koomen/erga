// The verify harness on Cloudflare (dev/verify.ts): a setting's Workers, deployed with wrangler (signed in to the
// account) and removed again. Every Worker's name starts with erga-verify-:
//
//   erga-verify-idp-N    the test issuer (idp.ts), on workers.dev: a third site, as an organization's issuer is
//   erga-verify-stub-N   the origin that stands in for Erga (stub.ts). SSO and Access: no route, no custom domain and
//                        no workers.dev address; only the gate's service binding reaches it. OAuth: the gate is inside
//                        it, and it has the hosts
//   erga-verify-gate-N   SSO and Access: the gate's own Worker (gate/mounts/worker.ts, as it is), from its own deploy
//                        file (gate/wrangler.jsonc: a deploy fills in the name, the hosts and the issuer), with the
//                        hosts. Access: Cloudflare Access is in front of the shell's host (access.ts), and the gate
//                        reads its proof
//   erga-verify-N        SSO, unless `--origin stub`: a real Erga of this checkout in the stub's place (erga.ts), with
//                        its database and its bucket. Its documents' hosts exist only after the seed made the
//                        documents: the gate's Worker is deployed a second time, with them
//
// The hosts are Custom Domains: each one makes its own DNS record and gets its own certificate, which a host two
// levels under the zone needs. (gate/wrangler.jsonc has a zone's routes, with DNS records that a person makes: an
// instance's content domain is a zone itself, and here six settings share one.)
// Every Worker goes to the settings' Cloudflare account with the suite's token (dedicated.ts, tokenNow), has the
// suite's name, and binds nothing of the account but the suite's own; every host is a run's host, under one of the two
// test zones (safe.ts, workerProblem).
//
// A deploy is a list of parts (update.ts): the issuer, the real Erga, the stub, the gate's Worker. The step `update`
// (`bun erga verify update`, on a setting that a run kept) deploys again each part whose built code, settings or
// secrets changed, on the Workers, the database and the bucket that are there. It makes no host: the Custom Domains
// and their certificates stay, and so do the people and the documents of the seed.

import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployAccess, removeAccess } from "./access.ts";
import { assertDedicated, tokenNow } from "./dedicated.ts";
import { ergaName, ergaPart, healthy, removeErga, seed } from "./erga.ts";
import {
  acceptHost,
  CLIENT,
  docHost,
  loadRun,
  local,
  otherSite,
  passes,
  type Run,
  type Setting,
  saveRun,
  secret,
  sh,
  until,
  warmHost,
  zone,
} from "./run.ts";
import { mine, workerProblem } from "./safe.ts";
import { bundleHash, hashOf, type Part, redeploy } from "./update.ts";

const ROOT = resolve(import.meta.dir, "../..");
/**
 * wrangler, for one of the suite's Workers only: a deploy of settings that `deployWorker` checked and wrote, or the
 * secrets or the removal of a Worker with the suite's name. It gets the suite's token at this time, and no other.
 * Trap: just after a Worker's first upload, the API may refuse for some seconds (run.ts, passes): again.
 */
function wrangler(args: string[], tries = 4): string {
  const named = args.indexOf("--name");
  if (args[0] == "deploy" ? args.length != 3 || args[1] != "--config" || !checked.has(args[2]) : named < 0)
    throw new Error(`The verify suite does not run wrangler ${args.slice(0, 2).join(" ")} so.`);
  if (named >= 0) mine(args[named + 1] ?? "");
  try {
    return sh(["bunx", "wrangler", ...args], { cwd: ROOT, env: { CLOUDFLARE_API_TOKEN: tokenNow() } });
  } catch (e) {
    if (tries <= 1 || args[0] == "delete" || !passes(String(e))) throw e;
    Bun.sleepSync(3000);
    return wrangler(args, tries - 1);
  }
}
/** The settings' files that `deployWorker` wrote, after the suite's rule let them through. */
const checked = new Set<string>();
export const worker = (kind: string, s: Setting) => `erga-verify-${kind}-${s.n}`;

/** Deploys one Worker from its settings (`main`: from the repository's root) and secrets; gives what wrangler printed. */
export function deployWorker(config: Record<string, unknown> & { name: string; main: string }, secrets: Record<string, string>): string {
  // Only the suite's own Workers, with hosts under the test zones only, and bound to nothing else (safe.ts).
  const no = workerProblem(config, local().cloudflare);
  if (no) throw new Error(no);
  const dir = mkdtempSync(join(tmpdir(), "erga-verify-"));
  const at = join(dir, "wrangler.json");
  writeFileSync(
    at,
    JSON.stringify({ compatibility_date: "2026-01-01", workers_dev: false, preview_urls: false, ...config, main: join(ROOT, config.main) })
  );
  checked.add(at);
  const out = wrangler(["deploy", "--config", at]);
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  wrangler(["secret", "bulk", join(dir, "secrets.json"), "--name", config.name]);
  return out;
}

/**
 * Deploys the test issuer (idp.ts) on workers.dev, with a new key for its ID tokens: its address. `redirect`: the one
 * address it sends a person back to.
 */
export async function deployIssuer(s: Setting, run: Pick<Run, "idp">, redirect: string): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const key = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "verify" };
  const out = deployWorker(
    { name: worker("idp", s), main: "dev/verify/idp.ts", workers_dev: true, vars: { CLIENT, REDIRECT: redirect } },
    { CLIENT_SECRET: run.idp.secret, PASSWORD: run.idp.password, KEY: secret(), SIGNING_KEY: JSON.stringify(key) }
  );
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0];
  if (!url) throw new Error(`The issuer has no workers.dev address:\n${out}`);
  // A new workers.dev address answers 404 for a while (seen: an AWS run asked at once, and stopped): wait for its
  // discovery document, three good answers in a row, at most two minutes.
  let good = 0;
  for (const end = Date.now() + 120_000; good < 3; ) {
    const ok = await fetch(`${url}/.well-known/openid-configuration`).then(
      (r) => r.ok,
      () => false
    );
    good = ok ? good + 1 : 0;
    if (good < 3 && Date.now() > end) throw new Error(`The test issuer at ${url} does not answer.`);
    if (good < 3) await Bun.sleep(2000);
  }
  return url;
}

/** The hosts as routes: a Custom Domain each. */
const routes = (hosts: string[]) => hosts.map((h) => ({ pattern: h, custom_domain: true }));

/** The gate's own deploy file (gate/wrangler.jsonc), as a deploy reads it before it fills in its values. */
const GATE = Bun.JSONC.parse(readFileSync(join(ROOT, "gate/wrangler.jsonc"), "utf8")) as Record<string, unknown> & { main: string };

/**
 * Waits until a host answers over HTTPS (its certificate is there), and it is this run's gate that answers (`text`
 * null: any text). `of`: the host's zone, whose own name server is asked.
 * Trap: this machine keeps a "no such host" for the zone's 30 minutes. So the zone's own name server is asked first,
 * and the machine's resolver only when the record is there.
 */
export async function answers(
  host: string,
  path = "/_edge/ready",
  status = 404,
  text: string | null = "Not found",
  of = zone(host)
): Promise<void> {
  const servers = await dns.resolve4((await dns.resolveNs(of))[0]);
  // (A new resolver each time: a resolver keeps a "no such host" too.)
  await until(
    `${host} is in DNS`,
    async () => {
      const own = new dns.Resolver();
      own.setServers(servers);
      return (await own.resolve4(host)).length > 0;
    },
    300_000,
    2000
  );
  await steady(`https://${host}${path}`, status, text);
}

/**
 * Waits until an address gives the same good answer five times in a row.
 * Trap: one good answer is not enough. For a time after a Worker is made, some of Cloudflare's machines answer its
 * hosts with "Script not found" (a 500, error 1104), between good answers: a run's first requests then fail (seen
 * 2026-11-19, in the seed and in the first checks of five runs).
 */
async function steady(url: string, status: number, text: string | null): Promise<void> {
  let row = 0;
  await until(
    `${url} answers each time`,
    async () => {
      const r = await fetch(url, { redirect: "manual" }).catch(() => null);
      row = r && r.status == status && (text == null || (await r.text()) == text) ? row + 1 : 0;
      return row >= 5;
    },
    1_200_000,
    1500
  );
}

/**
 * The test issuer as a part of a deploy (update.ts): its code, the address it sends a person back to, and the run's
 * client secret and password. Each deploy of it makes a new key for its ID tokens. `run.idp.url` gets its address.
 */
export const issuerPart = (s: Setting, run: Pick<Run, "idp">, redirect: string): Part => ({
  name: "idp",
  hash: async () => hashOf(await bundleHash("dev/verify/idp.ts"), redirect, run.idp.secret, run.idp.password),
  deploy: async () => {
    const url = await deployIssuer(s, run, redirect);
    // (The gate's settings, and Access's, name the address.)
    if (run.idp.url && run.idp.url != url) throw new Error(`The test issuer's address was ${run.idp.url}, and is ${url} now.`);
    run.idp.url = url;
  },
});

/** Where the issuer sends a person back to: the gate's callback; behind Access, the team's own. */
const redirectOf = (run: Run) =>
  run.access ? `https://${run.access.team}.cloudflareaccess.com/cdn-cgi/access/callback` : `https://${run.shell}/_edge/callback`;

/**
 * The hosts of a setting's Workers: the shell, the documents' (the stub's have fixed hosts; the real Erga's are the
 * seed's documents'), and where the documents are on another site the accept host (the real Erga: the warm one too).
 */
const hostsOf = (run: Run): string[] => [
  run.shell,
  ...(run.erga ? run.erga.docs.map((d) => d.host) : [docHost(run, 1), docHost(run, 2), docHost(run, 3)]),
  ...(otherSite(run) ? [acceptHost(run), ...(run.erga ? [warmHost(run)] : [])] : []),
];

/**
 * The stub (unless a real Erga is the origin) and the gate's own Worker (SSO and Access) as parts of a deploy
 * (update.ts), each with its code, its settings (the hosts too) and its secrets, from the run's values.
 */
export function workerParts(run: Run): Part[] {
  const front = run.who != "oauth";
  const hosts = hostsOf(run);
  const gateVars = {
    SHELL: run.shell,
    CONTENT: run.content,
    ...(run.access
      ? { ACCESS: JSON.stringify({ team: run.access.team, aud: run.access.aud }) }
      : {
          IDP: JSON.stringify({
            name: "sso",
            issuer: run.idp.url,
            authorize: `${run.idp.url}/authorize`,
            token: `${run.idp.url}/token`,
            client: CLIENT,
          }),
        }),
  };
  // (GATE_KEY: the gate's own Worker does not start without it; the stub does not read it.)
  const gateSecrets = { EDGE_KEY: run.key, GATE_KEY: run.gateKey!, ...(run.access ? {} : { IDP_SECRET: run.idp.secret }) };
  const part = (kind: string, config: Parameters<typeof deployWorker>[0], secrets: Record<string, string>): Part => ({
    name: kind,
    hash: async () => hashOf(await bundleHash(config.main), config, secrets),
    deploy: () => deployWorker(config, secrets),
  });
  return [
    ...(run.erga
      ? []
      : [
          part(
            "stub",
            {
              name: worker("stub", run),
              main: "dev/verify/stub.ts",
              durable_objects: { bindings: [{ name: "LOG", class_name: "Log" }] },
              migrations: [{ tag: "v1", new_sqlite_classes: ["Log"] }],
              vars: { ...(front ? { SHELL: run.shell, CONTENT: run.content } : gateVars), GATE: front ? "front" : "inside" },
              ...(front ? {} : { routes: routes(hosts) }),
            },
            front ? {} : gateSecrets
          ),
        ]),
    ...(front
      ? [
          part(
            "gate",
            {
              ...GATE,
              name: worker("gate", run),
              main: join("gate", GATE.main),
              services: [{ binding: "ERGA", service: run.erga ? ergaName(run) : worker("stub", run) }],
              vars: gateVars,
              routes: routes(hosts),
            },
            gateSecrets
          ),
        ]
      : []),
  ];
}

/** Waits until the shell answers as this run's gate. (Behind Access, an address of the shell with no proof never comes to the gate, but for the open paths: the vouch.) */
const shellAnswers = (run: Run) => (run.access ? answers(run.shell, "/_edge/vouch", 401, "Sign in first.") : answers(run.shell));

export async function deployCloudflare(s: Setting, origin: "stub" | "erga"): Promise<Run> {
  // Only on zones of the suite's own, in an account that it may use: asked here, before anything is made.
  await assertDedicated({ cloudflare: true, aws: false });
  const real = origin == "erga";
  if (real && s.who != "sso")
    throw new Error("A real Erga runs only behind the gate's own Worker, with the gate's own sign-in: an SSO setting.");
  // A Worker that runs keeps its secrets' meaning: a second deploy of the run sends the same ones.
  const had = loadRun(s.n)?.erga;
  const key = () => randomBytes(32).toString("hex");
  const run: Run = {
    ...s,
    key: secret(),
    gateKey: secret(),
    parts: {},
    idp: { url: "", secret: secret(), password: secret(12) },
    // (The real Erga's documents get their hosts below, after the seed.)
    ...(real
      ? { erga: { database: had?.database ?? "", version: "", session: had?.session ?? key(), factory: had?.factory ?? key(), docs: [] } }
      : {}),
  };
  // (Kept after each part: a deploy that fails leaves the run's values for `check` and `remove`.)
  const keep = (parts: Record<string, string>) => {
    run.parts = parts;
    saveRun(run);
  };
  // Access: the issuer sends a person back to the team's own callback, and the gate has no issuer: it reads Access's proof.
  if (s.who == "access") {
    run.access = await deployAccess(s, run, deployIssuer);
    keep({ idp: await issuerPart(s, run, redirectOf(run)).hash() });
  } else await redeploy([issuerPart(s, run, redirectOf(run))], run.parts, keep, console.log);
  // The address the origin would have on workers.dev: the issuer's, with the origin's name.
  run.originAddress = run.idp.url.replace(worker("idp", s), real ? ergaName(s) : worker("stub", s));
  await redeploy([...(real ? [ergaPart(run)] : []), ...workerParts(run)], run.parts, keep, console.log);

  const hosts = hostsOf(run);
  console.log(`Waiting for ${hosts.length} hosts' certificates...`);
  for (const h of hosts) await (h == s.shell ? shellAnswers(run) : answers(h));
  // (The issuer is a new Worker too.)
  await steady(`${run.idp.url}/.well-known/openid-configuration`, 200, null);
  if (real) {
    await seed(run);
    // The gate's Worker again, with the documents' hosts.
    await redeploy(workerParts(run), run.parts, keep, console.log);
    const docs = run.erga!.docs.map((d) => d.host);
    console.log(`Waiting for the ${docs.length} documents' hosts' certificates...`);
    for (const h of docs) await answers(h);
    await healthy(run);
  }
  return run;
}

/**
 * The step `update`, on a setting that a run kept: each part whose code, settings or secrets changed, again (see the
 * top). The run's values, its hosts and its seed stay. The parts it deployed.
 */
export async function updateCloudflare(s: Setting): Promise<string[]> {
  await assertDedicated({ cloudflare: true, aws: false });
  const run = loadRun(s.n);
  if (!run) throw new Error(`Setting ${s.n} is not deployed: bun erga verify ${s.n} --keep deploys it, and keeps it.`);
  if (run.shell != s.shell || run.content != s.content)
    throw new Error(`The deploy on record is of ${run.shell}, not of this machine's settings (${s.shell}): remove it.`);
  const keep = (parts: Record<string, string>) => {
    run.parts = parts;
    saveRun(run);
  };
  const did = await redeploy(
    [issuerPart(s, run, redirectOf(run)), ...(run.erga ? [ergaPart(run)] : []), ...workerParts(run)],
    run.parts,
    keep,
    console.log
  );
  await shellAnswers(run);
  await steady(`${run.idp.url}/.well-known/openid-configuration`, 200, null);
  if (run.erga) await healthy(run);
  return did;
}

/** Removes one of the suite's Workers, and says what it found. */
export function removeWorker(name: string) {
  try {
    wrangler(["delete", "--name", mine(name), "--force"]);
    console.log(`Removed ${name}`);
  } catch (e) {
    const said = String(e);
    console.log(/does not exist|not found|10007/i.test(said) ? `${name}: none` : said);
  }
}

export async function removeCloudflare(s: Setting) {
  for (const kind of ["gate", "stub", "idp"]) removeWorker(worker(kind, s));
  if (s.who == "access") await removeAccess(s);
  // The real Erga, if a run made one: after the gate's Worker, which binds it.
  if (s.who == "sso") await removeErga(s).catch((e: Error) => console.log(`${ergaName(s)}: not looked for: ${e.message}`));
}
