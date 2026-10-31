// The Authentication page's script (/admin/auth, server/admin/auth.ts): each provider's switch, and each app's Save,
// Discard and Clear.

import { post, reload, runTool, say } from "../common/admin-post";
import { liveList, refresh } from "../common/live-rows";

export default function adminAuth(): void {
  // A change shows both providers' sections as they are now (each says whether the other is on), and its message under
  // the provider's card.
  const changed = async (provider: string, text: string) => {
    await refresh("auth:github", "auth:google");
    const hint = document.querySelector('section.server[data-provider="' + provider + '"] .hint');
    if (hint) say(hint, text);
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
  /** A provider's section: its switch, and its card's buttons. */
  function wire(section: HTMLElement) {
    // The switch, in the section's header: on or off, with the server's rules (it says why it refuses, in place).
    const box = section.querySelector<HTMLInputElement>(":scope > header input[data-provider]")!;
    box.addEventListener("change", async () => {
      const hint = box.closest("section.provider")!.querySelector(".provider-hint")!;
      say(hint, "Saving…");
      try {
        await runTool("switch_sign_in_provider", { provider: box.dataset.provider!, on: box.checked });
        say(hint, "");
        refresh("auth:github", "auth:google");
      } catch (err) {
        box.checked = !box.checked;
        say(hint, (err as Error).message, true);
      }
    });
    for (const card of section.querySelectorAll<HTMLElement>("section.server")) wireCard(card);
  }
  function wireCard(card: HTMLElement) {
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
        await runTool("clear_sign_in_app", { provider, what: "pending" });
        await changed(provider, "Discarded: sign-in keeps the values in use.");
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
    card.querySelector("button.clear")?.addEventListener("click", async () => {
      if (!confirm("Clear the values set on this page? Sign-in goes back to the deploy's values.")) return;
      say(hint, "Clearing…");
      try {
        const result = await runTool("clear_sign_in_app", { provider });
        await changed(provider, result.message);
      } catch (err) {
        const message = (err as Error).message;
        if (!/force/.test(message) || !confirm(message + "\n\nClear anyway?")) {
          say(hint, message, true);
          return;
        }
        try {
          const result = await runTool("clear_sign_in_app", { provider, force: true });
          await changed(provider, result.message);
        } catch (err2) {
          say(hint, (err2 as Error).message, true);
        }
      }
    });
  }
  const auth = document.querySelector<HTMLElement>("section.auth")!;
  for (const section of auth.querySelectorAll<HTMLElement>(":scope > section.provider")) wire(section);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  liveList(auth, { wire }, window.ergaView?.signal);
}
