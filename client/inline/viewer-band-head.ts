// The band's colour on a document's page (server/pages/viewer.ts), set before it paints: ergaBand(id, colour) sets it
// and remembers it for document `id`, ergaBand(id) sets the one remembered; and the controls' tone to suit. It answers
// the tone.

export default function viewerBandHead(): void {
  window.ergaBand = function (id: string, color?: string) {
    const key = "erga:band:v1:" + id,
      root = document.documentElement;
    let tone = "";
    try {
      if (color === undefined) {
        const b = JSON.parse(localStorage.getItem(key) || "null");
        color = b && typeof b.bg == "string" ? (b.bg as string) : "";
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
    if (arguments.length > 1)
      try {
        localStorage.setItem(key, JSON.stringify({ bg: color, tone }));
      } catch {}
    return tone;
  };
}
