// The account corner's menu (server/pages/account-menu.ts, accountHtml): the script after the corner and its style.
// It opens and closes the menu, and makes each control's tooltip on the page follow the pointer.

import { fastClick } from "../common/fast-click";
import { imgFallback } from "../common/img-fallback";
import { installQuickSearch } from "../common/quick-search";

export default function accountMenu(): void {
  const root = document.currentScript!.previousElementSibling!.previousElementSibling!,
    btn = root.querySelector("button")!,
    menu = root.querySelector<HTMLElement>(".erga-account-menu")!;
  imgFallback(root);
  // ⌘K, for someone signed in: on a document's page, from inside its frame too.
  if ((root as HTMLElement).dataset.ergaAccount == "in") installQuickSearch((e) => typeof ergaFrames != "undefined" && ergaFrames.from(e));
  const show = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", () => {
    show(!!menu.hidden);
    if (!menu.hidden) menu.querySelector("a")?.focus({ preventScroll: true });
  });
  // It opens as the press starts (client/common/fast-click.ts).
  fastClick(root, ".erga-account-btn");
  document.addEventListener("pointerdown", (e) => {
    if (!root.contains(e.target as Node)) show(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key == "Escape" && !menu.hidden) {
      show(false);
      btn.focus();
    }
  });
  window.addEventListener("blur", () => show(false));
  // Every control's tooltip on the page (the editor's too) follows the pointer while it's on the control: where, for its CSS.
  document.addEventListener(
    "pointermove",
    (e) => {
      const el = e.pointerType == "mouse" && (e.target as Element).closest?.<HTMLElement>("[data-tip]");
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Clear of the pointer's arrow, which reaches down and right of its tip.
      el.style.setProperty("--tip-x", e.clientX - r.left - 6 + "px");
      el.style.setProperty("--tip-y", e.clientY - r.top + 30 + "px");
    },
    { passive: true }
  );
}
