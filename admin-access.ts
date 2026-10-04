// Unlocking admin access with an SSH key, and the keys themselves (the
// model is admin-keys.ts; README, Admin SSH keys). For admins only: anyone
// else gets "not found".
//
//   /admin/keys                          the page: unlock (or lock), your keys, add one, revoke;
//                                        with ?next=<path>, back there once unlocked
//   GET  /api/admin/keys                 { login, unlocked, keys, bootstrap, everyone?, log? }
//   POST /api/admin/challenge            { purpose: "unlock" } or { purpose: "add-key", publicKey }
//                                        → { nonce, message, command, expires }: the text to sign, once, within five minutes
//   POST /api/admin/unlock               { nonce, signature }: in a browser, sets the erga_admin cookie (an hour);
//                                        with an agent token, answers an admin token { token, until } (ttl: seconds, at most 12 hours)
//   POST /api/admin/lock                 locks admin access in this browser again
//   POST /api/admin/keys                 { publicKey, name?, nonce, signature }: adds a key (in a browser only), and unlocks
//   POST /api/admin/keys/<id>/revoke     revokes a key: yours or another admin's (unlocked only)
//
// A POST from a browser must come from this site's own pages (its Origin);
// one with a token is its own proof.

import { CHALLENGE_MS, KeyError, NAMESPACE, TOKEN_MAX_MS, UNLOCK_MS, type AdminKey, type AdminKeys, type LogEntry, type Unlock } from "./admin-keys.ts";
import { appPage, brand, esc, fromElsewhere, ICON, link, page, safeNext, type Platform, type Session, TIMES_SCRIPT, whoOf } from "./front.ts";

/** What the Worker hands in: the erga_admin cookie (worker/auth.ts), and whether this is local development (GitHub isn't asked about a first key). */
export interface AccessHooks {
  unlockCookie(login: string, unlock: Unlock): Promise<string>;
  lockCookie(): string;
  local: boolean;
}

export const isAdminAccessPath = (path: string) => path == "/admin/keys" || path.startsWith("/api/admin/");

/** An admin who hasn't unlocked admin access: off to unlock it, then back to `path`. */
export function unlockFirst(path: string, session: Session): Response {
  return new Response(null, { status: 302, headers: { Location: link(`/admin/keys?next=${encodeURIComponent(path)}`, session), "Cache-Control": "no-store" } });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const notFound = () => page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);

/** A key as the API shows it: never more than its public half. */
const shownKey = (k: AdminKey) => ({
  id: k.id, login: k.login, name: k.name, type: k.type, fingerprint: k.fingerprint, publicKey: k.publicKey, addedHow: k.addedHow,
  created: new Date(k.created).toISOString(), lastUsed: k.lastUsed ? new Date(k.lastUsed).toISOString() : null,
  revoked: k.revoked ? new Date(k.revoked).toISOString() : null, revokedBy: k.revokedBy,
});

/** The command that signs `message`: the key's path is the person's to fill in (the page keeps the one they use). */
export const signCommand = (message: string, keyPath = "~/.ssh/id_ed25519") => `printf %s '${message}' | ssh-keygen -Y sign -n ${NAMESPACE} -f ${keyPath}`;

