/** A button that acts on its second click: the first shows `ask` for a while (`ms`), then `label` again. True on the second. */
export const secondClick = (btn: HTMLElement, ask: string, label: string, ms = 8000, mark?: (on: boolean) => void) => {
  const show = (on: boolean) => {
    btn.dataset.armed = on ? "1" : "";
    btn.textContent = on ? ask : label;
    mark?.(on);
  };
  if (btn.dataset.armed == "1") {
    btn.dataset.armed = "";
    return true;
  }
  show(true);
  setTimeout(() => btn.dataset.armed == "1" && show(false), ms);
  return false;
};
