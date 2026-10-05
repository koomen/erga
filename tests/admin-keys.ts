#!/usr/bin/env bun
// Admin SSH keys end to end (admin-keys.ts, admin-access.ts), on a dev server
// without local development's shortcut (ERGA_ADMIN_UNLOCKED off), so it's
// the real thing, keys made and signatures signed with the real ssh-keygen:
//
//   - locked, every surface that administers, edits or deploys the server
//     refuses an admin, or sends them to unlock: /admin and its POSTs, the
//     admin tools (with an agent token), /source and /api/source, the Git
//     endpoint, /api/deploys and its events, the factory, the homepage's
//     setting and deploy, and editing the homepage itself;
//   - the first key (locally, without GitHub), which unlocks; Lock now;
//     unlocking again with a challenge, once; a replay refused;
//   - Git's credential helper (source/git-credential.ts): an agent token
//     from the device flow once, then admin tokens from the key; git clones
//     and pushes to staging with nobody asked; erase makes it mint again;
//   - an admin token from admin-login.ts: the admin tools and the Git
//     endpoint take it, an agent token doesn't;
//   - revoking the key ends the browser's unlock and the admin token at once;
//   - in headless Chrome: /admin leads to /admin/keys, the challenge's
//     command signs it, pasting it unlocks and comes back to /admin.
//
// Screenshots land in tests/cdp.ts's SHOTS.
//
//   bun tests/admin-keys.ts [--keep]   (--keep: leave the server running, unlocked, with a key)

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { keygen, runCommand } from "./ssh-keys";
import { expect, until } from "./suite/harness";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };
const keep = process.argv.includes("--keep");

