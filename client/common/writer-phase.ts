// Who writes, as a reader's page says it (client/inline/viewer-live.ts): the pill's one state, and what moves it. The
// document tells the page each change with its author (at most every 2 s). While changes come, the pill says who
// writes; QUIET_MS after the last one it says "Updated now", and DONE_MS later it goes.
//
//   none --change--> writing --quiet--> updated --done--> none
//   writing, updated --change--> writing (the waits start again)

/** After the last change: how long until the writing is over (two of the document's tells apart, and a little). */
export const QUIET_MS = 4500;
/** How long "Updated now" stays. */
export const DONE_MS = 3000;

export type WriterPhase = { at: "none" } | { at: "writing"; by: string; n: number } | { at: "updated"; n: number };
/** `n`: the wait a timer's end belongs to; an end of an older wait counts for nothing. */
export type WriterEvent = { type: "change"; by: string } | { type: "quiet"; n: number } | { type: "done"; n: number };
export type WriterEffect = { wait: "quiet" | "done"; n: number };

export function writerStep(p: WriterPhase, e: WriterEvent): { phase: WriterPhase; effects: WriterEffect[] } {
  const n = p.at == "none" ? 0 : p.n;
  if (e.type == "change") return { phase: { at: "writing", by: e.by, n: n + 1 }, effects: [{ wait: "quiet", n: n + 1 }] };
  if (e.type == "quiet" && p.at == "writing" && e.n == p.n)
    return { phase: { at: "updated", n: p.n }, effects: [{ wait: "done", n: p.n }] };
  if (e.type == "done" && p.at == "updated" && e.n == p.n) return { phase: { at: "none" }, effects: [] };
  return { phase: p, effects: [] };
}

/** What the pill says; null: no pill. */
export const writerText = (p: WriterPhase): string | null =>
  p.at == "writing" ? `${p.by} is writing…` : p.at == "updated" ? "Updated now" : null;

/** An author as the pill names them: a person by their name, an agent by its connection's name ("Claude Code"), or "Pete’s agent". */
export function writerName(author: string): string {
  const [person, via] = author.split(", via ");
  if (!via) return author;
  const shared = /^a shared agent \((.*)\)$/
    .exec(via)?.[1]
    .replace(/\s*\([^()]*\)$/, "")
    .trim();
  return shared && shared != "no label" ? shared : `${person}’s agent`;
}
