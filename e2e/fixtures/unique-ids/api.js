// The cards' own edits (e2e/full/page/unique-ids.e2e.ts), each card named by its place (1 is the first). A copy keeps
// the card's id, which the editor then takes off: an id is unique in the page.
const card = (n) => `.cards > article:nth-child(${n})`;
export default {
  name: "cards",
  edits: [
    {
      name: "copy_card",
      description: "Adds a copy of a card after it",
      input: { type: "object", properties: { card: { type: "integer" }, id: { type: "string" }, title: { type: "string" } } },
    },
    {
      name: "move_up",
      description: "Moves a card before the one before it",
      input: { type: "object", properties: { card: { type: "integer" } } },
    },
  ],
  apply(html, edit, input) {
    if (edit == "copy_card")
      return [
        {
          op: "insert",
          after: card(input.card),
          html: `<article class="card" id="${input.id}">\n  <h3>${input.title} (copy)</h3>\n</article>`,
        },
      ];
    return [{ op: "move", el: card(input.card), before: card(input.card - 1) }];
  },
};
