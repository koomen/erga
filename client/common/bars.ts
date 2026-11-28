// The glass bars' buttons (server/pages/bars.ts), on a document's page (client/viewer/viewer.ts), on a published site
// (client/inline/site-controls.ts) and on the app's own pages (client/inline/page-bars.ts): breadcrumbs' room on a
// phone (quick.ts), and Share with an agent (agent-menu.ts). `root`: the page, or a published site's shadow root; `on`:
// the body or published site's controls' host.

import { mountAgentMenu } from "./agent-menu";
import { mountQuick } from "./quick";

export function mountBars(root: Document | ShadowRoot, on: HTMLElement) {
  const bar = root.querySelector<HTMLElement>(".erga-view-buttons")!;
  mountQuick({
    // (No breadcrumbs for an agent's view: a box of its own, never shown.)
    nav: root.querySelector<HTMLElement>(".erga-crumbs") ?? document.createElement("nav"),
    bar,
    on,
  });
  // (Every page has it.)
  const share = bar.querySelector<HTMLElement>(".erga-agent-share");
  const agentMenu = share
    ? mountAgentMenu({
        button: share,
        root,
        address: () => document.querySelector<HTMLMetaElement>('meta[name="erga-address"]')?.content ?? location.pathname,
        tokens: root.querySelector<HTMLElement>(".erga-account")?.dataset.ergaAccount == "in",
        // (The editor closes its other cards: client/shell/sharing.ts.)
        onOpen: () => share.dispatchEvent(new Event("erga:agent-menu", { bubbles: true })),
      })
    : null;
  return { agentMenu };
}
