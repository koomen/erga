// "Share with an agent": a prompt to paste into an outside agent, with a
// token in it; Copy prompt, and New token, which turns the old one off. On
// every admin page (admin-share.ts: an admin token) it's the card under the
// share button, made here as #share at the end of the body (style.css,
// .share). In the editor (main.ts: your agent token, for this document) it's
// the lower half of the Share card (client/editor.html, #sharing-agent): `into` says
// where, the card opens and closes it, and the prompt shows on request.

export interface ShareOptions {
  /** The button that opens it (#btn-share); not with `into`. */
  button?: HTMLElement;
  /** Fill this part of a card instead, which opens and closes it (toggle(true) when it opens: the token loads then). */
  into?: HTMLElement;
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
  const el = o.into ?? document.createElement("div");
  if (o.into) {
    // A half of the editor's Share card: the prompt and New token show on request ("Show the prompt").
    el.innerHTML = `<h2 id="share-title"></h2>
      <p class="share-lede"></p>
      <div class="share-actions">
        <button type="button" id="share-copy" class="share-primary">Copy prompt</button>
        <button type="button" id="share-show" class="share-show" aria-expanded="false" aria-controls="share-more">Show the prompt</button>
        <span id="share-status" class="share-status" role="status" aria-live="polite"></span>
      </div>
      <div id="share-more" class="share-more" hidden>
        <textarea id="share-prompt" readonly spellcheck="false" aria-label="Prompt for the other agent"></textarea>
        <div class="share-actions"><button type="button" id="share-rotate">New token</button></div>
        <p class="share-note"></p>
      </div>`;
    const show = el.querySelector<HTMLElement>("#share-show")!, more = el.querySelector<HTMLElement>("#share-more")!;
    show.addEventListener("click", () => {
      more.hidden = !more.hidden;
      show.setAttribute("aria-expanded", String(!more.hidden));
      show.textContent = more.hidden ? "Show the prompt" : "Hide the prompt";
    });
  } else {
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
  }
  el.querySelector("h2")!.textContent = o.title;
  el.querySelector("p")!.textContent = o.intro;
  el.querySelector(".share-note")!.innerHTML = o.note;
  const prompt = el.querySelector("textarea")!, status = el.querySelector<HTMLElement>("#share-status")!;
  const copy = el.querySelector<HTMLElement>("#share-copy")!, rotate = el.querySelector<HTMLElement>("#share-rotate")!;
  if (o.button) {
    o.button.setAttribute("aria-controls", "share");
    o.button.setAttribute("aria-expanded", "false");
  }
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
    // In a card of its own: it opens and closes. A half of one: the card does that, and opening loads the token.
    if (o.into) { if (force && !token) load(false); return; }
    const open = typeof force == "boolean" ? force : el.hidden;
    el.hidden = !open;
    o.button?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    o.onOpen?.();
    if (!token) load(false);
  }
  o.button?.addEventListener("click", () => toggle());
  copy.addEventListener("click", async () => {
    if (!token) { status.textContent = copy.title || "Getting a token…"; return; }
    const copied = await navigator.clipboard.writeText(prompt.value).then(() => true, () => false);
    // No clipboard: the prompt, selected to copy by hand (shown first, where it waits behind "Show the prompt").
    if (!copied) { el.querySelector<HTMLElement>("#share-more")?.removeAttribute("hidden"); prompt.focus(); prompt.select(); }
    status.textContent = copied ? "Copied" : "Couldn't reach the clipboard: the prompt is selected, press ⌘C.";
  });
  rotate.addEventListener("click", () => { if (rotate.getAttribute("aria-disabled") != "true") load(true); });
  if (o.dismiss) {
    document.addEventListener("keydown", (e) => { if (e.key == "Escape" && !el.hidden) { toggle(false); o.button?.focus(); } });
    document.addEventListener("mousedown", (e) => { if (!el.hidden && !el.contains(e.target as Node) && !o.button?.contains(e.target as Node)) toggle(false); });
  }
  return { el, toggle };
}
