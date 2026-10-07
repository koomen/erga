// The API keys admins enter on /admin/api-keys (credentials.ts, admin.ts), on an
// in-memory SQLite database with the same migrations D1 gets: stored
// encrypted, never answered back (only set, the last four characters, and who
// set it when), in the change log without the value, admins only, and read by
// the code that calls the providers before the Worker secret of the same name.
// Headless Chrome sets, replaces and clears one on the real page.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, expect, test } from "bun:test";
import { join } from "path";
import { adminDoor } from "../admin.ts";
import { checkKey, CredentialError, Credentials, withCredentials } from "../credentials.ts";
import { Directory, type Param, type Sql } from "../directory.ts";
import type { Platform, Session } from "../front.ts";
import { NotAllowed } from "../users.ts";
import { Browser, SHOTS } from "./cdp";
import { until } from "./suite/harness";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;
const ANTHROPIC = "sk-ant-api03-" + "x".repeat(80) + "Ab12";
const OPENAI = "sk-proj-" + "y".repeat(60) + "Zz90";
const GITHUB = "github_pat_" + "g".repeat(70) + "Gh12";
const CLOUDFLARE = "c".repeat(36) + "Cf34";

function fresh(secret: string | null = "the factory key", fallback: string[] = []) {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  const dir = new Directory(sql, { admins: ["ada"], credentialSecret: secret, fallback: (env) => fallback.includes(env) });
  return { db, sql, dir };
}
const ada = { login: "ada", admin: true };

test("a key is stored encrypted: the table and the change log never hold it; the list shows only its last four characters", async () => {
  const { db, dir } = fresh();
  const set = await dir.credentials.set(ada, "anthropic", `  ${ANTHROPIC}\n`);
  expect(set).toMatchObject({ name: "anthropic", env: "ANTHROPIC_API_KEY", set: true, last4: "Ab12", updatedBy: "ada", canStore: true });
  expect(JSON.stringify(await dir.credentials.list(ada))).not.toContain("xxxxxxxx");
  const everything = JSON.stringify([db.query("SELECT * FROM credentials").all(), db.query("SELECT * FROM server_config_versions").all()]);
  expect(everything).not.toContain(ANTHROPIC.slice(0, 20));
  expect(everything).not.toContain(btoa(ANTHROPIC).slice(0, 20));
  expect(await dir.credentials.value("anthropic")).toBe(ANTHROPIC);

  await dir.credentials.set(ada, "anthropic", ANTHROPIC.replace("Ab12", "Cd34"));
  expect(await dir.credentials.value("anthropic")).toBe(ANTHROPIC.replace("Ab12", "Cd34"));
  const cleared = await dir.credentials.clear(ada, "anthropic");
  expect(cleared).toMatchObject({ set: false, last4: null, updated: null });
  expect(await dir.credentials.value("anthropic")).toBeNull();
  // The change log: what happened to the key, by whom, never the key.
  const { versions } = await dir.config.history(ada);
  expect(versions.map((v) => [v.by, v.changes])).toEqual([
    ["ada", [{ key: "ANTHROPIC_API_KEY", from: null, to: null, credential: "cleared" }]],
    ["ada", [{ key: "ANTHROPIC_API_KEY", from: null, to: null, credential: "replaced" }]],
    ["ada", [{ key: "ANTHROPIC_API_KEY", from: null, to: null, credential: "set" }]],
  ]);
});

test("a fresh IV each time; another secret (staging, with a copy of production's database) can't open it", async () => {
  const { db, sql, dir } = fresh();
  await dir.credentials.set(ada, "openai", OPENAI);
  const first = db.query("SELECT iv, data FROM credentials").get() as { iv: string; data: string };
  await dir.credentials.set(ada, "openai", OPENAI);
  const second = db.query("SELECT iv, data FROM credentials").get() as { iv: string; data: string };
  expect(second.iv).not.toBe(first.iv);
  expect(second.data).not.toBe(first.data);
  const elsewhere = new Credentials(sql, dir.users, "another key");
  expect(await elsewhere.value("openai")).toBeNull();
  // A row moved to another name doesn't open either: the name is bound into the ciphertext.
  db.query("UPDATE credentials SET name = 'anthropic' WHERE name = 'openai'").run();
  expect(await dir.credentials.value("anthropic")).toBeNull();
});

