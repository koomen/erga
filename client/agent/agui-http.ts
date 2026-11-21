// A hosted agent, from the page: one run is one POST of a RunAgentInput to the agent's AG-UI endpoint (the setting
// agents has its address), answered with a stream of events (HTTP + SSE). The browser sends the person's own sign-in
// at the agent with it (credentials: "include"), so the agent must permit this site's pages (CORS, with credentials).
// Erga's server is not between the page and the agent; the agent uses Erga as any MCP client does.
//
// agui-run.ts decides (a state machine); this file does what it answers, and keeps the conversation in this browser
// (the agent owns the thread; the page keeps what it showed, and the messages that each run sends again).

import type { Log, LogEvent } from "../../shared/agent-log";
import type { RunAgentInput } from "../../shared/agui-schema";
import { hostedStart, hostedStep, sse, type Hosted, type HostedEffect, type HostedEvent } from "./agui-run";

export interface HostedAgent {
  name: string;
  url: string;
}

export interface HostedOptions {
  agent: HostedAgent;
  /** The document that the page has open: its thread with the agent is apart. */
  doc: string | null;
  /** One event for the panel's log. */
  apply(ev: LogEvent): void;
  /** The log as the panel has it, to keep. */
  log(): Log;
  /** The card that asks the person to sign in at the agent: shown, or gone. */
  signIn(show: boolean): void;
}

export interface HostedPanel {
  /** The conversation as this browser kept it. */
  readonly kept: Log["items"];
  readonly busy: boolean;
  send(text: string, context: string | null, id: string): void;
  answer(item: string, approve: boolean): void;
  stop(): void;
  reset(): void;
  /** The person came back from the agent's sign-in, or put the card away. */
  signedIn(): void;
  notNow(): void;
}

interface Kept {
  state: Hosted;
  items: Log["items"];
}

export function hostedPanel(o: HostedOptions): HostedPanel {
  const key = `erga:agui:v1:${o.agent.url}:${o.doc ?? ""}`;
  let kept: Kept | null = null;
  try {
    kept = JSON.parse(localStorage.getItem(key) ?? "null") as Kept | null;
  } catch {
    /* a private window, or a value that is not ours */
  }
  // A run that the page's last load cut is over: its stream is gone.
  let state: Hosted = kept?.state?.fold
    ? { ...kept.state, at: "idle", run: null, held: null, ended: true }
    : hostedStart(o.agent.name, crypto.randomUUID());
  let stream: AbortController | null = null;

  function post(input: RunAgentInput) {
    const abort = (stream = new AbortController()),
      run = input.runId;
    const hear = (ev: HostedEvent) => {
      if (!abort.signal.aborted) dispatch(ev);
    };
    fetch(o.agent.url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(input),
      signal: abort.signal,
    }).then(
      async (r) => {
        if (!r.ok || !r.body) return hear({ e: "refused", run, status: r.status });
        const feed = sse((text) => {
          let value: unknown = null;
          try {
            value = JSON.parse(text);
          } catch {
            /* not JSON: the machine fails the run */
          }
          hear({ e: "frame", run, value });
        });
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        try {
          for (let part = await reader.read(); !part.done; part = await reader.read()) feed(part.value);
        } catch {
          /* the stream broke: closed, below */
        }
        hear({ e: "closed", run });
      },
      () => hear({ e: "lost", run })
    );
  }

  function run(f: HostedEffect) {
    if (f.t == "post") post(f.input);
    else if (f.t == "abort") stream?.abort();
    else if (f.t == "log") o.apply(f.ev);
    else if (f.t == "sign-in") o.signIn(f.show);
    else
      try {
        localStorage.setItem(key, JSON.stringify({ state, items: o.log().items } satisfies Kept));
      } catch {
        /* no room, or a private window: the conversation stays in this page only */
      }
  }
  function dispatch(ev: HostedEvent) {
    const r = hostedStep(state, ev);
    state = r.state;
    for (const f of r.effects) run(f);
  }

  return {
    kept: kept?.items ?? [],
    get busy() {
      return state.at == "running";
    },
    send: (text, context, id) => dispatch({ e: "send", text, context, id, run: crypto.randomUUID() }),
    answer: (item, approve) => dispatch({ e: "answer", item, approve, run: crypto.randomUUID() }),
    stop: () => dispatch({ e: "stop" }),
    reset: () => dispatch({ e: "reset", thread: crypto.randomUUID() }),
    signedIn: () => dispatch({ e: "signed-in" }),
    notNow: () => dispatch({ e: "not-now" }),
  };
}
