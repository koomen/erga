// The viewer's one word to the page's editor (frame.ts), by postMessage from the viewer's origin: edit or view. Edit
// says where the document is (`doc`: its address on the viewer's origin, https://erga.dev/d/<id>, under which its
// socket and its files are), the edit key that opens them (server/documents/edit-key.ts; the viewer gives a new one
// before the last ends, for the next socket), who this tab is (`me`: the room attributes the edits to the key's person;
// this is how the editor shows them), which of the document's pages this is (`path`), this tab's own mark (`tab`: its
// presence in the room carries it, so the viewer knows its own page's caret), the zoom the viewer draws the page at, and
// what the tests set (`timescale`, `check`). `comment`: for a person who may comment and not edit (a commenter:
// client/inline/viewer-comment.ts sends it): the comments alone, on a page that nothing here changes.

import type { Author } from "../../../document/content";

export type EditMode =
  | {
      type: "erga-mode";
      mode: "edit";
      doc: string;
      key: string;
      me: Author;
      path: string;
      tab: string;
      zoom: number;
      /** The height of the frame's place on the screen, px: at `zoom`, the page's window is `tall / zoom` high. */
      tall: number;
      /** The browser has the whole window zoomed (its own pinch): a pinch on the page stays the browser's. */
      pinched: boolean;
      timescale?: number;
      check?: boolean;
      comment?: true;
    }
  | { type: "erga-mode"; mode: "view" };
