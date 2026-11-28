// Local daemon IO helpers: single Unix socket RPC (~/.erga/bridge.sock),
// Erga document lookup, and copying local folders into a managed directory.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ignored } from "../../document/model/pages.ts";
import { defaultOrigin, ergaFetch, ergaHome, normalizeOrigin } from "./auth.ts";

/** Single local Unix socket for the Erga bridge daemon (mode 0600). */
export function daemonSocketPath(home = ergaHome()): string {
  return join(home, "bridge.sock");
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
