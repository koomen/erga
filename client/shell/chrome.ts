// The quiet chrome: the controls go out of sight while you type and come back as the pointer moves; the on-screen
// keyboard; the quick actions on a phone; the help card; and the document's settings, behind the gear.

import type { Settings } from "../pages/settings";
import { live } from "../live/client";
import { mountQuick } from "../common/quick";
import { $, type Shell } from "./shell";
import { isMac } from "../common/app-keys";

export function mountChrome(shell: Shell) {

  const WAKE_PX = 30, WAKE_MS = 400, TYPING_GRACE_MS = 600;
  let chromeHidden = false;
  let anchor: { x: number; y: number; t: number } | null = null;
  let lastKeyAt = 0;
  function hideChrome() {
    if (chromeHidden || shell.docSettings?.isOpen() || !$("help").hidden || !$("sharing").hidden || !$("naming").hidden || !$("account").hidden) return;
    chromeHidden = true;
    anchor = null;
    document.body.classList.add("chrome-hidden");
  }
  function showChrome() {
    if (!chromeHidden) return;
    chromeHidden = false;
    document.body.classList.remove("chrome-hidden");
  }
  function pointerMoved(e: MouseEvent) {
    if (!chromeHidden) return;
    const now = performance.now();
    if (now - lastKeyAt < TYPING_GRACE_MS) { anchor = null; return; }
    if (!anchor || now - anchor.t > WAKE_MS) { anchor = { x: e.clientX, y: e.clientY, t: now }; return; }
    if (Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) > WAKE_PX) showChrome();
  }
  window.addEventListener("keydown", () => { lastKeyAt = performance.now(); }, true);
  window.addEventListener("mousemove", pointerMoved, { passive: true });

  // The on-screen keyboard. Where the browser lays it over the page instead
  // of resizing the window (Safari), --kb is its height, and the page, the
  // source view, the cards and the agent stop above it. Zoomed
  // in, the visual viewport is small for another reason: none of it is keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const keyboard = () => {
      const kb = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty("--kb", `${kb}px`);
    };
    vv.addEventListener("resize", keyboard);
    vv.addEventListener("scroll", keyboard);
  }

  // On a phone (narrower than 760px) the quick actions open out of your avatar (client/common/quick.ts), as in the viewer;
  // a tap on the page closes them too, while editing (main.ts, onPointer).
  const toggleQuick = mountQuick({
    quick: $("quick"),
    me: $("me"),
    nav: $("nav-docs"),
    bar: document.querySelector<HTMLElement>(".chrome-top")!,
    stack: $("people"),
    // (After the avatar's own click, which opened or closed its menu: people.ts.)
    menuOpen: () => (shell.people.accountLinks ? !$("account").hidden : undefined),
    keep: ".erga-bar-r, .help, .ds-menu, .erga-new-menu, .erga-agent-menu",
  });

  const help = $("help");
  const helpBtn = $("btn-help");
  function toggleHelp(force?: boolean) {
    const open = typeof force == "boolean" ? force : help.hidden;
    help.hidden = !open;
    helpBtn.setAttribute("aria-expanded", String(open));
    if (open) cardOpened("help");
  }
  helpBtn.addEventListener("click", () => toggleHelp());
  /** Closes every card but `keep`. */
  function closeCards(keep?: Card) {
    if (keep != "help") toggleHelp(false);
    if (keep != "sharing") shell.sharing.toggleSharing(false);
    if (keep != "agent") shell.sharing.toggleAgentMenu(false);
    if (keep != "naming") shell.naming.toggleNaming(false);
    if (keep != "pages") shell.naming.togglePages(false);
    if (keep != "account") shell.people.toggleAccount(false);
    if (keep != "settings") shell.docSettings?.toggle(false);
  }
  /** A card opened: the controls show, and the other cards close. */
  function cardOpened(card: Card) {
    showChrome();
    closeCards(card);
  }

  // Document settings (document or project, the homepage, versions): the gear opens
  // them, a popover under it. Their code loads once the editor is idle, or sooner if the gear is reached for.
  const settingsBtn = $("btn-settings");
  let settingsLoading: Promise<Settings | null> | null = null;
  function loadSettings(): Promise<Settings | null> {
    return (settingsLoading ??= import("../pages/settings").then(
      () => {
        shell.docSettings =
          window.ergaSettings?.mount({
            docId: shell.docId,
            query: shell.as,
            anchor: settingsBtn,
            admin: !!shell.people.accountLinks?.admin,
            kind: () => shell.docKind,
            onKind: shell.naming.applyKind,
            onToggle: (open) => open && cardOpened("settings"),
          }) ?? null;
        return shell.docSettings;
      },
      () => {
        settingsLoading = null;
        live((l) => l.check("a request failed"));
        return null;
      }
    ));
  }
  // Once the editor is idle, so that its first click opens them whole (they read what they show as they mount).
  (window.requestIdleCallback ?? setTimeout)(() => void loadSettings());
  for (const type of ["pointerenter", "focus"]) settingsBtn.addEventListener(type, () => void loadSettings(), { once: true });
  settingsBtn.addEventListener("click", async () => {
    const s = await loadSettings();
    if (s) {
      shell.alerts.end("settings");
      s.toggle();
    } else
      shell.alerts.raise({
        key: "settings",
        kind: "error",
        source: "editor",
        title: "Couldn't load the document's settings",
        detail: "Check your connection and try again.",
      });
  });
  if (!isMac) {
    for (const k of help.querySelectorAll("kbd")) {
      if (k.textContent == "⌘") k.textContent = "Ctrl";
      else if (k.textContent == "⌥") k.textContent = "Alt";
      else if (k.textContent == "⇧") k.textContent = "Shift";
    }
    for (const b of document.querySelectorAll<HTMLElement>("[data-tip]")) b.dataset.tip = b.dataset.tip!.replace("⌘⇧", "Ctrl+Shift+").replace("⌘", "Ctrl+");
  }
  return {
    closeCards,
    cardOpened,
    hideChrome,
    showChrome,
    pointerMoved,
    toggleHelp,
    toggleQuick,
    loadSettings,
    keyPressed() {
      lastKeyAt = performance.now();
    },
  };
}

export type Chrome = ReturnType<typeof mountChrome>;
/** The shell's cards, of which one is open at a time. */
type Card = "help" | "sharing" | "agent" | "naming" | "pages" | "account" | "settings";
