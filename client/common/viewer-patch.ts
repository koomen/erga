// Lightweight in-place DOM patcher for Viewing mode (client/inline/reader.ts): when the active HTML page changes,
// fetches the updated HTML and patches text, body DOM, and <head> styles/metadata in place without tearing down the
// iframe, preserving live script state, widgets (`data-erga-noedit`), and scroll position. Returns false whenever a
// <script>, <base>, or unsafe structural change requires a clean iframe reload.

const KEEP_OPAQUE = new Set(["canvas", "video", "audio", "iframe", "embed", "object"]);
const REPLACE_WHOLE = new Set(["svg", "math"]);

const isErgaNode = (n: Node): boolean =>
  n.nodeType == 1 && ((n as Element).hasAttribute("data-erga") || (n as Element).localName.startsWith("erga-"));

const scriptSig = (el: Element): string =>
  `${el.getAttribute("src") ?? ""}\0${el.getAttribute("type") ?? ""}\0${el.getAttribute("nomodule") ?? ""}\0${el.textContent ?? ""}`;

function sameScripts(live: Document, next: Document): boolean {
  const a = [...live.querySelectorAll("script")].filter((s) => !isErgaNode(s));
  const b = [...next.querySelectorAll("script")].filter((s) => !isErgaNode(s));
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (scriptSig(a[i]) != scriptSig(b[i])) return false;
  return true;
}

function sameBase(live: Document, next: Document): boolean {
  const a = live.head?.querySelector("base:not([data-erga])");
  const b = next.head?.querySelector("base:not([data-erga])");
  return (
    (a?.getAttribute("href") ?? null) == (b?.getAttribute("href") ?? null) &&
    (a?.getAttribute("target") ?? null) == (b?.getAttribute("target") ?? null)
  );
}

function syncAttrs(live: Element, next: Element, preserveRuntimeStyle: boolean): void {
  const keep = new Set<string>();
  for (const attr of [...next.attributes]) {
    if (attr.name.startsWith("data-erga") && attr.name != "data-erga-noedit") continue;
    keep.add(attr.name);
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
  }
  for (const attr of [...live.attributes]) {
    if (attr.name.startsWith("data-erga") && attr.name != "data-erga-noedit") continue;
    if (preserveRuntimeStyle && attr.name == "style" && !next.hasAttribute("style")) continue;
    if (!keep.has(attr.name)) live.removeAttribute(attr.name);
  }
}

function sameAttrs(a: Element, b: Element): boolean {
  const aList = [...a.attributes].filter((x) => !x.name.startsWith("data-erga") || x.name == "data-erga-noedit");
  const bList = [...b.attributes].filter((x) => !x.name.startsWith("data-erga") || x.name == "data-erga-noedit");
  if (aList.length != bList.length) return false;
  for (const x of bList) if (a.getAttribute(x.name) !== x.value) return false;
  return true;
}

function patchHead(doc: Document, nextDoc: Document, docPath: (href: string) => string | null): boolean {
  const head = doc.head,
    nextHead = nextDoc.head;
  if (!head || !nextHead) return true;
  if (doc.title != nextDoc.title) doc.title = nextDoc.title;

  const liveKids = [...head.children].filter((el) => !isErgaNode(el) && el.localName != "script" && el.localName != "title");
  const nextKids = [...nextHead.children].filter((el) => !isErgaNode(el) && el.localName != "script" && el.localName != "title");
  const used = new Set<Element>();

  const findMatch = (n: Element): Element | undefined => {
    if (n.localName == "link" && /\bstylesheet\b/i.test(n.getAttribute("rel") ?? "")) {
      const p = docPath(n.getAttribute("href") ?? "");
      return liveKids.find(
        (l) =>
          !used.has(l) &&
          l.localName == "link" &&
          /\bstylesheet\b/i.test(l.getAttribute("rel") ?? "") &&
          docPath(l.getAttribute("href") ?? "") == p
      );
    }
    if (n.localName == "meta") {
      const key = n.getAttribute("name") || n.getAttribute("property") || n.getAttribute("charset") || n.getAttribute("http-equiv");
      if (key) {
        return liveKids.find(
          (l) =>
            !used.has(l) &&
            l.localName == "meta" &&
            (l.getAttribute("name") || l.getAttribute("property") || l.getAttribute("charset") || l.getAttribute("http-equiv")) == key
        );
      }
    }
    return liveKids.find((l) => !used.has(l) && l.localName == n.localName);
  };

  for (const n of nextKids) {
    const match = findMatch(n);
    if (match) {
      used.add(match);
      if (n.localName == "style") {
        syncAttrs(match, n, false);
        if (match.textContent !== n.textContent) match.textContent = n.textContent;
      } else if (n.localName == "link" && /\bstylesheet\b/i.test(n.getAttribute("rel") ?? "")) {
        // Keep unchanged linked stylesheet element so it never flickers; sync non-href attributes if any.
        for (const a of [...n.attributes])
          if (a.name != "href" && match.getAttribute(a.name) !== a.value) match.setAttribute(a.name, a.value);
      } else {
        syncAttrs(match, n, false);
      }
    } else {
      head.appendChild(doc.importNode(n, true));
    }
  }
  for (const l of liveKids) if (!used.has(l)) l.remove();
  return true;
}

