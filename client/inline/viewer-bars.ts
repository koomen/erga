// The viewer's bars (server/pages/viewer.ts, after them): their buttons (client/common/bars.ts). A tap in the page closes
// the quick actions: the page is in the frame, on its own origin, which says so (pages/reader.ts: erga-pointer with tap),
// and a click there takes the focus from this window.

import { mountBars } from "../common/bars";

export default function viewerBars(): void {
  const toggle = mountBars(document, document.body);
  addEventListener("message", (e) => {
    if (ergaFrames.from(e) && e.data?.type == "erga-pointer" && e.data.tap === true) toggle(false);
  });
  addEventListener("blur", () => {
    if (!document.body.classList.contains("erga-editing")) toggle(false);
  });
}
