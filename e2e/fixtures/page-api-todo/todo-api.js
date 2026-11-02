// The page's own edits: check off and move the todo list's items. Items are numbered from 1.
const item = (n) => `ul.todo > li:nth-child(${n})`;
const num = { type: "integer", minimum: 1 };

export default {
  name: "todo",
  description: "The page's todo list.",
  edits: [
    {
      name: "check_item",
      description: "Checks an item off, or unchecks it",
      input: { type: "object", properties: { n: num, done: { type: "boolean" } }, required: ["n", "done"] },
    },
    {
      name: "move_item",
      description: "Moves item n before item `before`, or to the end when before is 0",
      input: { type: "object", properties: { n: num, before: { type: "integer", minimum: 0 } }, required: ["n", "before"] },
    },
  ],
  apply(html, edit, input) {
    if (edit == "check_item") return [{ op: "attr", el: item(input.n), name: "class", value: input.done ? "done" : null }];
    if (edit == "move_item") {
      if (input.before == input.n) return { refused: "the item is already there" };
      return [
        input.before ? { op: "move", el: item(input.n), before: item(input.before) } : { op: "move", el: item(input.n), into: "ul.todo" },
      ];
    }
    return { refused: `no edit named ${edit}` };
  },
};
