// Who a document is shared with, as a list a person changes: the people and their roles, "Anyone with the link", and
// the form that adds someone. Each change is saved as it's made (the operation share_document, as an agent's is; ls
// reads the list), and shows before the server answers. Two pages have it, each with its own elements and look: the
// documents list's Share dialog (client/inline/docs.ts) and the editor's Share card (client/shell/sharing.ts).

import { safeAvatar } from "../../shared/avatars";
import { runTool } from "./tools";

/** Who a document is shared with: ls's `access`, and share_document's answer. */
interface Shared {
  permissions: { login: string; role: string }[];
  notUsers?: string[];
  avatars?: Record<string, string>;
  publicSharing?: boolean;
}

export interface ShareList {
  /** The document it shows now (its id): a page with one list for many documents changes it. */
  doc(): string;
  /** Who looks at it: their row says "you". */
  me(): string | undefined;
  /** The people's list, the form that adds one (its fields: `who`, `role`), the link's menu and the status line. */
  people: HTMLElement;
  add: HTMLFormElement;
  anyone: HTMLSelectElement;
  status: HTMLElement;
  /** Whether the person sees the list now: an answer that comes while they don't is kept, not drawn. */
  shown(): boolean;
  /** The page's look: the classes of a row and of its role menu, its Remove button, and a face's colour (none: the style's). */
  look: { row: string; role: string; remove: { className: string; innerHTML: string }; color?(login: string): string };
  /** After each draw, the page's words beside the link's menu. `offered`: the menu has a use; else public sharing is off, and the link is shared with nobody. */
  link(offered: boolean, publicSharing: boolean): void;
}

const ROLES = [
  ["editor", "Can edit"],
  ["commenter", "Can comment"],
  ["viewer", "Can view"],
];
const LOADING = "Loading…";

export function shareList(o: ShareList) {
  /** The last answer, and the document it is of: another document's list starts with none. */
  let kept: { doc: string; shared: Shared } | null = null;
  const last = () => (kept?.doc == o.doc() ? kept.shared : null);
  const who = o.add.elements.namedItem("who") as HTMLInputElement;
  const tell = (text: string, error = false) => {
    o.status.textContent = text;
    o.status.classList.toggle("error", error);
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown>, label?: string): HTMLElementTagNameMap[K] => {
    const e = Object.assign(document.createElement(tag), props);
    if (label) e.setAttribute("aria-label", label);
    return e;
  };
  /** Who it's shared with (ls's access), or that after a change (share_document). */
  const call = (change?: { login: string; role: string }): Promise<Shared> =>
    change
      ? runTool("share_document", { document: o.doc(), ...change })
      : runTool<{ access: Shared }>("ls", { document: o.doc() }).then((r) => r.access);
  function draw({ permissions, notUsers, avatars, publicSharing }: Shared) {
    o.people.replaceChildren();
    const pending = new Set(notUsers ?? []);
    let all = "none";
    for (const p of permissions) {
      if (p.login == "*") {
        all = p.role;
        continue;
      }
      const face = el("span", { className: "face", textContent: p.login.slice(0, 1).toUpperCase() });
      face.setAttribute("aria-hidden", "true");
      if (o.look.color) face.style.setProperty("--c", o.look.color(p.login));
      // Their picture, as the header's avatars show it; the initial stays under it, and shows if it doesn't load.
      const picture = safeAvatar(avatars?.[p.login]);
      if (picture) {
        const img = el("img", { src: picture, alt: "", draggable: false, referrerPolicy: "no-referrer" });
        img.addEventListener("error", () => img.remove());
        face.append(img);
      }
      const name = el("span", { className: "who", textContent: p.login });
      if (p.login == o.me()) name.append(el("small", { textContent: "you" }));
      if (pending.has(p.login))
        name.append(
          el("small", { className: "pending", textContent: "can't sign in yet", title: "Not a user of this server: an admin can add them" })
        );
      const li = el("li", { className: o.look.row });
      li.append(face, name);
      if (p.role == "owner") li.append(el("span", { className: "fixed", textContent: "Owner" }));
      else {
        const role = el("select", { className: o.look.role }, `Role for ${p.login}`);
        for (const [v, t] of ROLES) role.append(new Option(t, v, false, v == p.role));
        role.addEventListener("change", () => change(p.login, role.value));
        const x = el("button", { type: "button", title: `Stop sharing with ${p.login}`, ...o.look.remove }, `Stop sharing with ${p.login}`);
        x.addEventListener("click", () => change(p.login, "none"));
        li.append(role, x);
      }
      o.people.append(li);
    }
    o.anyone.value = all;
    // Anyone with the link, only while the server lets users share content publicly; a share made before stays, to stop.
    for (const opt of o.anyone.options) opt.disabled = !publicSharing && opt.value != "none" && opt.value != all;
    o.link(!!publicSharing || all != "none", !!publicSharing);
  }
  /** A change of the sharing: the list shows it at once; if the server refuses, the list is as before, and says why. */
  async function change(login: string, role: string): Promise<boolean> {
    const doc = o.doc(),
      before = last();
    if (before) {
      const others = before.permissions.filter((p) => p.login != login);
      const at = before.permissions.findIndex((p) => p.login == login);
      if (role != "none") others.splice(at < 0 ? others.length : at, 0, { login, role });
      draw({ ...before, permissions: others });
    }
    tell(before ? "" : "Saving…");
    try {
      kept = { doc, shared: await call({ login, role }) };
      if (doc == o.doc()) {
        draw(kept.shared);
        tell("");
      }
      return true;
    } catch (e) {
      if (doc != o.doc()) return false;
      if (before) draw(before);
      tell((e as Error).message, true);
      return false;
    }
  }
  o.add.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = who.value.trim().replace(/^@/, "");
    if (login && (await change(login, (o.add.elements.namedItem("role") as HTMLSelectElement).value))) who.value = "";
  });
  o.anyone.addEventListener("change", () => change("*", o.anyone.value));
  return {
    tell,
    /** The list comes into view: the last answer for its document at once, or "Loading…" until `read` has one. */
    open() {
      const shared = last();
      o.add.reset();
      if (shared) draw(shared);
      else o.people.replaceChildren();
      tell(shared ? "" : LOADING);
      who.focus();
    },
    /** Reads who it's shared with, and draws it if the list shows. False: the read failed (it says why, if it has nothing to show). */
    async read(): Promise<boolean> {
      const doc = o.doc();
      try {
        kept = { doc, shared: await call() };
        if (doc == o.doc() && o.shown()) {
          draw(kept.shared);
          if (o.status.textContent == LOADING) tell("");
        }
        return true;
      } catch (e) {
        if (doc == o.doc() && o.shown() && !last()) tell((e as Error).message, true);
        return false;
      }
    },
  };
}
