// The checks of Erga's own deploy on AWS with no gate in front (aws.ts deploys it, as `bun erga setup` deploys an
// instance): celld on one machine in a private subnet, CloudFront in front (a VPC origin), the documents' pages on a
// zone of their own (another site). Celld runs Erga's Worker code, so the gate runs inside it, as its first call
// (OAuth mode: server/identity/mount.ts). Two units of the suite:
//
//   celld   the deploy itself: health, no public address, one journey with the real editor in Chromium; then the
//           deploy scenarios on AWS (deploys-aws.ts): from this machine, and from the deployer in the account
//   6       the plan's setting 6 (AWS, OAuth, the gate inside celld): the same deploy, with a stack of its own; the
//           checks above, the gate's own answers and its checks of each request, an agent's whole way in, and the
//           journey in each browser, with sign-out
//
//   bun dev/verify/celld.ts deploy|update|check|remove                  (the unit celld)
//   bun dev/verify.ts 6 deploy|update|check|remove [--browsers a,b]     (setting 6)
//
// Nobody signs in at a provider here: OAuth mode's providers are GitHub and Google, which take no scripted person.
// ada's sign-in cookie is made as the gate inside the server makes it (gate/core.ts, signInCookies),
// with the key that comes from the server's SESSION_SECRET, which the run made. So the gate's check of each request
// runs for real; its sign-in's start is checked up to GitHub's address (setting 6 has a client ID that GitHub does not
// know), and the callback's exchange is not.
// Trap: Erga remembers for a time that a login has no row. ada's row goes in with the deploy, before her first request.

import { writeFileSync } from "node:fs";
import { type BrowserType, chromium, firefox, webkit } from "playwright-core";
import { awsCli } from "../../deploy/aws/cli.ts";
import { awsSql } from "../../deploy/aws/deploy.ts";
import { awsEntry, whereOf } from "../../deploy/aws/setup.ts";
import { heldSecrets, specOf } from "../../deploy/cli/instance.ts";
import { Cloudflare } from "../../deploy/deployer/cloudflare-api.ts";
import { CELLD_PORT } from "../../deploy/aws/template.ts";
import { openEditor } from "../../e2e/helpers/editor";
import type { Tab } from "../../e2e/helpers/fixtures";
import { clickOn } from "../../e2e/helpers/press";
import type { Server } from "../../e2e/helpers/server";
import { seal, signInCookies } from "../../gate/core.ts";
import { webPort } from "../../gate/port.ts";
import { edgeKey } from "../../server/identity/caller.ts";
import { allowHere, answersOf, type AwsRun, type AwsUnit, deployOnAws, GITHUB_CLIENT, loadAws, removeOnAws } from "./aws.ts";
import { answers } from "./cloudflare.ts";
import { awsDeployChecks } from "./deploys-aws.ts";
import { useDedicated } from "./dedicated.ts";
import { agentChecks, ergas, tool } from "./erga.ts";
import { type Answer, ask, type Jar } from "./http.ts";
import { recordChecks } from "./record.ts";
import { local, Report, resultsFile, type Run as VerifyRun } from "./run.ts";

/** This file's two units (see the top). */
export type Unit = Exclude<AwsUnit, "5">;
let unit: Unit = "celld";
/** ada, as a provider vouches for her: the subject of her identity's row (aws.ts), and of her sign-in cookie. */
const ADA = { p: "github", sub: "1", email: "", name: "Ada" };
type Run = AwsRun;

/** The deploy; `update`: on a deploy that a run kept, only what changed (aws.ts). */
async function deploy(update = false) {
  const run = await deployOnAws(unit, update);
  await answers(run.host, "/api/health", 200, null, local().aws.shell);
}

/**
 * The machine, as AWS and the internet see it: no public address, and no answer on its private one from here.
 * (Unit 5's checks too: the same machine behind the gate.)
 */
