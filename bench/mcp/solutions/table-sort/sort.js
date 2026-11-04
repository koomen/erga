// Sorts the sales table by a column when its header is clicked: ascending first, then descending. Numbers sort by
// value. The rows move; their text does not change. The totals row is in tfoot, so it stays at the bottom.

const table = document.getElementById("sales");
const body = table.tBodies[0];
const value = (text) => {
  const n = Number(text.replace(/[$,\s]/g, ""));
  return text.trim() != "" && Number.isFinite(n) ? n : null;
};

for (const [col, th] of [...table.tHead.rows[0].cells].entries()) {
  th.addEventListener("click", () => {
    const dir = th.getAttribute("aria-sort") == "ascending" ? -1 : 1;
    for (const other of table.tHead.rows[0].cells) other.removeAttribute("aria-sort");
    th.setAttribute("aria-sort", dir == 1 ? "ascending" : "descending");
    const rows = [...body.rows];
    const numeric = rows.every((r) => value(r.cells[col].textContent) != null);
    const key = (r) => (numeric ? value(r.cells[col].textContent) : r.cells[col].textContent.trim());
    rows.sort((a, b) => dir * (numeric ? key(a) - key(b) : key(a).localeCompare(key(b), "en", { sensitivity: "base" })));
    body.append(...rows);
  });
}
