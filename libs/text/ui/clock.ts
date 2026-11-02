// The render's clock (view_page, evaluate_page: capture.ts), which a tab in the background doesn't slow down. There
// Chrome runs a chain of timers at most once a second, and after five minutes once a minute, and draws no frames, so
// a render that waits 50 ms at a time took minutes and the agent's view_page ran out of time. A dedicated worker's
// timers aren't held back, so the render waits on them, and runs its hidden frame's requestAnimationFrame on them too.

import { sleep } from "../../../shared/time";

const WORKER = "onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}";
let worker: Worker | null | undefined;
let next = 0;
const waiting = new Map<number, { ms: number; done: () => void }>();

function timers(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
    worker.onmessage = (e: MessageEvent<number>) => {
      waiting.get(e.data)?.done();
      waiting.delete(e.data);
    };
    // A page whose policy forbids the worker: the window's own timers, then.
    worker.onerror = () => {
      worker = null;
      for (const w of waiting.values()) void sleep(w.ms).then(w.done);
      waiting.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Waits `ms` milliseconds, in the background too. */
export function wait(ms: number): Promise<void> {
  const w = timers();
  if (!w) return sleep(ms);
  return new Promise((done) => {
    const id = ++next;
    waiting.set(id, { ms, done });
    w.postMessage({ id, ms: Math.max(0, ms) });
  });
}

/**
 * The hidden frame's requestAnimationFrame, run by the render (frames()), not by the tab's drawing: a deck that moves
 * to a step by script (a camera's glide) gets there in a tab in the background too.
 */
export const FRAMES_BY_CLOCK = `<script>(function(){var q=new Map(),n=0;window.requestAnimationFrame=function(f){q.set(++n,f);return n};window.cancelAnimationFrame=function(i){q.delete(i)};window.__ergaFrame=function(){var run=Array.from(q.values()),t=performance.now();q.clear();run.forEach(function(f){try{f(t)}catch(e){reportError(e)}})}})()</script>`;

/** Runs `frame`'s requestAnimationFrame callbacks about 60 times a second, until the answer's stop(). */
export function frames(frame: HTMLIFrameElement): { stop(): void } {
  let on = true;
  void (async () => {
    while (on) {
      await wait(16);
      try {
        (frame.contentWindow as (Window & { __ergaFrame?: () => void }) | null)?.__ergaFrame?.();
      } catch {
        /* the frame went */
      }
    }
  })();
  return { stop: () => void (on = false) };
}
