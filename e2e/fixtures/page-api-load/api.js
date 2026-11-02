export default {
  name: "note",
  edits: [{ name: "remove_note", description: "Removes the note", input: { type: "object" } }],
  apply: () => [{ op: "remove", el: "#note" }],
};