function preserveNoEdit(live: Element, next: Element): "keep" | "reload" {
  // Script-populated containers (e.g. `<div id="plans-app" data-erga-noedit></div>` or shadow-root demos) have
  // empty static HTML or a live shadowRoot: keep them untouched so runtime widget state survives.
  if (next.innerHTML.trim() === "" || live.shadowRoot) {
    syncAttrs(live, next, true);
    return "keep";
  }
  return live.innerHTML === next.innerHTML && sameAttrs(live, next) ? "keep" : "reload";
}

function patchChildren(doc: Document, liveParent: Element, nextParent: Element): boolean {
  const liveNodes = [...liveParent.childNodes].filter((n) => !isErgaNode(n));
  const nextNodes = [...nextParent.childNodes].filter((n) => !isErgaNode(n));

  const liveById = new Map<string, Element>();
  for (const n of liveNodes) if (n.nodeType == 1 && (n as Element).id) liveById.set((n as Element).id, n as Element);

  const used = new Set<Node>();
  const targetOrder: Node[] = [];
  let cursor = 0;

  for (const next of nextNodes) {
    if (next.nodeType == 8) continue; // ignore HTML comments
    let match: Node | null = null;
    if (next.nodeType == 1 && (next as Element).id) {
      const byId = liveById.get((next as Element).id);
      if (byId && !used.has(byId) && byId.localName == (next as Element).localName) match = byId;
    }
    if (!match) {
      for (let i = cursor; i < liveNodes.length; i++) {
        const cand = liveNodes[i];
        if (used.has(cand)) continue;
        if (cand.nodeType == next.nodeType && (cand.nodeType != 1 || (cand as Element).localName == (next as Element).localName)) {
          match = cand;
          cursor = i + 1;
          break;
        }
      }
    }

    if (match) {
      used.add(match);
      if (next.nodeType == 3) {
        if (match.nodeValue !== next.nodeValue) match.nodeValue = next.nodeValue;
        targetOrder.push(match);
      } else if (next.nodeType == 1) {
        const lEl = match as Element,
          nEl = next as Element;
        if (nEl.localName == "script") {
          targetOrder.push(lEl);
        } else if (lEl.hasAttribute("data-erga-noedit") && nEl.hasAttribute("data-erga-noedit")) {
          if (preserveNoEdit(lEl, nEl) == "reload") return false;
          targetOrder.push(lEl);
        } else if (KEEP_OPAQUE.has(nEl.localName)) {
          if (!sameAttrs(lEl, nEl)) return false;
          targetOrder.push(lEl);
        } else if (REPLACE_WHOLE.has(nEl.localName)) {
          if (lEl.outerHTML != nEl.outerHTML) {
            const fresh = doc.importNode(nEl, true);
            liveParent.replaceChild(fresh, lEl);
            targetOrder.push(fresh);
          } else targetOrder.push(lEl);
        } else if (nEl.localName == "style") {
          syncAttrs(lEl, nEl, false);
          if (lEl.textContent !== nEl.textContent) lEl.textContent = nEl.textContent;
          targetOrder.push(lEl);
        } else {
          syncAttrs(lEl, nEl, true);
          if (!patchChildren(doc, lEl, nEl)) return false;
          targetOrder.push(lEl);
        }
      }
    } else {
      if (next.nodeType == 1 && (next as Element).localName == "script") return false;
      targetOrder.push(doc.importNode(next, true));
    }
  }

  // Remove live nodes no longer present (skip Erga nodes and scripts, which were verified equal).
  for (const l of liveNodes) {
    if (used.has(l) || isErgaNode(l)) continue;
    if (l.nodeType == 1 && (l as Element).localName == "script") return false;
    l.parentNode?.removeChild(l);
  }

  // Place nodes in exact order while leaving Erga nodes untouched.
  let ref: Node | null = liveParent.firstChild;
  for (const node of targetOrder) {
    while (ref && isErgaNode(ref)) ref = ref.nextSibling;
    if (ref === node) {
      ref = ref.nextSibling;
      continue;
    }
    liveParent.insertBefore(node, ref);
  }
  return true;
}

/**
 * Patches `doc` in place to match `nextHtml`. Returns `true` when patched cleanly with zero reload, or `false` if a
 * `<script>`, `<base>`, or incompatible widget change requires a full iframe reload.
 */
export function patchDocumentHtml(doc: Document, nextHtml: string, docPath: (href: string) => string | null): boolean {
  if (!doc.body) return false;
  const nextDoc = new DOMParser().parseFromString(nextHtml, "text/html");
  if (!nextDoc.body) return false;
  if (!sameScripts(doc, nextDoc) || !sameBase(doc, nextDoc)) return false;
  if (!patchHead(doc, nextDoc, docPath)) return false;
  syncAttrs(doc.documentElement, nextDoc.documentElement, true);
  syncAttrs(doc.body, nextDoc.body, true);
  return patchChildren(doc, doc.body, nextDoc.body);
}
