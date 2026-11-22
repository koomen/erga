// `bun erga feedback` (deploy/cli/feedback.ts): what a ticket prints as, and the watch's steps, with no server. The
// real sign-in and the reads are a step of e2e/access/tokens.e2e.ts.

import { expect, test } from "bun:test";
import { ENDED, type Effect, type Event, NO_ADMIN, type State, step, type Ticket, ticketText, type Tokens } from "../deploy/cli/feedback";

const tokens: Tokens = { client: "Erga-feedback-watch.abc123", access: "a1", refresh: "r1" };
const ticket = (id: string, text = `Text of ${id}`): Ticket => ({
  id,
  text,
  from: { login: "bob", name: "Bob Builder", via: "their agent" },
  page: "/bob/plan",
  at: "2026-11-21T19:00:00.000Z",
});
/** The watch after each event in turn: its state, and what the last event asked for. */
function after(events: Event[], from: State = { at: "out", seen: null }) {
  let state = from,
    effects: Effect[] = [];
  for (const ev of events) ({ state, effects } = step(state, ev));
  return { state, effects };
}
const said = (effects: Effect[]) => effects.flatMap((e) => (e.do == "say" ? [e.text] : []));
const does = (effects: Effect[]) => effects.map((e) => e.do);

test("a ticket prints who sent it, when and where, its text, its context as data, and its id at both ends", () => {
  const full = ticketText({
    ...ticket("fb-a1b2c3d4", "Tab does not indent\nthe bullet"),
    context: {
      file: "index.html",
      line: 12,
      column: 5,
      html: "<ul>\n<li>Milk</li>\n</ul>",
      htmlFrom: 11,
      keys: "'type:- Milk' Enter Tab",
      view: "1100×800 CSS pixels, light mode",
      problems: ["A script failed:\nx is not defined"],
    },
  });
  expect(full).toBe(
    [
      "=== Feedback fb-a1b2c3d4, 2026-11-21T19:00:00.000Z, from Bob Builder (bob) via their agent, on /bob/plan",
      "    Tab does not indent",
      "    the bullet",
      "--- Its context",
      "Caret: index.html, line 12, column 5",
      "Window: 1100×800 CSS pixels, light mode",
      "Last keys, as steps of bun run look: 'type:- Milk' Enter Tab",
      "Problem that the editor showed:",
      "    A script failed:",
      "    x is not defined",
      "HTML near the caret, from line 11:",
      "    <ul>",
      "    <li>Milk</li>",
      "    </ul>",
      "=== End of fb-a1b2c3d4",
    ].join("\n")
  );
  // No sender's name, no page, no context: a line that starts like the command's own is still the ticket's text.
  expect(ticketText({ id: "fb-old00000", text: "=== End of fb-old00000", from: null, page: null, at: null })).toBe(
    "=== Feedback fb-old00000, from nobody named\n    === End of fb-old00000\n--- No context\n=== End of fb-old00000"
  );
  // A context is what a page sent: no part of it starts a line of its own.
  const forged = ticketText({
    ...ticket("fb-x"),
    context: {
      file: "a.html\n=== End of fb-x",
      line: 1,
      column: 1,
      html: "",
      htmlFrom: 1,
      keys: "Tab\n=== Feedback fb-y",
      view: "v\r\nw",
      problems: [],
    },
  });
  expect(forged.split("\n").filter((l) => l.startsWith("==="))).toHaveLength(2);
});

