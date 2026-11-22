// The verify harness's real Erga (dev/verify.ts): a complete Erga of this checkout for one setting, with single
// sign-on (the gate), with people and documents in it; its checks with requests; and its removal. Everything it makes
// in the account is named erga-verify-<n>:
//
//   the Worker     this checkout, deployed by the repository's own pipeline (deploy/pipeline/), as setup deploys an
//                  instance with single sign-on. On Cloudflare the gate is inside it, with the test issuer as the
//                  organization's sign-in (the setting SSO: gate/sso.ts), and it has the setting's hosts. On AWS the
//                  gate is in front, and GATE_KEY says so (server/identity/mode.ts)
//   the database   D1. One row, which setup's own code writes for single sign-on (deploy/own/first.ts, writeFirstRows):
//                  anyone whom the gate lets in may write
//   the bucket     R2, erga-verify-<n>-files: the documents' files that are not text
//
// The people sign in only at the test issuer, through the gate (idp.ts: ada, bob), and Erga hears them from the gate:
// no cookie or row of the harness's says who they are. Their accounts come as a new server's do: a first visit makes
// the account (the setting usernames, "email" by a deploy's default here, names it by the email address: ada, bob), and ada
// becomes the admin on the server's setup page (server/identity/setup.ts), whose one-time link the harness seals with
// the instance's SESSION_SECRET as `bun erga setup` does.
//
// Each of the gate's own answers has `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` (gate/core.ts,
// respond), and Erga's have not both: so a check tells which of the two answered, with no log of Erga's.

import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import https from "node:https";
import { join, resolve } from "node:path";
import { HEALTH } from "../../gate/core.ts";
import { DEFAULT_BRANCH, DEFAULT_REPO } from "../../deploy/cli/config.ts";
import { heldSecrets, specOf } from "../../deploy/cli/instance.ts";
import { type Carry, d1, d1Api, d1Sql, healthRow, readHealth } from "../../deploy/deployer/cloudflare.ts";
import { findDatabase } from "../../deploy/pipeline/account.ts";
import { DeployError } from "../../deploy/deployer/cloudflare-api.ts";
import type { Release } from "../../deploy/deployer/release-format.ts";
import { writeFirstRows } from "../../deploy/own/first.ts";
import { noAnswers } from "../../deploy/own/plan.ts";
import { runPipeline, type Target, targetFacts } from "../../deploy/pipeline/pipeline.ts";
import { setupUrl } from "../../server/identity/setup-link.ts";
import { cloudflare } from "./dedicated.ts";
import { type Answer, ask, type Jar, routes, signIn } from "./http.ts";
import { recordChecks } from "./record.ts";
import { acceptHost, local, otherSite, type Report, type Run, type Setting, saveRun, ssoSetting, zone } from "./run.ts";
import { mine } from "./safe.ts";
import { buildRelease, hashOf, type Part } from "./update.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const ergaName = (s: Setting) => `erga-verify-${s.n}`;
export type Who = "ada" | "bob";
/** A 1x1 PNG: a file that is not text is in the bucket. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JSON_TYPE = { "content-type": "application/json" };

/**
 * Cloudflare's API as the suite may use it, and the settings' account: the suite's rule is asked before each call
 * (dedicated.ts, `cloudflare`), and the token is the suite's own (never printed): no other sign-in of this machine.
 */
export async function account() {
  const { cf, local } = await cloudflare();
  const id = local.cloudflare.account;
  return { cf, id, acc: `/accounts/${id}` };
}

/** The setting's Erga as the repository's pipeline deploys it: its Worker and database, its hosts, its settings (the gate's sign-in among them) and secrets. */
const targetOf = (run: Run): Target => ({
  label: run.shell,
  accountId: local().cloudflare.account,
  workerName: ergaName(run),
  databaseName: ergaName(run),
  app: { kind: "domain", zoneName: zone(run.shell), hostname: run.shell },
  pages: { kind: "zone", zoneName: zone(run.content), domain: run.content },
  // A new person's username is their address's (no step to choose one: a run has no person to choose).
  vars: { SERVER_DEFAULTS: JSON.stringify({ usernames: "email" }), GITHUB_CLIENT_ID: "", SSO: ssoSetting(run)! },
  secrets: { SESSION_SECRET: run.erga!.session, SECRETS_KEY: run.erga!.factory, SSO_CLIENT_SECRET: run.idp.secret },
});

