// The documents list's script (/docs, server/pages/docs.ts): times in the reader's own language and zone, the New
// document picker, a question before deleting, the share dialog, and each document's pages beneath its row.

import { fastClick } from "../common/fast-click";
import { newDocPicker } from "../common/new-doc";
import type { TreeHandle } from "../pages/pages-tree";
import times from "./times";

export interface DocsConfig {
  /** The close icon's SVG, for the share dialog's rows. */
  close: string;
  /** pages-tree.js's address. */
  tree: string;
  /** The ?user= a local tab carries, for the tree's reads ("" without). */
  query: string;
  /** The editor's scripts, to fetch ahead for a document you may edit. */
  editor: string[];
}

interface Permission {
  login: string;
  role: string;
}

interface ShareAnswer {
  permissions: Permission[];
  notUsers?: string[];
  avatars?: Record<string, string>;
  publicSharing?: boolean;
  error?: string;
}

export default function docs(c: DocsConfig): void {
  // Times in the reader's own language and zone, and a question before deleting.
  times();
  // New: the picker the viewer's and the editor's + open (client/common/new-doc.ts).
  newDocPicker(document);
  // The chevrons, Share and the share card's buttons act as the press starts (client/common/fast-click.ts). Delete keeps its click.
  fastClick(document, "button.twist, button.share, #share .copy, #share .done");
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-title]")) {
    const q =
      "disk" in f.dataset
        ? "Take “" + f.dataset.title + "” off your list? Its files stay where they are."
        : "Delete “" + f.dataset.title + "”? This can't be undone.";
    f.addEventListener("submit", (e) => {
      if (!confirm(q)) e.preventDefault();
    });
  }
  // Sharing: each change is saved as it's made (POST /docs/share), and the list follows when the dialog closes.
  const share = document.getElementById("share") as HTMLDialogElement,
    action = share.dataset.action!,
    me = share.dataset.me;
  const people = share.querySelector(".people")!,
    adder = share.querySelector<HTMLFormElement>("form.add")!,
    anyone = document.getElementById("share-anyone") as HTMLSelectElement;
  const shareHint = document.getElementById("share-hint")!;
  const tell = (text: string, error?: boolean) => {
    shareHint.textContent = text;
    shareHint.classList.toggle("error", !!error);
  };
  const field = (name: string) => adder.elements.namedItem(name) as HTMLInputElement;
  let doc: { id: string; title: string; address: string } | null = null,
    changed = false;
  const el = (tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): any => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  };
  const ROLES = [
    ["editor", "Can edit"],
    ["viewer", "Can view"],
  ];
  const roleSelect = (role: string, label: string) => {
    const s: HTMLSelectElement = el("select", { ariaLabel: label });
    for (const [v, t] of ROLES) s.append(el("option", { value: v, textContent: t, selected: v == role }));
    return s;
  };
  function render({ permissions, notUsers, avatars, publicSharing }: ShareAnswer) {
    people.replaceChildren();
    const pending = new Set(notUsers || []);
    let all = "none";
    for (const p of permissions) {
      if (p.login == "*") {
        all = p.role;
        continue;
      }
      const who = el("span", { className: "who", textContent: p.login });
      if (p.login == me) who.append(el("small", { textContent: "you" }));
      if (pending.has(p.login))
        who.append(
          el("small", { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" })
        );
      const face = el("span", { className: "face", ariaHidden: "true", textContent: p.login[0] });
      const pic = avatars?.[p.login];
      if (pic) {
        const img = el("img", { src: pic, alt: "", draggable: false, referrerPolicy: "no-referrer" });
        img.addEventListener("error", () => img.remove());
        face.append(img);
      }
      const li = el("li", {}, face, who);
      if (p.role == "owner") li.append(el("span", { className: "fixed", textContent: "Owner" }));
      else {
        const s = roleSelect(p.role, "Role for " + p.login);
        s.addEventListener("change", () => change(p.login, s.value));
        const x = el("button", {
          type: "button",
          className: "act",
          title: "Stop sharing with " + p.login,
          ariaLabel: "Stop sharing with " + p.login,
          innerHTML: c.close,
        });
        x.addEventListener("click", () => change(p.login, "none"));
        li.append(s, x);
      }
      people.append(li);
    }
    anyone.value = all;
    // Anyone with the link, only while the server lets users share content publicly; a share made before stays, to stop.
    anyone.closest<HTMLElement>(".anyone")!.hidden = !publicSharing && all == "none";
    for (const o of anyone.options) o.disabled = !publicSharing && o.value != "none" && o.value != all;
    document.getElementById("share-anyone-note")!.textContent = publicSharing
      ? "Signed in or not; people who aren't signed in view it"
      : "Public sharing is off here: only people who sign in can open it";
  }
  async function call(init?: Record<string, string>): Promise<ShareAnswer> {
    const r = await fetch(
      init ? action : action + (action.includes("?") ? "&" : "?") + "id=" + doc!.id,
      init ? { method: "POST", body: new URLSearchParams(init), headers: { Accept: "application/json" } } : {}
    ).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  async function change(login: string, role: string) {
    tell("Saving…");
    try {
      render(await call({ id: doc!.id, login, role }));
      changed = true;
      tell("");
      return true;
    } catch (e) {
      tell((e as Error).message, true);
      return false;
    }
  }
  for (const b of document.querySelectorAll<HTMLElement>("button.share"))
    b.addEventListener("click", async () => {
      doc = { id: b.dataset.id!, title: b.dataset.title!, address: b.dataset.address! };
      share.querySelector("h2")!.textContent = "Share “" + doc.title + "”";
      people.replaceChildren();
      adder.reset();
      tell("Loading…");
      share.showModal();
      field("login").focus();
      try {
        render(await call());
        tell("");
      } catch (e) {
        tell((e as Error).message, true);
      }
    });
  adder.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = field("login").value.trim().replace(/^@/, "");
    if (login && (await change(login, (adder.elements.namedItem("role") as HTMLSelectElement).value))) field("login").value = "";
  });
  anyone.addEventListener("change", () => change("*", anyone.value));
  share.querySelector(".copy")!.addEventListener("click", async () => {
    const url = location.origin + doc!.address;
    try {
      await navigator.clipboard.writeText(url);
      tell("Link copied: " + url);
    } catch {
      tell(url);
    }
  });
  share.querySelector(".done")!.addEventListener("click", () => share.close());
  share.addEventListener("close", () => {
    if (changed) location.reload();
  });
  // A document's pages, beneath its row: the tree. The script loads once the list is up and the tab is idle, and a
  // document's pages are read as the pointer heads for its row, together, so a click shows them at once. Each document's last
  // answer is kept for the tab: opened again, or on the next visit, its pages show straight away, and are read again behind.
  // Pages open in the editor for those who may edit, in the viewer otherwise. Which are open is remembered for the tab.
  let treeJs: Promise<NonNullable<Window["ergaTree"]>> | null = null;
  const loadTree = () =>
    (treeJs ??= import(c.tree).then(
      () => window.ergaTree!,
      () => {
        treeJs = null;
        throw new Error("Couldn't load the pages: check your connection and try again.");
      }
    ));
  (window.requestIdleCallback ?? setTimeout)(() => loadTree().catch(() => {}));
  const treeQuery = c.query;
  // A tree read ahead of the click, handed to the tree for its first read (once), if it's still fresh.
  const ahead = new Map<string, { at: number; answer: Promise<Response> }>();
  const readAhead = (id: string) => {
    const a = ahead.get(id);
    if (a && Date.now() - a.at < 10000) return;
    const answer = fetch("/api/docs/" + encodeURIComponent(id) + "/tree" + treeQuery, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    answer.catch(() => {});
    ahead.set(id, { at: Date.now(), answer });
  };
  const fetchFor =
    (id: string) =>
    (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const a = ahead.get(id);
      if (a && (!init || !init.method || init.method == "GET")) {
        ahead.delete(id);
        if (Date.now() - a.at < 10000)
          return a.answer.then(
            (r) => r.clone(),
            () => fetch(url, init)
          );
      }
      return fetch(url, init);
    };
  const keptKey = (id: string) => "erga:docs-tree:" + id;
  const kept = (id: string) => {
    try {
      return JSON.parse(sessionStorage.getItem(keptKey(id)) || "null");
    } catch {
      return null;
    }
  };
  const keep = (id: string, answer: { entries: unknown; canEdit: unknown; kind: unknown }) => {
    try {
      sessionStorage.setItem(keptKey(id), JSON.stringify({ entries: answer.entries, canEdit: answer.canEdit, kind: answer.kind }));
    } catch {}
  };
  const openKey = "erga:docs-open";
  const opened = new Set<string>(
    (() => {
      try {
        return JSON.parse(sessionStorage.getItem(openKey) || "[]");
      } catch {
        return [];
      }
    })()
  );
  const saveOpened = () => {
    try {
      sessionStorage.setItem(openKey, JSON.stringify([...opened]));
    } catch {}
  };
  const trees = new Map<string, TreeHandle>(),
    readAt = new Map<string, number>();
  async function showPages(b: HTMLElement, open: boolean) {
    const id = b.dataset.id!;
    b.setAttribute("aria-expanded", String(open));
    if (open) opened.add(id);
    else opened.delete(id);
    saveOpened();
    let sub = document.getElementById("pages-" + id);
    // Opened again: its pages are there already; read again only if they're more than a few seconds old.
    if (sub) {
      sub.hidden = !open;
      if (open && Date.now() - (readAt.get(id) ?? 0) > 4000) trees.get(id)?.refresh({ quiet: true });
      return;
    }
    if (!open) return;
    readAhead(id);
    sub = Object.assign(document.createElement("li"), { id: "pages-" + id, className: "sub" });
    const box = Object.assign(document.createElement("div"), { className: "sub-tree" });
    // Until the tree's script runs: the pages kept from before, or a quiet line saying they're on their way.
    box.append(Object.assign(document.createElement("p"), { className: "sub-wait", textContent: "Loading pages…" }));
    sub.append(box);
    b.closest("li")!.after(sub);
    try {
      const t = await loadTree();
      box.replaceChildren();
      trees.set(
        id,
        t.mountTree(box, {
          id,
          base: b.dataset.base!,
          editing: "edit" in b.dataset,
          query: treeQuery,
          rootTitle: b.dataset.title,
          label: "Pages of " + b.dataset.title,
          initial: kept(id),
          fetch: fetchFor(id) as typeof fetch,
          onChange: (a) => {
            readAt.set(id, Date.now());
            keep(id, a);
          },
        })
      );
    } catch (e) {
      box.className = "sub-tree error";
      box.textContent = (e as Error).message;
    }
  }
  // Opening a document, ahead of the click: as the pointer rests on its row, or focus comes to it, the browser fetches its page
  // (speculation rules: the click's navigation then takes that answer instead of asking again), and the editor's files for one
  // you may edit (kept for good, by their hashed names). Its room wakes too: the tree read above goes through the room, after
  // the same access check as the page. Each document once, and at most WARM_MAX a minute, so a pointer sweeping down
  // the list fetches little. A browser without speculation rules gets the files and the room only (the page itself is never
  // cached, so a plain prefetch of it would be thrown away).
  const SPECULATE = !!HTMLScriptElement.supports?.("speculationrules"),
    WARM_MAX = 6;
  // The rules are a script: they take the page's nonce (server/security.ts).
  const NONCE = (document.currentScript as HTMLScriptElement | null)?.nonce ?? "";
  const warmed = new Set<string>();
  let warmTimes: number[] = [],
    filesWarmed = false;
  const warm = (a: HTMLAnchorElement, edit: boolean) => {
    // (With its #edit: Chrome takes a prefetch only for the very address the click goes to, fragment and all.)
    const url = a.href,
      now = Date.now();
    if (warmed.has(url)) return;
    warmTimes = warmTimes.filter((t) => now - t < 60000);
    if (warmTimes.length >= WARM_MAX) return;
    warmTimes.push(now);
    warmed.add(url);
    if (SPECULATE)
      document.head.append(
        Object.assign(document.createElement("script"), {
          type: "speculationrules",
          nonce: NONCE,
          textContent: JSON.stringify({ prefetch: [{ source: "list", urls: [url] }] }),
        })
      );
    if (edit && !filesWarmed) {
      filesWarmed = true;
      for (const href of c.editor) document.head.append(Object.assign(document.createElement("link"), { rel: "prefetch", href }));
    }
  };
  for (const b of document.querySelectorAll<HTMLElement>("button.twist")) {
    // The pointer resting on a row (or the chevron or the title focused, or touched): its pages are read, the script fetched,
    // and the document's page fetched ahead (warm).
    let rest: ReturnType<typeof setTimeout> | undefined;
    const li = b.closest("li")!,
      a = li.querySelector<HTMLAnchorElement>("a.doc")!,
      edit = "edit" in b.dataset;
    const ready = () => {
      if (!trees.has(b.dataset.id!)) readAhead(b.dataset.id!);
      loadTree().catch(() => {});
    };
    const opening = () => {
      ready();
      warm(a, edit);
    };
    li.addEventListener("pointerenter", () => {
      clearTimeout(rest);
      rest = setTimeout(opening, 60);
    });
    li.addEventListener("pointerleave", () => clearTimeout(rest));
    a.addEventListener("focus", opening);
    a.addEventListener("pointerdown", opening);
    b.addEventListener("focus", ready);
    b.addEventListener("pointerdown", ready);
    b.addEventListener("click", () => showPages(b, b.getAttribute("aria-expanded") != "true"));
    if (opened.has(b.dataset.id!)) showPages(b, true);
  }
  // Changes made elsewhere (another tab, an agent) show here too: the open trees are read again when the tab comes back,
  // and every few seconds while it's in view. Quietly: never while someone is naming, moving or deleting something in one.
  const refreshOpen = () => {
    for (const [id, t] of trees) if (!document.getElementById("pages-" + id)?.hidden) t.refresh({ quiet: true });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState == "visible") refreshOpen();
  });
  setInterval(() => {
    if (document.visibilityState == "visible") refreshOpen();
  }, 4000);
}
