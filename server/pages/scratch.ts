// Scratch documents (/scratch, server/documents/make.ts): the tip of + Scratch on the documents page, and Save on a
// scratch document's page, for its owner (client/inline/scratch.ts). Both tips have the card of client/inline/scratch.css.

import { inlineCall, inlineStyle } from "./inline.ts";

/** Unsaved, a scratch document goes `hours` after it's made (the setting delete_docs_after_hours). */
const deleted = (hours: number) => `Unsaved scratch docs are deleted in ${hours}h`;

/** Save's tip: `hours`, as deleted; null: never deleted, and the tip says nothing of it. */
export const scratchTip = (hours: number | null) => `Save to your documents list.${hours == null ? "" : ` ${deleted(hours)}`}`;

/** The tip of + Scratch on the documents page: the words of Save's tip about deletion; `hours` as scratchTip. */
export const scratchMakeTip = (hours: number | null) => (hours == null ? "Not on your documents list until you save it" : deleted(hours));

/** Save on a scratch document's page, for its owner, in the quick actions: `hours`, as scratchTip. */
export const scratchSave = (doc: string, hours: number | null) =>
  `<style>${inlineStyle("scratch")}</style><script>${inlineCall("scratch", doc, scratchTip(hours))}</script>`;
