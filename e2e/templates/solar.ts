// What the Solar system tour's page shows, for its tests and its bench.
import type { Page } from "playwright-core";
import { inPage } from "./templates";

/** The note on screen, and a few of the canvas's pixels (to tell the model or the camera moved). */
export const view = (page: Page) => inPage<{ note: string; pixels: string }>(page, `(() => {
  const c = document.getElementById("space"), d = document.createElement("canvas");
  d.width = 16; d.height = 9; d.getContext("2d").drawImage(c, 0, 0, 16, 9);
  return { note: [...document.querySelectorAll(".note")].filter((n) => !n.hidden).map((n) => n.querySelector("h1").textContent).join(),
    pixels: [...d.getContext("2d").getImageData(0, 0, 16, 9).data].join() };
})()`);
