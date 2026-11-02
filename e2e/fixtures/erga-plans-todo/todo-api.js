// The page's own edits. The todo list: add, check off, delete and move items.
// The plans: set a plan's status, which keeps them sorted by status.
// Items are numbered from 1, in the order of their list's children.
const item = (n) => `ul.todo > li:nth-child(${n})`;
const plan = (n) => `ul.plans > li:nth-child(${n})`;
const num = { type: "integer", minimum: 1 };
// Plans' statuses, in the order they're sorted: drafts at the top, merged at the bottom.
const STATUSES = { draft: "Draft", "in-progress": "In progress", staging: "Staging", merged: "Merged" };
const rank = (s) => Object.keys(STATUSES).indexOf(s);

function setStatus(html, n, status) {
  if (!(status in STATUSES)) return { refused: `status is one of ${Object.keys(STATUSES).join(", ")}` };
  const ul = html.match(/<ul class="plans">([\s\S]*?)<\/ul>/);
  if (!ul) return { refused: "no ul.plans on the page" };
  const lis = ul[1].match(/<li\b[\s\S]*?<\/li>/g) || [];
  const li = lis[n - 1];
  if (!li) return { refused: `there is no plan ${n}` };
  const re = /(<span class="status )[\w-]+("[^>]*>)[^<]*(<\/span>)/;
  if (!re.test(li)) return { refused: `plan ${n} has no status` };
  const now = li.match(re)[0].match(/status ([\w-]+)/)[1];
  if (now == status) return { refused: `plan ${n} is ${STATUSES[status]} already` };
  const html2 = li.replace(re, `$1${status}$2${STATUSES[status]}$3`);
  // Its place: at the top of its status's group, among the other plans.
  const others = lis.map((l, i) => ({ i: i + 1, s: (l.match(/class="status ([\w-]+)"/) || [])[1] })).filter((o) => o.i != n);
  const at = others.find((o) => rank(o.s) >= rank(status));
  return [
    { op: "remove", el: plan(n) },
    at ? { op: "insert", before: plan(at.i), html: html2 } : { op: "insert", into: "ul.plans", html: html2 },
  ];
}

export default {
  name: "todo",
  description: "The page's todo list.",
  edits: [
    { name: "add_item", description: "Adds an item at the end of the todo list", input: { type: "object", properties: {} } },
    {
      name: "check_item",
      description: "Checks an item off, or unchecks it",
      input: {
        type: "object",
        properties: { n: { ...num, description: "1 is the first item" }, done: { type: "boolean" } },
        required: ["n", "done"],
      },
    },
    {
      name: "delete_item",
      description: "Deletes an item",
      input: { type: "object", properties: { n: { ...num, description: "1 is the first item" } }, required: ["n"] },
    },
    {
      name: "set_status",
      description:
        "Sets a plan's status (draft, in-progress, staging or merged) and moves it to the top of that status's group: drafts first, merged last",
      input: {
        type: "object",
        properties: { n: { ...num, description: "1 is the first plan" }, status: { type: "string", enum: Object.keys(STATUSES) } },
        required: ["n", "status"],
      },
    },
    {
      name: "move_item",
      description: "Moves item n before item `before` (numbered as the list is now), or to the end when before is 0",
      input: { type: "object", properties: { n: num, before: { type: "integer", minimum: 0 } }, required: ["n", "before"] },
    },
  ],
  apply(html, edit, input) {
    if (edit == "set_status") return setStatus(html, input.n, input.status);
    if (edit == "add_item") return [{ op: "insert", into: "ul.todo", html: "<li><p>New item</p></li>" }];
    if (edit == "check_item") return [{ op: "attr", el: item(input.n), name: "class", value: input.done ? "done" : null }];
    if (edit == "delete_item") return [{ op: "remove", el: item(input.n) }];
    if (edit == "move_item") {
      if (input.before == input.n) return { refused: "the item is already there" };
      return [
        input.before ? { op: "move", el: item(input.n), before: item(input.before) } : { op: "move", el: item(input.n), into: "ul.todo" },
      ];
    }
    return { refused: `no edit named ${edit}` };
  },
};
