// The confirmation every copy button shows, on itself.

/** A copy button confirms on itself: "Copied ✓", with a short pop (style.css, .copied). An icon button keeps its icon and
 *  says it in its tooltip (the editor's and the viewer's icon buttons), shown for the moment. With `then` (the card closes), that comes a moment later, so the
 *  confirmation shows first; the label comes back then. */
export function showCopied(button: HTMLElement, then?: () => void) {
  const icon = button.matches(".icon-btn, .erga-view-button");
  const label = (button.dataset.label ??= (icon ? button.dataset.tip : button.textContent) ?? "");
  if (icon) button.dataset.tip = "Copied ✓";
  else {
    button.style.minWidth = `${button.offsetWidth}px`;
    button.textContent = "Copied ✓";
  }
  button.classList.remove("copied");
  void button.offsetWidth; // the pop again, on a second copy
  button.classList.add("copied");
  clearTimeout(Number(button.dataset.timer));
  const done = () => {
    then?.();
    if (icon) button.dataset.tip = label;
    else {
      button.textContent = label;
      button.style.minWidth = "";
    }
    button.classList.remove("copied");
  };
  button.dataset.timer = String(setTimeout(done, then ? 700 : 1600));
}
