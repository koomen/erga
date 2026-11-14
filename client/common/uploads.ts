// Uploads: each file a person adds to a document (a drop, a paste, the "/" menu's picker) on its way to the server. One
// state for all of them, and `step`, the one function that says what happens next. No IO here: client/shell/uploads.ts
// hashes, asks the server, sends the bytes, and tells the alerts and the page what this file says they show.
//
// A file's states:
//
//   checking  --checked-->   waiting    (the server takes it: its write waits for the bytes; or done: Erga has them)
//   checking  --refused-->   refused    (too large, no space, a folder at its path: with its fixes)
//   waiting   --(a slot)-->  sending    (SLOTS files send at a time; none while the connection is lost)
//   sending   --progress-->  sending    (the bytes that went)
//   sending   --sent------>  done
//   sending   --lost------>  waiting    (no answer: it starts again by itself, from its first byte, at `online`)
//   sending   --failed---->  waiting    (the server failed: again, TRIES times), then failed (Try again: `retry`)
//   refused   --fixed----->  checking   (an admin raised the limit)
//   any but done --cancel--> cancelled  (its element leaves the document, and its write waits no more)
//
// Trap: a file's place in the document is its element there, which the editor wrote at the drop. This machine never
// says where a file goes: only whether its bytes are there.

import { agentLabel } from "../../shared/attribution";
import type { Pending } from "../../shared/room-socket";
import type { Action, Raise, Row } from "./alerts";

export const SLOTS = 3,
  TRIES = 3,
  /** The speed is that of the last SPEED_MS. */
  SPEED_MS = 3000,
  /** How long a file waits before it tries a lost connection again. */
  AGAIN_MS = 3000;
const MB = 1_000_000,
  GB = 1_000_000_000;
/** The most an admin can set max_file_mb to (server/directory/settings.ts). */
const MAX_FILE_MB = 500;

/** Why a file can't go in as it is. `size`, `space`: a limit an admin sets (its value; `used`: the project's bytes now). */
export type Refusal = { t: "size"; limitMb: number } | { t: "space"; limitGb: number; used: number } | { t: "other"; text: string };

export type FileState =
  | { t: "checking" }
  | { t: "waiting" }
  | { t: "sending" }
  | { t: "done" }
  | { t: "refused"; why: Refusal }
  | { t: "failed"; why: string }
  | { t: "cancelled" };

export interface Up {
  /** Its path in the document: its name here too. */
  id: string;
  /** The drop, paste or pick it came with. */
  batch: number;
  name: string;
  size: number;
  state: FileState;
  /** The bytes that went, of this try (kept while it waits for the connection, to show). */
  received: number;
  /** [when, bytes that had gone]: the last SPEED_MS of this try. */
  samples: [number, number][];
  /** How many times the server failed it. */
  tries: number;
}

export interface State {
  files: Up[];
  /** False from a request with no answer until the connection is tried again. */
  online: boolean;
  /** The largest file the server takes, in MB (null: not known, the server says). */
  maxMb: number | null;
}

export type Event =
  | { t: "add"; batch: number; files: { id: string; name: string; size: number }[] }
  /** The server takes it. `have`: it has its bytes already. */
  | { t: "checked"; id: string; have: boolean }
  | { t: "refused"; id: string; why: Refusal }
  | { t: "progress"; id: string; received: number; now: number }
  | { t: "sent"; id: string }
  /** A request of its ended with no answer. */
  | { t: "lost"; id: string }
  /** The connection is tried again. */
  | { t: "online" }
  /** The server failed it. `gone`: its write waits no more there (it took too long): it is checked again. */
  | { t: "failed"; id: string; why: string; gone?: boolean }
  | { t: "retry"; id: string }
  | { t: "cancel"; id: string }
  | { t: "cancel-batch"; batch: number }
  /** An admin set the largest file, in MB. */
  | { t: "fixed"; maxMb: number };

export type Effect =
  /** Hash it and write it: the server's check. Answers `checked` or `refused` (`lost`, `failed`). */
  | { t: "check"; id: string }
  /** Send its bytes. Answers `progress`, then `sent` (`lost`, `failed`). */
  | { t: "send"; id: string }
  | { t: "abort"; id: string }
  /** Its element leaves the document, and its write waits no more. */
  | { t: "remove"; id: string }
  /** Its bytes are there: the pages show it. */
  | { t: "landed"; id: string }
  /** Say `online` after `ms`. */
  | { t: "again"; ms: number }
  /** The alerts and the page, again. */
  | { t: "show" }
  /** Only its numbers changed. */
  | { t: "paint"; id: string };

