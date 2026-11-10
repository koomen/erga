// ... and as its body starts: opened with ?edit, editing from the first frame, with the editor's controls (inert, and
// out of sight until its code is in: viewer-edit-boot.ts) and its layout (viewer-layout-early.ts), unmoving until
// it's ready; reloaded in the editor, shown as they were (viewer-editing-head.ts).

import viewerLayoutEarly from "./viewer-layout-early";

export default function viewerEditingBody(): void {
  window.ergaControls = () => {
    let wrap = document.getElementById("erga-editor");
    if (wrap) return wrap;
    wrap = Object.assign(document.createElement("div"), { id: "erga-editor", inert: true });
    for (const el of (document.getElementById("erga-shell") as HTMLTemplateElement).content.children)
      if (el.tagName != "STYLE") wrap.append(document.importNode(el, true));
    document.body.append(wrap);
    return wrap;
  };
  if (!ergaEditAddress()) return;
  document.body.classList.add("erga-editing");
  const r = window.ergaRestored;
  ergaControls();
  viewerLayoutEarly();
  if (!r) return;
  document.body.classList.add(...r.body, "erga-restored", "erga-editor-ready", "no-motion");
  // The bars' parts, once the bars are there (server/pages/viewer.ts, after them).
  window.ergaRestoreParts = () => {
    for (const [id, html] of Object.entries(r.parts || {})) {
      const t = document.createElement("template");
      t.innerHTML = html;
      const was = document.getElementById(id),
        now = t.content.firstElementChild;
      if (was && now?.id == id) was.replaceWith(now);
    }
  };
}
