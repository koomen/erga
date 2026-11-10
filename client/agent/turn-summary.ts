// The end of the agent's turn, in its panel (client/agent/person-agent.ts): one line says what the turn changed in the
// document open ("Done. 8 changes in index.html."), with two buttons. "See changes" shows the text before and after the
// turn: a diff of each file, from the version the document cut before the turn. "Undo the turn" takes back all
// of its changes at once. The document's host keeps the turn (agents/document/session.ts, AgentSession.undoable).
// The line shows when a turn ends on this page, and goes when the next one starts.

/** The agent's last turn in the document open: its changes Undo can still take back, its files, the version before it. */
export interface TurnFacts {
  changes: number;
  files: readonly string[];
  version: string | null;
}

const count = (n: number) => `${n} ${n == 1 ? "change" : "changes"}`;

/** The line for a turn that changed the document. */
export function turnLine(t: Pick<TurnFacts, "changes" | "files">): string {
  const f = t.files;
  const where = !f.length ? "" : f.length == 1 ? ` in ${f[0]}` : f.length == 2 ? ` in ${f[0]} and ${f[1]}` : ` in ${f.length} files`;
  return `Done. ${count(t.changes)}${where}.`;
}

/** Where the line is: no turn seen, one under way, one that ended here, or one taken back (`n` changes). */
type Phase = { at: "none" | "working" | "ended" } | { at: "undone"; n: number };

export function mountTurn(o: {
  el: HTMLElement;
  /** The turn's diff, as text. */
  diff: () => Promise<string>;
  /** Takes the turn back: how many changes went. */
  undo: () => Promise<number>;
  /** After an undo: the counts again. */
  changed: () => void;
  hint: (text: string) => void;
}) {
  let phase: Phase = { at: "none" },
    facts: TurnFacts | null = null;
  const text = document.createElement("span");
  const button = (cls: string, label: string) =>
    Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: label });
  const see = button("see", "See changes"),
    undo = button("undo", "Undo the turn");
  o.el.replaceChildren(text, see, undo);

  function render() {
    const done = phase.at == "ended" && !!facts && facts.changes > 0;
    o.el.hidden = !done && phase.at != "undone";
    text.textContent = phase.at == "undone" ? `Took back ${count(phase.n)}.` : done ? turnLine(facts!) : "";
    see.hidden = !done || !facts?.version;
    undo.hidden = !done;
  }

  undo.addEventListener("click", async () => {
    undo.disabled = true;
    const n = await o.undo().catch(() => 0);
    undo.disabled = false;
    if (n) phase = { at: "undone", n };
    else o.hint("Couldn't undo the agent's turn. Try again.");
    render();
    o.changed();
  });

  let dialog: HTMLDialogElement | null = null;
  see.addEventListener("click", async () => {
    if (!facts?.version) return;
    if (!dialog) {
      dialog = Object.assign(document.createElement("dialog"), { className: "agent-changes" });
      dialog.innerHTML = `<header><h2>What the agent's turn changed</h2><button type="button" class="close" aria-label="Close">Close</button></header><pre></pre>`;
      dialog.querySelector("button")!.addEventListener("click", () => dialog!.close());
      document.body.append(dialog);
    }
    const pre = dialog.querySelector("pre")!;
    pre.textContent = "Loading…";
    dialog.showModal();
    try {
      const diff = (await o.diff()) || "Nothing differs from the text before the turn.";
      // Each line of the diff, in its colour: "+" added, "-" removed, "@@" a place.
      pre.replaceChildren(
        ...diff.split("\n").map((l) =>
          Object.assign(document.createElement("span"), {
            className: /^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^(@@|\+\+\+|---)/.test(l) ? "at" : "",
            textContent: l + "\n",
          })
        )
      );
    } catch (e) {
      pre.textContent = (e as Error).message;
    }
  });

  render();
  return {
    /** The agent works, or stopped: a turn that ends here shows its line. */
    busy(on: boolean) {
      if (on) phase = { at: "working" };
      else if (phase.at == "working") phase = { at: "ended" };
      render();
    },
    /** The turn, as the document's host has it now. */
    facts(t: TurnFacts | null) {
      facts = t;
      render();
    },
  };
}
