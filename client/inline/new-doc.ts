// The New document picker on a page (server/pages/viewer.ts): client/common/new-doc.ts.

import { newDocPicker } from "../common/new-doc";

export default function newDoc(): void {
  newDocPicker(document);
}
