// Reusable visual badge helper for Erga architecture demos:
// 1. Styles `[data-planned="true"]` nodes/chips in proposal-mode demos with a
//    subtle dashed amber "planned" badge (light & dark mode).
// 2. Renders a compact Verification Ledger strip inside or below a demo container.
//
// Usage:
//   mountVerifyBadge(shadowRoot, { status: "verified", combos: 20, traces: 5, elided: 3, planned: 0 });

(() => {
  const BADGE_CSS = `
[data-planned="true"] {
  outline: 1.5px dashed #d97706 !important;
  outline-offset: -1px;
  position: relative;
}
[data-planned="true"]::after {
  content: "planned";
  position: absolute;
  top: 6px;
  right: 8px;
  font: 600 9.5px/1 ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  pointer-events: none;
}
.erga-verify-ledger {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 10px;
  border-radius: 999px;
  font: 500 11.5px/1.3 ui-sans-serif, system-ui, sans-serif;
  background: #eef6f1;
  color: #166534;
  box-shadow: inset 0 0 0 0.5px rgba(22, 101, 52, 0.2);
}
.erga-verify-ledger.is-proposal {
  background: #fef6e7;
  color: #92400e;
  box-shadow: inset 0 0 0 0.5px rgba(146, 64, 14, 0.24);
}
.erga-verify-ledger i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
@media (prefers-color-scheme: dark) {
  [data-planned="true"] { outline-color: #f59e0b !important; }
  [data-planned="true"]::after { background: #3a2a10; color: #f6c46d; }
  .erga-verify-ledger { background: #143025; color: #6fd3a0; box-shadow: inset 0 0 0 0.5px rgba(111, 211, 160, 0.25); }
  .erga-verify-ledger.is-proposal { background: #3a2a10; color: #f0b45c; box-shadow: inset 0 0 0 0.5px rgba(240, 180, 92, 0.28); }
}
`;

  function mountVerifyBadge(root, ledger) {
    if (!root) return;
    if (!root.querySelector("[data-erga-verify-css]")) {
      const style = document.createElement("style");
      style.dataset.ergaVerifyCss = "";
      style.textContent = BADGE_CSS;
      root.append(style);
    }
    if (!ledger) return;
    let bar = root.querySelector(".erga-verify-ledger");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "erga-verify-ledger";
      root.append(bar);
    }
    bar.classList.toggle("is-proposal", ledger.status === "proposal");
    const bits = [
      ledger.status === "verified" ? "Verified against HEAD" : `Proposal (${ledger.planned || 0} planned)`,
      ledger.combos ? `${ledger.combos} toggle combos via gate()` : "",
      ledger.traces ? `${ledger.traces} live traces` : "",
      ledger.elided != null ? `${ledger.elided} declared elisions` : "",
    ].filter(Boolean);
    bar.innerHTML = `<i></i><span>${bits.join(" · ")}</span>`;
  }

  window.mountVerifyBadge = mountVerifyBadge;
})();
