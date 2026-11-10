// The viewer's bars (server/pages/viewer.ts, after them): their buttons (client/common/bars.ts). A tap in the page closes
// the quick actions: the page is in the frame, on its own origin, which says so (pages/reader.ts: erga-pointer with tap),
// and a click there takes the focus from this window. And ⌘P, which prints the page.

import { mountBars } from "../common/bars";

export default function viewerBars(): void {
  const toggle = mountBars(document, document.body);
  addEventListener("message", (e) => {
    if (ergaFrames.from(e) && e.data?.type == "erga-pointer" && e.data.tap === true) toggle(false);
  });
  // Print (⌘P; Ctrl+P off a Mac): the page in the frame prints itself, whole and without Erga's bars (reader.ts).
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  addEventListener("keydown", (e) => {
    if (
      !(mac ? e.metaKey : e.ctrlKey) ||
      e.shiftKey ||
      e.altKey ||
      e.key.toLowerCase() != "p" ||
      document.body.classList.contains("source")
    )
      return;
    e.preventDefault();
    ergaFrames.send({ type: "erga-print" });
  });
  addEventListener("blur", () => {
    if (!document.body.classList.contains("erga-editing")) toggle(false);
  });
}