/**
 * The setting's Erga as a part of the deploy (update.ts): this checkout's release, built when the part is asked, with
 * its settings and secrets. A release with the same files as the one that runs is not deployed again.
 */
export function ergaPart(run: Run): Part {
  let built: Promise<Release> | null = null;
  const release = () => (built ??= buildRelease(console.log));
  return {
    name: "erga",
    hash: async () => hashOf((await release()).version, targetOf(run)),
    deploy: async () => deployErga(run, await release()),
  };
}

/**
 * Deploys the release as the setting's Erga, behind the gate, with the repository's own pipeline: on a Worker that is
 * there, a new version of it on the same database and bucket, with the migrations. `run.erga` gets the database and
 * the release's name.
 */
async function deployErga(run: Run, release: Release): Promise<void> {
  const { cf } = await account();
  const first = !run.erga!.version;
  const carry: Carry = {};
  try {
    await runPipeline(cf, release, targetOf(run), {
      carry,
      // (A Worker that ran before: the pipeline's own wait for the new release's health row.)
      ...(first ? { waitMs: 60_000 } : {}),
      report: (step, status, detail) => status == "done" && console.log(`  ${step}: ${detail ?? "done"}`),
    });
  } catch (e) {
    // Trap: Cloudflare starts a new Cron Trigger up to 15 minutes late, and the health row is the trigger's. The
    // deploy goes on: `healthy` asks Erga itself through the gate, and the checks read the row again.
    if (!(first && e instanceof DeployError && /first health row has not come yet/.test(e.message))) throw e;
    console.log(`  live: no health row in the first minute (a new Cron Trigger): the deploy goes on.`);
  } finally {
    run.erga!.database = carry.dbId ?? run.erga!.database;
    saveRun(run);
  }
  run.erga!.version = release.version;
  saveRun(run);
}

// ---------------------------------------------------------------- people, as requests

/** Whether the gate itself answered, by an answer's headers; and whether Erga did, behind it: see the top. */
const gateSaid = (header: (name: string) => unknown) =>
  header("referrer-policy") == "no-referrer" && header("x-content-type-options") == "nosniff";
export const ergas = (a: Answer) => !gateSaid((name) => a.headers.get(name));

/** A page of the shell as a browser asks it, through each redirect: the last answer. */
async function page(run: Run, jar: Jar, path: string): Promise<Answer> {
  let a = await ask(`https://${run.shell}${path}`, { jar, dest: "document" });
  for (let i = 0; i < 6 && a.status == 302; i++)
    a = await ask(new URL(a.headers.get("location") ?? "", a.url).href, { jar, dest: "document" });
  return a;
}

/**
 * A person as requests: the gate's cookies, from a sign-in at the test issuer, and nothing else. Their first page
 * makes their account, as a person's first visit does.
 */
export async function person(run: Run, who: Who): Promise<Jar> {
  const jar: Jar = new Map();
  const back = (await signIn(run, who, jar)).at(-1)!;
  if (back.status != 302 || !jar.has(`=${run.shell}`)) throw new Error(`${who} did not sign in at the gate: ${back.status} ${back.text}`);
  const first = await page(run, jar, "/documents");
  if (first.status != 200)
    throw new Error(`${who}'s first page (/documents): ${first.status} at ${first.url}: ${first.text.slice(0, 200)}`);
  return jar;
}

/** One tool call as the person of `jar`, as a page of the shell makes it: its result, or its error thrown. */
export async function tool<T = unknown>(run: Run, jar: Jar, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const shell = `https://${run.shell}`;
  const a = await ask(`${shell}/api/tools/${name}`, { jar, body: JSON.stringify(args), headers: { ...JSON_TYPE, origin: shell } });
  let body: { ok?: boolean; result?: T; error?: string } = {};
  try {
    body = JSON.parse(a.text);
  } catch {}
  if (a.status != 200 || !body.ok) throw new Error(`${name} ${args.op ?? ""}: ${a.status} ${body.error ?? a.text.slice(0, 200)}`);
  return body.result as T;
}

/** A document's page as text, as its person's tool reads it. */
export const pageOf = async (run: Run, jar: Jar, document: string) =>
  JSON.stringify(await tool(run, jar, "read", { op: "read", document, path: "index.html" }));

