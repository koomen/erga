// Send feedback: a small dialog on every page of someone signed in (the agent's bundle loads it when it's first asked
// for, client/agent/person-agent.ts). The account menu's Send feedback opens it, and so does any link to "#feedback".
// A text box and Send: Send calls the operation send_feedback with the text and this page's path, then says
// "Thanks, sent." The server keeps it and opens an issue on GitHub with no name (server/feedback.ts).

import { runTool } from "../common/tools";

let dialog: HTMLDialogElement | null = null;

/** Opens the dialog (made the first time), empty and ready to type in. */
export function openFeedback(): void {
  dialog ??= make();
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  form.hidden = false;
  dialog.querySelector<HTMLElement>(".thanks")!.hidden = true;
  said("");
  if (!dialog.open) dialog.showModal();
  form.querySelector("textarea")!.focus();
}

function said(text: string, error = false) {
  const hint = dialog!.querySelector<HTMLElement>(".hint")!;
  hint.textContent = text;
  hint.classList.toggle("error", error);
}

function make(): HTMLDialogElement {
  document.head.insertAdjacentHTML("beforeend", `<style>${STYLE}</style>`);
  const d = document.createElement("dialog");
  d.id = "erga-feedback";
  d.setAttribute("aria-labelledby", "erga-feedback-title");
  d.innerHTML = `<header><h2 id="erga-feedback-title">Send feedback</h2><button type="button" class="close" aria-label="Close">✕</button></header>
<form><p class="sub">What works, what doesn't, what you want. Your text goes to Erga's issue list on GitHub, without your name.</p>
<textarea name="text" rows="6" maxlength="5000" required aria-label="Your feedback" placeholder="Your feedback" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></textarea>
<div class="row"><p class="hint" role="status"></p><button class="pill send">Send</button></div></form>
<div class="thanks" hidden><p role="status">Thanks, sent.</p><button type="button" class="pill done">Close</button></div>`;
  document.body.append(d);
  d.querySelector(".close")!.addEventListener("click", () => d.close());
  d.querySelector(".done")!.addEventListener("click", () => d.close());
  // A click on the backdrop (the dialog itself, outside its content) closes it.
  d.addEventListener("click", (e) => {
    if (e.target == d) d.close();
  });
  const form = d.querySelector("form")!,
    text = form.querySelector("textarea")!,
    send = form.querySelector<HTMLButtonElement>(".send")!;
  // ⌘Enter (Ctrl+Enter) sends, as Send does.
  text.addEventListener("keydown", (e) => {
    if (e.key == "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return said("Write the feedback first.", true);
    send.disabled = true;
    said("Sending…");
    const sent = await runTool("send_feedback", { text: text.value, page: location.pathname }).then(
      () => null,
      (err: Error) => err
    );
    send.disabled = false;
    if (sent) return said(sent.message, true);
    text.value = "";
    said("");
    form.hidden = true;
    d.querySelector<HTMLElement>(".thanks")!.hidden = false;
    d.querySelector<HTMLElement>(".done")!.focus();
  });
  return d;
}

const STYLE = `
#erga-feedback { width: min(520px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--panel-border); border-radius: 14px;
  background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font: 14px/1.45 var(--font-text); }
#erga-feedback [hidden] { display: none !important; }
#erga-feedback::backdrop { background: rgba(0, 0, 0, 0.25); }
#erga-feedback header { position: static; margin: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px;
  border-bottom: 1px solid var(--rule); }
#erga-feedback h2 { margin: 0; font-size: 18px; color: var(--fg-strong); }
#erga-feedback .close { border: 0; background: none; color: var(--chrome); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
#erga-feedback .close:hover { color: var(--chrome-hover); background: var(--code-bg); }
#erga-feedback form, #erga-feedback .thanks { margin: 0; padding: 16px 20px; }
#erga-feedback .sub { margin: 0 0 10px; color: var(--soft); }
#erga-feedback textarea { display: block; box-sizing: border-box; width: 100%; resize: vertical; font: inherit; padding: 8px 10px;
  border: 1px solid var(--panel-border); border-radius: 8px; background: var(--bg); color: var(--fg); }
#erga-feedback .row { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 10px; }
#erga-feedback .hint { flex: 1; margin: 0; color: var(--soft); font-size: 13px; }
#erga-feedback .hint.error { color: #c0392b; }
#erga-feedback .thanks { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
#erga-feedback .thanks p { margin: 0; font-size: 15px; color: var(--fg-strong); }
#erga-feedback .pill { font: inherit; padding: 5px 14px; border: 1px solid var(--panel-border); border-radius: 999px; background: var(--code-bg);
  color: var(--fg); cursor: pointer; }
#erga-feedback .pill:hover { border-color: var(--chrome); }
#erga-feedback .pill:disabled { opacity: 0.6; cursor: default; }
`;
