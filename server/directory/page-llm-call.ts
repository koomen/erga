// One call of a page's model (agents/page-llm.ts), as its row of page_llm_use counts it. The call reserves the most it
// can cost when it starts, so calls at the same moment see each other's cost; its end replaces the reservation:
//
//   started (reserved) --answered--> finished (the tokens the model used)
//                      --failed----> failed (the reservation: the provider may charge a call that failed)
//
// A call that ended stays as it ended. A call that never ends (the Worker stopped) stays started: it counts its
// reservation. Decides only: no IO.

/** Tokens, in and out. */
export interface Tokens {
  input: number;
  output: number;
}

export type CallState = { state: "started"; reserved: Tokens } | { state: "finished"; used: Tokens } | { state: "failed"; counted: Tokens };

export type CallEvent = { type: "answered"; used: Tokens } | { type: "failed" };

/** The most a call may use: its input (about 4 characters for each token) and the output it may answer. */
export const reserve = (inputChars: number, maxTokens: number): Tokens => ({ input: Math.ceil(inputChars / 4), output: maxTokens });

/** The call's next state. */
export function callStep(s: CallState, e: CallEvent): CallState {
  if (s.state != "started") return s;
  return e.type == "answered" ? { state: "finished", used: e.used } : { state: "failed", counted: s.reserved };
}

/** The tokens the log counts for a call in state `s`. */
export const countedTokens = (s: CallState): Tokens => (s.state == "started" ? s.reserved : s.state == "finished" ? s.used : s.counted);
