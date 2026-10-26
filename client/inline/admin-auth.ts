// The Authentication page's script (/admin/auth, server/admin/auth.ts): each provider's switch, and each app's Save,
// Discard and Clear.

import { post, reload, say } from "../common/admin-post";

export interface AuthConfig {
  /** Where the changes go: POST /admin/auth. */
  action: string;
}

export default function adminAuth(c: AuthConfig): void {
  // A change shows the page again in place (reload), and its message under the provider's card in the new page: it
  // waits in sessionStorage through the reload (a whole page's too, without the admin shell).
  const SAID = "erga:admin-auth-said";
  const sayAfter = (provider: string, text: string) => {
    try {
      sessionStorage.setItem(SAID, JSON.stringify({ provider, text }));
    } catch {}
  };
  try {
    const said = JSON.parse(sessionStorage.getItem(SAID) || "null");
    sessionStorage.removeItem(SAID);
    const hint = said && document.querySelector('section.server[data-provider="' + said.provider + '"] .hint');
    if (hint) say(hint, said.text);
  } catch {}
  const changed = async (provider: string, text: string) => {
    sayAfter(provider, text);
    await reload();
  };
  // A check GitHub or Google didn't answer in time: the page asks again by itself, a few times, while it's open.
  const RETRIES = "erga:admin-auth-retries";
  let tries = 0;
  try {
    tries = Number(sessionStorage.getItem(RETRIES)) || 0;
  } catch {}
  if (document.querySelector('section.server[data-state="unknown"]') && tries < 3) {
    const timer = setTimeout(
      () => {
        try {
          sessionStorage.setItem(RETRIES, String(tries + 1));
        } catch {}
        reload();
      },
      5000 * (tries + 1)
    );
    window.ergaView?.onLeave(() => clearTimeout(timer));
  } else {
    try {
      sessionStorage.removeItem(RETRIES);
    } catch {}
  }
  // Each provider's switch, in its section's header: on or off, with the server's rules (it says why it refuses, in place).
  for (const box of document.querySelectorAll<HTMLInputElement>("section.provider > header input[data-provider]"))
    box.addEventListener("change", async () => {
      const hint = box.closest("section.provider")!.querySelector(".provider-hint")!;
      say(hint, "Saving…");
      try {
        await post(c.action, { do: "providers", provider: box.dataset.provider!, on: box.checked ? "1" : "0" });
        reload();
      } catch (err) {
        box.checked = !box.checked;
        say(hint, (err as Error).message, true);
      }
    });
  for (const card of document.querySelectorAll<HTMLElement>("section.server")) {
    const hint = card.querySelector(".hint")!,
      provider = card.dataset.provider!;
    for (const b of card.querySelectorAll<HTMLButtonElement>("button.copy"))
      b.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy!);
          b.textContent = "Copied";
          setTimeout(() => {
            b.textContent = "Copy";
          }, 1500);
        } catch {}
      });
    const form = card.querySelector<HTMLFormElement>("form.configure");
    const value = (name: string) => (form!.elements.namedItem(name) as HTMLInputElement).value;
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hint, "Checking the values…");
      try {
        const { result } = await post(form.action, { do: "save", provider, clientId: value("clientId"), secret: value("secret") });
        await changed(provider, result.message);
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
    card.querySelector("button.discard")?.addEventListener("click", async () => {
      if (!confirm("Discard the new values? Sign-in keeps the values in use.")) return;
      try {
        await post(form!.action, { do: "discard", provider });
        await changed(provider, "Discarded: sign-in keeps the values in use.");
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
    card.querySelector("button.clear")?.addEventListener("click", async () => {
      if (!confirm("Clear the values set on this page? Sign-in goes back to the deploy's values.")) return;
      say(hint, "Clearing…");
      try {
        const { result } = await post(form!.action, { do: "clear", provider });
        await changed(provider, result.message);
      } catch (err) {
        const message = (err as Error).message;
        if (!/force/.test(message) || !confirm(message + "\n\nClear anyway?")) {
          say(hint, message, true);
          return;
        }
        try {
          const { result } = await post(form!.action, { do: "clear", provider, force: "1" });
          await changed(provider, result.message);
        } catch (err2) {
          say(hint, (err2 as Error).message, true);
        }
      }
    });
  }
}
