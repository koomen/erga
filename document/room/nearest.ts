// What an edit tool's error adds, so the agent corrects its next call without another read: the line of the file
// nearest to the oldText that isn't there, with the place where the two differ (workspace.ts).

/** The longest start two strings share. */
const shared = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] == b[i]) i++;
  return i;
};

/** A line as an error shows it: whole, or cut. */
const shown = (line: string) => (line.length > 200 ? line.slice(0, 200) + "…" : line);

/**
 * The line of `current` nearest to `oldText`, which isn't in it: the file's place that goes on most like oldText's first
 * line (its indent apart), then the first line from there where the two differ, and the character of that line (from 1)
 * where they do. Null when the file has its first 4 characters nowhere.
 */
export function nearestLine(current: string, oldText: string): { line: number; text: string; at: number } | null {
  const old = oldText.split("\n");
  const first = old.findIndex((l) => l.trim());
  if (first < 0) return null;
  const lines = current.split("\n");
  const want = old[first].trimStart();
  // The place in the file that goes on most like its first line: at each place its first characters are.
  const head = want.slice(0, 4);
  let best = -1,
    from = 0,
    most = 0;
  lines.forEach((l, i) => {
    for (let at = l.indexOf(head); at >= 0; at = l.indexOf(head, at + 1)) {
      const n = shared(l.slice(at), want);
      if (n > most) [best, from, most] = [i, at, n];
    }
  });
  if (best < 0) return null;
  // From there, line by line: the first that differs (a later line from its start, with its indent).
  for (let j = first; j < old.length; j++) {
    const line = lines[best + j - first];
    if (line == null) return { line: lines.length, text: shown(lines[lines.length - 1]), at: lines[lines.length - 1].length + 1 };
    const mine = j == first ? want : old[j];
    const at = j == first ? from : 0;
    const n = shared(line.slice(at), mine);
    const last = j == old.length - 1;
    if (n < mine.length || (!last && at + n < line.length)) return { line: best + j - first + 1, text: shown(line), at: at + n + 1 };
  }
  // (Each line is there: the lines between them differ, an empty line or the indent of the first.)
  return { line: best + 1, text: shown(lines[best]), at: 1 };
}

/** The error's sentence for it, or "". */
export function nearestNote(current: string, oldText: string): string {
  const n = nearestLine(current, oldText);
  return n ? ` Nearest, line ${n.line}:\n  ${n.text}\nIt differs from oldText at character ${n.at} of that line.` : "";
}

/** The files a missing path's error lists: all, or the first 40. */
export function filesNote(paths: string[]): string {
  if (!paths.length) return " The document has no files.";
  const more = paths.length - 40;
  return ` The files: ${paths.slice(0, 40).join(", ")}${more > 0 ? `, and ${more} more (ls lists them)` : ""}.`;
}
