// This page's own edits (its API: <meta name="erga-api" content="api.js">). Erga runs it in a sandbox, for the page's
// buttons (ergaEditor.call) and for agents (call_edit). A view is named by its place in the tree: [2, 1] is the first
// view under the second.
const NEW = `<li>
  <div class="view">
    <div class="view-head"><h3>New view</h3><p class="url">/path</p></div>
  </div>
</li>`;
const view = (path) => ".map > ul" + path.map((n) => ` > li:nth-child(${n})`).join(" > ul");
const list = (path) => (path.length ? view(path) + " > ul" : ".map > ul");
const place = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  description: "The view's place: [2, 1] is the first view under the second",
};

export default {
  name: "views",
  description: "The views of the tree: add, delete, move.",
  edits: [
    {
      name: "add_view",
      description: "Adds a new view at the end of a list",
      input: {
        type: "object",
        properties: { list: { ...place, description: "The view whose list it goes in; [] for the top" } },
        required: ["list"],
      },
    },
    {
      name: "add_under",
      description: "Adds a new view under a view, starting its list if it has none",
      input: { type: "object", properties: { view: place, has_list: { type: "boolean" } }, required: ["view", "has_list"] },
    },
    {
      name: "delete_view",
      description: "Deletes a view, with the views under it",
      input: { type: "object", properties: { view: place }, required: ["view"] },
    },
    {
      name: "move_view",
      description: "Moves a view one place up (-1) or down (1) in its list",
      input: { type: "object", properties: { view: place, by: { enum: [-1, 1] } }, required: ["view", "by"] },
    },
  ],
  apply(html, edit, input) {
    const p = input.view ?? [];
    if (edit == "add_view") return [{ op: "insert", into: list(input.list), html: NEW }];
    if (edit == "add_under")
      return input.has_list
        ? [{ op: "insert", into: list(p), html: NEW }]
        : [{ op: "insert", into: view(p), html: `<ul class="branch">\n${NEW}\n</ul>` }];
    if (edit == "delete_view") return [{ op: "remove", el: view(p) }];
    if (edit == "move_view") {
      const to = [...p.slice(0, -1), p.at(-1) + input.by];
      if (to.at(-1) < 1) return { refused: "the first view can't move up" };
      return [{ op: "move", el: view(p), [input.by < 0 ? "before" : "after"]: view(to) }];
    }
    return { refused: `no edit named ${edit}` };
  },
};
