// The Ops page's operations (control/operations.ts), used as their users use them: the Ops page and an outside agent
// over POST /api/tools/<name> on the app (server/api.ts: erga.dev and staging, the objects over the CONTROL binding)
// and on the control Worker (control/routes.ts), and the admin agent through its tool list. The repository's and the
// pipeline's objects are stand-ins that record what they were asked.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import type { Platform, Session } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { Tokens } from "../server/identity/tokens";
import { serverApi } from "../server/api";
import { respond } from "../server/http";
import { agentTools, toolsFor } from "../agents/tools";
import { CONTROL_OPERATIONS } from "../control/operations";
import { controlRoutes, type Control } from "../control/routes";
import { VIA } from "../shared/attribution";

const ORIGIN = "https://erga.test";
const OPS = "https://ops.erga.test";

/** What the stand-in objects were asked, in order. */
let asked: string[] = [];
beforeEach(() => {
  asked = [];
});

const RELEASES = { edge: { latest: "abc", releases: [] }, stable: { latest: null, releases: [] } };
const deploys = {
  status: async (history?: number) => ({
    targets: [{ name: "staging", state: "deployed", history: Array.from({ length: history ?? 0 }, (_, i) => ({ id: `d${i}` })) }],
    credential: { connected: false, by: null, error: null, problem: "not connected" },
  }),
  logOf: async (target: string, deploy?: string) =>
    target == "staging" && (!deploy || deploy == "d1")
      ? { deployId: "d1", state: "deployed", lines: Array.from({ length: 300 }, (_, i) => ({ at: 0, text: `line ${i}` })) }
      : null,
  redeploy: async (name: string, trigger?: string) => {
    asked.push(`redeploy ${name}: ${trigger}`);
    return name == "staging"
      ? { ok: true, status: { name, state: "queued" } }
      : { ok: false, error: `There's no deploy target called ${name}.`, status: 404 };
  },
  redeployWith: async (name: string, trigger: string, o: { fresh?: boolean }) => {
    asked.push(`redeploy ${name} fresh=${o.fresh}: ${trigger}`);
    return { ok: true, status: { name, state: "queued" } };
  },
  rollback: async () => ({ ok: false, error: "staging has no version to go back to.", status: 409 }),
  releases: async () => RELEASES,
  domains: async () => ({ targets: { staging: [{ hostname: "staging.erga.test", primary: true }] } }),
  addDomain: async (target: string, hostname: string, by: string) => {
    asked.push(`add ${hostname} to ${target}: ${by}`);
    return { targets: { [target]: [{ hostname }] } };
  },
  removeDomain: async (target: string, hostname: string) =>
    hostname == "staging.erga.test" ? { error: "That's staging's own address: it stays.", status: 400 } : { targets: { [target]: [] } },
  credentialStatus: async () => ({ connected: false, by: null, error: null, problem: "not connected" }),
  disconnectCredential: async () => {
    asked.push("disconnect the credential");
  },
};
const github = { connected: true, link: null, state: "idle", lastSyncAt: null, lastSyncBy: null, error: null };
const source = {
  object: {
    branches: async (origin: string) => ({ branches: [{ name: "staging", commit: "s1", commits: [] }], github, conflict: null, origin }),
    githubStatus: async () => github,
    syncGithub: async (origin: string, by: string) => {
      asked.push(`sync from ${origin}: ${by}`);
      return github;
    },
    merge: async (origin: string, who: { login: string; name: string; via?: string }, commit?: string) => {
      asked.push(`merge ${commit ?? "head"} by ${who.login} (${who.name}) via ${who.via}`);
      return { commit: "s1aaaaaaaaaa", fastForward: true, upToDate: false };
    },
    read: async () => ({ ref: "staging", commit: "s1aaaaaaaaaa", text: "README.md  12" }),
  },
};