export async function machineChecks(report: Report, run: AwsRun) {
  const aws = awsCli(whereOf(answersOf(run.unit)));
  const machine = (
    await aws<{ Reservations: { Instances: { PublicIpAddress?: string; PublicDnsName?: string; PrivateIpAddress: string }[] }[] }>(
      "ec2",
      "describe-instances",
      "--instance-ids",
      run.outputs!.Machine
    )
  ).Reservations[0].Instances[0];
  report.add(
    "The machine has no public address (describe-instances)",
    !machine.PublicIpAddress && !machine.PublicDnsName,
    `public IP: ${machine.PublicIpAddress ?? "none"}; public DNS name: ${machine.PublicDnsName || "none"}; private IP: ${machine.PrivateIpAddress}`
  );
  const direct = await fetch(`http://${machine.PrivateIpAddress}:${CELLD_PORT}/api/health`, { signal: AbortSignal.timeout(5000) }).then(
    (r) => `it answered ${r.status}`,
    (e: Error) => `no answer: ${e.name}`
  );
  report.add("The machine's private address does not answer from here", direct.startsWith("no answer"), direct);
  // The instance's record of its deploys, in the machine's database: each statement is one command of Systems Manager.
  const a = answersOf(run.unit);
  const { Account } = await aws<{ Account: string }>("sts", "get-caller-identity");
  const entry = awsEntry(a, Account, run.outputs!, run.unit == "6" ? GITHUB_CLIENT : undefined);
  const spec = await heldSecrets(entry, { cf: new Cloudflare("", fetch), aws: () => aws }).then(
    (held) => specOf(entry, held),
    (e: Error) => e
  );
  if (spec instanceof Error) report.add("The instance's entry is a spec that the instance can hold", false, spec.message);
  else await recordChecks(report, awsSql(aws, entry.aws), spec, "Systems Manager");
}

/** Waits until `read` gives a value (asked each 100 ms); null after `limit`. */
async function seen<T>(read: () => Promise<T>, limit: number): Promise<T | null> {
  const end = Date.now() + limit;
  for (;;) {
    const v = await read().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await Bun.sleep(100);
  }
}

async function check(browsers: string[]) {
  const run = loadAws(unit);
  if (!run?.outputs?.Machine) throw new Error(`No deploy of ${unit} on record: run deploy first.`);
  const report = new Report();
  await allowHere(unit);
  const root = `https://${run.host}`;
  const url = new URL(root);

  const h = await fetch(`${root}/api/health`);
  const said = await h.text();
  const body = (() => {
    try {
      return JSON.parse(said) as { ok?: boolean; version?: string };
    } catch {
      return {};
    }
  })();
  report.add(
    "Health through the App distribution: ok, with this release's version",
    h.status == 200 && body.ok === true && !!body.version && body.version == run.deployed?.version,
    `${h.status} ${said.slice(0, 160)}; x-cache: ${h.headers.get("x-cache")}; pop: ${h.headers.get("x-amz-cf-pop")}; deploy: ${run.deployed?.seconds ?? "?"} s`
  );
  // What Erga takes for its own address: it says it in the agents' metadata. celld hears http, and no header says
  // the scheme: Erga takes a deployed server's address for https (shared/http.ts, overHttps).
  const self = await (await fetch(`${root}/.well-known/oauth-protected-resource`)).text();
  report.add("Erga takes its address for https://, with no header for the scheme", self.includes(`"${root}/mcp"`), self.slice(0, 120));

  await machineChecks(report, run);

  // Seed and journey, as deploy/aws/check.ts does them, with ada's sign-in cookie (see the top).
  const cookie = await adaCookie(run.session, url.host);
  const made = await fetch(`${root}/new`, { redirect: "manual", headers: { cookie: `${cookie.name}=${cookie.value}` } });
  const at = made.headers.get("location");
  report.add(
    "Seed: ada makes a document (GET /new)",
    made.status == 302 && !!at,
    `${made.status} ${at ?? (await made.text()).slice(0, 160)}`
  );
  const address = at ? root + at.replace(/[?&]edit$/, "") : null;
  if (unit == "celld") {
    await journey(report, "chromium", "", run, root, address);
    // Last, on the same instance: the deploys from this machine, and from the deployer in the account (deploys-aws.ts).
    await awsDeployChecks(report, run).catch((e: Error) => report.add("The deploy scenarios on AWS ran to their end", false, e.message));
    return report;
  }
  await gateInside(report, run, root);
  for (const name of browsers) {
    if (!(name in TYPES)) throw new Error(`Setting 6 runs in chromium, firefox and webkit: no "${name}".`);
    await journey(report, name, name, run, root, address);
  }
  await signOutChecks(report, run, root);
  return report;
}

