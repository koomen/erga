// Work for when the typing pauses (libs/text/ui/pause.ts): many asks run it once, after the pause; a hidden tab and a
// tab that goes run it at once.

import { expect, test } from "bun:test";
import { afterPause, type PauseWindow } from "../libs/text/ui/pause";

function fakeWindow() {
  const heard = new Map<string, () => void>();
  const on = (type: string, f: () => void) => void heard.set(type, f);
  const off = (type: string) => void heard.delete(type);
  const win: PauseWindow = {
    addEventListener: on,
    removeEventListener: off,
    document: { hidden: false, addEventListener: on, removeEventListener: off },
  };
  return { win, fire: (type: string) => heard.get(type)?.() };
}

test("asks while typing run the work one time, after the pause", async () => {
  (globalThis as { __ergaTimescale?: number }).__ergaTimescale = 0.02;
  try {
    const { win } = fakeWindow();
    let runs = 0;
    const ran = new Promise<void>((done) => {
      const later = afterPause(() => (runs++, done()), win);
      for (let i = 0; i < 5; i++) later.ask();
    });
    expect(runs).toBe(0);
    await ran;
    expect(runs).toBe(1);
  } finally {
    delete (globalThis as { __ergaTimescale?: number }).__ergaTimescale;
  }
});

test("a tab that is hidden, or goes, runs what waits at once; with nothing asked, nothing runs", () => {
  const { win, fire } = fakeWindow();
  let runs = 0;
  const later = afterPause(() => runs++, win);
  fire("pagehide");
  expect(runs).toBe(0);
  later.ask();
  fire("pagehide");
  expect(runs).toBe(1);
  later.ask();
  win.document.hidden = true;
  fire("visibilitychange");
  expect(runs).toBe(2);
  // Hidden already: its timers can wait long, so an ask runs at once.
  later.ask();
  expect(runs).toBe(3);
  win.document.hidden = false;
  later.ask();
  later.stop();
  fire("pagehide");
  expect(runs).toBe(3);
});