export const initial = (maxMb: number | null): State => ({ files: [], online: true, maxMb });

const active = (u: Up) => u.state.t == "checking" || u.state.t == "waiting" || u.state.t == "sending";
const over = (u: Up) => u.state.t == "done" || u.state.t == "cancelled";

/** Gives the free slots to the files that wait, the oldest first: their sends. */
function fill(s: State): [State, Effect[]] {
  if (!s.online) return [s, []];
  let free = SLOTS - s.files.filter((u) => u.state.t == "sending").length;
  const sends: Effect[] = [];
  const files = s.files.map((u) => {
    if (u.state.t != "waiting" || free <= 0) return u;
    free--;
    sends.push({ t: "send", id: u.id });
    return { ...u, state: { t: "sending" } as const, received: 0, samples: [] };
  });
  return [sends.length ? { ...s, files } : s, sends];
}

export function step(s: State, e: Event): [State, Effect[]] {
  const old = "id" in e ? s.files.find((u) => u.id == e.id) : undefined;
  const put = (u: Up): State => ({ ...s, files: s.files.map((x) => (x == old ? u : x)) });
  const show: Effect = { t: "show" };
  /** After a change: the slots are given, and all is shown. */
  const settle = (next: State, effects: Effect[] = []): [State, Effect[]] => {
    const [filled, sends] = fill(next);
    return [filled, [...effects, ...sends, show]];
  };
  const cancelled = (u: Up): Effect[] => [
    ...(u.state.t == "sending" ? [{ t: "abort", id: u.id } as const] : []),
    { t: "remove", id: u.id },
  ];
  switch (e.t) {
    case "add": {
      const added = e.files.map((f): Up => {
        const tooLarge = s.maxMb != null && f.size > s.maxMb * MB;
        const state: FileState = tooLarge ? { t: "refused", why: { t: "size", limitMb: s.maxMb! } } : { t: "checking" };
        return { ...f, batch: e.batch, state, received: 0, samples: [], tries: 0 };
      });
      const checks = added.filter((u) => u.state.t == "checking").map((u): Effect => ({ t: "check", id: u.id }));
      // (A file of the same path that is over makes room for the new one.)
      const ids = new Set(added.map((u) => u.id));
      return [{ ...s, files: [...s.files.filter((u) => !ids.has(u.id)), ...added] }, [...checks, show]];
    }
    case "checked": {
      if (!old) return [s, []];
      // (Cancelled while the server was asked: the write that waits there now is taken back.)
      if (old.state.t == "cancelled") return [s, [{ t: "remove", id: old.id }]];
      if (old.state.t != "checking") return [s, []];
      if (e.have) return settle(put({ ...old, state: { t: "done" }, received: old.size }), [{ t: "landed", id: old.id }]);
      return settle(put({ ...old, state: { t: "waiting" } }));
    }
    case "refused":
      if (!old || !active(old)) return [s, []];
      return settle(put({ ...old, state: { t: "refused", why: e.why } }), old.state.t == "sending" ? [{ t: "abort", id: old.id }] : []);
    case "progress": {
      if (old?.state.t != "sending") return [s, []];
      const samples = [...old.samples.filter(([at]) => at > e.now - SPEED_MS), [e.now, e.received] as [number, number]];
      return [put({ ...old, received: e.received, samples }), [{ t: "paint", id: old.id }]];
    }
    case "sent":
      if (old?.state.t != "sending") return [s, []];
      return settle(put({ ...old, state: { t: "done" }, received: old.size }), [{ t: "landed", id: old.id }]);
    case "lost": {
      if (!old || (old.state.t != "sending" && old.state.t != "checking")) return [s, []];
      // Every file that sends waits with it: none has an answer. One that was asked about is asked about again.
      const files = s.files.map((u) => (u.state.t == "sending" ? { ...u, state: { t: "waiting" } as const, samples: [] } : u));
      const aborts = s.files.filter((u) => u.state.t == "sending" && u != old).map((u): Effect => ({ t: "abort", id: u.id }));
      return [{ ...s, files, online: false }, [...aborts, ...(s.online ? [{ t: "again", ms: AGAIN_MS } as const] : []), show]];
    }
    case "online": {
      if (s.online) return [s, []];
      const checks = s.files.filter((u) => u.state.t == "checking").map((u): Effect => ({ t: "check", id: u.id }));
      return settle({ ...s, online: true }, checks);
    }
    case "failed": {
      if (!old || (old.state.t != "sending" && old.state.t != "checking")) return [s, []];
      const tries = old.tries + 1;
      if (tries >= TRIES) return settle(put({ ...old, tries, state: { t: "failed", why: e.why } }));
      // Again: checked again if its write waits no more, or if the check itself failed.
      if (e.gone || old.state.t == "checking")
        return settle(put({ ...old, tries, state: { t: "checking" }, samples: [] }), [{ t: "check", id: old.id }]);
      return settle(put({ ...old, tries, state: { t: "waiting" }, samples: [] }));
    }
    case "retry":
      if (old?.state.t != "failed") return [s, []];
      return settle(put({ ...old, tries: 0, received: 0, state: { t: "checking" } }), [{ t: "check", id: old.id }]);
    case "cancel":
      if (!old || over(old)) return [s, []];
      return settle(put({ ...old, state: { t: "cancelled" } }), cancelled(old));
    case "cancel-batch": {
      const gone = s.files.filter((u) => u.batch == e.batch && active(u));
      if (!gone.length) return [s, []];
      return settle(
        { ...s, files: s.files.map((u) => (gone.includes(u) ? { ...u, state: { t: "cancelled" } as const } : u)) },
        gone.flatMap(cancelled)
      );
    }
    case "fixed": {
      const fits = (u: Up) => u.state.t == "refused" && u.state.why.t == "size" && u.size <= e.maxMb * MB;
      const again = s.files.filter(fits);
      const files = s.files.map((u) => (fits(u) ? { ...u, state: { t: "checking" } as const } : u));
      return settle(
        { ...s, maxMb: e.maxMb, files },
        again.map((u): Effect => ({ t: "check", id: u.id }))
      );
    }
  }
}