test("admins only, with admin power; a key that isn't one, or a server with no secret, is refused saying why", async () => {
  const { dir } = fresh();
  await expect(dir.credentials.set({ login: "mallory" }, "anthropic", ANTHROPIC)).rejects.toThrow(NotAllowed);
  await expect(dir.credentials.list({ login: "ada" })).rejects.toThrow(/no admin power/);
  await expect(dir.credentials.set(ada, "gemini", ANTHROPIC)).rejects.toThrow(/no key "gemini"/);
  expect(() => checkKey("anthropic", "sk-ant-oat01-" + "z".repeat(40))).toThrow(/Claude plan token/);
  expect(() => checkKey("anthropic", OPENAI)).toThrow(/starts with sk-ant-/);
  expect(() => checkKey("openai", "sk-has a space in it xxxxxxxxxxxx")).toThrow(CredentialError);
  expect(() => checkKey("openai", "")).toThrow(/Paste/);
  const none = fresh(null, ["ANTHROPIC_API_KEY"]).dir;
  await expect(none.credentials.set(ada, "anthropic", ANTHROPIC)).rejects.toThrow(/no FACTORY_KEY/);
  expect((await none.credentials.list(ada)).map((c) => [c.name, c.canStore, c.fallback])).toEqual([["anthropic", false, true], ["openai", false, false], ["github_mirror", false, false], ["cloudflare_deploy", false, false]]);
});

test("every key Erga calls a service with: the GitHub mirror's and Cloudflare's too; the deploy's own secrets only as set or not", async () => {
  const { dir } = fresh("the factory key", ["SESSION_SECRET", "GITHUB_CLIENT_SECRET"]);
  expect(() => checkKey("github_mirror", "gho_" + "q".repeat(36))).toThrow(/starts with github_pat_ or ghp_/);
  expect(checkKey("github_mirror", " " + GITHUB + " ")).toBe(GITHUB);
  expect(checkKey("cloudflare_deploy", CLOUDFLARE)).toBe(CLOUDFLARE);
  expect(() => checkKey("cloudflare_deploy", "short")).toThrow(/20 to 400 characters/);
  await dir.credentials.set(ada, "github_mirror", GITHUB);
  await dir.credentials.set(ada, "cloudflare_deploy", CLOUDFLARE);
  const env = { GITHUB_MIRROR_TOKEN: "github_pat_from_the_deploy", CLOUDFLARE_DEPLOY_TOKEN: "from-the-deploy" };
  expect(await withCredentials(env, dir.credentials)).toEqual({ GITHUB_MIRROR_TOKEN: GITHUB, CLOUDFLARE_DEPLOY_TOKEN: CLOUDFLARE });
  const deployed = await dir.credentials.deployed(ada);
  expect(deployed.map((d) => [d.env, d.set])).toEqual([["SESSION_SECRET", true], ["FACTORY_KEY", false], ["GITHUB_CLIENT_SECRET", true], ["SNAPSHOT_TOKEN", false], ["DEPLOY_HOOK_SECRET", false]]);
  expect(deployed.find((d) => d.env == "FACTORY_KEY")!.standIn).toBe(true);
  await expect(dir.credentials.deployed({ login: "mallory" })).rejects.toThrow(NotAllowed);
});

test("the code that calls the providers reads the stored key first, else the Worker secret", async () => {
  const { dir } = fresh();
  const env = { ANTHROPIC_API_KEY: "sk-ant-from-the-deploy", OPENAI_API_KEY: "sk-openai-from-the-deploy", OTHER: 1 };
  expect(await withCredentials(env, dir.credentials)).toEqual(env);
  await dir.credentials.set(ada, "anthropic", ANTHROPIC);
  expect(await withCredentials(env, dir.credentials)).toEqual({ ...env, ANTHROPIC_API_KEY: ANTHROPIC });
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-from-the-deploy");
  // A database that doesn't answer leaves the Worker secret.
  const broken = new Credentials({ all: async () => { throw new Error("D1 is down"); }, run: async () => {}, batch: async () => {} }, dir.users, "the factory key");
  expect(await withCredentials(env, broken)).toEqual(env);
});

// The real page, on the real directory: the section, the browser's Set, Replace and Clear.
const { dir } = fresh("the factory key", ["ANTHROPIC_API_KEY"]);
const session = { login: "ada", name: "Ada", admin: true } as unknown as Session;
const platform = { sessionOf: async () => session, directory: dir } as unknown as Platform;
let claude: { signedIn: boolean; at: string | null; by: string | null; canStore: boolean; token?: string } = { signedIn: false, at: null, by: null, canStore: true };
const server = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    if (path == "/admin" || path.startsWith("/admin/")) return adminDoor(platform, r);
    if (path == "/api/factory/claude") {
      if (r.method == "PUT") claude = { signedIn: true, at: "2026-10-06T12:00:00.000Z", by: "ada", canStore: true, token: String((await r.json()).token) };
      if (r.method == "DELETE") claude = { signedIn: false, at: null, by: null, canStore: true };
      const { token: _, ...shown } = claude as typeof claude & { token?: string };
      return Response.json(shown);
    }
    const file = Bun.file(join(import.meta.dir, "..", path));
    return (path == "/style.css" || path.startsWith("/fonts/")) && !path.includes("..") && (await file.exists()) ? new Response(file) : new Response("", { status: 404 });
  },
});
const origin = `http://localhost:${server.port}`;
const browser = await Browser.launch();
afterAll(() => { browser.close(); server.stop(true); });

