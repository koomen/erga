// The editor in the page, run as editor-state.ts decides: this sends it what happens (editing, the view, full screen,
// the edit key's answers, time), and does what it returns: tells the page, asks the host for a key, says so in a note
// when the editor can't start. The key is kept in this tab (sessionStorage): the editor starts with it after a reload,
// offline too.

import { ms } from "../../libs/text/ui/timescale";
import { live } from "../live/client";
import { initial, step, type EditorEvent, type Held } from "./editor-state";
import { BASE, type Shell } from "./shell";

export function mountEditor(shell: Shell, editing: boolean, full: boolean) {
  const KEY = `erga:edit-key:${BASE}${shell.as}`;
  let state = initial(
    editing,
    full,
    (() => {
      try {
        return JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Held | null;
      } catch {
        return null;
      }
    })()
  );
  function send(e: EditorEvent) {
    const { state: next, effects } = step(state, e, Date.now());
    state = next;
    if (effects.say) shell.page.say();
    if (effects.ask) void ask();
    if (effects.retry) setTimeout(() => send({ type: "retry" }), ms(effects.retry));
    if (effects.note == "failed")
      shell.alerts.raise({
        key: "edit-key",
        kind: "error",
        source: "editor",
        title: "The editor can't start",
        detail: "The server didn't give it an edit key. It asks again in a few seconds.",
      });
    if (effects.note == "started") {
      shell.alerts.end("edit-key");
      shell.toast.flash("The editor started.", 2200);
    }
  }
  async function ask() {
    // The first one was asked for as the page connected (client/inline/viewer-editing-head.ts, ergaConnect).
    const early = window.ergaKey;
    window.ergaKey = undefined;
    const r = await (early ?? fetch(shell.api("/api/key"), { method: "POST" }).catch(() => null));
    if (!r) return send({ type: "unreachable" });
    const got = r.ok ? ((await r.json().catch(() => null)) as { key?: unknown; expires?: unknown } | null) : null;
    if (typeof got?.key != "string" || typeof got.expires != "number") return send({ type: "refused" });
    const held = { key: got.key, expires: got.expires };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(held));
    } catch {
      /* private mode */
    }
    send({ type: "key", held });
  }
  setInterval(() => send({ type: "tick" }), 60_000);
  live((l) => l.signedOut(() => send({ type: "signed-out" })));
  return {
    get state() {
      return state;
    },
    send,
  };
}

export type Editor = ReturnType<typeof mountEditor>;