// ---------------------------------------------------------------- what it shows

/** A size in a few characters: "86 KB", "1.5 MB", "64 MB", "4.98 GB". */
export function sizeText(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2).replace(/\.?0+$/, "")} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
const count = (n: number) => `${n} file${n == 1 ? "" : "s"}`;
const timeText = (seconds: number) =>
  seconds < 90 ? `${Math.max(1, Math.round(seconds))} s left` : `${Math.round(seconds / 60)} min left`;

/** Bytes a second over the files' last SPEED_MS, or 0 if it can't tell yet. */
function speed(files: Up[], now: number): number {
  let n = 0;
  for (const u of files) {
    const recent = u.samples.filter(([at]) => at > now - SPEED_MS);
    if (u.state.t != "sending" || recent.length < 2) continue;
    const [t0, b0] = recent[0],
      [t1, b1] = recent[recent.length - 1];
    if (t1 > t0) n += ((b1 - b0) * 1000) / (t1 - t0);
  }
  return n;
}
/** The time left for `files` ("4 s left"), or "" if it can't tell: the bytes left, by the speed of all that send. */
function left(files: Up[], all: Up[], now: number): string {
  const bytes = files.reduce((n, u) => n + (active(u) ? u.size - (u.state.t == "sending" ? u.received : 0) : 0), 0);
  const rate = speed(all, now);
  return bytes > 0 && rate > 0 ? timeText(bytes / rate) : "";
}
/** How far a file is, 0 to 1. */
const part = (u: Up) => (u.state.t == "done" ? 1 : u.size ? Math.min(1, u.received / u.size) : 0);
/** What a file that waits says of itself. */
const waitsFor = (s: State, u: Up) => (!s.online ? "waiting for the connection" : u.state.t == "checking" ? "" : "waiting");

/** The most an admin can raise max_file_mb to for a file of `size` bytes: the next 50 MB; null: more than a file can ever have. */
export function raiseTo(size: number): number | null {
  const mb = Math.ceil(size / MB / 50) * 50;
  return mb <= MAX_FILE_MB ? mb : null;
}

