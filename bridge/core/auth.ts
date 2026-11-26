// OAuth 2.1 + PKCE + Dynamic Client Registration against any Erga instance
// (gate/core.ts, server/identity/authorize.ts). One shared token store
// (~/.erga/auth.json, mode 0600) serves Yjs room sync, the local MCP proxy,
// and the agent pane bridge so the user approves once per agent & server.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredToken {
  origin: string;
  clientName: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when accessToken expires. */
  expiresAt: number;
}

interface AuthFile {
  tokens: Record<string, StoredToken>;
}

export const DEFAULT_ERGA_DIR = join(homedir(), ".erga");

export function ergaHome(): string {
  return process.env.ERGA_HOME || DEFAULT_ERGA_DIR;
}

function authPath(): string {
  return join(ergaHome(), "auth.json");
}

function tokenKey(origin: string, clientName: string): string {
  return `${normalizeOrigin(origin)}\n${clientName}`;
}

export function normalizeOrigin(urlOrOrigin: string): string {
  const u = new URL(urlOrOrigin);
  return u.origin;
}

function readAuth(): AuthFile {
  const p = authPath();
  if (!existsSync(p)) return { tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as AuthFile;
    return parsed && typeof parsed.tokens == "object" ? parsed : { tokens: {} };
  } catch {
    return { tokens: {} };
  }
}

/** Default Erga origin: ERGA_SERVER env, else the most recently signed-in server, else local dev. */
export function defaultOrigin(): string {
  if (process.env.ERGA_SERVER?.trim()) return normalizeOrigin(process.env.ERGA_SERVER.trim());
  const latest = Object.values(readAuth().tokens).sort((a, b) => b.expiresAt - a.expiresAt)[0];
  return latest?.origin || "http://localhost:4400";
}

export const DEFAULT_ORIGIN = defaultOrigin();

function writeAuth(data: AuthFile): void {
  const p = authPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  renameSync(tmp, p);
}

/** Reads a cached token entry without prompting the user. */
export function cachedToken(origin: string, clientName: string): StoredToken | null {
  return readAuth().tokens[tokenKey(origin, clientName)] ?? null;
}

/** Removes a cached token (e.g. after revoke or logout). */
export function clearToken(origin: string, clientName: string): void {
  const data = readAuth();
  delete data.tokens[tokenKey(origin, clientName)];
  writeAuth(data);
}

/** Saves an explicit token entry (also useful in tests). */
export function saveToken(entry: StoredToken): void {
  const data = readAuth();
  data.tokens[tokenKey(entry.origin, entry.clientName)] = entry;
  writeAuth(data);
}

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform == "darwin" ? ["open", url] : process.platform == "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* user can open the printed URL manually */
  }
}

interface OAuthMeta {
  authorization_endpoint: string;
  device_authorization_endpoint?: string;
  token_endpoint: string;
  registration_endpoint: string;
}

export interface PendingDeviceAuth {
  origin: string;
  clientName: string;
  clientId: string;
  verifier: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalMs: number;
  deviceEndpoint: string;
  tokenEndpoint: string;
}

/** True when running over SSH, inside herdr-core, or in a headless Linux shell without a desktop display. */
export function isRemoteSession(): boolean {
  if (process.env.ERGA_REMOTE == "1") return true;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT || process.env.HC_TERMINAL_ID) return true;
  if (process.platform == "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  return false;
}

