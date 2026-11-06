// The state of one Durable Object's connection to the server's browser (cloudflare/browser.ts), as a pure machine:
// the renders in flight are counted, and the connection is held for a while only once none is left.
//
//   none ─use→ starting(n) ─started→ in use(n) ─done (n=1)→ held ─timer→ none (disconnect)
//                         ─failed→ none(n)      held ─use→ in use(1)

/** `n` is the count of renders in flight: each `use` adds one, each `done` takes one away. */
export type Hold<B> =
  | { at: "none"; n: number }
  | { at: "starting"; n: number }
  | { at: "in use"; n: number; browser: B }
  | { at: "held"; browser: B };

export type HoldEvent<B> =
  /** A render starts; `alive`: the connection kept (in use or held) is still open. */
  | { type: "use"; alive: boolean }
  | { type: "started"; browser: B }
  | { type: "failed" }
  /** A render ends, whatever it did (it called `use` before). */
  | { type: "done" }
  /** The hold's timer fired. */
  | { type: "timer" };

export type HoldEffect<B> = { do: "start" } | { do: "arm" } | { do: "disarm" } | { do: "disconnect"; browser: B };

const START = { do: "start" } as const;
const ARM = { do: "arm" } as const;
const DISARM = { do: "disarm" } as const;

export function step<B>(s: Hold<B>, e: HoldEvent<B>): [Hold<B>, HoldEffect<B>[]] {
  switch (e.type) {
    case "use": {
      if (s.at == "starting") return [{ at: "starting", n: s.n + 1 }, []];
      if (s.at == "none") return [{ at: "starting", n: s.n + 1 }, [START]];
      const n = s.at == "held" ? 1 : s.n + 1;
      const fx: HoldEffect<B>[] = s.at == "held" ? [DISARM] : [];
      return e.alive ? [{ at: "in use", n, browser: s.browser }, fx] : [{ at: "starting", n }, [...fx, START]];
    }
    case "started":
      if (s.at != "starting") return [s, [{ do: "disconnect", browser: e.browser }]];
      return s.n == 0 ? [{ at: "held", browser: e.browser }, [ARM]] : [{ at: "in use", n: s.n, browser: e.browser }, []];
    case "failed":
      return s.at == "starting" ? [{ at: "none", n: s.n }, []] : [s, []];
    case "done":
      if (s.at == "held") return [s, []];
      if (s.at == "in use") return s.n <= 1 ? [{ at: "held", browser: s.browser }, [ARM]] : [{ ...s, n: s.n - 1 }, []];
      return [{ ...s, n: Math.max(0, s.n - 1) }, []];
    case "timer":
      return s.at == "held" ? [{ at: "none", n: 0 }, [{ do: "disconnect", browser: s.browser }]] : [s, []];
  }
}
