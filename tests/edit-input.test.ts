// call_edit checks an edit's input against the edit's JSON Schema before the edit runs (agents/document/edit-input.ts).
import { expect, test } from "bun:test";
import { inputProblem } from "../agents/document/edit-input";
import { slidesApi } from "../libs/slides/api/slides";
import { textApi } from "../libs/text/api/edits";

const schemaOf = (api: typeof slidesApi, name: string) => api.edits.find((e) => e.name == name)!.input;

test("an input that fits the edit's schema passes; one that doesn't says what is wrong, each problem by its key", () => {
  const move = schemaOf(slidesApi, "move_slide");
  expect(inputProblem("move_slide", move, { slide: 3, to: 2 })).toBeNull();
  expect(inputProblem("move_slide", move, { slide: 3, by: -1 })).toBe(
    "move_slide's input is wrong: to is required. document_api lists its input's schema."
  );
  expect(inputProblem("move_slide", move, { slide: "3", to: 1.5 })).toBe(
    "move_slide's input is wrong: slide: Expected number; to: Expected an integer. document_api lists its input's schema."
  );
  expect(inputProblem("set_layout", schemaOf(slidesApi, "set_layout"), { slide: 1, layout: "big" })).toMatch(
    /layout: Expected "title" \| "content"/
  );
  expect(inputProblem("replace_text", schemaOf(textApi, "replace_text"), { selector: "h1", find: "a", text: "b", x: 1 })).toMatch(
    /: x: Expected no excess property\./
  );
});

test("a page's own schema: a pattern isn't run on the server; a schema that can't be checked says so", () => {
  const schema = { type: "object", properties: { id: { type: "string", pattern: "^(a+)+$" } }, required: ["id"] };
  expect(inputProblem("tag", schema, { id: "b" })).toBeNull();
  expect(inputProblem("tag", schema, {})).toMatch(/id is required/);
  // Open, as a schema is unless it says additionalProperties: false: other keys pass.
  expect(inputProblem("tag", schema, { id: "a", note: 1 })).toBeNull();
  expect(inputProblem("tag", { $ref: "https://example.com/s.json" }, {})).toMatch(/^tag's input schema can't be checked: /);
});
