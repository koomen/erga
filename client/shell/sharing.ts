// Share: the document with people (its owner only), and with an external agent (a prompt to copy).

import { colorFor } from "../../document/content";
import { showCopied } from "../common/copied";
import { shareList } from "../common/share-list";
import { BASE, $, type Shell } from "./shell";

export function mountSharing(shell: Shell) {

  // Share with an agent (#btn-agent-share): the bar's own menu (client/common/bars.ts), viewing and editing. When it
  // opens, the editor's other cards close.
  const agentMenu = window.ergaAgentMenu;
  $("btn-agent-share").addEventListener("erga:agent-menu", () => shell.chrome.cardOpened("agent"));

  const shareBtn = $("btn-share");
  // Share (#btn-share, the Share card): who may view or edit the document, and anyone signed in with the link. Only its
  // owner may (the app says where, meta erga-share). The button stays for everyone else too, off, and its tip says why
  // (dimmed from the first frame: client/styles/editor.css). The list and its changes are client/common/share-list.ts's,
  // as on My Documents' share dialog.
  const sharing = $("sharing");
  const sharingAnyone = $("sharing-anyone") as HTMLSelectElement,
    linkHint = $("sharing-hint"),
    anyoneLabel = document.querySelector<HTMLLabelElement>("label[for=sharing-anyone]")!;
  const shareAt = !!document.querySelector<HTMLMetaElement>('meta[name="erga-share"]');
  if (!shareAt) {
    shareBtn.setAttribute("aria-disabled", "true");
    shareBtn.dataset.tip = "Only the owner can share";
    shareBtn.setAttribute("aria-label", "Share: only the document's owner can share it");
  }
  const list = shareList({
    doc: () => shell.docId,
    me: () => shell.me.user,
    people: $("sharing-list"),
    add: $("sharing-add") as HTMLFormElement,
    anyone: sharingAnyone,
    status: $("sharing-status"),
    shown: () => !sharing.hidden,
    look: { row: "share-grid", role: "role", remove: { className: "remove", innerHTML: "×" }, color: colorFor },
    link(offered, publicSharing) {
      sharingAnyone.hidden = !offered;
      // Who the link lets in, where its menu doesn't say: no menu, or a share made before public sharing went off.
      linkHint.textContent = !offered ? "only people added" : !publicSharing ? "they sign in first" : "";
      anyoneLabel.textContent = offered ? "Anyone with the link" : "Link";
    },
  });
  // Who it's shared with: read once the editor is idle, again behind as the pointer or focus comes to Share, and after
  // each change. A click opens the card at once with the last answer; while it's open, a fresher one redraws it.
  let readAt = 0;
  function reread() {
    if (!shareAt || Date.now() - readAt < 2000) return;
    readAt = Date.now();
    void list.read().then((ok) => {
      if (!ok) readAt = 0;
    });
  }
  (window.requestIdleCallback ?? setTimeout)(reread);
  shareBtn.addEventListener("pointerenter", reread);
  shareBtn.addEventListener("focus", reread);
  // Where focus was when the card opened (the page, mostly: the Share button doesn't take it), to go back to after a copy.
  let focusBefore: Element | null = null;
  function toggleSharing(force?: boolean) {
    const open = typeof force == "boolean" ? force : !!sharing.hidden;
    if (open && sharing.hidden) focusBefore = document.activeElement;
    show(open);
  }
  function show(open = true) {
    sharing.hidden = !open;
    shareBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    shell.chrome.cardOpened("sharing");
    if (!shareAt) return;
    list.open();
    reread();
  }
  shareBtn.addEventListener("click", () => {
    if (shareAt) toggleSharing();
  });
  // Copy link: the button confirms (showCopied), then the card closes and focus goes back.
  function closeAfterCopy() {
    if (sharing.hidden) return;
    toggleSharing(false);
    if (!focusBefore || focusBefore == document.body || focusBefore instanceof HTMLIFrameElement) shell.page.focus();
    else (focusBefore as HTMLElement).focus?.();
  }
  const copyLink = $("sharing-copy");
  copyLink.addEventListener("click", async () => {
    const url = location.origin + (shell.docName?.address ?? location.pathname);
    const ok = await navigator.clipboard.writeText(url).then(
      () => true,
      () => false
    );
    if (!ok) {
      list.tell(url);
      return;
    }
    showCopied(copyLink, closeAfterCopy);
  });
  /** Its sharing changed (anyone's doing: another tab, an agent): an open card reads it again. */
  function accessChanged() {
    if (sharing.hidden || !shareAt) return;
    void list.read();
  }
  return { toggleSharing, accessChanged, toggleAgentMenu: (force?: boolean) => agentMenu?.toggle(force) };
}

export type Sharing = ReturnType<typeof mountSharing>;