/**
 * The seed: the rule that lets the gate's people in; ada's account and bob's, by their first visit; ada the admin, by
 * setup's one-time link; three documents of ada, made with tool calls through the gate, the third shared with bob.
 */
export async function seed(run: Run): Promise<void> {
  const shell = `https://${run.shell}`;
  // The rule that lets the gate's people in, as setup writes it for single sign-on. (On AWS it went in with the
  // release: deploy/aws/setup.ts, firstSql.)
  if (run.where == "cloudflare") {
    const { cf, acc } = await account();
    await writeFirstRows(cf, acc, ergaName(run), { ...noAnswers(run.shell), where: "cloudflare", signIn: "sso" }, console.log);
  }
  const ada = await person(run, "ada");
  // The setup page's link, as setup opens it, and its last step: ada, whom the gate signed in, becomes the admin.
  const link = new URL(await setupUrl(run.shell, run.erga!.session));
  const asked = await page(run, ada, link.pathname + link.search);
  const claimed = await ask(`${shell}/setup/admin`, { jar: ada, body: "", headers: { origin: shell } });
  const me = await tool<{ login: string; adminPower: boolean }>(run, ada, "whoami");
  if (me.login != "ada" || !me.adminPower)
    throw new Error(
      `ada is not the admin: the setup page ${asked.status}, its last step ${claimed.status}; whoami: ${JSON.stringify(me).slice(0, 200)}`
    );
  await person(run, "bob");
  run.erga!.docs = [];
  for (const n of [1, 2, 3]) {
    const html = `<!doctype html><meta charset="utf-8"><title>Verify ${n}</title><body><h1>Verify ${n}</h1><p>The seed wrote this.</p><p><img src="dot.png" alt=""></p>`;
    const d = await tool<{ id: string; address: string }>(run, ada, "documents", {
      op: "create_document",
      title: `Verify ${n}`,
      files: { "index.html": html, "dot.png": { base64: PNG } },
    });
    run.erga!.docs.push({ id: d.id, address: d.address, host: `${d.id}-ada.${run.content}` });
    console.log(`  document ${n}: ${d.address} (${run.erga!.docs[n - 1].host})`);
  }
  await tool(run, ada, "documents", { op: "share_document", document: run.erga!.docs[2].address, login: "bob", role: "editor" });
  saveRun(run);
}

/** Erga's own health report, through the gate, as a signed-in person: its status and text. */
async function healthOf(run: Run, jar: Jar) {
  const a = await ask(`https://${run.shell}/api/health`, { jar });
  return { ok: a.status == 200 && /"ok":\s*true/.test(a.text), said: `${a.status} ${a.text.slice(0, 200)}` };
}

/** After a deploy: Erga answers its health through the gate, or the deploy fails with what it said. */
export async function healthy(run: Run): Promise<void> {
  const h = await healthOf(run, await person(run, "ada"));
  if (!h.ok) throw new Error(`Erga's health through the gate: ${h.said}`);
  console.log(`  Erga's health through the gate: ${h.said}`);
}

// ---------------------------------------------------------------- the checks with requests

/** One request, a socket's first request too (the method "WS"), with nothing followed: its status, and who answered. */
const probe = (method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; erga: boolean }> =>
  new Promise((done) => {
    const socket = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    const r = https.request(url, { method: method == "WS" ? "GET" : method, headers: { ...headers, ...(method == "WS" ? socket : {}) } });
    // (A socket that opens is Erga's: the gate opens none.)
    r.on("upgrade", (_res, sock) => (sock.destroy(), done({ status: 101, erga: true })));
    r.on("response", (res) => (res.resume(), done({ status: res.statusCode ?? 0, erga: !gateSaid((name) => res.headers[name]) })));
    r.on("error", () => done({ status: 0, erga: false }));
    r.end();
  });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** The checks with requests alone: Erga behind the gate, as the people of the seed. */
