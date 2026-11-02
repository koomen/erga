// An edit's input, checked against the edit's JSON Schema (its `input`, as document_api lists it) before the edit runs:
// call_edit (tools.ts) answers what is wrong with the input, for a library's edits and a page's own alike.

import { JsonSchema, Result, Schema, SchemaIssue, SchemaRepresentation } from "effect";

const issues = SchemaIssue.makeFormatterStandardSchemaV1();

/** What is wrong with `input` for the edit named `edit`, or null if nothing is. */
export function inputProblem(edit: string, schema: Record<string, unknown>, input: unknown): string | null {
  let codec: Schema.Codec<unknown, unknown>;
  try {
    // A pattern in a page's schema is the page's code: the server doesn't run its regular expressions.
    codec = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema), {
      patterns: "ignore",
    }) as Schema.Codec<unknown, unknown>;
  } catch (e) {
    return `${edit}'s input schema can't be checked: ${(e as Error).message}`;
  }
  const r = Schema.decodeUnknownResult(codec)(input, { errors: "all", onExcessProperty: "error" });
  if (Result.isSuccess(r)) return null;
  const what = issues(r.failure.issue).issues.map(({ message, path }) => {
    const at = path?.map((p) => (typeof p == "object" ? String(p.key) : String(p))).join(".");
    if (!at) return message;
    if (message == "Missing key") return `${at} is required`;
    return `${at}: ${message}`;
  });
  return `${edit}'s input is wrong: ${what.join("; ")}. document_api lists its input's schema.`;
}
