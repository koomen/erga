// erga/steps' API: a presentation's steps, as the page says them (window.ergaSteps, the contract) and as the agent names
// them (view_page's and eval_in_page's `step`): a number as the steps' list shows it ("3.2": slide 3, its second part;
// "4": slide 4, or its first part), or a hash ("#3.2"). Pure. The steps library on the page (libs/steps/ui/steps.ts)
// answers the agent's render (client/page-tools/capture.ts) with goToStep; the agent's tool cleans the step with stepSpec.

import type { StepShown } from "../../../shared/agent-log";

/**
 * The contract: window.ergaSteps, which a presentation's page defines in its own code, and imports erga/steps (the
 * templates' slides.js and canvas.js: assets/templates/; e2e/fixtures/steps and builds). A step is what people see at one moment: a slide, or one part of
 * a slide that builds up in parts, numbered from 0. The page says when the step or the steps change
 * (dispatchEvent(new Event("ergastep"))); the bar also checks a few times a second. The bar takes ← and → unless the
 * page calls preventDefault() on them.
 */
export type Steps = {
  /** How many steps there are. */
  count(): unknown;
  /** Shows step n. */
  go(n: number): void;
  /** The step shown now. */
  current(): unknown;
  /** A short name for step i (its title). Without it, the list says "Step 3". */
  label?(i: number): unknown;
  /** A small picture of step i, about that size: a canvas, a Blob or an image's address, or a Promise of one. */
  image?(i: number, size: { width: number; height: number }): unknown;
  /** The slide step i is on (from 0), for a deck whose slides build up in parts: then "3.2" is slide 3's second part. */
  slide?(i: number): unknown;
};

/** The most steps Erga reads of a page. */
export const STEP_MAX = 1000;
/** `x` as a whole number from 0 to `max`. */
export const whole = (x: unknown, max: number) => {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};

/** The slide each of the `count` steps is on (null: each step a slide of its own), never one before the step before's. */
export function slidesOf(p: Steps, count: number): number[] | null {
  if (typeof p.slide != "function") return null;
  const slides: number[] = [];
  for (let i = 0; i < count; i++) slides.push(Math.max(i ? slides[i - 1] : 0, whole(p.slide(i), STEP_MAX)));
  return slides;
}

/** A step's label, as the list and the agent read it: one line, at most 200 characters ("" for none). */
export const labelOf = (p: Steps, i: number) => {
  const l = typeof p.label == "function" ? p.label(i) : "";
  return typeof l == "string" ? l.replace(/\s+/g, " ").trim().slice(0, 200) : "";
};

/**
 * Shows the step `spec` names (a stepSpec), for the agent's render: the step shown, or why not, in words for the agent.
 * A hash ("#3.2": the render opened at it) shows the step the page is at.
 */
export function goToStep(p: Steps, spec: string): StepShown | string {
  try {
    const count = whole(p.count(), STEP_MAX);
    if (!count) return "The page's ergaSteps.count() answered no steps.";
    const slides = slidesOf(p, count);
    const i = spec.startsWith("#") ? whole(p.current(), count - 1) : findStep(spec, count, slides);
    if (typeof i == "string") return i;
    if (!spec.startsWith("#")) p.go(i);
    const label = labelOf(p, i);
    return { index: i, number: stepNumber(i, slides), count, ...(label ? { label } : {}) };
  } catch (e) {
    return `The page's ergaSteps threw: ${(e as Error)?.message ?? String(e)}`;
  }
}

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
