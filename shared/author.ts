// Who made an edit or holds a caret: shared by the server (document/, server/), the page editor (libs/text/ui/) and
// the shell (client/shell/). Pure: no dependencies, so browser bundles that only show avatars or share lists never
// pull in Yjs or CodeMirror.

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

/** Whether a name tag says what `b` says. */
export const sameAuthor = (a: Author | undefined, b: Author): boolean =>
  !!a && a.user == b.user && a.name == b.name && a.color == b.color && a.kind == b.kind && a.avatar == b.avatar && a.via == b.via;
