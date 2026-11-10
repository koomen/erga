// The shared document: what a document room holds and every participant
// (editor tabs, agent sessions, the room itself merging edits made on disk)
// replicates. Shared by the host and the shell,
// so both sides agree on its shape.
//
//   files    path -> Y.Text, one per text file in the folder (pages,
//            stylesheets, scripts). Paths are relative, with "/" separators.
//   assets   path -> content hash, for every other file. The bytes stay in
//            storage; the hash is the versioned reference (last write wins),
//            so a changed image re-renders the page.
//   authors  Yjs client id -> who that client is. Every participant writes
//            its own entry on joining, so any edit can be attributed from
//            the client ids it carries.
//   folders  path -> true, for every folder made as one (a new folder, or one
//            moved): empty ones too. Folders holding files are there anyway,
//            from the files' paths (document/pages.ts puts the two together).
//   room     the room's epoch: a fresh id whenever a room starts without
//            its saved history. A tab only ever merges into the epoch its
//            history came from.

import * as Y from "yjs";
import { byLine, VIA } from "../shared/attribution.ts";
import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import { base64, fromBase64 } from "../shared/bytes.ts";

export type AuthorKind = "person" | "agent" | "disk";

export interface Author {
  /** Stable id of the person (an agent shares its owner's). */
  user: string;
  /** Shown on cursors and marks: "Pete", "Pete, via their agent", "On disk". */
  name: string;
  /** A colour from PALETTE. */
  color: string;
  kind: AuthorKind;
  /** Their picture, if they have one (shared/avatars.ts: GitHub's by id, or Google's). */
  avatar?: string;
  /** An agent's: how its person acts through it, "their agent" or "a shared agent (label)". Its edits are `user`'s, via this. */
  via?: string;
}

export const files = (doc: Y.Doc) => doc.getMap<Y.Text>("files");
export const assets = (doc: Y.Doc) => doc.getMap<string>("assets");
export const authors = (doc: Y.Doc) => doc.getMap<Author>("authors");
export const folders = (doc: Y.Doc) => doc.getMap<boolean>("folders");
/** The room's own facts: its `epoch` (which history this is. */
export const roomInfo = (doc: Y.Doc) => doc.getMap<string>("room");

/** Files the room holds as text; anything else is an asset. */
const TEXT = /\.(html?|md|markdown|css|js|mjs|cjs|ts|json|svg|txt|xml|csv|ya?ml|toml)$/i;
export const isTextPath = (path: string) => TEXT.test(path);

/**
 * Cursor and selection colours: saturated enough to read as a caret on a
 * white page, distinct enough to tell two people apart.
 */
export const PALETTE = ["#2f6fec", "#d6409f", "#12a594", "#e5730b", "#8e4ec6", "#c2410c", "#0e7490", "#65a30d"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A person's colour, from their id; their agent's is the one opposite it. */
export function colorFor(user: string, agent = false): string {
  const i = hash(user) % PALETTE.length;
  return PALETTE[agent ? (i + PALETTE.length / 2) % PALETTE.length : i];
}

/** What an agent calls itself ("Pete’s agent"). Its work is attributed to its person, via it: byLine. */
export const agentName = (owner: string) => `${owner}’s agent`;

/** Who an edit is by, as a version records it: a person's login, and an agent's person, via it ("pete, via their agent"). */
export const editorOf = (a: Author): string => (a.kind == "agent" ? byLine(a.user, a.via ?? VIA.agent) : a.user);

/** Records who this doc's client is, so its edits can be attributed. */
export function introduce(doc: Y.Doc, me: Author): void {
  doc.transact(() => authors(doc).set(String(doc.clientID), me));
}

/**
 * Who made a transaction: the clients whose clocks it advanced. An edit that
 * only deletes advances no clock, so each participant also re-stamps its
 * `authors` entry in a transaction that deletes without inserting (`stamp`).
 */
export function authorOf(doc: Y.Doc, tr: Y.Transaction): Author | null {
  for (const [client, clock] of tr.afterState) {
    if ((tr.beforeState.get(client) ?? 0) == clock) continue;
    const a = authors(doc).get(String(client));
    if (a) return a;
  }
  return null;
}

/** Inside a local transaction that only deleted, marks it as ours (see `authorOf`). */
export function stamp(doc: Y.Doc, me: Author): void {
  authors(doc).set(String(doc.clientID), me);
}

/** Applies a CodeMirror change set to a Y.Text (inside the caller's transaction). */
export function applyChanges(text: Y.Text, changes: ChangeSet): { inserted: boolean; deleted: boolean } {
  let adj = 0, inserted = false, deleted = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
    const insert = ins.sliceString(0, ins.length, "\n");
    if (toA > fromA) { text.delete(fromA + adj, toA - fromA); deleted = true; }
    if (insert) { text.insert(fromA + adj, insert); inserted = true; }
    adj += insert.length - (toA - fromA);
  });
  return { inserted, deleted };
}

/** A Y.Text event's delta as a CodeMirror change set over the text before it. */
export function deltaToChanges(delta: Y.YTextEvent["delta"], length: number): ChangeSet {
  const specs: ChangeSpec[] = [];
  let pos = 0;
  for (const op of delta) {
    if (op.retain != null) pos += op.retain;
    else if (op.delete != null) { specs.push({ from: pos, to: pos + op.delete }); pos += op.delete; }
    else if (typeof op.insert == "string") specs.push({ from: pos, insert: op.insert });
  }
  return ChangeSet.of(specs, length);
}

// ------------------------------------------------------------ state vectors

/**
 * A participant's state vector, so another can wait until it has seen
 * everything the first had (view_page renders the agent's latest edits).
 */
export const stateVector = (doc: Y.Doc) => base64(Y.encodeStateVector(doc));

export function hasSeen(doc: Y.Doc, vector: string): boolean {
  const want = Y.decodeStateVector(fromBase64(vector));
  for (const [client, clock] of want) if (Y.getState(doc.store, client) < clock) return false;
  return true;
}

/**
 * Who reads a document's versions (the list, an old file, a diff): only people who may edit it. A version may hold
 * text that its authors removed before they shared the document.
 */
export const EDITORS_READ_VERSIONS = "Only people who can edit a document read its versions.";