test("POST /admin/credentials: only from this site's pages; the answer never holds the key", async () => {
  const post = (fields: Record<string, string>, from = origin) => fetch(`${origin}/admin/credentials`, { method: "POST", body: new URLSearchParams(fields), headers: { Origin: from } });
  expect((await post({ name: "openai", value: OPENAI }, "https://evil.example")).status).toBe(403);
  const r = await post({ name: "openai", value: OPENAI });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain(OPENAI.slice(0, 20));
  expect(JSON.parse(text).credential).toMatchObject({ name: "openai", set: true, last4: "Zz90" });
  expect((await post({ name: "openai", value: "nope" })).status).toBe(400);
  const html = await (await fetch(`${origin}/admin/api-keys`)).text();
  expect(html).not.toContain(OPENAI.slice(0, 20));
  expect(html).toContain(`ends in <span class="last4">…Zz90</span>`);
  expect(html).toContain("Not set here. The server uses ANTHROPIC_API_KEY from the deploy.");
  const log = await (await fetch(`${origin}/admin/changes`)).text();
  expect(log).toContain(`<span class="key">OPENAI_API_KEY</span> key set`);
  expect(log).not.toContain(OPENAI.slice(0, 20));
  expect((await fetch(`${origin}/admin/credentials`, { redirect: "manual" })).headers.get("location")).toBe("/admin/api-keys");
  // The keys have their own page now: Settings has none of them; every key and deploy secret is on API keys.
  expect(await (await fetch(`${origin}/admin`)).text()).not.toContain("li class=\"setting credential");
  for (const name of ["anthropic", "openai", "claude", "github_mirror", "cloudflare_deploy"]) expect(html).toContain(`data-name="${name}"`);
  for (const env of ["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET", "SNAPSHOT_TOKEN", "DEPLOY_HOOK_SECRET"]) expect(html).toContain(`data-env="${env}"`);
  expect(html).toContain(`href="/admin/api-keys" aria-current="page"`);
});

test("in the browser: paste a key and Save, then Clear it", async () => {
  const p = await browser.page(await browser.context());
  await p.open(`${origin}/admin/api-keys`, { width: 1100, height: 1400 });
  await p.settle();
  const row = (expr: string) => p.eval<any>(`(() => { const li = document.querySelector('li.credential[data-name="anthropic"]'); return ${expr}; })()`);
  expect(await row(`li.querySelector(".save").disabled`)).toBe(true);
  expect(await row(`li.querySelector("input").type`)).toBe("password");
  await row(`(() => { const input = li.querySelector("input"); input.value = ${JSON.stringify(ANTHROPIC)}; input.dispatchEvent(new Event("input")); li.querySelector(".save").click(); })()`);
  await until(async () => (await dir.credentials.value("anthropic")) == ANTHROPIC, 5000, "the key is saved");
  await until(async () => (await p.eval<string>(`document.querySelector('li.credential[data-name="anthropic"] .state-line')?.textContent ?? ""`)).includes("…Ab12"), 5000, "the page shows it");
  expect(await row(`li.querySelector("input").value`)).toBe("");
  expect(await p.eval<string>("document.documentElement.outerHTML")).not.toContain(ANTHROPIC.slice(0, 20));
  expect(await row(`li.querySelector(".save").textContent`)).toBe("Replace");
  // The Claude plan token, through the factory's API.
  const claudeRow = (expr: string) => p.eval<any>(`(() => { const li = document.querySelector('li.credential[data-name="claude"]'); return ${expr}; })()`);
  await until(async () => (await claudeRow(`li.querySelector(".state-line").textContent`)).startsWith("Not set"), 5000, "the Claude row asks the factory");
  expect(await claudeRow(`getComputedStyle(li.querySelector(".clear")).display`)).toBe("none");
  const OAT = "sk-ant-oat01-" + "o".repeat(60);
  await claudeRow(`(() => { const input = li.querySelector("input"); input.value = ${JSON.stringify(OAT)}; input.dispatchEvent(new Event("input")); li.querySelector(".save").click(); })()`);
  await until(async () => claude.token == OAT, 5000, "the Claude token goes to the factory");
  await until(async () => (await claudeRow(`li.querySelector(".state-line").textContent`)).includes("by ada"), 5000, "the page shows it set");
  expect(await claudeRow(`getComputedStyle(li.querySelector(".clear")).display`)).not.toBe("none");
  await p.screenshot(join(SHOTS, "admin-credentials.png"));
  await p.eval(`window.confirm = () => true`);
  await row(`li.querySelector(".clear").click()`);
  await until(async () => (await dir.credentials.value("anthropic")) == null, 5000, "the key is cleared");
  expect(p.errors).toEqual([]);
}, 30_000);
