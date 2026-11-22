// A feedback's context: what the editor tells the server with a message to the person's agent, while the setting
// feedback_context is on (client/shell/agent-context.ts makes it). The agent's send_feedback keeps it with the
// feedback (server/operations/feedback.ts), so whoever repairs the problem sees where the person was and what they
// pressed, and asks nothing. Pure: no browser, no server.

/** What a feedback keeps of the open page, as the admins and their agents read it. */
export interface FeedbackContext {
  /** The page's address on this site, and its file in the document. */
  page: string;
  file: string;
  /** The caret, in the file's source: its line and column, from 1. */
  line: number;
  column: number;
  /** The file's HTML near the caret, and the line that it starts at. */
  html: string;
  htmlFrom: number;
  /** The keys the person pressed last in the page, as the steps of `bun run look` (lookSteps). */
  keys: string;
  /** How they see the page: its size and colour scheme. */
  view: string;
  /** Each problem that the editor showed them, in its words. */
  problems: readonly string[];
}

/** The most each part keeps (the server cuts what a page sent to these). */
export const CONTEXT_MAX = { page: 300, file: 300, html: 4000, keys: 1500, view: 60, problems: 8, problem: 500 } as const;
/** How many lines of the source go before the caret's line, and after it. */
export const CONTEXT_LINES = 8;
/** How many keys the editor remembers. */
export const KEYS_KEPT = 60;

/**
 * What the person pressed: a keydown (the parts that the steps read), or text that the page took with no keydown of its
 * own (a phone's keyboard, a composition, a dictation).
 */
export type Pressed = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean } | { text: string };

/** A keydown of a character with no command key: the page takes it as text. */
const typed = (k: Pressed) => !("text" in k) && k.key.length == 1 && !k.metaKey && !k.ctrlKey && !k.altKey;

/**
 * The keys with one more, the oldest gone past KEYS_KEPT. Text that the page took for the keydown before it is that
 * key, not a second one.
 */
export function pressedWith(keys: readonly Pressed[], k: Pressed): Pressed[] {
  const before = keys.at(-1);
  if ("text" in k && (!k.text || (before && typed(before) && (before as { key: string }).key == k.text))) return [...keys];
  return [...keys, k].slice(-KEYS_KEPT);
}

/** A key that only holds: it is in the next key's own modifiers. */
const HOLDS = ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "Fn", "Dead", "Process", "Unidentified"];
/** A step as one argument of a shell command. */
const quoted = (step: string) => (/^[\w:+*.,\/-]+$/.test(step) ? step : `'${step.replace(/'/g, `'\\''`)}'`);

/**
 * The keys as the steps of `bun run look`, in order, each quoted for a shell: `'type:- Milk' Enter Tab Backspace*3`.
 * A character typed with no command key is text; any other key is a press, with its modifiers (the command key of the
 * person's computer is ControlOrMeta, as the journeys write it).
 */
export function lookSteps(keys: readonly Pressed[], mac: boolean): string {
  const steps: string[] = [];
  let text = "",
    last = "",
    times = 0;
  const flush = () => {
    if (text) steps.push(`type:${text}`);
    if (last) steps.push(times > 1 ? `${last}*${times}` : last);
    text = last = "";
    times = 0;
  };
  for (const k of keys) {
    if ("text" in k || typed(k)) {
      if (last) flush();
      text += "text" in k ? k.text : k.key;
      continue;
    }
    if (!k.key || HOLDS.includes(k.key)) continue;
    const command = mac ? k.metaKey : k.ctrlKey;
    const press = [
      command ? "ControlOrMeta" : "",
      k.ctrlKey && mac ? "Control" : "",
      k.metaKey && !mac ? "Meta" : "",
      k.altKey ? "Alt" : "",
      k.shiftKey ? "Shift" : "",
      k.key == " " ? "Space" : k.key.length == 1 ? k.key.toLowerCase() : k.key,
    ]
      .filter(Boolean)
      .join("+");
    if (text || press != last) flush();
    last = press;
    times++;
  }
  flush();
  return steps.map(quoted).join(" ");
}

/**
 * The part of `source` near the caret at `offset`: its line with CONTEXT_LINES on each side, and never more than a
 * context keeps (a long line is cut on both sides of the caret, "[...]" at each cut). `htmlFrom`: the line it starts in.
 */
export function sourceNear(source: string, offset: number): { html: string; htmlFrom: number; line: number; column: number } {
  const at = Math.max(0, Math.min(source.length, offset));
  const before = source.slice(0, at).split("\n"),
    after = source.slice(at).split("\n");
  const line = before.length,
    first = Math.max(1, line - CONTEXT_LINES);
  // (The lines before the first one, each with its line break.)
  const from = before.slice(0, first - 1).reduce((n, l) => n + l.length + 1, 0),
    to = at + after.slice(0, CONTEXT_LINES + 1).join("\n").length;
  const half = CONTEXT_MAX.html / 2;
  const start = Math.max(from, at - half),
    end = Math.min(to, at + half);
  return {
    html: `${start > from ? "[...]" : ""}${source.slice(start, end)}${end < to ? "[...]" : ""}`,
    htmlFrom: source.slice(0, start).split("\n").length,
    line,
    column: before[line - 1].length + 1,
  };
}
