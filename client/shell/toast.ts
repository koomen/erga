// The toast: a short confirmation ("Saved", "Zoom 125%") that fades on its own. It is not an alert
// (client/common/alerts.ts): it has a place of its own, over the alerts' card, and never takes an alert's place.

import { ms } from "../../libs/text/ui/timescale";
import { $ } from "./shell";

export function mountToast() {
  const toast = $("toast");
  let timer = 0;
  return {
    flash(text: string, duration = 1400) {
      toast.textContent = text;
      toast.classList.add("show");
      clearTimeout(timer);
      timer = window.setTimeout(() => toast.classList.remove("show"), ms(duration));
    },
  };
}

export type Toast = ReturnType<typeof mountToast>;