/** What a file that can't go in says, on the file and in its alert, and its fixes. `admin`: the person can raise a limit. */
export function problemOf(u: Up, admin: boolean): { lead: string; text: string; title: string; detail: string; actions: Action[] } | null {
  const remove: Action = { id: "remove", label: "Remove" };
  if (u.state.t == "failed")
    return {
      lead: "Not uploaded.",
      text: `The server did not take ${u.name}.`,
      title: `The server did not take “${u.name}”`,
      detail: u.state.why,
      actions: [{ id: "retry", label: "Try again", primary: true }, remove],
    };
  if (u.state.t != "refused") return null;
  const why = u.state.why;
  if (why.t == "size") {
    const to = raiseTo(u.size);
    const numbers = `${sizeText(u.size)}. The limit here is ${why.limitMb} MB.`;
    return {
      lead: "Too large.",
      text: `${u.name} has ${numbers}`,
      title: `“${u.name}” is too large`,
      detail: `it has ${numbers}`,
      actions: admin && to != null ? [{ id: "raise", label: `Raise the limit to ${to} MB`, primary: true }, remove] : [remove],
    };
  }
  if (why.t == "space") {
    const numbers = `${sizeText(why.used)}. This file does not fit in the ${why.limitGb} GB.`;
    return {
      lead: "No space.",
      text: `The files here have ${numbers}`,
      title: `“${u.name}” does not fit`,
      detail: `the files here have ${numbers}`,
      actions: [remove],
    };
  }
  return { lead: "Not added.", text: why.text, title: `“${u.name}” was not added`, detail: why.text, actions: [remove] };
}

/** The alert's key of a batch, and of a file that can't go in. */
export const batchKey = (batch: number) => `upload:${batch}`;
export const fileKey = (id: string) => `upload-file:${id}`;

/** A batch's row for one file: its name, its size and what is left, its bar, and its ×. */
export function rowOf(s: State, u: Up, now: number): Row {
  const done = u.state.t == "done";
  const tail = done ? "uploaded" : u.state.t == "sending" ? left([u], s.files, now) : waitsFor(s, u);
  return {
    id: u.id,
    title: u.name,
    detail: [sizeText(u.size), tail].filter(Boolean).join(" · "),
    state: done ? "done" : u.state.t == "sending" ? "running" : "waiting",
    p: part(u),
    actions: done ? [] : [{ id: "cancel", label: "×" }],
  };
}

/**
 * The alerts of the uploads now. Each batch that runs is one progress alert, with a row for each file that is not
 * refused. Each file that can't go in is a problem of its own, with its fixes. `ended`: the batches that are over, and
 * what the line says of each for a moment ("3 files uploaded"; none: nothing went in).
 */
export function alertsOf(s: State, now: number, admin: boolean): { alerts: Raise[]; ended: { key: string; title?: string }[] } {
  const alerts: Raise[] = [],
    ended: { key: string; title?: string }[] = [];
  for (const batch of new Set(s.files.map((u) => u.batch))) {
    const all = s.files.filter((u) => u.batch == batch),
      rows = all.filter((u) => active(u) || u.state.t == "done"),
      done = all.filter((u) => u.state.t == "done").length;
    if (!all.some(active)) {
      ended.push({ key: batchKey(batch), ...(done ? { title: `${count(done)} uploaded` } : {}) });
      continue;
    }
    const one = rows.length == 1 ? rows[0].name : null;
    const tail = !s.online ? "waiting for the connection" : left(rows, s.files, now);
    alerts.push({
      key: batchKey(batch),
      kind: "progress",
      source: "upload",
      title: `Uploading ${one ?? count(rows.length)}`,
      line: [one && s.online ? one : count(rows.length), tail].filter(Boolean).join(" · "),
      head: [count(rows.length), tail].filter(Boolean).join(" · "),
      by: { name: "you", agent: false },
      p:
        rows.reduce((n, u) => n + part(u) * u.size, 0) /
        Math.max(
          1,
          rows.reduce((n, u) => n + u.size, 0)
        ),
      actions: rows.length > 1 ? [{ id: "cancel-all", label: "Cancel all" }] : [],
      rows: rows.map((u) => rowOf(s, u, now)),
    });
  }
  for (const u of s.files) {
    const p = problemOf(u, admin);
    if (p) alerts.push({ key: fileKey(u.id), kind: "error", source: "upload", title: p.title, detail: p.detail, actions: p.actions });
  }
  return { alerts, ended };
}