const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };

/**
 * ada's sign-in cookie, as the gate inside the server makes it now (the first of a sign-in's cookies; see the top).
 * `ahead`: its time, ahead of this machine's clock: a sign-in after a sign-out must be later by the server's clock.
 */
export async function adaCookie(session: string, host: string, ahead = 0) {
  const config = { key: await edgeKey(session), shell: host, content: "pages.invalid", https: true, open: true, idp: {}, oauth: true };
  const [shell] = await signInCookies(Date.now() + ahead, config, webPort, ADA);
  return { name: shell.slice(0, shell.indexOf("=")), value: shell.slice(shell.indexOf("=") + 1, shell.indexOf(";")) };
}

/**
 * One journey with the real editor, in one browser, as ada: the document opens, takes text typed with real keys, the
 * room's socket connects, and a new tab shows the text. `label`: the rows' browser ("": the unit celld's one journey).
 * Setting 6 goes on: what the document's page may read and ask, and sign-out by the account menu.
 */
async function journey(report: Report, name: string, label: string, run: Run, root: string, address: string | null) {
  const add = (check: string, ok: boolean | null, note = "") => report.add(check, ok, note, label);
  const url = new URL(root);
  /** A document's page is on a host of its own, under the pages' domain. */
  const onPages = (host: string) => host.endsWith(`.${run.pages}`);
  const rows = [
    `The real editor opens the document (headless ${name})`,
    "Text typed with real keys shows on the page",
    "The room's WebSocket connects through CloudFront and the VPC origin",
    "The typed text is saved: the document shows it again in a new tab",
  ];
  if (!address) {
    for (const row of rows) add(row, null, "no document");
    return;
  }
  const browser = await TYPES[name].launch();
  try {
    if (label) add("The browser", true, `${name} ${browser.version()}`);
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    // (After another browser's sign-out: a sign-in later than it.)
    const cookie = await adaCookie(run.session, url.host, label ? 5000 : 0);
    await context.addCookies([{ ...cookie, domain: url.hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    /** Each socket a tab or its frames opened: where to, the frames each way, and how it ended. */
    const sockets: { to: string; got: number; sent: number; end: string }[] = [];
    const errors: string[] = [];
    /** The requests of a frame's own document (the pages' host), and those of them to another origin. */
    const own = { n: 0, away: new Set<string>() };
    context.on("request", (r) => {
      try {
        const f = r.frame();
        if (!f.parentFrame() || r.isNavigationRequest() || !onPages(new URL(f.url()).host)) return;
        own.n++;
        if (new URL(r.url()).origin != new URL(f.url()).origin) own.away.add(`${new URL(r.url()).host}${new URL(r.url()).pathname}`);
      } catch {
        // (A service worker's request has no frame.)
      }
    });
    const tabOf = async (): Promise<Tab> => {
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
      page.on("websocket", (ws) => {
        // (The query holds the document's key: left out.)
        const s = { to: new URL(ws.url()).host + new URL(ws.url()).pathname, got: 0, sent: 0, end: "open" };
        sockets.push(s);
        ws.on("framereceived", () => s.got++);
        ws.on("framesent", () => s.sent++);
        ws.on("socketerror", (e) => (s.end = `error: ${e}`));
        ws.on("close", () => (s.end = s.end == "open" ? "closed" : s.end));
      });
      return { page, errors: [], strict: false, own: () => Promise.reject(new Error("no server of its own")) };
    };
    const server = { fixture: async () => ({ dir: "", address }) } as unknown as Server;
    const first = await tabOf();
    const open = async (tab: Tab) => openEditor(tab, server, "", { allowErrors: true, timescale: 1 });

    const t = Date.now();
    const ed = await open(first);
    const frameAt = new URL(await ed.frame<string>("location.href")).host;
    add(rows[0], true, `${Date.now() - t} ms; the page's frame is on ${frameAt}`);
    const words = `Typed with real keys in ${name} at ${new Date().toISOString()}`;
    await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
    await ed.type(` ${words}`);
    add(rows[1], !!(await seen(async () => (await ed.visible()).includes(words), 10_000)));
    const connected = await ed.eval<boolean>("ergaPage.collab.connected");
    add(
      rows[2],
      connected && sockets.some((s) => s.to.startsWith(url.host) && s.got > 0),
      `the editor says connected: ${connected}; ${sockets.map((s) => `${s.to}: ${s.got} frames in, ${s.sent} out, ${s.end}`).join("; ") || "no socket"}`
    );
    const before = sockets.length;
    const again = await open(await tabOf());
    add(
      rows[3],
      !!(await seen(async () => (await again.visible()).includes(words), 15_000)),
      `its sockets: ${
        sockets
          .slice(before)
          .map((s) => `${s.to}: ${s.got} in`)
          .join("; ") || "none"
      }`
    );
    if (!label) return;

    // --- setting 6: the document's page, and sign-out
    add(
      "The document's frame is on a host under the pages' domain: another site than the app's",
      onPages(frameAt),
      `${frameAt}; the app: ${url.host}`
    );
    const read = await ed.frame<string>("document.cookie");
    add("A3: the document's script reads no cookie", read == "", read || "document.cookie is empty");
    const lost = [
      ...own.away,
      ...sockets.filter((s) => !s.to.startsWith(url.host) && !onPages(s.to.split("/")[0])).map((s) => `a socket to ${s.to}`),
    ];
    add(
      "Invariant 4: the document's own requests go only to its own origin",
      own.n > 0 && !lost.length,
      `${own.n} requests in the document's frames${lost.length ? `; away: ${lost.slice(0, 4).join(", ")}` : ""}`
    );
    add("No script error", !errors.length, [...new Set(errors)].slice(0, 4).join("; "));
    const tab = first.page;
    await tab.goto(`${root}/documents`);
    await clickOn(tab, "[data-erga-account] button");
    await clickOn(tab, `.erga-account-menu a[href="/auth/logout"]`);
    const gone = await seen(async () => !(await context.cookies()).some((c) => c.name == cookie.name), 15_000);
    // (With the cookies that the browser still has: the sign-out's page goes on by itself, so no script of the tab asks.)
    const left = (await context.cookies(root)).map((c) => `${c.name}=${c.value}`).join("; ");
    const after = await ask(`${root}/api/tools/whoami`, {
      body: "{}",
      headers: { "content-type": "application/json", origin: root, ...(left ? { cookie: left } : {}) },
    });
    add(
      "Sign-out by the account menu: the gate inside ends its cookie, and Erga knows nobody",
      !!gone && after.status == 401,
      `the sign-in cookie is ${gone ? "gone" : "still there"}; whoami with the browser's cookies then: ${after.status}; the tab is at ${new URL(tab.url()).pathname}`
    );
  } catch (e) {
    add("The journey", false, String(e).split("\n")[0]);
  } finally {
    await browser.close();
  }
}

/**
 * Setting 6, with requests: the gate inside celld. Its own answers (the agents' metadata and token endpoint, its
 * sign-in's start), who Erga hears for each kind of proof, and an agent's whole way in (erga.ts, agentChecks).
 */
async function gateInside(report: Report, run: Run, root: string) {
  const host = new URL(root).host;
  const as = { shell: host } as VerifyRun;
  const c = await adaCookie(run.session, host);
  const ada: Jar = new Map([[`=${host}`, new Map([[c.name, c.value]])]]);
  const whoami = (o: { jar?: Jar; headers?: Record<string, string> } = {}) =>
    ask(`${root}/api/tools/whoami`, {
      jar: o.jar,
      body: "{}",
      headers: { "content-type": "application/json", origin: root, ...o.headers },
    });
  const loginOf = (a: Answer) => {
    try {
      return String(JSON.parse(a.text).result?.login ?? `${a.status}`);
    } catch {
      return `${a.status}`;
    }
  };
  const by = (a: Answer) => (ergas(a) ? "Erga" : "the gate");

  // --- the gate's own answers
  const [meta, tokenGet, tokenPost, none] = await Promise.all([
    ask(`${root}/.well-known/oauth-authorization-server`),
    ask(`${root}/oauth/token`),
    ask(`${root}/oauth/token`, { body: "" }),
    ask(`${root}/_edge/none`),
  ]);
  report.add(
    "The gate inside celld answers its own addresses: the agents' metadata, the token endpoint, and a 404 for any other of /_edge/",
    [meta, tokenGet, tokenPost, none].every((a) => !ergas(a)) &&
      meta.status == 200 &&
      JSON.parse(meta.text).token_endpoint == `${root}/oauth/token` &&
      tokenGet.status == 405 &&
      tokenPost.status == 400 &&
      none.status == 404,
    `${meta.status} ${tokenGet.status} ${tokenPost.status} ${none.status}; each from ${[meta, tokenGet, tokenPost, none].map(by).join(", ")}`
  );
  const start = await ask(`${root}/_edge/sign-in?idp=github&next=${encodeURIComponent("/documents")}`, { dest: "document" });
  const to = new URL(start.headers.get("location") ?? "http://none.invalid/");
  const state = start.set.find((l) => l.startsWith("__Host-signin=")) ?? "";
  report.add(
    "Sign-in starts at the gate: on to GitHub with the server's client, the gate's callback, a state and a PKCE challenge; the state cookie is __Host-, HttpOnly, Lax",
    start.status == 302 &&
      `${to.origin}${to.pathname}` == "https://github.com/login/oauth/authorize" &&
      to.searchParams.get("client_id") == GITHUB_CLIENT &&
      to.searchParams.get("redirect_uri") == `${root}/_edge/callback` &&
      to.searchParams.get("code_challenge_method") == "S256" &&
      to.searchParams.get("code_challenge")?.length == 43 &&
      !!to.searchParams.get("state") &&
      /; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/.test(state),
    `${start.status} ${to.origin}${to.pathname}?${[...to.searchParams.keys()].join("&")}; ${state.replace(/=[^;]*/, "=…")}`
  );
  const stolen = await ask(`${root}/_edge/callback?code=x&state=y`, { dest: "document" });
  report.add(
    "A callback with no state cookie is refused",
    stolen.status == 400 && !stolen.set.length && !ergas(stolen),
    `${stolen.status} ${stolen.text.slice(0, 40)}`
  );

  // --- who Erga hears
  const nobody = await whoami();
  const me = await whoami({ jar: ada });
  const admin = await tool<{ login: string; adminPower: boolean }>(as, ada, "whoami").catch((e: Error) => ({
    login: e.message,
    adminPower: false,
  }));
  report.add(
    "With no proof a request goes on to Erga as nobody; with ada's sign-in cookie Erga hears ada, an admin",
    ergas(nobody) && nobody.status == 401 && loginOf(me) == "ada" && admin.adminPower,
    `no proof: ${nobody.status} from ${by(nobody)}; ada: ${loginOf(me)}, admin power: ${admin.adminPower}`
  );
  const now = Math.floor(Date.now() / 1000);
  const key = await edgeKey(run.session);
  const good = [...ada.get(`=${host}`)!][0];
  const person = { ...ADA, i: Date.now() };
  const flip = (v: string) => v.replace(/\.(.)/, (_m, ch) => `.${ch == "A" ? "B" : "A"}`);
  const bad: Record<string, Record<string, string>> = {
    "a forged cookie": { cookie: `${good[0]}=${flip(good[1])}` },
    "an expired cookie": { cookie: `${good[0]}=${await seal(webPort, key, "s", person, now - 5)}` },
    "a cookie of another key": {
      cookie: `${good[0]}=${await seal(webPort, "another-edge-key-of-thirty-two-chars", "s", person, now + 3600)}`,
    },
    "a caller's header from outside": {
      "x-erga-caller": Buffer.from(JSON.stringify({ kind: "person", ...person, e: now + 3600 })).toString("base64url"),
    },
  };
  const heard = await Promise.all(Object.entries(bad).map(async ([what, headers]) => `${what}: ${loginOf(await whoami({ headers }))}`));
  report.add(
    "A forged, an expired and another key's sign-in cookie, and a caller's header from outside, each name nobody",
    heard.every((h) => h.endsWith(": 401")),
    heard.join("; ")
  );
  const both = await whoami({ jar: ada, headers: { authorization: "Bearer a.b.c" } });
  report.add(
    "A bad token gets the gate's 401, whatever cookie comes with it",
    both.status == 401 &&
      !ergas(both) &&
      (both.headers.get("www-authenticate") ?? "").includes(`${root}/.well-known/oauth-protected-resource`),
    `${both.status} from ${by(both)}`
  );

  // --- an agent's whole way in, as against the real Erga behind a gate in front (three documents first: it lists them)
  for (const n of [1, 2, 3])
    await tool(as, ada, "documents", {
      op: "create_document",
      title: `Verify ${n}`,
      files: {
        "index.html": `<!doctype html><meta charset="utf-8"><title>Verify ${n}</title><body><h1>Verify ${n}</h1><p>The seed wrote this.</p>`,
      },
    });
  await agentChecks(as, report, ada);
}

/** Setting 6, last: ada signs out with a request, and a copy of her cookie from before it names nobody. */
async function signOutChecks(report: Report, run: Run, root: string) {
  const host = new URL(root).host;
  const c = await adaCookie(run.session, host, 10_000);
  const cookie = `${c.name}=${c.value}`;
  const whoami = () =>
    ask(`${root}/api/tools/whoami`, { body: "{}", headers: { "content-type": "application/json", origin: root, cookie } });
  const before = await whoami();
  const out = await ask(`${root}/auth/logout`, { dest: "document", headers: { cookie, "sec-fetch-site": "same-origin" } });
  const after = await whoami();
  // (A request that is not a page gets the refusal only; a page gets a redirect to itself that ends the cookie:
  // server/identity/admit.ts, signedOut.)
  const page = await ask(`${root}/documents`, { dest: "document", headers: { cookie } });
  const ends = (a: Answer) => a.set.some((l) => l.startsWith(`${c.name}=;`) && l.includes("Max-Age=0"));
  report.add(
    "Sign-out ends the gate's cookie; a copy of the cookie from before it names nobody, and a page has the gate end it",
    before.status == 200 &&
      out.status == 200 &&
      ends(out) &&
      !out.headers.has("x-erga-gate") &&
      after.status == 401 &&
      page.status == 302 &&
      ends(page) &&
      !page.headers.has("x-erga-gate"),
    `before: ${before.status}; sign-out: ${out.status}, the cookie ${ends(out) ? "ends" : "stays"}; the copy after: ${after.status}; its page: ${page.status}, the cookie ${ends(page) ? "ends" : "stays"}`
  );
}

/** A unit's steps (see the top). `check` gives the report. */
export function celld(of: Unit) {
  unit = of;
  return { deploy: () => deploy(), update: () => deploy(true), check, remove: () => removeOnAws(of) };
}

if (import.meta.main) {
  const step = process.argv[2];
  await useDedicated();
  const run = celld("celld");
  if (step == "deploy") await run.deploy();
  else if (step == "update") await run.update();
  else if (step == "check") {
    const report = await run.check(["chromium"]);
    writeFileSync(resultsFile("celld"), JSON.stringify(report.rows, null, 2));
    process.exit(report.failed ? 1 : 0);
  } else if (step == "remove") await run.remove();
  else {
    console.error("usage: bun dev/verify/celld.ts deploy|update|check|remove");
    process.exit(2);
  }
}
