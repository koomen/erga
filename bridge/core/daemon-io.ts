// Local daemon IO helpers: single Unix socket RPC (~/.erga/bridge.sock),
// exclusive single-instance daemon lock (~/.erga/daemon.lock), safe owned-file
// cleanup, Erga document lookup, and copying local folders into a managed dir.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ignored } from "../../document/model/pages.ts";
import { defaultOrigin, ergaFetch, ergaHome, normalizeOrigin } from "./auth.ts";

/** Single local Unix socket for the Erga bridge daemon (mode 0600). */
export function daemonSocketPath(home = ergaHome()): string {
  return join(home, "bridge.sock");
}

/** Exclusive single-instance lockfile for the Erga bridge daemon (mode 0600). */
export function daemonLockPath(home = ergaHome()): string {
  return join(home, "daemon.lock");
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface DaemonLockInfo {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: number;
}

export interface DaemonLockHandle extends DaemonLockInfo, FileIdentity {
  readonly path: string;
  isOwned(): boolean;
  release(): boolean;
}

const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));

function safeLstat(p: string): { dev: number; ino: number; mtimeMs: number } | null {
  try {
    const st = lstatSync(p);
    return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function sameFile(a: FileIdentity | null, b: FileIdentity | null): boolean {
  return a != null && b != null && a.dev == b.dev && a.ino == b.ino;
}

/** Returns true if a process with `pid` currently exists on this machine. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code == "EPERM";
  }
}

function parseLockFile(path: string): DaemonLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonLockInfo>;
    if (
      typeof parsed.pid == "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token == "string" &&
      parsed.token
    ) {
      return { pid: parsed.pid, token: parsed.token, startedAt: typeof parsed.startedAt == "number" ? parsed.startedAt : 0 };
    }
    return null;
  } catch {
    return null;
  }
}

/** Reads the current daemon lock record from `ERGA_HOME`, or null if absent/invalid. */
export function readDaemonLock(home = ergaHome()): DaemonLockInfo | null {
  return parseLockFile(daemonLockPath(home));
}

function createExclusive(tmpPath: string, targetPath: string, payload: string): FileIdentity | null {
  try {
    linkSync(tmpPath, targetPath);
    const st = safeLstat(tmpPath);
    return st ? { dev: st.dev, ino: st.ino } : null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code == "EEXIST") return null;
    if (code != "EPERM" && code != "EXDEV" && code != "ENOTSUP" && code != "ENOSYS") throw e;
  }
  try {
    const fd = openSync(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, payload);
      const st = fstatSync(fd);
      return { dev: st.dev, ino: st.ino };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code == "EEXIST") return null;
    throw e;
  }
}

/**
 * Atomically acquires the exclusive single-instance lock for `home`.
 * Returns a handle if acquired, or `null` if a live daemon already holds it.
 * Stale lockfiles belonging to dead PIDs are reclaimed race-free.
 */