async function discover(origin: string): Promise<OAuthMeta> {
  const fallback: OAuthMeta = {
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
  };
  try {
    const r = await fetch(`${origin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return fallback;
    const j = (await r.json()) as Partial<OAuthMeta>;
    return {
      authorization_endpoint: j.authorization_endpoint ?? fallback.authorization_endpoint,
      ...(j.device_authorization_endpoint ? { device_authorization_endpoint: j.device_authorization_endpoint } : {}),
      token_endpoint: j.token_endpoint ?? fallback.token_endpoint,
      registration_endpoint: j.registration_endpoint ?? fallback.registration_endpoint,
    };
  } catch {
    return fallback;
  }
}

async function refresh(entry: StoredToken): Promise<StoredToken | null> {
  if (!entry.refreshToken) return null;
  const meta = await discover(entry.origin);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: entry.refreshToken,
    client_id: entry.clientId,
  });
  const r = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const tok = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tok.access_token) return null;
  const updated: StoredToken = {
    ...entry,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? entry.refreshToken,
    expiresAt: Date.now() + Math.max(60, (tok.expires_in ?? 3600) - 30) * 1000,
  };
  saveToken(updated);
  return updated;
}

/** Starts an RFC 8628 device-code sign-in (works over SSH, herdr-core, headless servers, and locally). */
export async function startDeviceLogin(rawOrigin: string, clientName: string): Promise<PendingDeviceAuth> {
  const origin = normalizeOrigin(rawOrigin);
  const meta = await discover(origin);
  const deviceEndpoint = meta.device_authorization_endpoint ?? `${origin}/oauth/device_authorization`;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const clientId =
    clientName
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "Agent";

  const res = await fetch(deviceEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, code_challenge: challenge, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Device authorization failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Server returned an incomplete device authorization response.");
  }
  return {
    origin,
    clientName,
    clientId,
    verifier,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete || `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`,
    expiresAt: Date.now() + (data.expires_in ?? 600) * 1000,
    intervalMs: Math.max(1000, (data.interval ?? 2) * 1000),
    deviceEndpoint,
    tokenEndpoint: meta.token_endpoint,
  };
}

/** Polls once for approval of `pending`; exchanges the PKCE code for tokens and saves to auth.json when approved. */
export async function pollDeviceOnce(
  pending: PendingDeviceAuth
): Promise<{ status: "pending" } | { status: "approved"; token: StoredToken } | { status: "denied" | "expired" }> {
  if (Date.now() >= pending.expiresAt) return { status: "expired" };
  const res = await fetch(`${pending.deviceEndpoint}/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: pending.deviceCode, client_id: pending.clientId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error == "authorization_pending" || body.error == "slow_down") return { status: "pending" };
    if (body.error == "access_denied") return { status: "denied" };
    return { status: "expired" };
  }
  const got = (await res.json()) as { code?: string; redirect_uri?: string };
  if (!got.code || !got.redirect_uri) return { status: "expired" };
  const tokBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: got.code,
    redirect_uri: got.redirect_uri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  const tokRes = await fetch(pending.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokBody.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokRes.ok) throw new Error(`Token exchange failed (${tokRes.status}): ${await tokRes.text()}`);
  const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tok.access_token) throw new Error("Token exchange returned no access_token.");
  const entry: StoredToken = {
    origin: pending.origin,
    clientName: pending.clientName,
    clientId: pending.clientId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + Math.max(60, (tok.expires_in ?? 3600) - 30) * 1000,
  };
  saveToken(entry);
  return { status: "approved", token: entry };
}

/** Polls until a pending device-code sign-in is approved, denied, expired, or aborted. */
export async function waitForDeviceLogin(
  pending: PendingDeviceAuth,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<StoredToken> {
  const deadline = Math.min(pending.expiresAt, Date.now() + (opts.timeoutMs ?? 600_000));
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Sign-in canceled.");
    const step = await pollDeviceOnce(pending);
    if (step.status == "approved") return step.token;
    if (step.status == "denied") throw new Error("Authorization denied.");
    if (step.status == "expired") throw new Error("Device sign-in code expired.");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pending.intervalMs);
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    });
  }
  throw new Error("Timed out waiting for browser approval.");
}

