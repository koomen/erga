// A reader's copy out of a document's page: clean HTML, Markdown and absolute links, loaded as a deferred module from
// the page's own origin (server/pages/reader.ts) so it stays out of the inline HTML and is cached across documents.

import { copyOf } from "../../libs/text/ui/clipboard-read";
import { placeOf } from "../common/link-target";
import type {} from "../common/reader-api";

addEventListener("copy", (e) => {
  const C = window.__ergaReader?.config;
  const field = document.activeElement;
  if (
    !C ||
    document.documentElement.hasAttribute("data-erga-editing") ||
    e.defaultPrevented ||
    !e.clipboardData ||
    (field && /^(INPUT|TEXTAREA)$/.test(field.tagName))
  )
    return;
  let out = null;
  try {
    out = copyOf(window, placeOf(window, C));
  } catch {}
  if (!out) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", out.text);
  e.clipboardData.setData("text/html", out.html);
});
