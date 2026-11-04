// A page's details: a dialog that the document's settings open (client/pages/settings.ts, Page). It sets what every
// web page says about itself in its <head> (shared/page-head.ts): the tab's title, a description for search results and
// link previews, the tab's icon, and the picture a link to the page shows. A preview shows the tab and a link's card
// as they will look. Save runs the tool set_head, which rewrites those tags in the page's source (the agent has the
// same tool). An empty field removes its tag.

import { runTool } from "../common/tools";
import { esc } from "../../shared/html";
import { HEAD_FIELDS, headUrl, tabTitle, type PageHead } from "../../shared/page-head";

export interface PageHeadHost {
  docId: string;
  /** The page's file ("index.html", "blog/post.html"). */
  page: string;
  /** Its details now, as ls read them. */
  head: PageHead;
  /** The document's title: the tab's when the page has none. */
  docTitle: string;
  /** The document's pictures, offered for the icon and the link picture. */
  images: string[];
  /** Whether you may change it (else it's read-only). */
  canEdit: boolean;
  /** Where the document's files are, for the preview (ends in "/"); "" if unknown. */
  files: string;
  /** Saved: the page's details now. */
  onSaved(head: PageHead): void;
}

const LABELS: Record<(typeof HEAD_FIELDS)[number], { label: string; hint: string }> = {
  title: { label: "Title", hint: "The browser tab, search results and links show it." },
  description: { label: "Description", hint: "A sentence or two for search results and link previews." },
  icon: { label: "Icon", hint: "The tab's icon: a picture in the document, or a URL. Square, 32 × 32 or larger." },
  image: { label: "Link picture", hint: "The picture a link to the page shows: a file or a URL, 1200 × 630 is best." },
};

const STYLE = `
#erga-page-head { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 48px); padding: 0; border: 1px solid var(--panel-border);
  border-radius: 14px; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font: 14px/1.45 var(--font-text); overflow: auto; }
#erga-page-head::backdrop { background: rgba(0, 0, 0, 0.25); }
#erga-page-head [hidden] { display: none !important; }
#erga-page-head header { position: sticky; top: 0; z-index: 1; background: var(--bg); display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--rule); }
#erga-page-head h2 { margin: 0; font-size: 17px; color: var(--fg-strong, var(--fg)); }
#erga-page-head .ph-file { font: 12.5px var(--font-mono); color: var(--soft); background: var(--code-bg); padding: 2px 7px; border-radius: 6px; }
#erga-page-head .ph-close { margin-left: auto; border: 0; background: none; color: var(--chrome); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
#erga-page-head .ph-close:hover { background: var(--code-bg); }
#erga-page-head .ph-body { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 22px; padding: 18px 20px; }
@media (max-width: 680px) { #erga-page-head .ph-body { grid-template-columns: 1fr; } }
#erga-page-head .ph-field { display: block; margin: 0 0 14px; }
#erga-page-head .ph-field > span { display: flex; justify-content: space-between; font: 600 12.5px var(--font-text); color: var(--fg-strong, var(--fg)); margin-bottom: 4px; }
#erga-page-head .ph-field small { font-weight: 500; color: var(--chrome); font-feature-settings: "tnum"; }
#erga-page-head .ph-field small.long { color: #b26b00; }
#erga-page-head input, #erga-page-head textarea { box-sizing: border-box; width: 100%; font: inherit; font-size: 13.5px; padding: 7px 9px;
  border: 1px solid var(--panel-border); border-radius: 8px; background: var(--bg); color: var(--fg); }
#erga-page-head textarea { resize: vertical; min-height: 64px; }
#erga-page-head input:focus-visible, #erga-page-head textarea:focus-visible { outline: 2px solid var(--caret); outline-offset: -1px; border-color: transparent; }
#erga-page-head .ph-hint { margin: 4px 0 0; font-size: 12px; color: var(--soft); }
#erga-page-head .ph-preview h3 { margin: 0 0 8px; font: 600 12px/1.3 var(--font-text); color: var(--soft); text-transform: uppercase; letter-spacing: 0.04em; }
#erga-page-head .ph-tab { display: flex; align-items: center; gap: 8px; max-width: 240px; padding: 8px 12px; border-radius: 10px 10px 0 0;
  background: var(--code-bg); font-size: 12.5px; color: var(--fg); }
#erga-page-head .ph-tab img, #erga-page-head .ph-tab .ph-noicon { flex: none; width: 16px; height: 16px; border-radius: 3px; object-fit: contain; }
#erga-page-head .ph-tab .ph-noicon { background: color-mix(in srgb, var(--chrome) 35%, transparent); }
#erga-page-head .ph-tab span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#erga-page-head .ph-card { margin-top: 16px; border: 1px solid var(--panel-border); border-radius: 12px; overflow: hidden; background: var(--bg); }
#erga-page-head .ph-card .ph-pic { aspect-ratio: 1.91 / 1; background: var(--code-bg) center / cover no-repeat; display: grid; place-items: center;
  color: var(--chrome); font-size: 12px; }
#erga-page-head .ph-card .ph-text { padding: 10px 12px; }
#erga-page-head .ph-card .ph-host { font-size: 11.5px; color: var(--chrome); }
#erga-page-head .ph-card .ph-title { margin-top: 2px; font-weight: 600; font-size: 13.5px; color: var(--fg-strong, var(--fg)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#erga-page-head .ph-card .ph-desc { margin-top: 2px; font-size: 12.5px; color: var(--soft); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#erga-page-head footer { position: sticky; bottom: 0; background: var(--bg); display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--rule); }
#erga-page-head .ph-status { flex: 1; margin: 0; font-size: 12.5px; color: var(--soft); }
#erga-page-head .ph-status.error { color: #b42318; }
#erga-page-head footer button { font: 600 13px var(--font-text); padding: 7px 14px; border-radius: 8px; cursor: pointer; border: 1px solid var(--panel-border); background: var(--bg); color: var(--fg); }
#erga-page-head footer .ph-save { background: var(--caret); border-color: var(--caret); color: #fff; }
#erga-page-head footer button:disabled { opacity: 0.55; cursor: default; }
`;