/** /admin/keys and /api/admin/... */
export async function adminAccess(request: Request, platform: Platform, hooks: AccessHooks): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/", method = request.method;
  const keys = platform.adminKeys;
  if (!keys) return json({ error: "Admin keys aren't set up on this server." }, 503);
  const session = await platform.sessionOf(request);
  if (!session) {
    if (path == "/admin/keys" && method == "GET") return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}` } });
    return json({ error: "Sign in first, or send an agent token as \"Authorization: Bearer <token>\"." }, 401);
  }
  const users = platform.directory.users, who = whoOf(session), login = session.login.toLowerCase();
  const admin = !session.test && (await users.isAdmin(who));
  if (!admin) return path == "/admin/keys" ? notFound() : json({ error: "Only the server's admins have admin keys." }, 403);
  const unlocked = (await users.isUnlocked(who)) ? session.unlocked! : null;
  // A browser is the person themselves; a token is an agent's (an admin token's included).
  const browser = !session.agent;
  if (method == "POST" && browser && (fromElsewhere(request) || request.headers.get("origin") != url.origin)) return json({ error: "Not from this site." }, 403);

  try {
    if (path == "/admin/keys" && method == "GET") {
      if (!browser) return notFound();
      return keysPage(session, url, await state(keys, login, unlocked), safeNext(url.searchParams.get("next")));
    }
    if (path == "/api/admin/keys" && method == "GET") return json(await state(keys, login, unlocked));

    if (path == "/api/admin/challenge" && method == "POST") {
      const body = await bodyOf(request);
      const purpose = body.purpose == "add-key" ? "add-key" : body.purpose == "unlock" || body.purpose == null ? "unlock" : null;
      if (!purpose) return json({ error: 'purpose: "unlock" or "add-key".' }, 400);
      if (purpose == "add-key" && !browser) return json({ error: "Keys are added by the admin themselves, signed in, on /admin/keys." }, 403);
      const c = await keys.challenge(login, url.host, purpose, String(body.publicKey ?? ""));
      return json({ ...c, expires: new Date(c.expires).toISOString(), command: signCommand(c.message), namespace: NAMESPACE });
    }

    if (path == "/api/admin/unlock" && method == "POST") {
      const body = await bodyOf(request);
      if (!browser && session.unlocked && session.agent?.id.startsWith("admin-")) return json({ error: "That's an admin token already: unlock with an agent token to make another." }, 400);
      const ttl = browser ? UNLOCK_MS : Math.min(TOKEN_MAX_MS, Math.max(60, Number(body.ttl) || UNLOCK_MS / 1000) * 1000);
      const { key, unlock } = await keys.unlock(login, String(body.nonce ?? ""), String(body.signature ?? ""), ttl);
      const until = new Date(unlock.until).toISOString();
      if (browser) {
        await keys.log(login, "unlocked", `in a browser with ${key.name} (${key.fingerprint}) until ${until}`);
        return json({ unlocked: { until, key: shownKey(key) } }, 200, { "Set-Cookie": await hooks.unlockCookie(login, unlock) });
      }
      return json({ token: await keys.token(login, session.name, unlock), until, key: shownKey(key) });
    }

    if (path == "/api/admin/lock" && method == "POST") {
      if (!browser) return json({ error: "An admin token locks itself when it ends; revoke its key to end it sooner." }, 400);
      if (unlocked) await keys.log(login, "locked", "in a browser");
      return json({ unlocked: null }, 200, { "Set-Cookie": hooks.lockCookie() });
    }

    if (path == "/api/admin/keys" && method == "POST") {
      if (!browser) return json({ error: "Keys are added by the admin themselves, signed in, on /admin/keys." }, 403);
      const body = await bodyOf(request);
      const key = await keys.add(login, {
        nonce: String(body.nonce ?? ""), signature: String(body.signature ?? ""), publicKey: String(body.publicKey ?? ""),
        name: body.name == null ? undefined : String(body.name), unlocked, local: hooks.local,
      });
      // Signing for the key proved holding it, as an unlock's signature does: the browser is unlocked with it (unless it already is).
      if (unlocked) return json({ key: shownKey(key) }, 201);
      const unlock: Unlock = { key: key.id, until: Date.now() + UNLOCK_MS };
      await keys.log(login, "unlocked", `in a browser with ${key.name} (${key.fingerprint}), just added, until ${new Date(unlock.until).toISOString()}`);
      return json({ key: shownKey(key), unlocked: { until: new Date(unlock.until).toISOString(), key: shownKey(key) } }, 201, { "Set-Cookie": await hooks.unlockCookie(login, unlock) });
    }

    const [, revokeId] = /^\/api\/admin\/keys\/([\w-]+)\/revoke$/.exec(path) ?? [];
    if (revokeId && method == "POST") {
      if (!unlocked) return json({ error: "Unlock admin access first: revoking a key needs it (another admin can revoke yours if you lost them)." , locked: true }, 403);
      const key = await keys.revoke(login, revokeId);
      // Revoking the key this browser unlocked with locks it.
      const locks = browser && unlocked.key == revokeId;
      return json({ key: shownKey(key), ...(locks ? { unlocked: null } : {}) }, 200, locks ? { "Set-Cookie": hooks.lockCookie() } : {});
    }
  } catch (e) {
    if (e instanceof KeyError) return json({ error: e.message }, e.status);
    throw e;
  }
  return json({ error: `There's nothing at ${method} ${path}.` }, 404);
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = await request.json().catch(() => null);
    return b && typeof b == "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
  }
  const form = await request.formData().catch(() => null);
  return form ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])) : {};
}