export function acquireDaemonLock(home = ergaHome()): DaemonLockHandle | null {
  const lockPath = daemonLockPath(home);
  const reclaimPath = join(dirname(lockPath), ".daemon.lock.reclaim");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const token = crypto.randomUUID();
  const startedAt = Date.now();
  const pid = process.pid;
  const payload = JSON.stringify({ pid, token, startedAt }) + "\n";
  const tmpPath = join(dirname(lockPath), `.daemon.lock.${pid}.${token.slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, payload, { mode: 0o600 });

  const makeHandle = (id: FileIdentity): DaemonLockHandle => {
    let released = false;
    const isOwned = (): boolean => {
      if (released) return false;
      if (!sameFile(safeLstat(lockPath), id)) return false;
      const cur = parseLockFile(lockPath);
      return cur != null && cur.pid == pid && cur.token == token;
    };
    return {
      path: lockPath,
      pid,
      token,
      startedAt,
      dev: id.dev,
      ino: id.ino,
      isOwned,
      release(): boolean {
        if (!isOwned()) {
          released = true;
          return false;
        }
        released = true;
        try {
          rmSync(lockPath, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    };
  };

  try {
    for (let attempt = 0; attempt < 25; attempt++) {
      const won = createExclusive(tmpPath, lockPath, payload);
      if (won) return makeHandle(won);

      const curStat = safeLstat(lockPath);
      if (!curStat) continue;
      const curInfo = parseLockFile(lockPath);
      if (curInfo && isPidAlive(curInfo.pid)) return null;

      // Stale lock (dead PID or corrupt): serialize reclamation via atomic reclaim guard.
      const guard = createExclusive(tmpPath, reclaimPath, payload);
      if (guard) {
        try {
          const againStat = safeLstat(lockPath);
          const againInfo = againStat ? parseLockFile(lockPath) : null;
          if (againInfo && isPidAlive(againInfo.pid)) return null;
          if (againStat) rmSync(lockPath, { force: true });
          const reclaimed = createExclusive(tmpPath, lockPath, payload);
          if (reclaimed) return makeHandle(reclaimed);
        } finally {
          if (sameFile(safeLstat(reclaimPath), guard)) rmSync(reclaimPath, { force: true });
        }
        continue;
      }

      const guardStat = safeLstat(reclaimPath);
      const guardInfo = guardStat ? parseLockFile(reclaimPath) : null;
      if (guardStat && (!guardInfo ? Date.now() - guardStat.mtimeMs > 2_000 : !isPidAlive(guardInfo.pid))) {
        rmSync(reclaimPath, { force: true });
        continue;
      }
      Atomics.wait(WAIT_BUF, 0, 0, 10);
    }
    return null;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

/** Unlinks `sockPath` only if it still refers to the exact `(dev, ino)` created by this daemon. */
export function unlinkSocketIfOwned(sockPath: string, owned: FileIdentity): boolean {
  if (!sameFile(safeLstat(sockPath), owned)) return false;
  try {
    rmSync(sockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Parses an Erga document URL, `/<owner>/<slug>`, `/d/<id>`, or bare id. */
export function parseDocumentRef(ref: string, fallbackOrigin = defaultOrigin()): { origin: string; ref: string } {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const cleanPath = u.pathname.replace(/\/+$/, "") || "/";
    return { origin: u.origin, ref: cleanPath };
  }
  return { origin: normalizeOrigin(fallbackOrigin), ref: trimmed };
}

/** Resolves an Erga document reference (`/d/<id>`, `/<owner>/<slug>`, or bare id) to its metadata. */
export async function resolveDocument(
  origin: string,
  clientName: string,
  ref: string,
  opts: { interactive?: boolean } = {}
): Promise<{ id: string; owner: string; slug: string; title: string }> {
  const interactive = opts.interactive ?? true;
  const clean = ref.replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/");
  const docPath =
    parts[0] == "d" && parts[1]
      ? `/d/${parts[1]}/api/doc`
      : parts.length >= 2
        ? `/${parts[0]}/${parts[1]}/api/doc`
        : `/d/${parts[0]}/api/doc`;
  const res = await ergaFetch(origin, clientName, docPath, {}, { interactive });
  if (res.ok) {
    const info = (await res.json()) as {
      docName?: { id?: string; owner?: string; slug?: string; title?: string; address?: string };
      name?: string;
      dir?: string;
    };
    const id = info.docName?.id || (parts[0] == "d" ? parts[1] : parts.length == 1 ? parts[0] : "");
    if (id) {
      const owner = info.docName?.owner || info.dir || parts[0] || "doc";
      const slug = info.docName?.slug || parts[1] || id;
      const title = info.docName?.title || slug;
      return { id, owner, slug, title };
    }
  }
  const listRes = await ergaFetch(
    origin,
    clientName,
    "/api/tools/list_documents",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 100 }),
    },
    { interactive }
  );
  if (listRes.ok) {
    const payload = (await listRes.json()) as {
      ok?: boolean;
      result?: { documents?: { id: string; address: string; title: string }[] };
    };
    const docs = payload.result?.documents ?? [];
    const needle = `/${clean}`.toLowerCase();
    const hit = docs.find((d) => d.id == clean || d.address.toLowerCase() == needle || needle.startsWith(`${d.address.toLowerCase()}/`));
    if (hit) {
      const [, o = "doc", s = hit.id] = hit.address.split("/");
      return { id: hit.id, owner: o, slug: s, title: hit.title || s };
    }
  }
  throw new Error(`Could not find Erga document "${ref}" on ${origin} (status ${res.status}).`);
}

/** Copies non-ignored files from a local project folder into a document's managed directory. */
export async function copyIntoManaged(srcDir: string, dstDir: string, sub = ""): Promise<void> {
  if (!sub && resolve(srcDir) == resolve(dstDir)) return;
  const entries = await readdir(join(srcDir, sub), { withFileTypes: true });
  for (const ent of entries) {
    const rel = sub ? `${sub}/${ent.name}` : ent.name;
    if (ent.name == ".git" || ent.name == "node_modules" || ent.name == ".DS_Store" || ent.name == ".erga" || ignored(rel)) continue;
    const from = join(srcDir, rel);
    const to = join(dstDir, rel);
    if (ent.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyIntoManaged(srcDir, dstDir, rel);
    } else if (ent.isFile()) {
      await mkdir(join(dstDir, sub), { recursive: true });
      await copyFile(from, to);
    }
  }
}

/** Sends one RPC request to the running local bridge daemon over ~/.erga/bridge.sock; null if not running. */
export async function daemonRpc<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  timeoutMs = 180_000,
  home = ergaHome()
): Promise<T | null> {
  const sock = daemonSocketPath(home);
  if (!existsSync(sock)) return null;
  try {
    const res = await fetch(`http://localhost${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      unix: sock,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { unix: string });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
