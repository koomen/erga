// The uploads' owner: it keeps the one state (client/common/uploads.ts decides it) and does what the state says. For
// each file: its sha-256, the write that names it (the operation `write`, which an agent has too: the server checks the
// size, the space and the path before a byte goes, and the write waits), then its bytes to the document's own address
// (PUT /api/blobs/<sha-256>: document/uploads.ts), with XMLHttpRequest, which says how many went and can stop. It
// raises the uploads' alerts in the card, and tells the page each file's state, for its element there
// (libs/text/ui/pending.ts). The page's editor hands it the files a person dropped, pasted or picked, each with the
// path the editor gave it.
//
// Trap: a message from the page can be the page's own script's. It may start an upload into this document and cancel
// one (the page's edit key can do as much), never more: "Raise the limit" acts only from the card's own button.

import { sha256Hex } from "../../shared/bytes";
import { assets, files, stamp } from "../../document/content";
import { encodePath } from "../../document/pages";
import { ms } from "../../libs/text/ui/timescale";
import type { Pending } from "../../shared/room-socket";
import { DISMISS, type Raise } from "../common/alerts";
import { placeIn } from "../common/dropped";
import { asUser, runTool } from "../common/tools";
import * as U from "../common/uploads";
import { BASE, type Shell } from "./shell";

/**
 * A file for the document, at the path the editor gave it (images/…, files/…). `noPlace`: the page has no place for it
 * where it was dropped ("": none at all; else the reason the page's own edit gave).
 */
export interface NewFile {
  file: File;
  path: string;
  noPlace?: string;
}
/** What the write answers of a file it refused (document/uploads.ts, Published). */
interface Refused {
  path: string;
  why: string;
  limit?: { setting: "max_file_mb" | "max_project_gb"; value: number; used?: number };
}

declare global {
  interface Window {
    /** The editor's uploads, for the agent's panel (client/agent/person-agent.ts): a file into a folder of the document. */
    ergaUploads?: { addIn(dir: string, files: File[]): string[] };
  }
}

/** How long the server has to answer the check of a file. */
const CHECK_MS = 30_000;
const PATH = /^(images|files)\/[^\\]{1,400}$/;