interface State {
  login: string;
  unlocked: { until: string; key: ReturnType<typeof shownKey> | { id: "local"; name: string } } | null;
  keys: ReturnType<typeof shownKey>[];
  /** No key that works: the next one must be on GitHub (github.com/<login>.keys). */
  bootstrap: boolean;
  /** Unlocked only: every admin's keys that work, and the log. */
  everyone?: ReturnType<typeof shownKey>[];
  log?: { at: string; login: string; action: string; detail: string }[];
}

async function state(keys: AdminKeys, login: string, unlocked: Unlock | null): Promise<State> {
  const mine = await keys.list(login);
  const live = mine.filter((k) => !k.revoked);
  const key = unlocked && (unlocked.key == "local" ? { id: "local" as const, name: "local development (ERGA_ADMIN_UNLOCKED)" } : mine.find((k) => k.id == unlocked.key));
  return {
    login,
    unlocked: unlocked && key ? { until: new Date(unlocked.until).toISOString(), key: "fingerprint" in key ? shownKey(key) : key } : null,
    keys: mine.map(shownKey),
    bootstrap: live.length == 0,
    ...(unlocked ? {
      everyone: (await keys.list()).filter((k) => !k.revoked && k.login != login).map(shownKey),
      log: (await keys.history(40)).map((e: LogEntry) => ({ ...e, at: new Date(e.at).toISOString() })),
    } : {}),
  };
}

// ---------------------------------------------------------------- the page

const HOW: Record<string, string> = { github: "first key, from GitHub", unlocked: "added while unlocked", local: "local development" };

function keyRow(k: ReturnType<typeof shownKey>, opts: { mine: boolean; canRevoke: boolean; using: boolean }): string {
  const added = `<time datetime="${esc(k.created)}">${esc(k.created.slice(0, 10))}</time>`;
  const used = k.lastUsed ? `last used <time datetime="${esc(k.lastUsed)}">${esc(k.lastUsed.slice(0, 10))}</time>` : "never used";
  return `      <li class="key${k.revoked ? " revoked" : ""}" data-id="${esc(k.id)}">
        <div class="what">
          <div class="line"><span class="title">${esc(k.name)}</span>${opts.mine ? "" : `<span class="badge">${esc(k.login)}</span>`}${opts.using ? `<span class="badge strong">unlocked with</span>` : ""}${k.revoked ? `<span class="badge">revoked${k.revokedBy ? ` by ${esc(k.revokedBy)}` : ""}</span>` : ""}</div>
          <div class="fp mono" title="${esc(k.publicKey)}">${esc(k.type)} ${esc(k.fingerprint)}</div>
          <div class="meta">Added ${added} (${esc(HOW[k.addedHow] ?? k.addedHow)}) · ${k.revoked ? `revoked <time datetime="${esc(k.revoked)}">${esc(k.revoked.slice(0, 10))}</time>` : used}</div>
        </div>
        ${!k.revoked && opts.canRevoke ? `<button type="button" class="act revoke" aria-label="Revoke ${esc(k.name)}" title="Revoke: it stops working at once, and so does every unlock made with it">${ICON.delete}</button>` : ""}
      </li>`;
}

