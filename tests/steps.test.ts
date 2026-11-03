// A presentation's step, as the agent names it to view_page and eval_in_page (libs/steps/api/steps.ts).
import { expect, test } from "bun:test";
import { findStep, goToStep, stepNumber, stepSpec } from "../libs/steps/api/steps";

// Slide 1 in three parts, slide 2 in one, slide 3 in two.
const SLIDES = [0, 0, 0, 1, 2, 2];

test("a step's number reads as the steps' list shows it", () => {
  expect(SLIDES.map((_, i) => stepNumber(i, SLIDES))).toEqual(["1.1", "1.2", "1.3", "2", "3.1", "3.2"]);
  expect(stepNumber(4, null)).toBe("5");
});

test("a number or a slide finds its step; a step that isn't there says what there is", () => {
  expect(findStep("3.2", 6, SLIDES)).toBe(5);
  expect(findStep("3", 6, SLIDES)).toBe(4);
  expect(findStep("2", 6, SLIDES)).toBe(3);
  expect(findStep(" 1.3 ", 6, SLIDES)).toBe(2);
  expect(findStep("4", 5, null)).toBe(3);
  expect(findStep("3.3", 6, SLIDES)).toMatch(
    /Slide 3 has 2 parts \(3\.1 to 3\.2\), so there's no "3\.3"\. The page has 6 steps on 3 slides/
  );
  expect(findStep("4", 6, SLIDES)).toMatch(/There's no slide 4/);
  expect(findStep("2.2", 5, null)).toMatch(/steps have no parts/);
  expect(findStep("next", 5, null)).toMatch(/isn't a step/);
});

test("a step as a model gives it: a number is its digits, never an index; quotes and space go", () => {
  expect(stepSpec(3.3)).toBe("3.3");
  expect(stepSpec(3)).toBe("3");
  expect(stepSpec('"#3.3"')).toBe("#3.3");
  expect(stepSpec(" '3.2' ")).toBe("3.2");
  expect(findStep(stepSpec(3.3), 6, [0, 1, 2, 2, 2, 3])).toBe(4);
});

test("goToStep, the steps library's answer to the agent's render: shows the step a spec names, or says why not", () => {
  let at = 0;
  const deck = {
    count: () => 6,
    current: () => at,
    go: (n: number) => void (at = n),
    slide: (i: number) => SLIDES[i],
    label: (i: number) => `Slide  ${SLIDES[i] + 1}\n`,
  };
  expect(goToStep(deck, "3.2")).toEqual({ index: 5, number: "3.2", count: 6, label: "Slide 3" });
  expect(at).toBe(5);
  // A hash: the render opened there; the page says its step.
  at = 1;
  expect(goToStep(deck, "#1.2")).toEqual({ index: 1, number: "1.2", count: 6, label: "Slide 1" });
  expect(goToStep(deck, "4")).toMatch(/There's no slide 4/);
  expect(goToStep({ count: () => 0, current: () => 0, go() {} }, "1")).toMatch(/answered no steps/);
  expect(
    goToStep(
      {
        count: () => {
          throw new Error("broken");
        },
        current: () => 0,
        go() {},
      },
      "1"
    )
  ).toMatch(/threw: broken/);
});
