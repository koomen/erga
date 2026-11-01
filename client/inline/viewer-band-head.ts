// The band's colour on a document's page (server/pages/viewer.ts), set before it paints: ergaBand(id, colour) sets it
// and remembers it for document `id`, ergaBand(id) sets the one remembered, and where the frame was; and the controls'
// tone to suit. It answers the tone.

export default function viewerBandHead(): void {
  // (`given`: whether a colour was passed at all, as ergaBand(id) remembers nothing.)
  window.ergaBand = (id: string, ...given: [color?: string]) => {
    let color = given[0];
    const key = "erga:band:v1:" + id,
      root = document.documentElement;
    let tone = "";
    try {
      if (color === undefined) {
        const b = JSON.parse(localStorage.getItem(key) || "null");
        color = b && typeof b.bg == "string" ? (b.bg as string) : "";
        // And whether the page filled the window last time (its frame below the band: viewer-band.ts).
        root.classList.toggle("erga-fills", localStorage.getItem("erga:fills:v1:" + id) == "1");
      }
    } catch {
      color = "";
    }
    if (color && !(window.CSS && CSS.supports("color", color))) color = "";
    const rgb = color!.match(/[\d.]+/g)?.map(Number);
    if (color && /^rgba?\(/.test(color) && rgb && rgb.length >= 3)
      tone = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45 ? "page-dark" : "page-light";
    if (color) root.style.setProperty("--band", color);
    else root.style.removeProperty("--band");
    root.classList.toggle("page-dark", tone == "page-dark");
    root.classList.toggle("page-light", tone == "page-light");
    if (given.length)
      try {
        localStorage.setItem(key, JSON.stringify({ bg: color, tone }));
      } catch {}
    return tone;
  };
}