export function mountUploads(shell: Shell) {
  let state = U.initial(shell.info.maxFileMb ?? null);
  let batches = 0;
  /** Each file's bytes and, once known, their sha-256, by its path. */
  const blobs = new Map<string, File>(),
    hashes = new Map<string, string>();
  const sends = new Map<string, XMLHttpRequest>(),
    asked = new Set<string>();
  /** The files whose write waits on the server for their bytes. */
  const waits = new Set<string>();
  /** The alerts in the card, as they were raised last; and the problems the person closed (they stay on their files). */
  const raised = new Map<string, Raise>(),
    closed = new Set<string>();
  /** The files on their way from anyone, as the room says (document/waits.ts). */
  let others: Record<string, Pending> = {};
  /** When each file of this tab's arrived: a moment after, the page may still say that it didn't load. */
  const arrivedAt = new Map<string, number>();
  /** The files that arrived since the page was last told: their elements load them. */
  let landed: string[] = [];
  /** The files the page has, with their bytes (for the picture it shows meanwhile), since it loaded. */
  let given = new Set<string>();
  const admin = () => !!shell.people.accountLinks?.admin;

  function send(e: U.Event) {
    const [next, effects] = U.step(state, e);
    state = next;
    for (const f of effects) {
      if (f.t == "check") void check(f.id);
      else if (f.t == "send") put(f.id);
      else if (f.t == "abort") sends.get(f.id)?.abort();
      else if (f.t == "remove") remove(f.id);
      else if (f.t == "again") window.setTimeout(again, ms(f.ms));
      else if (f.t == "landed") {
        waits.delete(f.id);
        arrivedAt.set(f.id, Date.now());
        landed.push(f.id);
        forget(f.id);
      }
    }
    if (effects.length) show();
  }
  /** The connection is tried again, when the browser has one. */
  const again = () =>
    navigator.onLine ? send({ t: "online" }) : window.addEventListener("online", () => send({ t: "online" }), { once: true });
  function forget(id: string) {
    blobs.delete(id);
    hashes.delete(id);
    sends.delete(id);
  }

  // ---------------------------------------------------------------- the server

  /** One file at a time is read whole for its sha-256. */
  let hashing: Promise<unknown> = Promise.resolve();
  const hashOf = (id: string, file: File): Promise<string | null> => {
    const known = hashes.get(id);
    if (known) return Promise.resolve(known);
    // (A file that can't be read, or hashed, answers null: the next file's turn comes all the same.)
    const next = hashing
      .then(() => file.arrayBuffer())
      .then((bytes) => sha256Hex(bytes))
      .catch(() => null);
    hashing = next;
    return next.then((h) => {
      if (h) hashes.set(id, h);
      return h;
    });
  };

  /** The server's check: the write that names the file by its sha-256 and size. */
  async function check(id: string) {
    const file = blobs.get(id);
    if (!file || asked.has(id)) return;
    asked.add(id);
    const answer = (e: U.Event) => {
      asked.delete(id);
      send(e);
    };
    const hash = file.size ? await hashOf(id, file) : "";
    if (hash == null) return answer({ t: "refused", id, why: { t: "other", text: "The browser can't read this file." } });
    const r = await fetch(asUser("/api/tools/write"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // (A file with no bytes has nothing to send after.)
      body: JSON.stringify({ document: shell.docId, files: { [id]: file.size ? { blob: hash, size: file.size } : { base64: "" } } }),
      // (A server that gives no answer in this time is a lost connection: the file waits and is asked about again.)
      signal: AbortSignal.timeout(CHECK_MS),
    }).catch(() => null);
    if (!r) return answer({ t: "lost", id });
    const body = (await r.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      result?: { refused?: Refused[]; waiting?: string[] };
    } | null;
    if (!r.ok || !body?.result) {
      const why = body?.error ?? `The server answered ${r.status}.`;
      return answer(r.status >= 500 || !body ? { t: "failed", id, why } : { t: "refused", id, why: { t: "other", text: why } });
    }
    const no = body.result.refused?.find((x) => x.path == id);
    if (!no) {
      const have = !body.result.waiting?.includes(id);
      if (!have) waits.add(id);
      return answer({ t: "checked", id, have });
    }
    const l = no.limit;
    answer({
      t: "refused",
      id,
      why:
        l?.setting == "max_file_mb"
          ? { t: "size", limitMb: l.value }
          : l?.setting == "max_project_gb"
            ? { t: "space", limitGb: l.value, used: l.used ?? 0 }
            : { t: "other", text: no.why },
    });
  }

  /** The file's bytes, to the write that waits for them. */
  function put(id: string) {
    const file = blobs.get(id),
      hash = hashes.get(id);
    if (!file || !hash) return;
    const x = new XMLHttpRequest();
    sends.set(id, x);
    x.open("PUT", `${BASE}/api/blobs/${hash}`);
    x.upload.onprogress = (e) => send({ t: "progress", id, received: e.loaded, now: performance.now() });
    x.onload = () => {
      sends.delete(id);
      if (x.status == 200) return send({ t: "sent", id });
      let why = `The server answered ${x.status}.`;
      try {
        why = (JSON.parse(x.responseText) as { error?: string }).error ?? why;
      } catch {
        /* not JSON: the status says it */
      }
      // (404: no write waits for these bytes any more. It is written again.)
      if (x.status == 404 || x.status >= 500) send({ t: "failed", id, why, gone: x.status == 404 });
      else send({ t: "refused", id, why: { t: "other", text: why } });
    };
    x.onerror = () => {
      sends.delete(id);
      send({ t: "lost", id });
    };
    // Its bytes, not the file itself: the browser reads a file of the person's disk by its path, for the process that
    // may read it. The file was dropped on the page, a process of its own, and this one (the viewer's) may not: Chrome
    // ends a process that sends such a file.
    x.send(file.slice(0, file.size, file.type));
  }

  /** The files whose elements the page's editor says left the text (Undo): there is none to take out. */
  const gone = new Set<string>();
  /** A cancelled file: its element leaves each page that shows it, and its write, if one waits, waits no more. */
  function remove(id: string, waiting = waits.delete(id)) {
    const doc = shell.collab.doc;
    // (This replica may still have the element the person's Undo took out: taken out here too, the line break beside
    // it would go with it.)
    if (!gone.delete(id))
      doc.transact(() => {
        for (const [page, text] of files(doc)) {
          if (!/\.html?$/i.test(page)) continue;
          // (From the page's folder: a page in blog/ reaches images/ as ../images/.)
          const at = U.elementOf(text.toString(), "../".repeat(page.split("/").length - 1) + encodePath(id));
          if (!at) continue;
          text.delete(at.from, at.to - at.from);
          stamp(doc, shell.me);
        }
      });
    forget(id);
    // Its write waits no more. (Only a write that waits: a file the server refused may have the path of a file or a
    // folder that is there, and that one stays.)
    if (waiting) void runTool("rm", { document: shell.docId, path: id }).catch(() => {});
  }

  /** An admin's "Raise the limit": the server's setting, then the files it refused go again. */
  async function raise(id: string) {
    const u = state.files.find((x) => x.id == id),
      to = u && U.raiseTo(u.size);
    if (!to || !admin()) return;
    try {
      await runTool("set_setting", { key: "max_file_mb", value: to });
      send({ t: "fixed", maxMb: to });
    } catch (e) {
      shell.alerts.raise({
        key: "upload:limit",
        kind: "error",
        source: "upload",
        title: "The limit did not change",
        detail: (e as Error).message,
      });
    }
  }

  // ---------------------------------------------------------------- an agent's files

  /** When each agent's file was first seen with bytes, and how many: its speed. And the timer of each one's end. */
  const first = new Map<string, [number, number]>(),
    ends = new Map<string, number>();
  const ofAgent = (path: string, f: Pending) => !!f.via && !state.files.some((u) => u.id == path);
  /** The agents' files on their way, each an alert: progress, then done; one whose bytes never came is a problem. */
  function agents(was: Record<string, Pending>) {
    const now = performance.now();
    for (const [path, f] of Object.entries(others)) {
      if (!ofAgent(path, f)) continue;
      if (f.got != null && !first.has(path)) first.set(path, [now, f.got]);
      const [t0, b0] = first.get(path) ?? [now, 0];
      const rate = f.got != null && now > t0 ? ((f.got - b0) * 1000) / (now - t0) : 0;
      const alert = U.agentAlert(path, f, rate, f.login.toLowerCase() == shell.info.userId.toLowerCase());
      const old = raised.get(alert.key);
      if (!old || numbers(old) != numbers(alert)) shell.alerts.raise(alert, (action) => action != DISMISS && remove(path, true));
      else shell.alerts.row(alert.key, alert.rows![0]);
      raised.set(alert.key, alert);
      if (!ends.has(path))
        ends.set(
          path,
          window.setTimeout(() => never(path), Math.max(0, f.until - Date.now()))
        );
    }
    for (const [path, f] of Object.entries(was)) {
      if (path in others || !ofAgent(path, f)) continue;
      window.clearTimeout(ends.get(path));
      ends.delete(path);
      first.delete(path);
      const key = U.agentKey(path);
      // (In the document's files now: it came. Else it was taken back.)
      if (raised.delete(key))
        shell.alerts.end(key, assets(shell.collab.doc).has(path) || files(shell.collab.doc).has(path) ? "1 file uploaded" : undefined);
    }
  }
  /** An agent's file whose write waited to its end: its bytes never came. */
  function never(path: string) {
    ends.delete(path);
    if (!(path in others)) return;
    delete others[path];
    raised.delete(U.agentKey(path));
    shell.alerts.raise(U.neverCame(path), (action) => action == "remove" && remove(path, false));
  }

  // ---------------------------------------------------------------- what shows

  /** The same alert but for its rows' numbers: only those are painted. */
  const numbers = (a: Raise) => JSON.stringify({ ...a, p: 0, rows: a.rows?.map((r) => ({ ...r, p: 0, detail: "" })) });

  function hear(key: string, action: string, row?: string) {
    const id = row ?? state.files.find((u) => U.fileKey(u.id) == key)?.id;
    if (action == DISMISS) {
      raised.delete(key);
      if (state.files.some((u) => U.fileKey(u.id) == key)) closed.add(key);
    } else if (action == "cancel-all") send({ t: "cancel-batch", batch: Number(key.slice(key.indexOf(":") + 1)) });
    else if (!id) return;
    else if (action == "cancel" || action == "remove") send({ t: "cancel", id });
    else if (action == "retry") send({ t: "retry", id });
    else if (action == "raise") void raise(id);
  }

  let painting = 0;
  /** The card and the page, as the state is now. */
  function show() {
    const now = performance.now();
    const { alerts, ended } = U.alertsOf(state, now, admin());
    for (const a of alerts) {
      const was = raised.get(a.key);
      if (closed.has(a.key)) continue;
      if (!was || numbers(was) != numbers(a)) shell.alerts.raise(a, (action, row) => hear(a.key, action, row));
      else
        for (const r of a.rows ?? [])
          if (JSON.stringify(r) != JSON.stringify(was.rows?.find((x) => x.id == r.id))) shell.alerts.row(a.key, r);
      raised.set(a.key, a);
    }
    const live = new Set(alerts.map((a) => a.key));
    for (const e of ended) if (raised.delete(e.key)) shell.alerts.end(e.key, e.title);
    for (const key of [...raised.keys()]) if (!live.has(key) && raised.delete(key)) shell.alerts.end(key);
    for (const key of [...closed]) if (!live.has(key)) closed.delete(key);
    const page = U.pageOf(state, now, admin());
    shell.page.uploads(
      page.map((f) => (given.has(f.path) ? f : { ...f, file: blobs.get(f.path) })),
      landed.splice(0)
    );
    for (const f of page) given.add(f.path);
    state = U.swept(state);
    // (The file tree shows them too: client/shell/tree-files.ts.)
    window.dispatchEvent(new Event("erga-uploads"));
    // (The time left changes while nothing else does.)
    window.clearTimeout(painting);
    if (state.files.some((u) => u.state.t == "sending")) painting = window.setTimeout(show, 500);
  }

  /** A new batch of files, each at its path. False: there is none. */
  function start(list: NewFile[], point?: { x: number; y: number }): boolean {
    const ok = list.slice(0, 50);
    if (!ok.length) return false;
      for (const f of ok) blobs.set(f.path, f.file);
      for (const f of ok) hashes.delete(f.path);
      send({
        t: "add",
        batch: ++batches,
        files: ok.map((f) => ({ id: f.path, name: f.path.slice(f.path.lastIndexOf("/") + 1), size: f.file.size })),
      });
      for (const f of ok)
        if (f.noPlace != null)
          shell.alerts.raise(U.noPlace(f.path, f.noPlace, shell.pagePath, point), (action) => {
            if (action == "copy") void navigator.clipboard?.writeText(f.path).then(() => shell.toast.flash("Copied"));
          });
    return true;
  }

  const api = {
    /**
     * Files for the document from the page's editor, each at the path it chose (images/…, files/…): a new batch. One
     * with no place on the page is a problem in the card, with the way on (`point`: where it was dropped). False: none
     * of them can be one (a path that is none).
     */
    add(list: NewFile[], point?: { x: number; y: number }): boolean {
      return start(
        list.filter((f) => f.file instanceof File && PATH.test(f.path) && !f.path.split("/").some((p) => p.startsWith("."))),
        point
      );
    },
    /**
     * Files for a folder of the document ("": its top), from the file tree or the agent's panel: each under its own
     * name there (or with -2, -3 before its extension), a dropped folder's files in the folder. Answers their paths.
     */
    addIn(dir: string, list: File[]): string[] {
      const doc = shell.collab.doc;
      const taken = new Set(
        [...files(doc).keys(), ...assets(doc).keys(), ...state.files.map((u) => u.id), ...Object.keys(others)].map((p) => p.toLowerCase())
      );
      const named = list.slice(0, 50).map((file) => ({ file, path: placeIn(dir, file, taken) }));
      start(named);
      return named.map((f) => f.path);
    },
    /** The files on their way, each with how far it is (0 to 1): this tab's, and those the room tells of. */
    pending(): Record<string, number> {
      const theirs = Object.entries(others).map(([path, f]): [string, number] => [path, f.size ? Math.min(1, (f.got ?? 0) / f.size) : 0]);
      const mine = U.pageOf(state, performance.now(), false).map((f): [string, number] => [f.path, f.p]);
      return Object.fromEntries([...theirs, ...mine]);
    },

    /**
     * A button on a file in the page: cancel, remove or retry act; "raise" only opens the card, where the person does
     * it. "gone": the file's element left the text (Undo), which cancels it.
     */
    act(path: string, action: string) {
      if (action == "gone") {
        // (Not one this owner took out itself a moment ago: it is cancelled already.)
        if (!state.files.some((u) => u.id == path && u.state.t != "done" && u.state.t != "cancelled")) return;
        gone.add(path);
        hear(U.fileKey(path), "cancel", path);
      } else if (action == "raise") {
        closed.delete(U.fileKey(path));
        raised.delete(U.fileKey(path));
        show();
      } else if (action == "cancel" || action == "remove" || action == "retry") hear(U.fileKey(path), action, path);
    },
    /** The editor in the page is new there (the page loaded again) and asks: it has no file's bytes, and knows of none. */
    asked() {
      given = new Set();
      shell.page.uploadsOf(others);
      if (state.files.length) show();
    },
    /** The room says which files are on their way, from anyone. */
    heard(files: Record<string, Pending>) {
      const was = others;
      others = files;
      shell.page.uploadsOf(files);
      agents(was);
    },
    /**
     * Whether the document's file at `path`, which the page couldn't load, is on its way: "yes" (the page will show it
     * when it comes: no problem), "no" (the document has it, so the failure is one), or "maybe": the document has no
     * such file yet, and an upload's element can come before its record does.
     */
    awaits(path: string): "yes" | "no" | "maybe" {
      const own = state.files.filter((u) => u.state.t != "done" && u.state.t != "cancelled").map((u) => u.id);
      const now = Date.now();
      for (const [p, at] of arrivedAt) if (now - at > 10_000) arrivedAt.delete(p);
      if ([...own, ...arrivedAt.keys(), ...Object.keys(others)].includes(path)) return "yes";
      return assets(shell.collab.doc).has(path) || files(shell.collab.doc).has(path) ? "no" : "maybe";
    },
  };
  window.ergaUploads = { addIn: api.addIn };
  return api;
}

export type Uploads = ReturnType<typeof mountUploads>;
