// "Share with an agent" on the admin pages: a prompt to paste into an outside agent, with a
// token in it; Copy prompt, and New token, which turns the old one off. On
// every admin page (admin-share.ts: an admin token) it's the card under the
// share button, made here as #share at the end of the body (style.css,
// .share). (The editor's and the viewer's Share with an agent copies a one-line prompt with no token: client/common/agent-prompt.ts.)

import { showCopied } from "../common/copied";

export interface ShareOptions {
  /** The button that opens it (#btn-share). */
  button: HTMLElement;
  title: string;
  /** Above the prompt: what to do with it. */
  intro: string;
  /** Under the buttons, as HTML: what the token can do, and how it ends. */
  note: string;
  /** The token: the current one, or a new one (rotate), which turns the old one off. Rejects with why it couldn't. */
  token(rotate: boolean): Promise<string>;
  /** The prompt that carries the token. */
  prompt(token: string): string;
  /** When it opens: close the page's other cards. */
  onOpen?(): void;
  /** Close it on Escape and on a click outside it (pages that don't do that themselves). */
  dismiss?: boolean;
}

export interface SharePanel {
  el: HTMLElement;
  toggle(force?: boolean): void;
}

export function shareWithAgent(o: ShareOptions): SharePanel {
  const el = document.createElement("div");
  el.id = "share";
  el.className = "help share";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-labelledby", "share-title");
  el.innerHTML = `<h2 id="share-title"></h2>
    <p></p>
    <textarea id="share-prompt" readonly spellcheck="false" aria-label="Prompt for the other agent"></textarea>
    <div class="share-actions">
      <button type="button" id="share-copy" class="share-primary">Copy prompt</button>
      <button type="button" id="share-rotate">New token</button>
      <span id="share-status" class="share-status" role="status" aria-live="polite"></span>
    </div>
    <p class="share-note"></p>`;
  document.body.append(el);
  el.querySelector("h2")!.textContent = o.title;
  el.querySelector("p")!.textContent = o.intro;
  el.querySelector(".share-note")!.innerHTML = o.note;
  const prompt = el.querySelector("textarea")!, status = el.querySelector<HTMLElement>("#share-status")!;
  const copy = el.querySelector<HTMLElement>("#share-copy")!, rotate = el.querySelector<HTMLElement>("#share-rotate")!;
  o.button.setAttribute("aria-controls", "share");
  o.button.setAttribute("aria-expanded", "false");
  let token: string | null = null;

  async function load(fresh: boolean) {
    for (const b of [copy, rotate]) { b.setAttribute("aria-disabled", "true"); b.title = "Getting a token…"; }
    status.textContent = fresh ? "Making a new token…" : "";
    const res = await o.token(fresh).catch((e: Error) => e);
    if (res instanceof Error) {
      token = null;
      prompt.value = "";
      status.textContent = `Couldn't get a token: ${res.message}.`;
      copy.title = "There's no prompt to copy: getting a token failed.";
      rotate.removeAttribute("aria-disabled");
      rotate.title = "Try again";
      return;
    }
    token = res;
    prompt.value = o.prompt(res);
    for (const b of [copy, rotate]) { b.removeAttribute("aria-disabled"); b.title = ""; }
    rotate.title = "Turn this token off and make a new one";
    status.textContent = fresh ? "New token: the old one no longer works." : "";
  }
  function toggle(force?: boolean) {
    const open = typeof force == "boolean" ? force : el.hidden;
    el.hidden = !open;
    o.button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    o.onOpen?.();
    if (!token) load(false);
  }
  o.button.addEventListener("click", () => toggle());
  copy.addEventListener("click", async () => {
    if (!token) { status.textContent = copy.title || "Getting a token…"; return; }
    const copied = await navigator.clipboard.writeText(prompt.value).then(() => true, () => false);
    // No clipboard: the prompt, selected to copy by hand.
    if (!copied) {
      prompt.focus();
      prompt.select();
    }
    status.textContent = copied ? "" : "Couldn't reach the clipboard: the prompt is selected, press ⌘C.";
    if (copied) showCopied(copy);
  });
  rotate.addEventListener("click", () => { if (rotate.getAttribute("aria-disabled") != "true") load(true); });
  if (o.dismiss) {
    document.addEventListener("keydown", (e) => {
      if (e.key == "Escape" && !el.hidden) {
        toggle(false);
        o.button.focus();
      }
    });
    document.addEventListener("mousedown", (e) => {
      if (!el.hidden && !el.contains(e.target as Node) && !o.button.contains(e.target as Node)) toggle(false);
    });
  }
  return { el, toggle };
}
