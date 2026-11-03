// Share: the document with people (its owner only), and with an external agent (a prompt to copy).

import { colorFor } from "../../document/content";
import { safeAvatar } from "../../shared/avatars";
import { copyAgentPrompt } from "../common/agent-prompt";
import { showCopied } from "../common/copied";
import { runTool } from "../common/tools";
import { BASE, $, type Shell } from "./shell";

export function mountSharing(shell: Shell) {

  // Share with an agent (#btn-agent-share): a one-line prompt, no token in it (client/common/agent-prompt.ts).
  const agentShare = $("btn-agent-share");
  agentShare.addEventListener("click", async () => {
    const failed = await copyAgentPrompt(agentShare, shell.docName?.address ?? location.pathname);
    if (failed) shell.toast.explain(`Couldn't reach the clipboard. Paste this into your agent: ${failed}`);
  });

  const shareBtn = $("btn-share");
  // Share (#btn-share, the Share card): who may view or edit the document, and anyone signed in with the link. Only its
  // owner may (the app says where, meta erga-share). The button stays for everyone else too, off, and its tip says why
  // (dimmed from the first frame: client/styles/editor.css). Each change is saved as it's made (the operation
  // share_document, as on My Documents' share dialog).
  const sharing = $("sharing");
  const sharingList = $("sharing-list"),
    sharingAdd = $("sharing-add") as HTMLFormElement;
  const sharingAnyone = $("sharing-anyone") as HTMLSelectElement,
    sharingStatus = $("sharing-status"),
    linkHint = $("sharing-hint"),
    anyoneLabel = document.querySelector<HTMLLabelElement>("label[for=sharing-anyone]")!;
  const shareAt = !!document.querySelector<HTMLMetaElement>('meta[name="erga-share"]');
  if (!shareAt) {
    shareBtn.setAttribute("aria-disabled", "true");
    shareBtn.dataset.tip = "Only the owner can share";
    shareBtn.setAttribute("aria-label", "Share: only the document's owner can share it");
  }
  type Shared = { permissions: { login: string; role: string }[]; notUsers?: string[]; avatars?: Record<string, string>; publicSharing?: boolean };
  const tellSharing = (text: string, error = false) => { sharingStatus.textContent = text; sharingStatus.classList.toggle("error", error); };
  const shareCall = (change?: { login: string; role: string }): Promise<Shared> =>
    change
      ? runTool("share_document", { document: shell.docId, ...change })
      : runTool<{ access: Shared }>("ls", { document: shell.docId }).then((r) => r.access);
  function renderSharing({ permissions, notUsers, avatars, publicSharing }: Shared) {
    sharingList.textContent = "";
    const pending = new Set(notUsers ?? []);
    let anyone = "none";
    for (const p of permissions) {
      if (p.login == "*") { anyone = p.role; continue; }
      const li = Object.assign(document.createElement("li"), { className: "share-grid" });
      const face = Object.assign(document.createElement("span"), { className: "face", textContent: p.login.slice(0, 1).toUpperCase() });
      face.setAttribute("aria-hidden", "true");
      face.style.setProperty("--c", colorFor(p.login));
      // Their picture, as the header's avatars show it; the initial stays under it, and shows if it doesn't load.
      const picture = avatars?.[p.login] && safeAvatar(avatars[p.login]);
      if (picture) {
        const img = Object.assign(document.createElement("img"), {
          src: picture,
          alt: "",
          draggable: false,
          referrerPolicy: "no-referrer",
        });
        img.addEventListener("error", () => img.remove());
        face.append(img);
      }
      li.append(face);
      const who = Object.assign(document.createElement("span"), { className: "who", textContent: p.login });
      if (p.login == shell.me.user) who.append(Object.assign(document.createElement("small"), { textContent: "you" }));
      if (pending.has(p.login)) who.append(Object.assign(document.createElement("small"), { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" }));
      li.append(who);
      if (p.role == "owner") li.append(Object.assign(document.createElement("span"), { className: "fixed", textContent: "Owner" }), document.createElement("span"));
      else {
        const role = Object.assign(document.createElement("select"), { className: "role" });
        role.setAttribute("aria-label", `Role for ${p.login}`);
        for (const [v, t] of [["editor", "Can edit"], ["viewer", "Can view"]]) role.append(new Option(t, v, false, v == p.role));
        role.addEventListener("change", () => changeSharing(p.login, role.value));
        const x = Object.assign(document.createElement("button"), { type: "button", className: "remove", textContent: "×", title: `Stop sharing with ${p.login}` });
        x.setAttribute("aria-label", x.title);
        x.addEventListener("click", () => changeSharing(p.login, "none"));
        li.append(role, x);
      }
      sharingList.append(li);
    }
    sharingAnyone.value = anyone;
    // Anyone with the link, only while the server lets users share content publicly; a share made before stays, to stop.
    const offered = !!publicSharing || anyone != "none";
    sharingAnyone.hidden = !offered;
    for (const o of sharingAnyone.options) o.disabled = !publicSharing && o.value != "none" && o.value != anyone;
    // Who the link lets in, where its menu doesn't say: no menu, or a share made before public sharing went off.
    linkHint.textContent = !offered ? "only people added" : !publicSharing && anyone != "none" ? "they sign in first" : "";
    anyoneLabel.textContent = offered ? "Anyone with the link" : "Link";
  }
  async function changeSharing(login: string, role: string): Promise<boolean> {
    tellSharing("Saving…");
    try {
      renderSharing((last = await shareCall({ login, role })));
      tellSharing("");
      return true;
    } catch (e) {
      tellSharing((e as Error).message, true);
      return false;
    }
  }
  // Who it's shared with: read once the editor is idle, again behind as the pointer or focus comes to Share, and after
  // each change. A click opens the card at once with the last answer; while it's open, a fresher one redraws it.
  let last: Shared | null = null,
    readAt = 0;
  function reread() {
    if (!shareAt || Date.now() - readAt < 2000) return;
    readAt = Date.now();
    shareCall().then(
      (d) => {
        last = d;
        if (!sharing.hidden) renderSharing(d);
      },
      (e: Error) => {
        readAt = 0;
        if (!sharing.hidden && !last) tellSharing(e.message, true);
      }
    );
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
    sharingAdd.reset();
    if (last) {
      renderSharing(last);
      tellSharing("");
    } else tellSharing("Loading…");
    (sharingAdd.elements.namedItem("login") as HTMLInputElement).focus();
    reread();
  }
  shareBtn.addEventListener("click", () => {
    if (shareAt) toggleSharing();
  });
  sharingAdd.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = sharingAdd.elements.namedItem("login") as HTMLInputElement;
    const login = input.value.trim().replace(/^@/, "");
    if (login && (await changeSharing(login, (sharingAdd.elements.namedItem("role") as HTMLSelectElement).value))) input.value = "";
  });
  sharingAnyone.addEventListener("change", () => changeSharing("*", sharingAnyone.value));
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
    const ok = await navigator.clipboard.writeText(url).then(() => true, () => false);
    if (!ok) { tellSharing(url); return; }
    showCopied(copyLink, closeAfterCopy);
  });
  /** Its sharing changed (anyone's doing: another tab, an agent): an open card reads it again. */
  function accessChanged() {
    if (sharing.hidden || !shareAt) return;
    shareCall().then(renderSharing, () => {});
  }
  return { toggleSharing, accessChanged };
}

export type Sharing = ReturnType<typeof mountSharing>;
