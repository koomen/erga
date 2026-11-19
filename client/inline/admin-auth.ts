// The Sign-in page's script (/admin/auth, server/admin/auth.ts): each provider's switch, and each app's values
// (Replace opens their form), Discard and Remove. The switch and the values save by themselves, with no Save button (client/common/autosave.ts): the
// switch at once; an app's Client ID and secret together, once both are there, when the typing pauses or the focus
// leaves the form. The save mark left of the buttons' bar says how far it is; refused, the value stays, with the
// server's reason under it.

import { post, reload, runTool, say } from "../common/admin-post";
import { saveMark } from "../common/admin-save";
import { autosave } from "../common/autosave";
import { liveList, refresh } from "../common/live-rows";

export default function adminAuth(): void {
  const mark = saveMark();
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
    const box = section.querySelector<HTMLInputElement>(":scope > header input[data-provider]")!,
      key = `${section.dataset.live}:on`;
    // (The section as the server has it now: what an older one was saving counts no more.)
    mark.set(key, "saved");
    const on = autosave({
      mark,
      key,
      label: box.getAttribute("aria-label") ?? "Sign-in",
      row: section,
      read: () => String(box.checked),
      saved: String(box.checked),
      save: (value) => runTool("set_sign_in", { provider: box.dataset.provider!, action: value == "true" ? "on" : "off" }),
      ended(why) {
        // (The hint of the section on the page now: a change heard meanwhile may have drawn it again.)
        const hint = document.querySelector(`section.provider[data-live="${section.dataset.live}"] .provider-hint`);
        if (hint) say(hint, why ?? "", !!why);
        box.toggleAttribute("aria-invalid", !!why);
        if (!why) void refresh("auth:github", "auth:google");
      },
    });
    box.addEventListener("change", () => on.changed(true));
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
    // Replace: the form to set other values, in the place of the buttons; Escape in it, with nothing typed, closes it.
    const row = card.querySelector<HTMLElement>(".secret-row");
    card.querySelector(".replace")?.addEventListener("click", () => {
      row!.hidden = true;
      form!.hidden = false;
      (form!.elements.namedItem("clientId") as HTMLInputElement).focus();
    });
    form?.addEventListener("keydown", (e) => {
      if (e.key != "Escape" || !row) return;
      if ([...form.querySelectorAll<HTMLInputElement>("input.input")].some((i) => i.value.trim())) return;
      form.hidden = true;
      row.hidden = false;
      row.querySelector<HTMLElement>(".replace")?.focus();
    });
    const appKey = `auth:${provider}:app`;
    mark.set(appKey, "saved");
    if (form) {
      const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
      /** What the server said of the values it took. */
      let message = "";
      const app = autosave({
        mark,
        key: appKey,
        label: `The ${provider == "github" ? "GitHub" : "Google"} app's values`,
        row: card.closest<HTMLElement>("section.provider")!,
        // (Both values as one: a line break is in neither.)
        read: () => (value("clientId") || value("secret") ? `${value("clientId")}\n${value("secret")}` : ""),
        saved: "",
        // (One value alone waits for the other, until the focus leaves the form.)
        ready: () => !!value("clientId") && !!value("secret"),
        async save() {
          message = (await post(form.action, { do: "save", provider, clientId: value("clientId"), secret: value("secret") })).result
            .message;
        },
        ended(why) {
          say(hint, why ?? "", !!why);
          for (const name of ["clientId", "secret"])
            (form.elements.namedItem(name) as HTMLInputElement).toggleAttribute("aria-invalid", !!why);
          // Saved: the card again, as the server has it (its form empty: the page keeps no secret), with what the server said.
          if (!why && value("clientId")) {
            app.stop();
            void changed(provider, message);
          }
        },
      });
      form.addEventListener("input", () => app.changed(false));
      form.addEventListener("focusout", (e) => {
        if (!form.contains(e.relatedTarget as Node | null)) app.changed(true);
      });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        app.changed(true);
      });
    }
    card.querySelector("button.discard")?.addEventListener("click", async () => {
      if (!confirm("Discard the new values? Sign-in keeps the values in use.")) return;
      try {
        await runTool("set_sign_in", { provider, action: "discard" });
        await changed(provider, "Discarded: sign-in keeps the values in use.");
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
    card.querySelector("button.clear")?.addEventListener("click", async () => {
      if (!confirm("Remove the values set on this page? Sign-in goes back to the deploy's values.")) return;
      say(hint, "Clearing…");
      try {
        const result = await runTool("set_sign_in", { provider, action: "clear" });
        await changed(provider, result.message);
      } catch (err) {
        const message = (err as Error).message;
        if (!/force/.test(message) || !confirm(message + "\n\nClear anyway?")) {
          say(hint, message, true);
          return;
        }
        try {
          const result = await runTool("set_sign_in", { provider, action: "clear", force: true });
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