/** Runs Erga's OAuth 2.1 PKCE login flow (device-code by default when supported, else loopback) and saves the grant. */
export async function login(
  rawOrigin: string,
  clientName: string,
  opts: { open?: boolean; timeoutMs?: number; log?: (line: string) => void; mode?: "auto" | "device" | "local" } = {}
): Promise<StoredToken> {
  const origin = normalizeOrigin(rawOrigin);
  const log = opts.log ?? ((s) => console.error(s));
  const meta = await discover(origin);
  const useDevice = opts.mode == "device" || (opts.mode != "local" && !!meta.device_authorization_endpoint);
  if (useDevice) {
    const pending = await startDeviceLogin(origin, clientName);
    log(`Open this URL in any browser to sign in to ${origin}:\n  ${pending.verificationUriComplete}\n\nCode: ${pending.userCode}`);
    if (opts.open === true || (opts.open !== false && !isRemoteSession())) {
      await openBrowser(pending.verificationUriComplete);
    }
    return waitForDeviceLogin(pending, { timeoutMs: opts.timeoutMs });
  }
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const gotCode = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname != "/callback") return new Response("Not found", { status: 404 });
      const err = u.searchParams.get("error");
      if (err) {
        rejectCode(new Error(`Authorization denied: ${err}`));
        return new Response("<h1>Denied</h1><p>You can close this tab.</p>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      if (!code || gotState != state) {
        rejectCode(new Error("Invalid OAuth callback state."));
        return new Response("<h1>Invalid callback</h1>", { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      resolveCode(code);
      return new Response(
        "<!doctype html><meta charset=utf-8><style>body{font:16px/1.5 system-ui;max-width:30em;margin:15vh auto;padding:0 1em}</style><h1>Connected to Erga</h1><p>You can close this tab and return to your agent.</p>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    },
  });

  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    const regRes = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!regRes.ok) throw new Error(`OAuth client registration failed (${regRes.status}): ${await regRes.text()}`);
    const reg = (await regRes.json()) as { client_id?: string };
    if (!reg.client_id) throw new Error("OAuth registration returned no client_id.");

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", reg.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    log(`Approve Erga access in your browser: ${authUrl.toString()}`);
    if (opts.open !== false) await openBrowser(authUrl.toString());

    const timer = setTimeout(() => rejectCode(new Error("Timed out waiting for browser approval.")), opts.timeoutMs ?? 180_000);
    const code = await gotCode.finally(() => clearTimeout(timer));

    const tokBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: verifier,
    });
    const tokRes = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokBody.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokRes.ok) throw new Error(`Token exchange failed (${tokRes.status}): ${await tokRes.text()}`);
    const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tok.access_token) throw new Error("Token exchange returned no access_token.");

    const entry: StoredToken = {
      origin,
      clientName,
      clientId: reg.client_id,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + Math.max(60, (tok.expires_in ?? 3600) - 30) * 1000,
    };
    saveToken(entry);
    return entry;
  } finally {
    server.stop(true);
  }
}

/**
 * Returns a valid Bearer token for `(origin, clientName)`: checks `ERGA_TOKEN`,
 * then cached token, refreshes if near expiry, and optionally runs browser login.
 */
export async function getAccessToken(
  rawOrigin: string,
  clientName: string,
  opts: { interactive?: boolean; log?: (line: string) => void } = {}
): Promise<string | null> {
  if (process.env.ERGA_TOKEN) return process.env.ERGA_TOKEN;
  const origin = normalizeOrigin(rawOrigin);
  const cached = cachedToken(origin, clientName);
  if (cached) {
    if (cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    const refreshed = await refresh(cached);
    if (refreshed) return refreshed.accessToken;
  }
  if (!opts.interactive) return null;
  const loggedIn = await login(origin, clientName, { log: opts.log });
  return loggedIn.accessToken;
}

/** Authenticated fetch against Erga with one automatic refresh retry on 401. */
export async function ergaFetch(
  rawOrigin: string,
  clientName: string,
  path: string,
  init: RequestInit = {},
  opts: { interactive?: boolean; log?: (line: string) => void } = {}
): Promise<Response> {
  const origin = normalizeOrigin(rawOrigin);
  const token = await getAccessToken(origin, clientName, opts);
  if (!token) throw new Error(`Not signed in to ${origin}. Run erga-agent login or erga-agent open.`);
  const go = (bearer: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${bearer}`);
    return fetch(`${origin}${path}`, { ...init, headers });
  };
  let res = await go(token);
  if (res.status == 401 && !process.env.ERGA_TOKEN) {
    const cached = cachedToken(origin, clientName);
    const refreshed = cached ? await refresh(cached) : null;
    if (refreshed) res = await go(refreshed.accessToken);
    else if (opts.interactive) {
      clearToken(origin, clientName);
      const fresh = await login(origin, clientName, { log: opts.log });
      res = await go(fresh.accessToken);
    }
  }
  return res;
}