/** The alert's key of a file on its way from an agent. */
export const agentKey = (path: string) => `upload-agent:${path}`;
/**
 * The alert of a file on its way from an agent (document/waits.ts): its name and the agent's, how far it is, the time
 * left (`rate`: bytes a second, 0 if not known) and Cancel. `mine`: the agent is this person's own.
 */
export function agentAlert(path: string, f: Pending, rate: number, mine: boolean): Raise {
  const name = path.slice(path.lastIndexOf("/") + 1),
    got = f.got ?? 0;
  const tail = rate > 0 && got < f.size ? timeText((f.size - got) / rate) : "";
  const agent = agentLabel(f, null, false).label;
  return {
    key: agentKey(path),
    kind: "progress",
    source: "upload",
    title: `Uploading ${name}`,
    line: [name, tail].filter(Boolean).join(" · "),
    head: ["1 file", tail].filter(Boolean).join(" · "),
    by: {
      name: agent == "Agent" ? (mine ? "your agent" : `${f.name}’s agent`) : `${agent}, ${mine ? "your" : `${f.name}’s`} agent`,
      agent: true,
    },
    p: f.size ? Math.min(1, got / f.size) : 0,
    actions: [{ id: "cancel", label: "Cancel" }],
    rows: [
      {
        id: path,
        title: name,
        detail: [sizeText(f.size), tail].filter(Boolean).join(" · "),
        state: f.got == null ? "waiting" : "running",
        p: f.size ? Math.min(1, got / f.size) : 0,
        actions: [{ id: "cancel", label: "×" }],
      },
    ],
  };
}
/** The problem of an agent's file whose bytes never came: the agent can be asked again, or its element removed. */
export const neverCame = (path: string): Raise => ({
  key: agentKey(path),
  kind: "error",
  source: "upload",
  title: `“${path.slice(path.lastIndexOf("/") + 1)}” never came`,
  detail: `the agent wrote ${path}, and did not send its bytes.`,
  fix: `The file ${path} of this document never arrived: you wrote it by its sha-256, and its bytes did not come in time. Write it again and send its bytes.`,
  fixLabel: "Ask the agent again",
  actions: [{ id: "remove", label: "Remove" }],
});

/** A file on its way, as the page shows it on its element (libs/text/ui/pending.ts). */
export interface PageFile {
  path: string;
  /** How far, 0 to 1. */
  p: number;
  /** Beside the percent: "4 s left", "waiting for the connection". */
  text: string;
  /** It can't go in: what the file says, and its fixes. */
  problem?: { lead: string; text: string; actions: Action[] };
}

/** The files that are not in the document's files yet, for the page. */
export function pageOf(s: State, now: number, admin: boolean): PageFile[] {
  return s.files
    .filter((u) => !over(u))
    .map((u) => {
      const p = problemOf(u, admin);
      return {
        path: u.id,
        p: part(u),
        text: u.state.t == "sending" ? left([u], s.files, now) : p ? "" : waitsFor(s, u),
        ...(p ? { problem: { lead: p.lead, text: p.text, actions: p.actions } } : {}),
      };
    });
}

/** The files that are over leave the state, when their batch is. */
export function swept(s: State): State {
  const live = new Set(s.files.filter((u) => !over(u)).map((u) => u.batch));
  const files = s.files.filter((u) => live.has(u.batch));
  return files.length == s.files.length ? s : { ...s, files };
}

// ---------------------------------------------------------------- a file's element in a page's text

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Where the element that shows the file `href` is in a page's HTML, as the editor wrote it at the drop (libs/text/ui/
 * input.ts, insertFiles): an image in a paragraph of its own (with the line break before it), an image in a line, or a
 * link. Null: the page doesn't show it (the person took it out).
 */
export function elementOf(html: string, href: string): { from: number; to: number } | null {
  const h = esc(href.replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
  const img = `<img [^<>]*src="${h}"[^<>]*>`;
  for (const re of [
    new RegExp(`(?:\\n[ \\t]*)?<p style="text-align: center">${img}</p>`),
    new RegExp(img),
    new RegExp(`<a href="${h}">[^<]*</a>`),
  ]) {
    const m = re.exec(html);
    if (m) return { from: m.index, to: m.index + m[0].length };
  }
  return null;
}