export async function ergaChecks(run: Run, report: Report): Promise<void> {
  const shell = `https://${run.shell}`;
  const [first, , shared] = run.erga!.docs;
  // (On Cloudflare: the account's own records of the Worker. On AWS the machine's checks are aws.ts's and celld.ts's.)
  const cloud = run.where == "cloudflare" ? await account() : null;
  const ada = await person(run, "ada");
  const whoami = (jar: Jar, headers: Record<string, string> = {}) =>
    ask(`${shell}/api/tools/whoami`, { jar, body: "{}", headers: { ...JSON_TYPE, origin: shell, ...headers } });
  const loginOf = (a: Answer) => (a.status == 200 ? (JSON.parse(a.text).result?.login as string) : `${a.status} ${a.text.slice(0, 60)}`);

  const h = await healthOf(run, ada);
  report.add("Erga's health report, through the gate", h.ok, h.said);
  if (cloud) {
    const row = readHealth(await healthRow(d1Api(cloud.cf, cloud.acc, run.erga!.database)), run.erga!.version, Date.now());
    report.add("Erga's scheduled run writes its health row (the Cron Trigger)", row.healthy, row.healthy ? row.summary : row.why);
    const applied = (
      (await d1(cloud.cf, cloud.acc, run.erga!.database, "SELECT name FROM d1_migrations", [], "read the database's migrations")) ?? []
    )
      .map((r) => String(r.name).replace(/\.sql$/, ""))
      .sort();
    const files = readdirSync(join(ROOT, "server/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    report.add(
      "The database has each migration of this checkout",
      files.length > 0 && files.every((f) => applied.includes(f)),
      `${applied.length} of ${files.length}; the last: ${applied.at(-1)}`
    );
    // The instance's record of its deploys, in its database, through D1's API.
    const entry = { host: run.shell, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, ...targetFacts(targetOf(run)) };
    const spec = await heldSecrets(entry, { cf: cloud.cf }).then(
      (held) => specOf(entry, held),
      (e: Error) => e
    );
    if (spec instanceof Error) report.add("The instance's entry is a spec that the instance can hold", false, spec.message);
    else await recordChecks(report, d1Sql(cloud.cf, entry), spec, "D1's API");
  }

  // --- who Erga hears
  const me = await whoami(ada);
  const admin = JSON.stringify(await tool(run, ada, "people", { op: "people" }).catch((e: Error) => e.message));
  report.add(
    "ada is ada to Erga with the gate's cookies alone, and the admin",
    loginOf(me) == "ada" && ergas(me) && admin.includes('"bob"'),
    `whoami: ${loginOf(me)}; the users she lists: ${admin.slice(0, 100)}`
  );
  const bob = await person(run, "bob");
  const reads = await Promise.all(
    [shared, first].map((d) =>
      pageOf(run, bob, d.address).then(
        (text) => (text.includes("The seed wrote this") ? "opened" : `opened, but: ${text.slice(0, 80)}`),
        (e: Error) => `refused (${e.message})`
      )
    )
  );
  report.add(
    "bob opens the document shared with him, and not another of ada's",
    reads[0] == "opened" && reads[1].startsWith("refused"),
    reads.join("; ")
  );

  // A browser that lost its member cookie: the person's next page of the shell gets it again (gate/core.ts, memberFor).
  // On CloudFront the response function sets it: it finds the person by the viewer's cookies.
  const bare = await ask(`${shell}/documents`, {
    dest: "document",
    headers: { cookie: `__Host-erga=${ada.get(`=${run.shell}`)?.get("__Host-erga")}` },
  });
  const again = bare.set.filter((l) => /member=/.test(l.split(";")[0]) && !l.includes("Max-Age=0")).map((l) => l.split("=")[0]);
  report.add(
    "A page of the shell that comes with the shell cookie and no member cookie gets its member cookie again",
    bare.status == 200 && ergas(bare) && again.length == 1,
    `${bare.status} from ${ergas(bare) ? "Erga" : "the gate"}; cookies set: ${again.join(", ") || "none"}`
  );

  // --- nothing reaches Erga but through the gate, and the gate alone says who calls
  const all = routes().flatMap((r) => [
    { ...r, at: "the shell", url: shell + r.path },
    { ...r, at: "a document's host", url: `https://${first.host}${r.path}` },
  ]);
  const reached: string[] = [];
  const statuses = new Map<number, number>();
  // One address goes on as nobody where the gate is inside Erga's Worker: the server's health report, which the
  // account's deployer asks after each deploy (gate/core.ts, Config.health). The gate in front lets nothing through.
  const report200 = (r: (typeof all)[number]) => !!cloud && r.method == "GET" && r.path == HEALTH && r.at == "the shell";
  for (let i = 0; i < all.length; i += 16)
    await Promise.all(
      all.slice(i, i + 16).map(async (r) => {
        const a = await probe(r.method, r.url);
        statuses.set(a.status, (statuses.get(a.status) ?? 0) + 1);
        if (report200(r) ? !a.erga : a.erga || !a.status) reached.push(`${a.status} ${r.method} ${r.path} on ${r.at}`);
      })
    );
  report.add(
    cloud
      ? "With no proof, the gate answers each of Erga's routes, on the shell and on a document's host: none reaches Erga but the health report, as nobody"
      : "With no proof, the gate answers each of Erga's routes, on the shell and on a document's host: none reaches Erga",
    all.length > 100 && !reached.length,
    `${all.length} requests; ${[...statuses].map(([s, n]) => `${n} x ${s}`).join(", ")}${reached.length ? `; Erga answered: ${reached.slice(0, 8).join(", ")}` : ""}`
  );
  if (otherSite(run)) {
    // Two of the gate's own addresses that need a member cookie: with none, each answers 401, and says nothing more.
    const vouch = await ask(`${shell}/_edge/vouch`);
    const out = await ask(`https://${acceptHost(run)}/_edge/sign-out`, { dest: "iframe" });
    report.add(
      "The vouch and sign-out's frame on the accept host need a member cookie: with none, each answers 401",
      vouch.status == 401 && out.status == 401 && !out.set.length && !ergas(vouch) && !ergas(out),
      `${vouch.status} and ${out.status}`
    );
  }
  const control = await probe("GET", `${shell}/api/health`, {
    cookie: [...ada.get(`=${run.shell}`)!].map(([k, v]) => `${k}=${v}`).join("; "),
  });
  report.add(
    "(The control: with ada's proof, the same kind of request reaches Erga)",
    control.erga && control.status == 200,
    String(control.status)
  );
  if (cloud) {
    if (run.originAddress) {
      const direct = await fetch(`${run.originAddress}/api/health`, { redirect: "manual" }).then(
        (r) => String(r.status),
        (e) => String(e).slice(0, 60)
      );
      const beside = await fetch(`${run.idp.url}/.well-known/openid-configuration`).then(
        (r) => r.status,
        () => 0
      );
      report.add(
        "Erga's Worker has no workers.dev address that answers (the issuer's, beside it, does)",
        !/^[23]/.test(direct) && beside == 200,
        `${new URL(run.originAddress).host}: ${direct}; the issuer: ${beside}`
      );
    }
    const workersDev = await cloud.cf.call<{ enabled?: boolean; previews_enabled?: boolean }>(
      "GET",
      `${cloud.acc}/workers/scripts/${ergaName(run)}/subdomain`,
      "read Erga's workers.dev setting"
    );
    const domains = await cloud.cf.call<{ hostname: string }[]>(
      "GET",
      `${cloud.acc}/workers/domains?service=${ergaName(run)}`,
      "read Erga's custom domains"
    );
    const strange = (domains ?? []).map((d) => d.hostname).filter((h) => h != run.shell && !h.endsWith(`.${run.content}`));
    report.add(
      "Erga's Worker has the run's hosts and no other address: workers.dev is not on",
      workersDev?.enabled !== true && !!domains?.length && !strange.length,
      `workers.dev ${JSON.stringify(workersDev)}; custom domains: ${domains?.map((d) => d.hostname).join(", ") || "none"}`
    );
  }
  // The caller's header and the gate's key, from outside: with the real key too, they change nothing.
  const now = Date.now();
  const forged = {
    "x-erga-caller": b64({
      kind: "person",
      p: "sso",
      sub: "sub-ada",
      email: "ada@example.com",
      name: "Ada",
      i: now,
      e: Math.floor(now / 1000) + 3600,
    }),
    // (On Cloudflare no gate is in front, and Erga has no such key: any value.)
    "x-erga-front": run.gateKey ?? "k".repeat(43),
  };
  const nobody = await ask(`${shell}/api/tools/whoami`, { body: "{}", headers: { ...JSON_TYPE, origin: shell, ...forged } });
  const asBob = await whoami(bob, forged);
  report.add(
    "A forged x-erga-caller (ada) and x-erga-front (the real key, where a gate is in front) change nothing: nobody stays nobody, and bob stays bob",
    nobody.status == 401 && !ergas(nobody) && loginOf(asBob) == "bob",
    `with no proof: ${nobody.status} from ${ergas(nobody) ? "Erga" : "the gate"}; with bob's cookies: ${loginOf(asBob)}`
  );

  await agentChecks(run, report, ada);
}

/**
 * An agent's whole way in, as an MCP app goes it (the MCP authorization spec), against the real Erga: no token, the
 * metadata, the approval page, the code, the token, a tool call, the refresh, a token to paste, and Revoke.
 */
export async function agentChecks(run: Run, report: Report, ada: Jar): Promise<void> {
  const shell = `https://${run.shell}`;
  const mcp = async (token: string | null, method: string, params: object = {}) => {
    const a = await ask(`${shell}/mcp`, {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      headers: { ...JSON_TYPE, accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const text = a.status == 200 ? ((JSON.parse(a.text).result?.content?.[0]?.text ?? "") as string) : "";
    return { status: a.status, auth: a.headers.get("www-authenticate") ?? "", text, erga: ergas(a) };
  };
  const trade = async (fields: Record<string, string>) => {
    const a = await ask(`${shell}/oauth/token`, { body: new URLSearchParams(fields).toString() });
    const body = JSON.parse(a.text) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: string;
    };
    return { status: a.status, ...body };
  };
  const grantOf = async (token: string) => {
    const said = (await mcp(token, "tools/call", { name: "documents", arguments: { op: "whoami" } })).text;
    try {
      const w = JSON.parse(said) as { login: string; token?: { id: string; label: string; scope: string } };
      return { login: w.login, id: w.token?.id ?? "", label: w.token?.label ?? "", scope: w.token?.scope ?? "" };
    } catch {
      return { login: said.slice(0, 80), id: "", label: "", scope: "" };
    }
  };

  const none = await mcp(null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify", version: "1" },
  });
  const metadata = /resource_metadata="([^"]+)"/.exec(none.auth)?.[1] ?? "";
  // (With single sign-on the gate refuses it itself, in front of Erga or as its first call.)
  report.add(
    "Agents: with no token, /mcp gets a 401 that names the metadata",
    none.status == 401 && !none.erga && metadata == `${shell}/.well-known/oauth-protected-resource`,
    `${none.status} from ${none.erga ? "Erga" : "the gate"}: ${none.auth}`
  );
  const resource = metadata ? await ask(metadata) : null;
  const server = await ask(`${shell}/.well-known/oauth-authorization-server`);
  const as = server.status == 200 ? (JSON.parse(server.text) as Record<string, string>) : {};
  report.add(
    "Agents: the metadata names this server, its authorization, token and registration endpoints",
    resource?.status == 200 &&
      JSON.parse(resource.text).resource == `${shell}/mcp` &&
      as.authorization_endpoint == `${shell}/oauth/authorize` &&
      as.token_endpoint == `${shell}/oauth/token` &&
      as.registration_endpoint == `${shell}/oauth/register`,
    `${resource?.status} and ${server.status}: ${server.text.slice(0, 160)}`
  );
  // An app registers itself with no proof, for this computer's redirects only, and the gate keeps nothing.
  const reg = (uris: string[]) =>
    ask(`${shell}/oauth/register`, {
      body: JSON.stringify({ client_name: "Verify harness", redirect_uris: uris, token_endpoint_auth_method: "none" }),
      headers: { "content-type": "application/json" },
    });
  const [here, there] = [await reg(["http://127.0.0.1:43117/callback"]), await reg(["https://elsewhere.example/callback"])];
  report.add(
    "Agents: an app registers itself for this computer's redirects (a client ID with its name), and not for another site's",
    here.status == 201 && /^Verify-harness\.[a-z0-9]{6}$/.test(JSON.parse(here.text).client_id ?? "") && there.status == 400,
    `${here.status}: ${here.text.slice(0, 120)}; another site: ${there.status}`
  );

  // The app names itself, and comes back to this computer.
  const client = "Verify harness (erga)";
  const redirect = "http://127.0.0.1:43117/callback";
  /** An authorization request of the app's, with a PKCE pair of its own. */
  const request = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    return {
      verifier,
      authorize: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${shell}/mcp` })}`,
    };
  };
  /** Approve, as the approval page sends it: the answer, and where it sends the browser. */
  const approve = async (authorize: string) => {
    const approved = await ask(shell + authorize, { jar: ada, body: "answer=approve&scope=documents", headers: { origin: shell } });
    return { approved, back: new URL(approved.headers.get("location") ?? "http://none.invalid/") };
  };
  const { verifier, authorize } = await request();
  const cold = await ask(shell + authorize, { dest: "document" });
  const approval = await ask(shell + authorize, { jar: ada, dest: "document" });
  report.add(
    "Agents: /oauth/authorize shows ada Erga's approval page, with the app's own name; with no sign-in, the gate's sign-in",
    approval.status == 200 &&
      ergas(approval) &&
      approval.text.includes(`<b>${client}</b> wants to act for you`) &&
      cold.status == 302 &&
      !ergas(cold),
    `signed in: ${approval.status} from ${ergas(approval) ? "Erga" : "the gate"}; with no sign-in: ${cold.status} ${(cold.headers.get("location") ?? "").slice(0, 40)}`
  );
  const { approved, back } = await approve(authorize);
  const code = back.searchParams.get("code") ?? "";
  report.add(
    "Agents: Approve, as the page sends it, sends the browser back to the app with a code and its state",
    approved.status == 302 && back.href.startsWith(redirect) && !!code && back.searchParams.get("state") == "xyz",
    `${approved.status} ${back.origin}${back.pathname}?${[...back.searchParams.keys()].join("&")}`
  );
  const wrong = await trade({
    grant_type: "authorization_code",
    code,
    client_id: client,
    redirect_uri: redirect,
    code_verifier: "x".repeat(43),
  });
  const got = await trade({ grant_type: "authorization_code", code, client_id: client, redirect_uri: redirect, code_verifier: verifier });
  report.add(
    "Agents: the code with its PKCE verifier gives a token of an hour and a refresh grant; with a wrong verifier, none",
    got.status == 200 &&
      got.token_type == "Bearer" &&
      got.expires_in == 3600 &&
      !!got.refresh_token &&
      wrong.status == 400 &&
      wrong.error == "invalid_grant",
    `${got.status} ${got.token_type} ${got.expires_in}; the wrong verifier: ${wrong.status} ${wrong.error}`
  );
  const first = got.access_token ?? "";
  const listed = await mcp(first, "tools/call", { name: "documents", arguments: { op: "list_documents" } });
  const mine = await grantOf(first);
  report.add(
    "Agents: a real MCP tool call with the token lists ada's documents, as her agent by this grant",
    listed.status == 200 &&
      ["Verify 1", "Verify 2", "Verify 3"].every((t) => listed.text.includes(t)) &&
      mine.login == "ada" &&
      mine.label == client &&
      mine.scope == "documents",
    `${listed.status}: ${listed.text.replace(/\s+/g, " ").slice(0, 120)}; whoami: ${mine.login}, "${mine.label}", ${mine.scope}`
  );
  const fresh = await trade({ grant_type: "refresh_token", refresh_token: got.refresh_token ?? "", client_id: client });
  const second = fresh.access_token ?? "";
  const same = await grantOf(second);
  report.add(
    "Agents: the refresh grant gives a new token, of the same grant",
    fresh.status == 200 && !!second && !!mine.id && same.id == mine.id,
    `${fresh.status}; the grant is ${same.id == mine.id ? "the same" : "another"}`
  );
  // A code's second exchange, on a grant of its own. The gate keeps no state: its token endpoint gives tokens again,
  // with another exchange's mark. Erga takes one exchange's tokens only for a grant: the other's token ends the grant.
  const again = await request();
  const twice = {
    grant_type: "authorization_code",
    code: (await approve(again.authorize)).back.searchParams.get("code") ?? "",
    client_id: client,
    redirect_uri: redirect,
    code_verifier: again.verifier,
  };
  const one = await trade(twice);
  const two = await trade(twice);
  const firstUse = await mcp(one.access_token ?? "", "tools/list");
  const secondUse = await mcp(two.access_token ?? "", "tools/list");
  const firstAfter = await mcp(one.access_token ?? "", "tools/list");
  const renewed = await trade({ grant_type: "refresh_token", refresh_token: one.refresh_token ?? "", client_id: client });
  const renewedUse = await mcp(renewed.access_token ?? "", "tools/list");
  report.add(
    "Agents: a code works one time only: its second exchange gets tokens from the gate (200), Erga refuses that token (401) and ends the grant, and the first exchange's tokens stop too",
    one.status == 200 &&
      two.status == 200 &&
      firstUse.status == 200 &&
      [secondUse, firstAfter, renewedUse].every((a) => a.status == 401 && a.erga),
    `the exchanges: ${one.status} and ${two.status}; the first token: ${firstUse.status}; the second's: ${secondUse.status}; then the first's: ${firstAfter.status}, and one from its refresh grant (${renewed.status}): ${renewedUse.status}`
  );
  const made = await ask(`${shell}/tokens/new`, {
    jar: ada,
    body: JSON.stringify({ label: "Verify script", scope: "documents" }),
    headers: { ...JSON_TYPE, origin: shell },
  });
  const pasted = made.headers.get("x-erga-token") ?? "";
  const script = await grantOf(pasted);
  report.add(
    "Agents: a token to paste (POST /tokens/new, in x-erga-token, not in the body) works as ada's agent",
    made.status == 200 && !!pasted && !made.text.includes(pasted) && script.login == "ada" && script.label == "Verify script",
    `${made.status}, a token of ${pasted.length} characters; whoami: ${script.login}, "${script.label}"`
  );
  // Revoke, as Settings' button does it: every token of the grant stops at once, a later one from its refresh grant too.
  const revoked = await Promise.all(
    [mine.id, script.id].map((token) =>
      tool(run, ada, "revoke", { token }).then(
        () => "revoked",
        (e: Error) => e.message
      )
    )
  );
  const later = await trade({ grant_type: "refresh_token", refresh_token: fresh.refresh_token ?? "", client_id: client });
  const after = await Promise.all([first, second, later.access_token ?? "", pasted].map((t) => mcp(t, "tools/list")));
  report.add(
    'Agents: after Revoke, each token of the two grants gets a 401 with error="invalid_token", a later one from the refresh grant too',
    revoked.every((r) => r == "revoked") && after.every((a) => a.status == 401 && a.auth.includes('error="invalid_token"')),
    `revoke: ${revoked.join(", ")}; then: ${after.map((a) => `${a.status} ${/error="[^"]*"/.exec(a.auth)?.[0] ?? a.auth.slice(0, 40)} from ${a.erga ? "Erga" : "the gate"}`).join("; ")}`
  );
}