const host = await startHost(null, { env: { ERGA_ADMIN_UNLOCKED: "" }, port: keep ? Number(process.env.PORT) || undefined : undefined });
const root = host.root;
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  get(path, { method: "POST", headers: { Origin: root, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const cookieOf = (r: Response) => r.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
let browser: Browser | null = null;

try {
  const laptop = keygen("laptop");

  // ---- locked: everything that administers, edits or deploys the server says so
  await get("/");
  const home = ((await (await get("/tester/landing/api/name")).json()) as { id: string }).id;
  expect((await get("/admin")).headers.get("location") == "/admin/keys?next=%2Fadmin", "/admin sends a locked admin to unlock");
  expect((await get("/source")).headers.get("location") == "/admin/keys?next=%2Fsource", "/source does too");
  expect((await get("/admin/factory")).headers.get("location") == "/admin/keys?next=%2Fadmin%2Ffactory", "the factory's board too");
  const lockedPosts: [string, Response][] = [
    ["POST /admin/settings", await get("/admin/settings", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "delete_docs_after_hours", value: "5" }) })],
    ["POST /admin/users", await get("/admin/users", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ do: "add", login: "mallory", role: "admin" }) })],
    ["GET /api/deploys", await get("/api/deploys")],
    ["GET /api/events", await get("/api/events")],
    ["POST /api/deploys/production", await post("/api/deploys/production", {})],
    ["GET /api/source/branches", await get("/api/source/branches")],
    ["POST /api/source/merge", await post("/api/source/merge", { from: "staging", to: "main" })],
    ["GET /api/factory/tasks", await get("/api/factory/tasks")],
    ["POST /api/docs/<home>/home/deploy", await post(`/api/docs/${home}/home/deploy`, {})],
    ["POST /api/docs/<home>/home", await post(`/api/docs/${home}/home`, { isHome: false })],
  ];
  for (const [what, r] of lockedPosts) {
    const body = await r.json().catch(() => ({})) as { error?: string; locked?: boolean };
    expect(r.status == 403 && body.locked && /locked/.test(body.error ?? ""), `${what}: refused while locked`, { status: r.status, body });
  }
  const homeState = await (await get(`/api/docs/${home}/home`)).json() as { canSet: boolean; locked: boolean };
  expect(homeState.locked && !homeState.canSet, "the homepage's settings say admin access is locked", homeState);
  const viewerHtml = await (await get("/")).text();
  expect(viewerHtml.includes(`/admin/keys?next=${encodeURIComponent("/tester/landing#edit")}`), "the front page's Edit goes by way of unlocking", viewerHtml.slice(-2500));
  const access = await (await get("/tester/landing/api/doc")).json() as { canEdit?: boolean };
  expect(access.canEdit === false, "a locked admin only views the homepage document", access);
  ok("locked: /admin, /source and the factory send an admin to unlock; every admin, source, deploy, factory and homepage call refuses, saying why; the homepage is read-only");

  // An agent token isn't enough: no admin tools, refused if called, and the Git endpoint won't take it.
  const tokensPage = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Admin keys test" }), headers: { Origin: root } })).text();
  const agentToken = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokensPage)?.[1] ?? "";
  expect(agentToken, "an agent token to test with");
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const tools = await (await get("/api/ext/tools", { headers: bearer(agentToken) })).json() as { tools: { name: string }[] };
  expect(!tools.tools.some((t) => t.name == "list_users"), "an admin's agent token isn't offered the admin tools", tools.tools.map((t) => t.name));
  const refused = await post("/api/ext/tools/list_users", {}, bearer(agentToken));
  expect(refused.status == 403 && /admin token/.test((await refused.json() as { error: string }).error), "and calling one is refused, pointing to admin tokens");
  expect((await get("/api/deploys", { headers: bearer(agentToken) })).status == 403, "nor does it reach /api/deploys");
  const basic = (t: string) => ({ Authorization: `Basic ${btoa(`x:${t}`)}` });
  const gitWithAgent = await get("/git/erga.git/info/refs?service=git-upload-pack", { headers: basic(agentToken) });
  expect(gitWithAgent.status == 401 && /admin token/.test(await gitWithAgent.text()), "the Git endpoint refuses an agent token, saying what it needs");
  const guide = await (await get("/api/ext", { headers: bearer(agentToken) })).text();
  expect(guide.includes("admin-login.ts"), "the agent's guide says how to get an admin token");
  ok("an admin's agent token: no admin tools, no deploys, no Git; the guide says how to get an admin token");

  // ---- the first key (locally GitHub isn't asked), which unlocks this browser
  const state0 = await (await get("/api/admin/keys")).json() as { bootstrap: boolean; unlocked: unknown };
  expect(state0.bootstrap && !state0.unlocked, "no keys yet: the next one is the first", state0);
  const badKey = await post("/api/admin/challenge", { purpose: "add-key", publicKey: "not a key" });
  expect(badKey.status == 400, "a public key that isn't one is refused");
  const elsewhere = await get("/api/admin/challenge", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
  expect(elsewhere.status == 403, "another site can't ask for a challenge on an admin's behalf");
  const addC = await (await post("/api/admin/challenge", { purpose: "add-key", publicKey: laptop.pub })).json() as { nonce: string; message: string; command: string };
  expect(addC.command.startsWith("printf %s 'erga-admin add-key host=127.0.0.1:") && addC.command.includes("| ssh-keygen -Y sign -n erga-admin -f ~/.ssh/id_ed25519"), "the challenge comes with the command that signs it", addC.command);
  const added = await post("/api/admin/keys", { publicKey: laptop.pub, name: "Laptop", nonce: addC.nonce, signature: runCommand(addC.command, laptop.path) });
  expect(added.status == 201, "the first key is added", await added.clone().text());
  let unlocked = cookieOf(added);
  expect(/erga_admin=/.test(unlocked) && /SameSite=Strict/.test(added.headers.get("set-cookie") ?? "") && /HttpOnly/.test(added.headers.get("set-cookie") ?? ""), "adding it unlocks this browser (an HttpOnly, SameSite=Strict cookie)", added.headers.get("set-cookie"));
  const withCookie = { Cookie: unlocked };
  expect((await get("/admin", { headers: withCookie })).status == 200, "unlocked, /admin opens");
  const set = await get("/admin/settings", { method: "POST", headers: { Origin: root, ...withCookie }, body: new URLSearchParams({ key: "delete_docs_after_hours", value: "48" }) });
  expect(set.ok, "and a setting saves", await set.clone().text());
  expect((await get("/api/deploys", { headers: withCookie })).status == 200, "and /api/deploys answers");
  expect((await (await get(`/api/docs/${home}/home`, { headers: withCookie })).json() as { canSet: boolean }).canSet, "and the homepage can be set");
  expect((await (await get("/tester/landing/api/doc", { headers: withCookie })).json() as { canEdit: boolean }).canEdit, "and the homepage edited");
  // A cookie copied to another person's session is no good to them.
  expect((await get("/admin", { headers: { Cookie: unlocked }, ...{} })).status == 200 && (await get(`/admin?user=Mallory`, { headers: withCookie })).status == 404, "the unlock is only for the person it was made for");
  ok("the first key: proof of holding it, added, and this browser unlocked: /admin, settings, deploys and the homepage work");

  // ---- Lock now, then unlock with a challenge, once
  const locked = await post("/api/admin/lock", {}, withCookie);
  expect(locked.ok && /erga_admin=;/.test(locked.headers.get("set-cookie") ?? ""), "Lock now clears the cookie");
  expect((await get("/admin")).status == 302, "locked again, /admin sends you to unlock");
  const c = await (await post("/api/admin/challenge", { purpose: "unlock" })).json() as { nonce: string; command: string };
  const signature = runCommand(c.command, laptop.path);
  const unlockR = await post("/api/admin/unlock", { nonce: c.nonce, signature });
  expect(unlockR.ok, "a signed challenge unlocks", await unlockR.clone().text());
  unlocked = cookieOf(unlockR);
  const replay = await post("/api/admin/unlock", { nonce: c.nonce, signature });
  expect(replay.status == 400 && /used already/.test((await replay.json() as { error: string }).error), "the same signature again is refused (one try per challenge)");
  const stranger = keygen("stranger");
  const c2 = await (await post("/api/admin/challenge", { purpose: "unlock" })).json() as { nonce: string; command: string };
  const strangerTry = await post("/api/admin/unlock", { nonce: c2.nonce, signature: runCommand(c2.command, stranger.path) });
  expect(strangerTry.status == 403, "a key that isn't one of yours doesn't unlock");
  ok("Lock now; a signed challenge unlocks; a replay and a stranger's key are refused");

  // ---- an admin token, from admin-login.ts with an agent token and the key
  const cli = Bun.spawn(["bun", join(import.meta.dir, "..", "admin-login.ts"), root, "--key", laptop.path, "--hours", "2"], { env: { ...process.env, ERGA_TOKEN: agentToken }, stdout: "pipe", stderr: "pipe" });
  const adminToken = (await new Response(cli.stdout).text()).trim();
  const cliErr = await new Response(cli.stderr).text();
  expect((await cli.exited) == 0 && adminToken.startsWith("erga_admin_"), "admin-login.ts prints an admin token", cliErr);
  expect(/until/.test(cliErr), "and says until when", cliErr);
  const adminTools = await (await get("/api/ext/tools", { headers: bearer(adminToken) })).json() as { tools: { name: string }[] };
  expect(adminTools.tools.some((t) => t.name == "list_users"), "an admin token is offered the admin tools");
  const listed = await post("/api/ext/tools/list_users", {}, bearer(adminToken));
  expect(listed.ok, "and they work", await listed.clone().text());
  expect((await get("/api/deploys", { headers: bearer(adminToken) })).status == 200, "it reaches /api/deploys");
  const gitWithAdmin = await get("/git/erga.git/info/refs?service=git-upload-pack", { headers: basic(adminToken) });
  expect(gitWithAdmin.status != 401 && gitWithAdmin.status != 403, "the Git endpoint takes it as the password", gitWithAdmin.status);
  const chained = await post("/api/admin/unlock", { nonce: "x", signature: "y" }, bearer(adminToken));
  expect(chained.status == 400, "an admin token can't make another");
  ok("admin-login.ts: an admin token from an agent token and the key; the admin tools, deploys and Git take it");

  // ---- Git's credential helper (source/git-credential.ts): unattended fetches and pushes with the key
  {
    const helper = join(import.meta.dir, "..", "source/git-credential.ts");
    const store = mkdtempSync(join(tmpdir(), "erga-cred-")), notice = join(store, "notice.json"), work = mkdtempSync(join(tmpdir(), "erga-cred-git-"));
    const env: Record<string, string> = { ...process.env as Record<string, string>, ERGA_CREDENTIAL_DIR: store, ERGA_KEY: laptop.path, ERGA_LOGIN_NOTICE: notice, GIT_TERMINAL_PROMPT: "0" };
    delete env.ERGA_TOKEN; delete env.ERGA_CREDENTIAL_CACHED_ONLY;
    const run = async (cmd: string[], extra: Record<string, string> = {}, stdin?: string) => {
      const p = Bun.spawn(cmd, { cwd: work, env: { ...env, ...extra }, stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { ok: code == 0, out: out.trim(), err: err.trim() };
    };
    const ask = `protocol=http\nhost=${new URL(root).host}\npath=git/erga.git\n\n`;
    // Nothing kept yet, and only cached tokens wanted (the queue's background fetch): no answer, and nobody asked.
    const cachedOnly = await run(["bun", helper, "get"], { ERGA_CREDENTIAL_CACHED_ONLY: "1" }, ask);
    expect(cachedOnly.ok && cachedOnly.out == "" && !existsSync(notice), "with nothing kept, a cached-only ask gets no answer and starts no sign-in", cachedOnly);
    // The first time: the device flow. It says where to approve, the person approves, and it carries on by itself.
    const login = run(["bun", helper, "login", root]);
    await until(() => existsSync(notice), 15000, "the helper says where to approve");
    const waiting = JSON.parse(readFileSync(notice, "utf8")) as { approve_url: string; user_code: string };
    expect(waiting.approve_url.startsWith(`${root}/tokens/approve?code=`) && waiting.user_code, "the notice has the link to approve and its code", waiting);
    const approve = await get("/tokens/approve", { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ code: new URL(waiting.approve_url).searchParams.get("code")! }) });
    expect(approve.ok, "the person approves it", approve.status);
    const loggedIn = await login;
    expect(loggedIn.ok && /Ready/.test(loggedIn.out) && !existsSync(notice), "the helper takes the agent token, makes an admin token with the key, and the notice goes", loggedIn);
    const status = JSON.parse((await run(["bun", helper, "status", root])).out) as { agentToken: boolean; adminTokenUsable: boolean };
    expect(status.agentToken && status.adminTokenUsable, "it keeps both (status never shows them)", status);
    const kept = readdirSync(store).map((f) => readFileSync(join(store, f), "utf8"));
    expect(kept.some((v) => v.startsWith("erga_") && !v.startsWith("erga_admin_")) && kept.some((v) => / erga_admin_/.test(v)), "the agent token, and the admin token with when it ends", kept.length);
    // git with the helper: clone, push to staging; Erga's own lines come back.
    const cfg = ["-c", `credential.${root}.helper=`, "-c", `credential.${root}.helper=!bun ${helper}`];
    const clone = await run(["git", ...cfg, "clone", "-q", `${root}/git/erga.git`, "c"]);
    expect(clone.ok, "git clones through the helper, with nobody asked", clone);
    const c = join(work, "c");
    await run(["bash", "-c", `cd ${c} && git config user.email t@t && git config user.name t && git checkout -q -B mine && echo hi > helper.txt && git add . && git commit -qm "Pushed with the helper"`]);
    const push = await run(["bash", "-c", `cd ${c} && git ${cfg.map((a) => `'${a}'`).join(" ")} push origin HEAD:staging`]);
    expect(push.ok && /Erga: staging is now/.test(push.err), "and pushes to staging", push);
    // A 401 makes git erase the token: the next ask makes a new one, with the kept agent token (no approval).
    const before = (await run(["bun", helper, "get"], {}, ask)).out;
    await run(["bun", helper, "erase"], {}, `${ask.trim()}\nusername=admin\n${before.split("\n")[1]}\n\n`);
    const after = await run(["bun", helper, "get"], {}, ask);
    expect(after.out.startsWith("username=admin\npassword=erga_admin_") && after.out != before && !existsSync(notice), "after git erases it, the next ask makes a new admin token without a new approval", after);
    rmSync(store, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
    ok("source/git-credential.ts: a device-flow agent token once, then admin tokens from the key; git clones and pushes to staging with nobody asked");
  }

  // ---- revoking the key ends every unlock made with it
  const keysNow = await (await get("/api/admin/keys", { headers: { Cookie: unlocked } })).json() as { keys: { id: string; name: string }[]; log: { action: string }[] };
  expect(keysNow.log.some((e) => e.action == "key-added") && keysNow.log.some((e) => e.action == "unlock-failed") && keysNow.log.some((e) => e.action == "token"), "the log has the key, the failed try and the admin token", keysNow.log);
  const id = keysNow.keys.find((k) => k.name == "Laptop")!.id;
  const revoked = await post(`/api/admin/keys/${id}/revoke`, {}, { Cookie: unlocked });
  expect(revoked.ok, "the key is revoked");
  expect((await get("/admin", { headers: { Cookie: unlocked } })).status == 302, "the browser's unlock ended with it");
  expect((await get("/api/deploys", { headers: bearer(adminToken) })).status == 401, "and so did the admin token");
  expect((await (await get("/api/admin/keys")).json() as { bootstrap: boolean }).bootstrap, "with no key left, the next is a first key again");
  ok("revoking the key ends the browser's unlock and the admin token at once");

  // ---- in a browser: /admin leads to unlocking, the page's command signs it, and back to /admin
  const second = keygen("second");
  const addC2 = await (await post("/api/admin/challenge", { purpose: "add-key", publicKey: second.pub })).json() as { nonce: string; command: string };
  const add2 = await post("/api/admin/keys", { publicKey: second.pub, name: "MacBook", nonce: addC2.nonce, signature: runCommand(addC2.command, second.path) });
  expect(add2.status == 201, "a new first key");
  browser = await Browser.launch();
  const p = await browser.page();
  await p.open(`${root}/admin`, { width: 1100, height: 900, scale: 2 });
  await until(async () => (await p.eval<string>("location.pathname")) == "/admin/keys" && /erga-admin unlock/.test(await p.eval<string>(`document.getElementById("unlock-cmd")?.textContent ?? ""`)), 10_000, "the unlock page with its challenge");
  await p.screenshot(join(SHOTS, "admin-keys-locked.png"));
  const command = await p.eval<string>(`document.getElementById("unlock-cmd").textContent`);
  const sig = runCommand(command, second.path);
  await p.eval(`(() => { const t = document.getElementById("unlock-sig"); t.value = ${JSON.stringify(sig)}; t.dispatchEvent(new Event("input")); document.getElementById("unlock-go").click(); return true; })()`);
  await until(async () => (await p.eval<string>("location.pathname")) == "/admin", 10_000, "back on /admin, unlocked", () => p.eval(`document.getElementById("unlock-hint")?.textContent`));
  await p.navigate(`${root}/admin/keys`);
  await until(async () => (await p.eval<string>(`document.querySelector(".lockstate")?.textContent ?? ""`)).includes("unlocked"), 5000, "the keys page says unlocked");
  await p.screenshot(join(SHOTS, "admin-keys-unlocked.png"));
  await p.open(`${root}/admin/keys`, { width: 390, height: 800, scale: 2, dark: true, clear: false });
  await p.screenshot(join(SHOTS, "admin-keys-phone-dark.png"));
  const overflow = await p.eval<boolean>("document.documentElement.scrollWidth > innerWidth + 1");
  expect(!overflow, "no sideways scroll on a phone");
  ok("in a browser: /admin leads to /admin/keys; its command signs the challenge; pasting it unlocks and comes back to /admin");
} finally {
  browser?.close();
  if (keep) console.log(`\nkept: ${root}/admin/keys (state ${host.state})`);
  else await host.dispose();
}
console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);
if (keep) await new Promise(() => {});
