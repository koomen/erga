// The sign-in dialog: a page's model was asked by someone signed out (client/common/page-llm.ts, llmFetch). The viewer
// shows it around the document's frame; the homepage, which isn't in the viewer, shows it in the page itself. It offers
// the providers that are on (shared/sign-in.ts), each back to `next`. One dialog for each page: a call while it is open
// changes nothing. Escape, its close button and a click outside it close it.

import { PROVIDER_CSS, providerButtons, type SignInChoice } from "../../shared/sign-in";

const CLOSE = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// Erga's dialog (client/inline/app.css: dialog), in its own shadow root: the homepage's own style can't reach it.
const CSS = `
:host { --bg: #fff; --fg: #3a3a40; --fg-strong: #1c1c1f; --soft: #6b6b73; --ring: #e6e6ea; }
@media (prefers-color-scheme: dark) { :host { --bg: #1f1f23; --fg: #c9c9d1; --fg-strong: #ececf1; --soft: #8f8f99; --ring: #2f2f35; } }
dialog { width: min(360px, calc(100vw - 32px)); box-sizing: border-box; padding: 0; border: 1px solid var(--ring); border-radius: 12px;
  background: var(--bg); color: var(--fg); box-shadow: 0 18px 50px rgba(0, 0, 0, .18), 0 1px 2px rgba(0, 0, 0, .06);
  font: 400 14px/1.4 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
dialog::backdrop { background: rgba(0, 0, 0, .18); }
.body { position: relative; padding: 20px; outline: none; }
h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
p { margin: 0 0 14px; color: var(--soft); }
.close { position: absolute; top: 12px; right: 12px; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--soft); cursor: pointer; }
.close:hover { color: var(--fg-strong); background: color-mix(in srgb, var(--fg-strong) 8%, transparent); }
.close:focus-visible { outline: 2px solid #3b7cf0; outline-offset: 2px; }
.providers { max-width: none; }
${PROVIDER_CSS}`;

/** Shows the dialog with `choices`, each back to `next` (`base`: where Erga's paths are); while it's open, nothing. */
export function showSignIn(choices: SignInChoice[], next: string, base = ""): void {
  let host = document.querySelector<HTMLElement>("erga-sign-in");
  if (!host) {
    host = document.createElement("erga-sign-in");
    // The page's own style can't hide it.
    host.style.setProperty("display", "contents", "important");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      `<style>${CSS}</style><dialog aria-labelledby="t"><div class="body" tabindex="-1" autofocus>` +
      `<button class="close" type="button" aria-label="Close">${CLOSE}</button>` +
      `<h2 id="t">Sign in</h2><p>Sign in to use this page's AI.</p><div class="providers"></div></div></dialog>`;
    const dialog = root.querySelector("dialog")!;
    root.querySelector(".close")!.addEventListener("click", () => dialog.close());
    // A click on the backdrop (the dialog itself, outside its content) closes it.
    dialog.addEventListener("click", (e) => {
      if (e.target == dialog) dialog.close();
    });
    // Its keys are its own: not the page's.
    dialog.addEventListener("keydown", (e) => e.stopPropagation());
    (document.body ?? document.documentElement).append(host);
  }
  const dialog = host.shadowRoot!.querySelector("dialog")!;
  if (dialog.open) return;
  host.shadowRoot!.querySelector(".providers")!.innerHTML = choices.length
    ? providerButtons(choices, next, base)
    : "<p>No sign-in is on here.</p>";
  dialog.showModal();
}
