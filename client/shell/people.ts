// Presence: everyone's carets, the avatars of who's here, and your own avatar's account menu.

import type { Peer } from "../../libs/text/ui/editor";
import type { Presence } from "../../libs/text/ui/collab";
import type { Author } from "../../document/content";
import { $, type Shell } from "./shell";
import { safeAvatar } from "../../shared/avatars";

export function mountPeople(shell: Shell) {

  // Everyone's caret in the source view (the page's editor draws them on the page), with their name;
  // an agent's, dashed, while it works. The avatars at the
  // top say who's here and what each agent is doing. A person with several
  // tabs open is shown by the one they used last, and your own other tabs
  // not at all (Collab.shown).
  function busyAgents(): string[] {
    return shell.collab.others().filter((p) => p.user.kind == "agent" && p.busy).map((p) => p.user.name);
  }
  function presenceChanged() {
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
  }
  // This tab's caret in the source view, for everyone else (on the page, the page's editor shows its own). It stays
  // where you left it when you switch away, as a caret on paper would (but with another of your tabs in use since, that
  // one's caret is shown instead).
  let cursorQueued = false;
  function queueCursor() {
    if (cursorQueued) return;
    cursorQueued = true;
    requestAnimationFrame(() => {
      cursorQueued = false;
      if (!shell.sourceView) return;
      const sel = shell.sourceView.state.selection.main;
      shell.collab.setCursor(sel.anchor, sel.head);
    });
  }

  // The others' stack (client/styles/editor.css, .people): its faces' size and overlap, and how many show at rest.
  // (On a phone, two: the breadcrumbs need the room.)
  const FACE = 26,
    OVERLAP = 9,
    phone = matchMedia("(max-width: 759.98px)");
  const shown = () => (phone.matches ? 2 : 4);
  phone.addEventListener("change", () => renderPeople());
  const people = $("people"),
    meSlot = $("me");
  function renderPeople() {
    const SHOWN = shown();
    // One avatar per person: everyone else in a stack left of the buttons' bar, you
    // at its far right. A person's agent, once it has done
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
      b.dataset.name = p.user.name;
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
      if (p.client != -1 && people.childElementCount >= SHOWN) wrap.classList.add("extra");
      (p.client == -1 ? meSlot : people).append(wrap);
    }
    // Past SHOWN faces, the stack ends in "+N"; the spread shows them all, and takes the "+N" away.
    const others = people.childElementCount,
      extra = others - SHOWN;
    if (extra > 0) {
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = `+${extra}`;
      more.setAttribute("aria-hidden", "true");
      people.append(more);
    }
    // The stack's width at rest, for the breadcrumbs' room (client/common/quick.ts, barEdge).
    const faces = Math.min(others, SHOWN) + (extra > 0 ? 1 : 0);
    people.dataset.w = String(faces ? FACE + (faces - 1) * (FACE - OVERLAP) : 0);
  }
  // A finger has no hover: a tap on the stack spreads it first, and the next tap on a face is that face's click.
  // A tap anywhere else stacks them again.
  let spreadByTap = false;
  people.addEventListener("pointerdown", (e) => {
    spreadByTap = e.pointerType != "mouse" && !people.classList.contains("spread");
  });
  function tapSpreads(e: MouseEvent) {
    if (!spreadByTap) return;
    spreadByTap = false;
    e.stopPropagation();
    people.classList.add("spread");
  }
  people.addEventListener("click", tapSpreads, true);
  // (A press on the page, in its frame, is main.ts's onPress.)
  const stackPeople = () => people.classList.remove("spread");
  document.addEventListener("pointerdown", (e) => {
    if (!e.composedPath().includes(people)) stackPeople();
  });
  // Your avatar opens a small menu: who you are, Documents, Settings,
  // Deploy your own if the deploy_page setting lets you, Admin settings if you're an admin, Sign out (the same as every other page's upper
  // right, server/pages/account-menu.ts). The app says which links (meta erga-account).
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
  /** Clicking a participant scrolls the source view to their caret (the page's editor shows theirs where it is). */
  function revealOnClick(b: HTMLElement, p: Presence, none: string) {
    const at = shell.collab.positions(p);
    if (at && shell.sourceView)
      b.addEventListener("click", () => shell.sourceView?.dispatch({ selection: { anchor: at.head ?? at.anchor }, scrollIntoView: true }));
    else if (!at) {
      b.setAttribute("aria-disabled", "true");
      b.dataset.tip += none;
    }
  }
  return {
    accountLinks,
    busyAgents,
    presenceChanged,
    queuePeers,
    queueCursor,
    renderPeople,
    stackPeople,
    toggleAccount,
    pictureOf,
    get accountBtn() {
      return accountBtn;
    },
  };
}

export type People = ReturnType<typeof mountPeople>;
