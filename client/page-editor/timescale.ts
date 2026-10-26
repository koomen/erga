/**
 * Scales the editor's timed behaviour (how long notes stay, how marks fade).
 * 1 for people; the tests set `window.__ergaTimescale` lower so they don't sit
 * through real seconds to check what happens after them. On its own, so the
 * shell (main.ts) has it without the page editor's code (editor.ts).
 */
export const ms = (n: number) => n * ((globalThis as { __ergaTimescale?: number }).__ergaTimescale ?? 1);