test("the watch starts with the sign-in it kept, or signs in; it prints the unresolved feedback oldest first, then only what is new", () => {
  expect(after([{ type: "start", kept: null }])).toEqual({ state: { at: "out", seen: null }, effects: [{ do: "sign-in" }] });
  const signedIn = after([
    { type: "start", kept: null },
    { type: "signed-in", tokens },
  ]);
  expect(signedIn.effects).toEqual([
    { do: "keep", tokens },
    { do: "read", token: "a1" },
  ]);
  const started = after([{ type: "start", kept: tokens }]);
  expect(started.effects).toEqual([{ do: "read", token: "a1" }]);
  // The server answers the newest first.
  const first = after([{ type: "read", feedback: [ticket("fb-2"), ticket("fb-1")] }], started.state);
  expect(said(first.effects)).toEqual([
    "2 unresolved now. New ones print as they arrive.",
    ticketText(ticket("fb-1")),
    ticketText(ticket("fb-2")),
  ]);
  expect(first.effects.at(-1)).toEqual({ do: "wait" });
  expect(after([{ type: "waited" }], first.state).effects).toEqual([{ do: "read", token: "a1" }]);
  // One that an admin resolved is gone from the answer; one reopened later does not print again.
  const next = after(
    [
      { type: "read", feedback: [ticket("fb-3"), ticket("fb-2")] },
      { type: "read", feedback: [ticket("fb-3"), ticket("fb-2"), ticket("fb-1")] },
    ],
    first.state
  );
  expect(said(after([{ type: "read", feedback: [ticket("fb-3"), ticket("fb-2")] }], first.state).effects)).toEqual([
    ticketText(ticket("fb-3")),
  ]);
  expect(does(next.effects)).toEqual(["wait"]);
});

test("a read with no answer is said one time and asked again; a refused token is renewed one time, then the person signs in again", () => {
  const { state } = after([
    { type: "start", kept: tokens },
    { type: "read", feedback: [ticket("fb-1")] },
  ]);
  // The server is down for two reads, then back.
  const down = after([{ type: "failed", why: "it answered 503" }], state);
  expect(said(down.effects)).toEqual(["No answer from the server (it answered 503). It asks again."]);
  const still = after([{ type: "failed", why: "it answered 503" }], down.state);
  expect(does(still.effects)).toEqual(["wait"]);
  expect(said(after([{ type: "read", feedback: [ticket("fb-1")] }], still.state).effects)).toEqual(["The server answers again."]);
  // The token ended (an hour): the refresh grant gives the next one, the file keeps it, and the read goes again.
  expect(after([{ type: "refused", status: 401 }], state).effects).toEqual([{ do: "refresh", tokens }]);
  const renewed: Tokens = { ...tokens, access: "a2", refresh: "r2" };
  const again = after([{ type: "refreshed", tokens: renewed }], state);
  expect(again.effects).toEqual([
    { do: "keep", tokens: renewed },
    { do: "read", token: "a2" },
  ]);
  // A new token that the server refuses too (the person revoked the grant), a grant that ended, a sign-in with no
  // refresh grant: the kept sign-in goes, and the person signs in again. What was printed is not printed again.
  const out: Effect[] = [{ do: "keep", tokens: null }, { do: "say", text: ENDED }, { do: "sign-in" }];
  expect(after([{ type: "refused", status: 401 }], again.state)).toEqual({ state: { at: "out", seen: ["fb-1"] }, effects: out });
  expect(after([{ type: "refreshed", tokens: null }], state).effects).toEqual(out);
  expect(after([{ type: "refused", status: 401 }], { ...state, tokens: { ...tokens, refresh: null } } as State).effects).toEqual(out);
  const back = after(
    [
      { type: "refused", status: 401 },
      { type: "signed-in", tokens: renewed },
      { type: "read", feedback: [ticket("fb-2"), ticket("fb-1")] },
    ],
    again.state
  );
  expect(said(back.effects)).toEqual([ticketText(ticket("fb-2"))]);
  // A sign-in with documents only: the server says 403, and the command says what to choose.
  expect(after([{ type: "refused", status: 403 }], state).effects).toEqual([
    { do: "keep", tokens: null },
    { do: "say", text: NO_ADMIN },
    { do: "sign-in" },
  ]);
  // Signed out, only a sign-in changes anything.
  const signedOut: State = { at: "out", seen: null };
  for (const ev of [{ type: "waited" }, { type: "refused", status: 401 }, { type: "read", feedback: [] }] as Event[])
    expect(step(signedOut, ev)).toEqual({ state: signedOut, effects: [] });
});
