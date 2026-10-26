// Share: the document with people (its owner only), and with an external agent.

import { colorFor, type Author } from "../../document/content";
import { BASE } from "./base";
import { shareWithAgent } from "../agent/share-agent";
import { $, type Shell } from "./shell";

export function mountSharing(shell: Shell) {

  // Share with an external agent: a prompt carrying this page's API and your
  // agent token (server/identity/tokens.ts: the share button's, the same until rotated), which
  // lets the agent call your agent's tools here (document/host.ts, /api/ext) and act
  // as you on the rest of the server.
  const shareBtn = $("btn-share");
  function promptFor(token: string): string {
    const api = `${location.origin}${BASE}/api/ext`;
    return `I'd like your help editing "${shell.info?.path ?? shell.info?.name ?? "the document"}", an Erga document I have open in my editor. You can read and change it through the editor's API, working as my agent: your edits show up in my editor as you make them.

API: ${api}
Token: ${token}

Send the token on every request, as the header "Authorization: Bearer ${token}". Start by reading the API guide, which explains the tools and how to call them:

curl -s -H "Authorization: Bearer ${token}" ${api}

The same token works for the rest of Erga as me (my other documents, new ones, publishing a site): ${location.origin}/api/ext explains it, if I ask for that.

Once you've read the guide, await further instructions.`;
  }
  const { toggle: loadAgentShare } = shareWithAgent({
    into: $("sharing-agent"),
    title: "Share with an agent",
    intro: "Paste a prompt into Claude Code, Codex or another agent that can run commands. It edits this page as you.",
    note: `Anyone with this token can act as you on Erga: edit this document as your agent, and your other documents too. New token turns the old one off; <a href="/settings" target="_blank">your settings</a> lists and revokes them all.`,
    token: (rotate) => fetch(shell.api("/api/share"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotate }), signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the host answered ${r.status}`))) as Promise<{ token: string }>)
      .then((r) => r.token, (e: Error) => Promise.reject(e.name == "TimeoutError" ? new Error("the editor's host didn't answer") : e)),
    prompt: promptFor,
  });

  // Share (#btn-share, the Share card): with people, then with an agent (above). With people: who may view or edit the
  // document, and anyone signed in with the link. Only its owner may (the front door says where, meta erga-share), so the
  // card's people half shows for them alone; each change is saved as it's made (/docs/share, as on My Documents' share dialog).
  const sharing = $("sharing");
  const sharingList = $("sharing-list"), sharingAdd = $("sharing-add") as HTMLFormElement;
  const sharingAnyone = $("sharing-anyone") as HTMLSelectElement, sharingStatus = $("sharing-status"), anyoneLabel = document.querySelector<HTMLLabelElement>("label[for=sharing-anyone]")!;
  const shareAt = document.querySelector<HTMLMetaElement>('meta[name="erga-share"]')?.content ?? "";
  $("sharing-people").hidden = !shareAt;
  type Shared = { permissions: { login: string; role: string }[]; notUsers?: string[]; avatars?: Record<string, string>; publicSharing?: boolean };
  const tellSharing = (text: string, error = false) => { sharingStatus.textContent = text; sharingStatus.classList.toggle("error", error); };
  async function shareCall(change?: { login: string; role: string }): Promise<Shared> {
    const r = await fetch(change ? shareAt : `${shareAt}${shareAt.includes("?") ? "&" : "?"}id=${shell.docId}`,
      change ? { method: "POST", body: new URLSearchParams({ id: shell.docId, ...change }), headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) } : { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body as Shared;
  }
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
    linkHint = publicSharing ? (anyone == "none" ? "only the people it's shared with" : "anyone may view it, signed in or not")
      : anyone == "none" ? "only the people it's shared with" : "public sharing is off here: they sign in first";
    if (copied.textContent != "Copied") copied.textContent = linkHint;
    anyoneLabel.textContent = offered ? "Anyone with the link" : "Link";
  }
  async function changeSharing(login: string, role: string): Promise<boolean> {
    tellSharing("Saving…");
    try { renderSharing(await shareCall({ login, role })); tellSharing(""); return true; }
    catch (e) { tellSharing((e as Error).message, true); return false; }
  }
  function toggleSharing(force?: boolean) {
    const open = typeof force == "boolean" ? force : sharing.hidden;
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
  const copied = $("sharing-copied");
  let linkHint = copied.textContent;
  let copiedTimer = 0;
  $("sharing-copy").addEventListener("click", async () => {
    const url = location.origin + (shell.docName?.address ?? location.pathname);
    const ok = await navigator.clipboard.writeText(url).then(() => true, () => false);
    if (!ok) { tellSharing(url); return; }
    copied.textContent = "Copied";
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copied.textContent = linkHint; }, 2000);
  });
  return { toggleSharing };
}

export type Sharing = ReturnType<typeof mountSharing>;
