// Presence: everyone's carets, the avatars of who's here, and your own avatar's account menu.

import type { Peer } from "../page-editor/editor";
import type { Presence } from "./collab";
import type { Author } from "../../document/content";
import { $, type Shell } from "./shell";
import { safeAvatar } from "../../shared/avatars";

export function mountPeople(shell: Shell) {

  // Everyone's caret on the page (or in the source view), with their name;
  // an agent's, dashed, while it works. The avatars at the
  // top say who's here and what each agent is doing. A person with several
  // tabs open is shown by the one they used last, and your own other tabs
  // not at all (Collab.shown).
  function busyAgents(): string[] {
    return shell.collab.others().filter((p) => p.user.kind == "agent" && p.busy).map((p) => p.user.name);
  }
  function presenceChanged() {
    shell.room.setAgentBusy(busyAgents().length > 0 || shell.agent.log.busy);
    renderPeople();
    queuePeers();
  }
  let peersQueued = false;
  function queuePeers() {
    if (peersQueued) return;
    peersQueued = true;
    requestAnimationFrame(() => { peersQueued = false; paintPeers(); });
  }
  function paintPeers() {
    const peers: Peer[] = [];
    for (const p of shell.collab.shown()) {
      // An agent's caret shows while it works, so its edits read like a
      // person's typing; once it's idle, a caret left where it last edited
      // would only linger and distract.
      const agent = p.user.kind == "agent";
      if (agent && !p.busy) continue;
      const at = shell.collab.positions(p);
      if (!at) continue;
      peers.push({
        key: p.client,
        name: p.user.name,
        color: p.user.color,
        anchor: at.anchor,
        head: at.head,
        agent,
        activity: agent ? (p.activity ?? null) : null,
      });
    }
    if (shell.sourceView && shell.source) shell.sourceView.dispatch({ effects: shell.source.setPeers.of(peers) });
    else shell.page.setPeers(peers);
  }
  // This tab's caret, for everyone else. It stays where you left it when
  // you switch away, as a caret on paper would (but with another of your
  // tabs in use since, that one's caret is shown instead).
  let cursorQueued = false;
  function queueCursor() {
    if (cursorQueued) return;
    cursorQueued = true;
    requestAnimationFrame(() => {
      cursorQueued = false;
      const sel = shell.currentState().selection.main;
      shell.collab.setCursor(sel.anchor, sel.head);
    });
  }

  const people = $("people"), meSlot = $("me");
  function renderPeople() {
    // One avatar per person: everyone else on the left of the controls, you
    // at the far right. A person's agent, once it has done
    // something, is a small badge on their avatar that spins while it works.
    const persons = new Map<string, Presence>(), agents = new Map<string, Presence>();
    for (const p of shell.collab.shown()) {
      if (p.user.kind == "agent") {
        if (!p.busy && !p.cursor) continue;
        const prev = agents.get(p.user.user);
        if (!prev || (p.busy && !prev.busy)) agents.set(p.user.user, p);
      } else if (p.user.kind == "person") persons.set(p.user.user, p);
    }
    const all: { p: Presence; here: boolean }[] = [{ p: { client: -1, user: shell.me } as Presence, here: true }, ...[...persons.values()].map((p) => ({ p, here: true }))];
    // An agent keeps working with its person's tabs closed: show them, faded, to carry it.
    for (const [user, a] of agents) {
      if (user != shell.me.user && !persons.has(user)) all.push({ p: { client: -2, user: { user, name: a.user.name.replace(/[’']s agent$/, ""), color: a.user.color, kind: "person" } } as Presence, here: false });
    }
    people.textContent = meSlot.textContent = "";
    for (const { p, here } of all) {
      const wrap = document.createElement("span");
      wrap.className = "person";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "avatar" + (p.client == -1 ? " me" : "") + (here ? "" : " away");
      b.style.setProperty("--c", p.user.color);
      b.textContent = (p.user.name.trim()[0] ?? "?").toUpperCase();
      const picture = pictureOf(p.user);
      if (picture) {
        const img = document.createElement("img");
        img.src = picture;
        img.alt = "";
        img.draggable = false; // a click, not the browser's drag of the picture
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => img.remove()); // the initial shows through
        b.append(img);
      }
      b.dataset.tip = p.client == -1 ? `You (${shell.me.name})` : here ? p.user.name : `${p.user.name} (not here)`;
      if (p.client == -1) accountButton(b);
      else if (here) revealOnClick(b, p, " (not in the text yet)");
      else b.setAttribute("aria-disabled", "true");
      b.setAttribute("aria-label", b.dataset.tip);
      wrap.append(b);
      const a = agents.get(p.user.user);
      if (a) {
        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = "agent-badge" + (a.busy ? " busy" : "");
        badge.style.setProperty("--c", a.user.color);
        badge.innerHTML = `<span aria-hidden="true">✦</span>`;
        badge.dataset.tip = `${a.user.name}: ${a.busy ? a.activity ?? "working" : "idle"}`;
        revealOnClick(badge, a, " (hasn't edited yet)");
        badge.setAttribute("aria-label", badge.dataset.tip);
        wrap.append(badge);
      }
      (p.client == -1 ? meSlot : people).append(wrap);
    }
  }
  // Your avatar opens a small menu: who you are, Documents, Settings,
  // Deploy your own if the deploy_page setting lets you, Admin settings if you're an admin, Sign out (the same as every other page's upper
  // right, server/pages/account-menu.ts). The front door says which links (meta erga-account).
  const account = $("account");
  const accountLinks = (() => {
    try { return JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="erga-account"]')?.content ?? "") as { docs?: string; settings?: string; deploy?: string; admin?: string; signOut?: string }; } catch { return null; }
  })();
  let accountBtn: HTMLElement | null = null;
  function accountButton(b: HTMLElement) {
    accountBtn = b;
    if (!accountLinks) { b.setAttribute("aria-disabled", "true"); return; }
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-controls", "account");
    b.setAttribute("aria-expanded", String(!account.hidden));
    b.addEventListener("click", () => toggleAccount());
  }
  function toggleAccount(force?: boolean) {
    const open = typeof force == "boolean" ? force : account.hidden;
    if (open && !accountLinks) return;
    account.hidden = !open;
    accountBtn?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    shell.chrome.showChrome(); shell.chrome.toggleHelp(false); shell.sharing.toggleSharing(false); shell.naming.toggleNaming(false); shell.naming.togglePages(false); shell.docSettings?.toggle(false);
    $("account-name").textContent = shell.me.name;
    $("account-login").textContent = shell.me.name.toLowerCase() == shell.me.user ? "" : shell.me.user;
    const set = (id: string, href: string | undefined) => { const a = $(id) as HTMLAnchorElement; a.hidden = !href; if (href) a.href = href; };
    set("account-docs", shell.me.user.startsWith("test-") ? undefined : accountLinks!.docs);
    set("account-settings", shell.me.user.startsWith("test-") ? undefined : accountLinks!.settings);
    set("account-deploy", accountLinks!.deploy);
    set("account-admin", accountLinks!.admin);
    set("account-out", accountLinks!.signOut);
  }
  /**
   * A participant's picture: only GitHub's (by id) and Google's (shared/avatars.ts), since anyone in the room
   * can put anything in their presence and we'd rather not fetch it.
   */
  function pictureOf(user: Author): string | null {
    return safeAvatar(user.avatar);
  }
  /** Clicking a participant scrolls to their caret; with none yet, the button says so. */
  function revealOnClick(b: HTMLElement, p: Presence, none: string) {
    const at = shell.collab.positions(p);
    if (at) b.addEventListener("click", () => { shell.page.reveal(at.head ?? at.anchor); });
    else { b.setAttribute("aria-disabled", "true"); b.dataset.tip += none; }
  }
  return {
    accountLinks, busyAgents, presenceChanged, queuePeers, queueCursor, renderPeople, toggleAccount, pictureOf,
    get accountBtn() { return accountBtn; },
  };
}

export type People = ReturnType<typeof mountPeople>;