// ---------------------------------------------------------------- removal

/**
 * Removes the setting's Erga: its Worker (its routes and Custom Domains go with it), its database, and its bucket, emptied
 * first. Each part says what it found.
 */
export async function removeErga(s: Setting): Promise<void> {
  const { cf, acc } = await account();
  const name = mine(ergaName(s));
  const bucket = mine(`${name}-files`);
  const part = (what: string, run: () => Promise<string>) =>
    run().then(
      (did) => console.log(`${what}: ${did}`),
      (e: Error) => console.log(`${what}: NOT removed: ${e.message}`)
    );
  await part(name, async () => {
    if (!(await cf.call("GET", `${acc}/workers/scripts/${name}/settings`, "look for the Worker", undefined, { allow404: true })))
      return "none";
    await cf.call("DELETE", `${acc}/workers/scripts/${name}?force=true`, `delete the Worker ${name}`);
    return "removed";
  });
  await part(`the database ${name}`, async () => {
    const db = await findDatabase(cf, acc, name);
    if (!db) return "none";
    await cf.call("DELETE", `${acc}/d1/database/${db}`, `delete the database ${name}`);
    return "removed";
  });
  await part(`the bucket ${bucket}`, async () => {
    if (!(await cf.call("GET", `${acc}/r2/buckets/${bucket}`, "look for the bucket", undefined, { allow404: true }))) return "none";
    let emptied = 0;
    for (;;) {
      const objects =
        (await cf.call<{ key: string }[]>("GET", `${acc}/r2/buckets/${bucket}/objects?per_page=1000`, "list the bucket")) ?? [];
      if (!objects.length) break;
      for (const o of objects)
        await cf.call("DELETE", `${acc}/r2/buckets/${bucket}/objects/${encodeURIComponent(o.key)}`, "delete a file of the bucket");
      emptied += objects.length;
    }
    await cf.call("DELETE", `${acc}/r2/buckets/${bucket}`, `delete the bucket ${bucket}`);
    return `removed (${emptied} files in it)`;
  });
}
