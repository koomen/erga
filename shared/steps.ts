// A presentation's steps, as the agent names them (view_page's and evaluate_page's `step`): its number as the steps'
// list shows it ("3.2": slide 3, its second part; "4": slide 4, or its first part), or a hash ("#3.2"). agents/document/PROMPT.md, "Presentations", has the page's side. Pure: the hidden
// render (libs/text/ui/capture.ts) asks the page for its count and slides, and this finds the step.

/** Step i's number, as the list shows it: "3.2" for the second part of slide 3, "4" for a slide in one step. */
export function stepNumber(i: number, slides: number[] | null): string {
  if (!slides) return String(i + 1);
  let first = i,
    last = i;
  while (first > 0 && slides[first - 1] == slides[i]) first--;
  while (last < slides.length - 1 && slides[last + 1] == slides[i]) last++;
  return slides[i] + 1 + (last > first ? "." + (i - first + 1) : "");
}

/**
 * A step as the agent gave it, cleaned: a number as its digits (3.3 is "3.3", slide 3's third part: never an index),
 * without the quotes or space a model sometimes wraps it in ("\"#3.3\"" is "#3.3").
 */
export const stepSpec = (raw: string | number): string =>
  String(raw)
    .trim()
    .replace(/^(["'`])(.*)\1$/, "$2")
    .trim();

/**
 * The step `spec` (a stepSpec, not a hash) names, of `count` steps on `slides` (each step's slide, from 0; null: each step a slide of its own);
 * or why it names none, in words for the agent.
 */
export function findStep(spec: string, count: number, slides: number[] | null): number | string {
  const all = `The page has ${count} step${count == 1 ? "" : "s"}${slides ? ` on ${slides[count - 1] + 1} slides (numbered 1 to ${stepNumber(count - 1, slides)})` : ""}.`;
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(spec);
  if (!m)
    return `"${spec}" isn't a step: give its number as the steps' list shows it ("3", or "3.2" for the second part of slide 3), or a hash ("#3.2"). ${all}`;
  const slide = Number(m[1]) - 1,
    part = m[2] == null ? 1 : Number(m[2]);
  if (!slides) {
    if (m[2] != null && part != 1)
      return `"${spec}" names a part of a slide, but the page's steps have no parts (its ergaSteps has no slide()). ${all}`;
    return slide >= 0 && slide < count ? slide : `There's no step ${m[1]}. ${all}`;
  }
  const first = slides.indexOf(slide);
  if (first < 0) return `There's no slide ${m[1]}. ${all}`;
  const i = first + part - 1;
  if (part < 1 || i >= count || slides[i] != slide) {
    const parts = slides.filter((s) => s == slide).length;
    return `Slide ${m[1]} has ${parts} part${parts == 1 ? "" : "s"} (${m[1]}.1 to ${m[1]}.${parts}), so there's no "${spec}". ${all}`;
  }
  return i;
}