let dialog: HTMLDialogElement | null = null;

/** Opens the page's details, for `host`'s page. */
export function openPageHead(host: PageHeadHost): void {
  if (!document.getElementById("ph-style"))
    document.head.append(Object.assign(document.createElement("style"), { id: "ph-style", textContent: STYLE }));
  dialog?.remove();
  // A blank page's "Untitled" isn't a title: the box is empty, and shows the document's title instead.
  const was: PageHead = { ...host.head, title: tabTitle(host.head, "") };
  const d = (dialog = document.createElement("dialog"));
  d.id = "erga-page-head";
  d.setAttribute("aria-labelledby", "ph-heading");
  const field = (f: (typeof HEAD_FIELDS)[number]) => {
    const { label, hint } = LABELS[f];
    const value = esc(was[f] ?? "");
    const control =
      f == "description"
        ? `<textarea id="ph-${f}" name="${f}" rows="3" aria-describedby="ph-${f}-hint">${value}</textarea>`
        : `<input id="ph-${f}" name="${f}" value="${value}" autocomplete="off" spellcheck="${f == "title"}"${f == "icon" || f == "image" ? ` list="ph-images" placeholder="favicon.png, or https://…"` : f == "title" ? ` placeholder="${esc(host.docTitle)}"` : ""} aria-describedby="ph-${f}-hint">`;
    return `<label class="ph-field" for="ph-${f}"><span>${label}<small id="ph-${f}-count"></small></span>${control}<p class="ph-hint" id="ph-${f}-hint">${hint}</p></label>`;
  };
  d.innerHTML = `<form method="dialog">
    <header><h2 id="ph-heading">Page details</h2><span class="ph-file">${esc(host.page)}</span><button type="button" class="ph-close" aria-label="Close">✕</button></header>
    <div class="ph-body">
      <div>${HEAD_FIELDS.map(field).join("")}<datalist id="ph-images">${host.images.map((p) => `<option value="${esc(p)}">`).join("")}</datalist></div>
      <div class="ph-preview" aria-label="Preview">
        <h3>Tab</h3>
        <div class="ph-tab"><span class="ph-icon"></span><span class="ph-tab-title"></span></div>
        <h3 style="margin-top:18px">Link</h3>
        <div class="ph-card"><div class="ph-pic"></div><div class="ph-text"><div class="ph-host">${esc(location.host)}</div><div class="ph-title"></div><div class="ph-desc"></div></div></div>
      </div>
    </div>
    <footer><p class="ph-status" role="status"></p><button type="button" class="ph-cancel">Cancel</button><button type="submit" class="ph-save">Save</button></footer>
  </form>`;
  document.body.append(d);
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const input = (f: string) => $<HTMLInputElement>(`#ph-${f}`);
  const status = $(".ph-status"),
    save = $<HTMLButtonElement>(".ph-save");
  const url = (v: string) => (v ? headUrl(v, host.page, host.files || `${location.origin}/`) : null);
  const values = (): PageHead => Object.fromEntries(HEAD_FIELDS.map((f) => [f, input(f).value.trim()]));
  /** Only what the person changed: the rest of the head stays as the source has it. */
  const changes = (): PageHead => Object.fromEntries(Object.entries(values()).filter(([f, v]) => v != (was[f as keyof PageHead] ?? "")));

  function preview() {
    const v = values();
    const title = tabTitle(v, host.docTitle);
    $(".ph-tab-title").textContent = title;
    $(".ph-title").textContent = title;
    $(".ph-desc").textContent = v.description || "";
    const icon = url(v.icon ?? "");
    $(".ph-icon").innerHTML = icon ? `<img alt="" src="${esc(icon)}">` : `<span class="ph-noicon"></span>`;
    const pic = url(v.image ?? "");
    const box = $(".ph-pic");
    box.style.backgroundImage = pic ? `url("${pic.replace(/["\\]/g, "\\$&")}")` : "";
    box.textContent = pic ? "" : "No link picture";
    // Lengths that search results cut: about 60 for a title, 160 for a description.
    for (const [f, max] of [
      ["title", 60],
      ["description", 160],
    ] as const) {
      const n = (v[f] ?? "").length,
        count = $(`#ph-${f}-count`);
      count.textContent = n ? `${n} / ${max}` : "";
      count.classList.toggle("long", n > max);
    }
    save.disabled = !host.canEdit || !Object.keys(changes()).length;
  }
  for (const f of HEAD_FIELDS) {
    input(f).addEventListener("input", preview);
    input(f).disabled = !host.canEdit;
  }
  if (!host.canEdit) status.textContent = "Only its editors can change these.";
  preview();

  const close = () => d.close();
  $(".ph-close").addEventListener("click", close);
  $(".ph-cancel").addEventListener("click", close);
  d.addEventListener("click", (e) => {
    if (e.target == d) close();
  });
  d.addEventListener("close", () => d.remove());
  $<HTMLFormElement>("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    status.classList.remove("error");
    status.textContent = "Saving…";
    try {
      const r = await runTool<{ head: PageHead }>("set_head", { document: host.docId, path: host.page, ...changes() });
      host.onSaved(r.head);
      close();
    } catch (err) {
      status.classList.add("error");
      status.textContent = `Couldn't save: ${(err as Error).message}`;
      save.disabled = false;
    }
  });
  d.showModal();
  input("title").select();
}
