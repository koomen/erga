// Share: the document with people (its owner only), and with an external agent.

import { colorFor, type Author } from "../../document/content";
import { shareWithAgent, showCopied } from "../agent/share-agent";
import { runTool } from "../common/tools";
import { BASE, $, type Shell } from "./shell";

export function mountSharing(shell: Shell) {

  // Share with an external agent: a prompt carrying this document's address and your
  // agent token (server/identity/tokens.ts: the share button's, the same until rotated), which
  // lets the agent call the server's API (server/api.ts, /api/tools) as you: this document's
  // tools, with it as "document", and the rest of the server.
  const shareBtn = $("btn-share");
  function promptFor(token: string): string {
    const doc = `${location.origin}${BASE}`;
    return `I'd like your help editing "${shell.info?.path ?? shell.info?.name ?? "the document"}", an Erga document I have open in my editor. You can read and change it through Erga's API, working as my agent: your edits show up in my editor as you make them.

Document: ${doc}
Token: ${token}

Send the token on every request, as the header "Authorization: Bearer ${token}". Name the document in each tool call as "document": "${doc}". Start by reading the API guide, which explains the tools, how to call them, and the rules for pages:

curl -s -H "Authorization: Bearer ${token}" ${location.origin}/llms.txt

The same token works for the rest of Erga as me (my other documents, new ones, publishing a site), if I ask for that.

Once you've read the guide, await further instructions.`;
  }
  const { toggle: loadAgentShare } = shareWithAgent({
    into: $("sharing-agent"),
    title: "Share with an agent",
    intro: "Paste it into Claude Code, Codex or another agent. It edits this page as you.",
    note: `Anyone with this token can act as you on Erga: edit this document as your agent, and your other documents too. New token turns the old one off; <a href="/settings" target="_blank">your settings</a> lists and revokes them all.`,
    token: (rotate) => fetch(shell.api("/api/share"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotate }), signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the host answered ${r.status}`))) as Promise<{ token: string }>)
      .then((r) => r.token, (e: Error) => Promise.reject(e.name == "TimeoutError" ? new Error("the editor's host didn't answer") : e)),
    prompt: promptFor,
    onCopied: () => closeAfterCopy(),
  });

  // Share (#btn-share, the Share card): with people, then with an agent (above). With people: who may view or edit the
  // document, and anyone signed in with the link. Only its owner may (the app says where, meta erga-share), so the
  // card's people half shows for them alone; each change is saved as it's made (the operation share_document, as on My
  // Documents' share dialog).
  const sharing = $("sharing");
  const sharingList = $("sharing-list"),
    sharingAdd = $("sharing-add") as HTMLFormElement;
  const sharingAnyone = $("sharing-anyone") as HTMLSelectElement,
    sharingStatus = $("sharing-status"),
    linkHint = $("sharing-hint"),
    anyoneLabel = document.querySelector<HTMLLabelElement>("label[for=sharing-anyone]")!;
  const shareAt = !!document.querySelector<HTMLMetaElement>('meta[name="erga-share"]');
  $("sharing-people").hidden = !shareAt;
  type Shared = { permissions: { login: string; role: string }[]; notUsers?: string[]; avatars?: Record<string, string>; publicSharing?: boolean };
  const tellSharing = (text: string, error = false) => { sharingStatus.textContent = text; sharingStatus.classList.toggle("error", error); };
  const shareCall = (change?: { login: string; role: string }): Promise<Shared> =>
    change ? runTool("share_document", { document: shell.docId, ...change }) : runTool("document_access", { document: shell.docId });
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
      const picture = avatars?.[p.login] && shell.people.pictureOf({ avatar: avatars[p.login] } as Author);
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
      renderSharing(await shareCall({ login, role }));
      tellSharing("");
      return true;
    } catch (e) {
      tellSharing((e as Error).message, true);
      return false;
    }
  }
  // Where focus was when the card opened (the page, mostly: the Share button doesn't take it), to go back to after a copy.
  let focusBefore: Element | null = null;
  function toggleSharing(force?: boolean) {
    const open = typeof force == "boolean" ? force : sharing.hidden;
    if (open && sharing.hidden) focusBefore = document.activeElement;
    sharing.hidden = !open;
    shareBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    shell.chrome.showChrome(); shell.chrome.toggleHelp(false); shell.naming.toggleNaming(false); shell.naming.togglePages(false); shell.people.toggleAccount(false); shell.docSettings?.toggle(false); shell.pause.showPauseCard(false);
    loadAgentShare(true);
    if (!shareAt) return;
    sharingAdd.reset();
    tellSharing("Loading…");
    (sharingAdd.elements.namedItem("login") as HTMLInputElement).focus();
    shareCall().then((d) => { renderSharing(d); tellSharing(""); }, (e: Error) => tellSharing(e.message, true));
  }
  shareBtn.addEventListener("click", () => toggleSharing());
  sharingAdd.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = sharingAdd.elements.namedItem("login") as HTMLInputElement;
    const login = input.value.trim().replace(/^@/, "");
    if (login && (await changeSharing(login, (sharingAdd.elements.namedItem("role") as HTMLSelectElement).value))) input.value = "";
  });
  sharingAnyone.addEventListener("change", () => changeSharing("*", sharingAnyone.value));
  // Copy link and Copy prompt: the button confirms (showCopied), then the card closes and focus goes back.
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
  return { toggleSharing };
}

export type Sharing = ReturnType<typeof mountSharing>;