function keysPage(session: Session, url: URL, s: State, next: string | null): Response {
  const back = next && next != "/" && next != "/admin/keys" ? next : null;
  const live = s.keys.filter((k) => !k.revoked), revoked = s.keys.filter((k) => k.revoked);
  const usingId = s.unlocked?.key.id;
  const status = s.unlocked
    ? `<div class="status on" role="status"><div><b>Admin access is unlocked</b> until <span data-time="${esc(s.unlocked.until)}">${esc(s.unlocked.until.slice(11, 16))} UTC</span>, with ${esc(s.unlocked.key.name)}.${back ? ` <a href="${esc(back)}" class="go">Continue to ${esc(back.split("#")[0])}</a>` : ""}</div><button type="button" class="pill" id="lock">Lock now</button></div>`
    : `<div class="status" role="status"><div><b>Admin access is locked.</b> ${s.bootstrap ? "Add your first admin SSH key below: it must be one of your keys on GitHub." : "Sign a challenge with one of your admin SSH keys to unlock it for an hour."}</div></div>`;
  const style = `
  main { max-width: 760px; }
  section { margin-bottom: 40px; }
  h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
  h2 small { font-size: 13px; font-weight: 400; color: var(--soft); }
  .lede { margin: 0 0 14px; font-size: 13.5px; color: var(--soft); }
  .lede code, .meta code { font-family: var(--font-mono); font-size: 12.5px; }
  .back { font-size: 13px; color: var(--chrome); text-decoration: none; }
  .back:hover { color: var(--chrome-hover); }
  .mono { font-family: var(--font-mono); font-size: 12.5px; }
  .status { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 36px; padding: 14px 16px; border: 1px solid var(--rule); border-radius: 10px; font-size: 14px; color: var(--fg); background: color-mix(in srgb, #c2410c 7%, var(--bg)); }
  .status.on { background: color-mix(in srgb, #15803d 9%, var(--bg)); }
  .status .go { margin-left: 4px; }
  .step { margin: 0 0 14px; }
  .step > label { display: block; margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--fg-strong); }
  .step > label small { font-weight: 400; color: var(--soft); }
  .cmd { display: flex; gap: 8px; align-items: stretch; }
  .cmd pre { flex: 1; min-width: 0; margin: 0; padding: 9px 12px; border: 1px solid var(--rule); border-radius: 8px; background: color-mix(in srgb, var(--chrome) 6%, transparent); color: var(--fg-strong); font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
  .keypath { display: flex; gap: 8px; align-items: center; margin: 0 0 8px; font-size: 13px; color: var(--soft); }
  .keypath .input { flex: 1; max-width: 22em; font-family: var(--font-mono); font-size: 12.5px; height: 30px; }
  textarea.input { width: 100%; height: auto; min-height: 7.5em; padding: 8px 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.45; resize: vertical; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row .input { flex: 1; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .actions .hint { margin: 0; }
  ol.rows > li.key { align-items: flex-start; padding: 10px 2px; gap: 10px; }
  li.key .what { flex: 1; min-width: 0; }
  li.key .line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
  li.key .title { font-weight: 600; color: var(--fg-strong); }
  li.key .fp { margin-top: 2px; color: var(--soft); overflow-wrap: anywhere; }
  li.key .meta { margin-top: 2px; font-size: 12.5px; color: var(--soft); }
  li.key .meta time { margin: 0; font-size: inherit; }
  li.key.revoked .title, li.key.revoked .fp { color: var(--chrome); text-decoration: line-through; }
  li.key .act { opacity: 1; }
  ol.log { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  ol.log li { display: flex; gap: 10px; padding: 6px 2px; border-bottom: 1px solid var(--rule); color: var(--soft); }
  ol.log li b { color: var(--fg-strong); font-weight: 600; }
  ol.log li time { margin-left: 0; min-width: 7.5em; }
  ol.log li .d { min-width: 0; overflow-wrap: anywhere; }
  details summary { cursor: pointer; font-size: 13px; color: var(--soft); }
  @media (max-width: 520px) { .status { flex-direction: column; align-items: flex-start; } .cmd { flex-direction: column; } }
`;
  const keyPathField = (id: string) => `<div class="keypath"><label for="${id}">Your key</label><input class="input keyfile" id="${id}" value="~/.ssh/id_ed25519" autocomplete="off" spellcheck="false" aria-describedby="${id}-hint"><span id="${id}-hint">(or its .pub, if ssh-agent holds it)</span></div>`;
  const unlockSection = !s.unlocked && !s.bootstrap ? `
  <section aria-labelledby="unlock-title" id="unlock">
    <h2 id="unlock-title">Unlock admin access</h2>
    <p class="lede">Admin pages, the server's settings and users, the source, deploys and the factory need you to prove you hold one of your admin SSH keys. Your key never leaves your computer: you sign a one-time challenge from this server.</p>
    <div class="step">
      <label>1. Run this in a terminal <small>(the challenge works once, for five minutes)</small></label>
      ${keyPathField("unlock-key")}
      <div class="cmd"><pre id="unlock-cmd" aria-live="polite">Getting a challenge…</pre><button type="button" class="pill copy" data-copy="unlock-cmd">Copy</button></div>
    </div>
    <div class="step">
      <label for="unlock-sig">2. Paste what it prints</label>
      <textarea class="input" id="unlock-sig" placeholder="-----BEGIN SSH SIGNATURE-----&#10;…&#10;-----END SSH SIGNATURE-----" spellcheck="false" autocomplete="off"></textarea>
      <div class="actions"><button type="button" class="new" id="unlock-go">Unlock</button><p class="hint" id="unlock-hint" role="status"></p></div>
    </div>
  </section>` : "";
  const canAdd = !!s.unlocked || s.bootstrap;
  const addSection = canAdd ? `
  <section aria-labelledby="add-title" id="add">
    <h2 id="add-title">${s.bootstrap ? "Add your first admin key" : "Add a key"}</h2>
    <p class="lede">${s.bootstrap
      ? `Your first key must be one of your SSH keys on GitHub (<a href="https://github.com/${esc(s.login)}.keys">github.com/${esc(s.login)}.keys</a>${"" /* checked by the server */}), so only you can add it. Prefer a key that only this use has, best on a security key (<code>ssh-keygen -t ed25519-sk</code>).`
      : "A key of your own, on this computer or another (a security key is best). You'll sign a challenge with it, to prove you hold it."}</p>
    <div class="step">
      <label for="add-pub">1. Paste the public key <small>(the .pub file's one line: <code>cat ~/.ssh/id_ed25519.pub</code>)</small></label>
      <div class="row"><input class="input mono" id="add-pub" placeholder="ssh-ed25519 AAAA… you@laptop" autocomplete="off" spellcheck="false"><input class="input" id="add-name" placeholder="A name (e.g. MacBook)" maxlength="60" autocomplete="off" style="flex:0 1 12em"><button type="button" class="pill" id="add-challenge">Next</button></div>
      <p class="hint" id="add-hint1" role="status"></p>
    </div>
    <div class="step" id="add-step2" hidden>
      <label>2. Sign this with that key</label>
      ${keyPathField("add-key")}
      <div class="cmd"><pre id="add-cmd"></pre><button type="button" class="pill copy" data-copy="add-cmd">Copy</button></div>
    </div>
    <div class="step" id="add-step3" hidden>
      <label for="add-sig">3. Paste what it prints</label>
      <textarea class="input" id="add-sig" placeholder="-----BEGIN SSH SIGNATURE-----&#10;…&#10;-----END SSH SIGNATURE-----" spellcheck="false" autocomplete="off"></textarea>
      <div class="actions"><button type="button" class="new" id="add-go">Add key</button><p class="hint" id="add-hint" role="status"></p></div>
    </div>
  </section>` : "";
  const html = appPage("Admin keys", style, `${brand(session)}<main>
  <header>
    <h1>Admin keys</h1>
    <a class="back" href="${esc(link(s.unlocked ? "/admin" : "/docs", session))}">‹ ${s.unlocked ? "Admin" : "Documents"}</a>
  </header>
  ${status}
  ${unlockSection}
  <section aria-labelledby="mine-title">
    <h2 id="mine-title">Your keys <small>${live.length}</small></h2>
    <p class="lede">Only you can unlock with these. Revoke one you lost, or no longer use: it stops working at once, and so does every unlock made with it.${s.unlocked ? "" : " Revoking needs admin access unlocked."}</p>
    ${live.length ? `<ol class="rows keys">\n${live.map((k) => keyRow(k, { mine: true, canRevoke: !!s.unlocked, using: k.id == usingId })).join("\n")}\n    </ol>` : `<p class="lede"><i>None yet.</i></p>`}
    <p class="hint" id="keys-hint" role="status"></p>
    ${revoked.length ? `<details><summary>${revoked.length} revoked</summary><ol class="rows">\n${revoked.map((k) => keyRow(k, { mine: true, canRevoke: false, using: false })).join("\n")}\n</ol></details>` : ""}
  </section>
  ${addSection}
  ${s.everyone ? `<section aria-labelledby="all-title">
    <h2 id="all-title">Other admins' keys <small>${s.everyone.length}</small></h2>
    <p class="lede">Revoke an admin's key if they lost it or it may have leaked; they add a new one from their GitHub keys once they have none left.</p>
    ${s.everyone.length ? `<ol class="rows keys">\n${s.everyone.map((k) => keyRow(k, { mine: false, canRevoke: true, using: false })).join("\n")}\n    </ol>` : `<p class="lede"><i>None.</i></p>`}
  </section>` : ""}
  <section aria-labelledby="agents-title">
    <h2 id="agents-title">Agents, scripts and Git</h2>
    <p class="lede">They need an admin token: an unlock for an hour (up to 12), made on your computer with your key and one of your agent tokens (<a href="${esc(link("/settings", session))}">Settings</a>). From Erga's repository: <code>ERGA_TOKEN=erga_… bun admin-login.ts ${esc(url.origin)}</code>. Use it as the Bearer token, and as Git's password for <code>${esc(url.origin)}/git/erga.git</code>.</p>
  </section>
  ${s.log ? `<section aria-labelledby="log-title">
    <h2 id="log-title">Activity</h2>
    <ol class="log">
${s.log.map((e) => `      <li><time datetime="${esc(e.at)}">${esc(e.at.slice(0, 16).replace("T", " "))}</time><span class="d"><b>${esc(e.login)}</b> ${esc(e.action.replace(/-/g, " "))}${e.detail ? `: ${esc(e.detail)}` : ""}</span></li>`).join("\n")}
    </ol>
  </section>` : ""}
</main>
<script>
  ${TIMES_SCRIPT}
  for (const t of document.querySelectorAll("[data-time]")) t.textContent = new Date(t.dataset.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const next = ${JSON.stringify(back)};
  const done = () => { if (next) location.replace(next); else location.reload(); };
  async function call(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}) }).catch(() => null);
    const out = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(out.error || "Couldn't reach the server: try again.");
    return out;
  }
  const say = (el, text, error) => { el.textContent = text; el.classList.toggle("error", !!error); };
  const quote = (path) => path.trim() || "~/.ssh/id_ed25519";
  // The key's path, remembered in this browser (a convenience only).
  const KEYFILE = "erga-admin-keyfile";
  let remembered = null;
  try { remembered = localStorage.getItem(KEYFILE); } catch {}
  const commands = [];
  for (const input of document.querySelectorAll(".keyfile")) {
    if (remembered) input.value = remembered;
    input.addEventListener("input", () => { try { localStorage.setItem(KEYFILE, input.value); } catch {} for (const f of commands) f(); });
  }
  const show = (pre, input, message) => {
    const f = () => { if (message()) pre.textContent = "printf %s '" + message() + "' | ssh-keygen -Y sign -n ${NAMESPACE} -f " + quote(input.value); };
    commands.push(f); f();
  };
  for (const b of document.querySelectorAll("button.copy")) b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); } catch { b.textContent = "Select it"; }
  });

  // Unlock: a challenge now, a fresh one when it runs out or after a try.
  const unlockCmd = document.getElementById("unlock-cmd");
  if (unlockCmd) {
    // A link from another site doesn't carry the unlock's cookie (SameSite=Strict): ask again, from here, before asking for a signature.
    fetch("/api/admin/keys", { headers: { Accept: "application/json" } }).then((r) => r.json()).then((s) => { if (s.unlocked) done(); }).catch(() => {});
    let challenge = null, timer = 0;
    const input = document.getElementById("unlock-key"), sig = document.getElementById("unlock-sig"), hint = document.getElementById("unlock-hint"), go = document.getElementById("unlock-go");
    const fresh = async () => {
      clearTimeout(timer);
      try { challenge = await call("/api/admin/challenge", { purpose: "unlock" }); } catch (e) { unlockCmd.textContent = e.message; return; }
      show(unlockCmd, input, () => challenge && challenge.message);
      timer = setTimeout(() => { say(hint, "That challenge ran out: here's a new one."); fresh(); }, ${CHALLENGE_MS} - 15000);
    };
    fresh();
    go.addEventListener("click", async () => {
      if (!sig.value.trim()) { say(hint, "Paste the signature first.", true); sig.focus(); return; }
      say(hint, "Checking…"); go.disabled = true;
      try { await call("/api/admin/unlock", { nonce: challenge.nonce, signature: sig.value }); say(hint, "Unlocked."); done(); }
      catch (e) { say(hint, e.message + " (Here's a new challenge.)", true); sig.value = ""; fresh(); }
      go.disabled = false;
    });
  }

  // Lock now.
  document.getElementById("lock")?.addEventListener("click", async () => { try { await call("/api/admin/lock"); location.reload(); } catch (e) { alert(e.message); } });

  // Adding a key: its public half, then a challenge for it, then its signature.
  const addBtn = document.getElementById("add-challenge");
  if (addBtn) {
    let challenge = null;
    const pub = document.getElementById("add-pub"), name = document.getElementById("add-name"), hint1 = document.getElementById("add-hint1");
    const cmd = document.getElementById("add-cmd"), input = document.getElementById("add-key"), sig = document.getElementById("add-sig"), hint = document.getElementById("add-hint"), go = document.getElementById("add-go");
    addBtn.addEventListener("click", async () => {
      say(hint1, "");
      try { challenge = await call("/api/admin/challenge", { purpose: "add-key", publicKey: pub.value }); }
      catch (e) { say(hint1, e.message, true); return; }
      if (!name.value.trim()) name.value = pub.value.trim().split(/\\s+/).slice(2).join(" ");
      say(hint1, "Key " + challenge.key.fingerprint + ".");
      document.getElementById("add-step2").hidden = document.getElementById("add-step3").hidden = false;
      show(cmd, input, () => challenge && challenge.message);
      sig.focus();
    });
    go.addEventListener("click", async () => {
      if (!challenge) return;
      say(hint, "Checking…"); go.disabled = true;
      try { await call("/api/admin/keys", { publicKey: pub.value, name: name.value, nonce: challenge.nonce, signature: sig.value }); say(hint, "Added."); done(); }
      catch (e) { say(hint, e.message + " Press Next for a new challenge.", true); challenge = null; }
      go.disabled = false;
    });
  }

  // Revoking.
  for (const b of document.querySelectorAll("button.revoke")) b.addEventListener("click", async () => {
    const li = b.closest("li"), title = li.querySelector(".title").textContent;
    if (!confirm("Revoke " + title + "? It stops working at once, and so does every unlock made with it.")) return;
    try { await call("/api/admin/keys/" + li.dataset.id + "/revoke"); location.reload(); }
    catch (e) { say(document.getElementById("keys-hint"), e.message, true); }
  });
</script>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
