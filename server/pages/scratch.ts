// Scratch documents (/scratch, server/documents/make.ts): the documents page's line about them, and the note on a scratch
// document's page, with the time it has left and, for its owner, Save (client/inline/scratch.ts).

import { inlineCall, inlineStyle } from "./inline.ts";

/**
 * The documents page's line, beside + Scratch. A scratch document goes `hours` after it's made (the setting
 * delete_docs_after_hours, as unedited documents do); null: never.
 */
export const scratchLine = (hours: number | null) =>
  hours == null
    ? "A scratch document is not on your list, and is never deleted."
    : `A scratch document is not saved, and goes away after ${hours} ${hours == 1 ? "hour" : "hours"}.`;

/** The note on a scratch document's page: `expires`, when it goes (null: never); `save`, whether this person may save it (its owner). */
export const scratchNote = (doc: string, expires: number | null, save: boolean) =>
  `<aside id="erga-scratch" class="erga-scratch" aria-label="Scratch document"><p>${
    expires == null
      ? "<b>A scratch document</b> is not on your list, and is never deleted."
      : `<b>A scratch document</b> is not saved, and goes away <span id="erga-scratch-left"></span>.`
  }<small id="erga-scratch-said" role="status"></small></p>${
    save ? `<button type="button" id="erga-scratch-save">Save</button>` : ""
  }</aside><style>${inlineStyle("scratch")}</style><script>${inlineCall("scratch", doc, expires)}</script>`;
