// TEMPORARY, dev only: a stand-in for a document's pages API (GET and POST
// /api/docs/<id>/tree) until task #30 builds the real one. Delete this file
// and its one line in vite.config.ts when that lands.
//
// It's a Vite plugin (never part of the Worker), on only with
// ERGA_TREE_STUB=1. It keeps each document's tree in memory (and in
// <state>/tree-stub.json, so a restart keeps it), and changes no files: a new
// document is an entry, not a page. A document linked from disk starts from
// its folder's files; any other from index.html alone.
//
//   POST /__erga/tree-stub/<id>   {entries?, canEdit?, fail?}: sets a document's tree (tests, the preview);
//                                 fail: the next change answers that error (400) instead

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type Entry = { path: string; type: "page" | "folder" | "file" };
interface Doc { entries: Entry[]; canEdit: boolean; fail?: string }

export function treeStub(stateDir: string): Plugin {
  const file = join(stateDir, "tree-stub.json");
  const docs: Record<string, Doc> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const save = () => { try { writeFileSync(file, JSON.stringify(docs, null, 2)); } catch { /* no state dir yet */ } };

  const fromDisk = (id: string): Entry[] | null => {
    try {
      const links = JSON.parse(readFileSync(join(stateDir, "erga-links.json"), "utf8")) as { id: string; folder: string; only?: string }[];
      const link = links.find((l) => l.id == id);
      if (!link || link.only) return null;
      const out: Entry[] = [];
      const walk = (dir: string, rel: string) => {
        for (const name of readdirSync(dir)) {
          if (name.startsWith(".") || name == "node_modules") continue;
          const path = rel ? `${rel}/${name}` : name;
          if (statSync(join(dir, name)).isDirectory()) { out.push({ path, type: "folder" }); walk(join(dir, name), path); }
          else out.push({ path, type: /\.html?$/i.test(name) ? "page" : "file" });
        }
      };
      walk(link.folder, "");
      return out;
    } catch { return null; }
  };
  const docOf = (id: string): Doc => (docs[id] ??= { entries: fromDisk(id) ?? [{ path: "index.html", type: "page" }], canEdit: true });

  const read = (req: IncomingMessage) => new Promise<any>((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const clean = (p: unknown) => (typeof p == "string" ? p.replace(/^\/+|\/+$/g, "") : "");
  const parent = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

  function change(doc: Doc, op: any): string | null {
    const has = (p: string) => doc.entries.some((e) => e.path.toLowerCase() == p.toLowerCase());
    const needParent = (p: string) => (parent(p) && !doc.entries.some((e) => e.path == parent(p) && e.type == "folder") ? `There's no folder “${parent(p)}”.` : null);
    if (op.op == "new_page" || op.op == "new_folder") {
      const path = clean(op.path);
      if (!path || /(^|\/)\.\.?(\/|$)/.test(path)) return "That isn't a name a page can have.";
      if (has(path)) return `There's already something called “${path.split("/").pop()}” there.`;
      const missing = needParent(path);
      if (missing) return missing;
      doc.entries.push({ path, type: op.op == "new_folder" ? "folder" : /\.html?$/i.test(path) ? "page" : "file" });
      return null;
    }
    if (op.op == "move") {
      const from = clean(op.from), to = clean(op.to);
      if (from == "index.html") return "The document's own page (index.html) can't be moved or renamed.";
      if (!has(from)) return `There's nothing called “${from}”.`;
      if (to.toLowerCase() != from.toLowerCase() && has(to)) return `There's already something called “${to.split("/").pop()}” there.`;
      if (to.startsWith(from + "/")) return "A folder can't go inside itself.";
      const missing = needParent(to);
      if (missing) return missing;
      doc.entries = doc.entries.map((e) => (e.path == from ? { ...e, path: to } : e.path.startsWith(from + "/") ? { ...e, path: to + e.path.slice(from.length) } : e));
      return null;
    }
    if (op.op == "delete") {
      const path = clean(op.path);
      if (path == "index.html") return "The document's own page (index.html) can't be deleted.";
      if (!has(path)) return `There's nothing called “${path}”.`;
      doc.entries = doc.entries.filter((e) => e.path != path && !e.path.startsWith(path + "/"));
      return null;
    }
    return "Unknown operation.";
  }

  return {
    name: "erga:tree-stub",
    apply: "serve",
    configureServer(server) {
      server.config.logger.info("tree-stub: /api/docs/<id>/tree is answered by dev/tree-stub.ts (temporary, until task #30)");
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const seed = /^\/__erga\/tree-stub\/([a-z0-9]+)$/.exec(url.pathname);
        if (seed && req.method == "POST") {
          return void read(req).then((body) => {
            const doc = docOf(seed[1]);
            if (Array.isArray(body.entries)) doc.entries = body.entries;
            if (typeof body.canEdit == "boolean") doc.canEdit = body.canEdit;
            doc.fail = typeof body.fail == "string" ? body.fail : undefined;
            save();
            answer(res, 200, doc);
          });
        }
        const m = /^\/api\/docs\/([a-z0-9]+)\/tree$/.exec(url.pathname);
        if (!m) return next();
        const doc = docOf(m[1]);
        if (req.method == "GET") return answer(res, 200, { entries: doc.entries, canEdit: doc.canEdit });
        if (req.method != "POST") return answer(res, 405, { error: "GET or POST" });
        void read(req).then((op) => {
          if (!doc.canEdit) return answer(res, 403, { error: "You can view this document but not change it." });
          if (doc.fail) { const error = doc.fail; doc.fail = undefined; return answer(res, 400, { error }); }
          const error = change(doc, op);
          if (error) return answer(res, 400, { error });
          save();
          answer(res, 200, { entries: doc.entries, canEdit: doc.canEdit });
        });
      });
    },
  };
}