/** The app's server, with production's directory, its admin ada (and bo, who isn't one), and the control Worker's objects over the binding. */
async function app() {
  const db = new Database(":memory:", { strict: true });
  const migrations = new URL("../server/migrations/", import.meta.url).pathname;
  for (const name of readdirSync(migrations)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(migrations + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => {
      db.query(q).run(...bind(params));
    },
    batch: async (statements) => {
      db.transaction(() => {
        for (const [q, ...params] of statements) db.query(q).run(...bind(params));
      })();
    },
  };
  const dir = new Directory(sql, { admins: ["ada"] });
  await dir.users.add({ login: "ada", admin: true }, "bo");
  const tokens = new Tokens(sql, "secret-".repeat(6), dir);
  const platform = {
    directory: dir,
    tokens,
    sessionOf: (request: Request) => sessionOf(platform, request),
    dev: () => false,
    deploys,
    source,
    control: { url: OPS },
  } as unknown as Platform;
  const admin = (await tokens.mint({ login: "ada", name: "Ada" }, "CI", { scope: "admin" })).token;
  const plain = (await tokens.mint({ login: "ada", name: "Ada" }, "docs", { scope: "documents" })).token;
  const bos = (await tokens.mint({ login: "bo", name: "Bo" }, "bo's", { scope: "documents" })).token;
  /** POST /api/tools/<name>, as an outside agent with `token`. */
  const tool = async (token: string, name: string, args: object = {}) => {
    const r = await respond(
      serverApi,
      new Request(`${ORIGIN}/api/tools/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      }),
      platform
    );
    return { status: r.status, ...((await r.json()) as { ok: boolean; result?: any; error?: string }) };
  };
  return { platform, dir, admin, plain, bos, tool };
}

describe("on the app: POST /api/tools/<name>, as the Ops page and an outside agent call them", () => {
  test("the reads: the branches, the deploys (with the Connect Cloudflare offer), a log, the channels and the domains", async () => {
    const { admin, tool } = await app();
    const branches = await tool(admin, "branches");
    expect(branches).toMatchObject({
      status: 200,
      ok: true,
      result: { origin: ORIGIN, remote: `${OPS}/git/erga.git`, releases: RELEASES },
    });
    const status = await tool(admin, "deploys", { history: 100 });
    expect(status.result.targets[0].history.length).toBe(100);
    expect(status.result.offer).toEqual({ kind: "connect-cloudflare", label: "Connect Cloudflare", url: `${OPS}/install/start?popup=1` });
    // The page asks for the whole log (lines: 0); an agent gets the last 200 unless it asks.
    expect((await tool(admin, "deploys", { view: "log", target: "staging", lines: 0 })).result.lines.length).toBe(300);
    expect((await tool(admin, "deploys", { view: "log", target: "staging" })).result).toMatchObject({ cut: "the last 200 of 300 lines" });
    expect(await tool(admin, "deploys", { view: "log", target: "staging", deploy: "d9" })).toMatchObject({
      status: 404,
      error: "staging has no deploy d9 in its history: deploys lists them.",
    });
    expect(await tool(admin, "deploys", { view: "log" })).toMatchObject({
      status: 400,
      error: "The log needs target: staging or production.",
    });
    expect((await tool(admin, "deploys", { view: "domains" })).result.targets.staging[0].hostname).toBe("staging.erga.test");
  });

  test("the changes: each names the admin and their agent, and a refusal comes back with its status", async () => {
    const { admin, tool } = await app();
    expect((await tool(admin, "redeploy", { target: "staging" })).result).toMatchObject({ ok: true, target: { state: "queued" } });
    await tool(admin, "redeploy", { target: "staging", fresh_data: true });
    expect(await tool(admin, "redeploy", { target: "nowhere" })).toMatchObject({
      status: 404,
      error: "There's no deploy target called nowhere.",
    });
    expect(await tool(admin, "rollback", { target: "staging" })).toMatchObject({
      status: 409,
      error: "staging has no version to go back to.",
    });
    expect((await tool(admin, "github", { action: "sync" })).result).toMatchObject({
      github: { connected: true },
      done: expect.stringContaining("in sync"),
    });
    await tool(admin, "deploy_production", { commit: "s1" });
    await tool(admin, "set_domain", { action: "add", target: "staging", hostname: " Docs.Erga.Test " });
    expect(await tool(admin, "set_domain", { action: "remove", target: "staging", hostname: "staging.erga.test" })).toMatchObject({
      status: 400,
    });
    expect((await tool(admin, "disconnect_deploy_credential")).result).toMatchObject({ ok: true, credential: { connected: false } });
    const by = `ada, via ${VIA.token("CI")}`;
    expect(asked).toEqual([
      `redeploy staging: redeploy by ${by}`,
      `redeploy staging fresh=true: redeploy by ${by}`,
      `redeploy nowhere: redeploy by ${by}`,
      `sync from ${ORIGIN}: ${by}`,
      `merge s1 by ada (Ada) via ${VIA.token("CI")}`,
      `add docs.erga.test to staging: ${by}`,
      "disconnect the credential",
    ]);
  });

  test("admins only, with an admin token; a bad argument says what to fix", async () => {
    const { admin, plain, bos, tool } = await app();
    expect(await tool(bos, "redeploy", { target: "staging" })).toMatchObject({
      status: 403,
      error: "redeploy is for the server's admins only, and bo isn't one.",
    });
    expect(await tool(plain, "deploys")).toMatchObject({ status: 403, error: expect.stringContaining("needs an admin token") });
    expect(await tool(admin, "redeploy", {})).toMatchObject({ status: 400, error: 'redeploy needs "target".' });
    expect(asked).toEqual([]);
  });
});

describe("on the control Worker: the same POST /api/tools/<name>, from its own Ops page", () => {
  const ada = { login: "ada", name: "Ada" } as unknown as Session;
  let who: Session | null = ada;
  const platform = {
    sessionOf: async () => who,
    directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true, get: async () => null } },
    deploys,
    source,
  } as unknown as Platform;
  const c: Control = {
    platform,
    github: null,
    deploys: deploys as never,
    app: ORIGIN,
    version: null,
    layout: (o) => new Response(o.body),
    oauth: { clientId: "", accountId: "", worker: "erga-control", net: fetch },
  };
  const post = (name: string, args: object, origin: string | null = OPS) =>
    controlRoutes(
      new Request(`${OPS}/api/tools/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(args),
      }),
      c
    );

  test("Redeploy and Sync now from the page run as the admin signed in", async () => {
    who = ada;
    const r = await post("redeploy", { target: "staging" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, result: { ok: true, target: { state: "queued" } } });
    expect((await (await post("github", { action: "sync" })).json()) as object).toMatchObject({
      ok: true,
      result: { github: { connected: true } },
    });
    expect(asked).toEqual(["redeploy staging: redeploy by ada", `sync from ${OPS}: ada`]);
    // The branches' Git remote is this Worker's own.
    expect(((await (await post("branches", {})).json()) as { result: { remote: string } }).result.remote).toBe(`${OPS}/git/erga.git`);
  });

  test("never from another site's page, nor without a sign-in; an unknown name lists the operations", async () => {
    who = ada;
    expect((await post("redeploy", { target: "staging" }, "https://evil.test")).status).toBe(403);
    expect((await post("redeploy", { target: "staging" }, null)).status).toBe(403);
    const unknown = await post("nope", {});
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toContain("deploys");
    who = null;
    expect((await post("deploys", {})).status).toBe(401);
    expect(asked).toEqual([]);
  });
});

test("the admin agent has each of them in its tool list, and runs them as its admin, via their agent", async () => {
  const { platform, dir } = await app();
  const caller = { dir, who: { login: "ada", admin: true, via: VIA.agent }, name: "Ada", origin: ORIGIN, platform };
  const tools = await toolsFor(caller);
  for (const op of CONTROL_OPERATIONS) expect(tools.map((t) => t.name)).toContain(op.name);
  const redeploy = agentTools(tools, caller).find((t) => t.name == "redeploy")!;
  const out = await redeploy.execute("x", { target: "staging" } as never);
  expect((out.content[0] as { text: string }).text).toContain("staging redeploys now");
  expect(asked).toEqual([`redeploy staging: redeploy by ada, via ${VIA.agent}`]);
  // An agent with no admin power has none of them.
  const editor = await toolsFor({ ...caller, who: { login: "ada", via: "their agent" } });
  for (const op of CONTROL_OPERATIONS) expect(editor.map((t) => t.name)).not.toContain(op.name);
});
