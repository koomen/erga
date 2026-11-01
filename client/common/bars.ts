// The glass bars' buttons (server/pages/bars.ts), on a document's page (client/inline/viewer-bars.ts), on the homepage
// (client/inline/home-controls.ts) and on the app's own pages (client/inline/page-bars.ts): the quick actions on a phone, as the editor's (quick.ts), and Share
// with an agent (agent-prompt.ts). `root`: the page, or the homepage's shadow root; `on`: what carries quick-open.

import { copyAgentPrompt } from "./agent-prompt";
import { mountQuick } from "./quick";

export function mountBars(root: Document | ShadowRoot, on: HTMLElement) {
  const bar = root.querySelector<HTMLElement>(".erga-view-buttons")!,
    me = bar.querySelector<HTMLElement>(".me-slot")!;
  const toggle = mountQuick({
    quick: bar.querySelector<HTMLElement>(".quick")!,
    me,
    // (No breadcrumbs for an agent's view: a box of its own, never shown.)
    nav: root.querySelector<HTMLElement>(".erga-crumbs") ?? document.createElement("nav"),
    bar,
    menuOpen: () => {
      const menu = me.querySelector<HTMLElement>(".erga-account-menu");
      return menu ? !menu.hidden : undefined;
    },
    keep: ".erga-bar-r, .erga-new-menu",
    on,
  });
  // (Only a document's page has it.)
  const share = bar.querySelector<HTMLElement>(".erga-agent-share");
  share?.addEventListener("click", async () => {
    const address = document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content ?? location.pathname;
    if (!(await copyAgentPrompt(share, address))) return;
    // No clipboard: the button says so, where the person looks.
    share.dataset.tip = "Couldn't reach the clipboard";
    share.classList.add("copy-failed");
    setTimeout(() => {
      share.dataset.tip = "Share with an agent";
      share.classList.remove("copy-failed");
    }, 2400);
  });
  return toggle;
}
