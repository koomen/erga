// The converter: each kind of quantity has units, each unit its size in the kind's base unit (metre, kilogram,
// litre). Temperature has offsets too, so it converts through kelvin. The result and the list of recent
// conversions are drawn into their own empty elements.

const UNITS = {
  length: {
    m: ["metres", 1],
    km: ["kilometres", 1000],
    cm: ["centimetres", 0.01],
    mi: ["miles", 1609.344],
    ft: ["feet", 0.3048],
    in: ["inches", 0.0254],
  },
  mass: {
    kg: ["kilograms", 1],
    g: ["grams", 0.001],
    lb: ["pounds", 0.45359237],
    oz: ["ounces", 0.028349523125],
    st: ["stone", 6.35029318],
  },
  temperature: { C: ["degrees Celsius"], F: ["degrees Fahrenheit"], K: ["kelvin"] },
  volume: {
    l: ["litres", 1],
    ml: ["millilitres", 0.001],
    gal: ["US gallons", 3.785411784],
    floz: ["US fluid ounces", 0.0295735295625],
    cup: ["US cups", 0.2365882365],
  },
};
const DEFAULTS = { length: ["km", "mi"], mass: ["kg", "lb"], temperature: ["C", "F"], volume: ["l", "gal"] };

const $ = (id) => document.getElementById(id);
const category = $("category"),
  value = $("value"),
  from = $("from"),
  to = $("to"),
  result = $("result"),
  history = $("history");

const toKelvin = { C: (v) => v + 273.15, F: (v) => ((v - 32) * 5) / 9 + 273.15, K: (v) => v };
const fromKelvin = { C: (k) => k - 273.15, F: (k) => ((k - 273.15) * 9) / 5 + 32, K: (k) => k };

/** v in unit a, converted to unit b of the kind. */
export function convert(kind, v, a, b) {
  if (kind == "temperature") return fromKelvin[b](toKelvin[a](v));
  return (v * UNITS[kind][a][1]) / UNITS[kind][b][1];
}

/** A number with at most four significant decimals, without trailing zeros. */
const show = (n) =>
  Number.isFinite(n) ? Number(n.toPrecision(Math.abs(n) >= 1 ? 7 : 4)).toLocaleString("en", { maximumFractionDigits: 4 }) : "–";

function fillUnits() {
  const units = UNITS[category.value];
  const options = Object.entries(units)
    .map(([k, [name]]) => `<option value="${k}">${name}</option>`)
    .join("");
  from.innerHTML = to.innerHTML = options;
  [from.value, to.value] = DEFAULTS[category.value];
}

function update() {
  const v = Number.parseFloat(value.value);
  if (Number.isNaN(v)) {
    result.textContent = "Type a number to convert.";
    return;
  }
  const out = convert(category.value, v, from.value, to.value);
  const unit = (k) => UNITS[category.value][k][0];
  result.textContent = `${show(v)} ${unit(from.value)} = ${show(out)} ${unit(to.value)}`;
}

/** Keeps the last five results the person settled on (a change, not each key). */
function remember() {
  if (!result.textContent || result.textContent.startsWith("Type")) return;
  const li = document.createElement("li");
  li.textContent = result.textContent;
  history.prepend(li);
  while (history.children.length > 5) history.lastElementChild.remove();
}

category.addEventListener("change", () => {
  fillUnits();
  update();
});
value.addEventListener("input", update);
for (const el of [from, to]) el.addEventListener("change", update);
for (const el of [value, from, to]) el.addEventListener("change", remember);
$("swap").addEventListener("click", () => {
  [from.value, to.value] = [to.value, from.value];
  update();
  remember();
});
$("converter").addEventListener("submit", (e) => e.preventDefault());

fillUnits();
update();
