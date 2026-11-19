// The admin pages' save mark (client/common/save-mark.ts), left of the buttons' bar: one for all of them, since the bars
// stay while one admin page takes another's place (client/admin/admin-nav.ts). Each page's script gets it here; as its
// page goes, the mark forgets what that page was saving.

import { mountSaveMark, type SaveMark } from "./save-mark";

declare global {
  interface Window {
    ergaSave?: SaveMark;
  }
}

export function saveMark(): SaveMark {
  const mark = (window.ergaSave ??= mountSaveMark(document.getElementById("save-state")!));
  window.ergaView?.onLeave(() => mark.clear());
  return mark;
}
