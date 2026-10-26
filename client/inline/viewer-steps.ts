// A presentation's steps, on a document's page (server/pages/viewer.ts), viewing and editing alike: the page says when
// it has steps (server/pages/reader.ts: erga-steps; agents/document/PROMPT.md, "Presentations"), and this shows back and
// forward under the page, the step it's at, and a list of the steps that opens over its right side. The arrow keys
// step too, pressed here or in the page, except in text. The list shows each step's picture where the page draws them
// (erga-step-image), kept until the page changes (another rev: an edit, another page), else its number and label.

type Steps = { count: number; current: number; labels: string[]; images: boolean; rev: number };

export default function viewerSteps(): void {
  const svg = (d: string) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  const bar = document.createElement("div"),
    panel = document.createElement("div");
  bar.className = "erga-steps";
  bar.hidden = true;
  bar.innerHTML =
    '<button type="button" class="erga-steps-toggle" aria-label="Steps" aria-expanded="false">' +
    svg("M5 6.5h14M5 12h14M5 17.5h14") +
    "</button>" +
    '<button type="button" class="erga-steps-back" aria-label="Back">' +
    svg("M14.5 6.5L9 12l5.5 5.5") +
    "</button>" +
    '<span class="erga-steps-at" aria-live="polite"></span>' +
    '<button type="button" class="erga-steps-next" aria-label="Forward">' +
    svg("M9.5 6.5L15 12l-5.5 5.5") +
    "</button>";
  // The list under a head: the editor docks it beside the page, and the head is where it's dragged from.
  panel.className = "erga-steps-panel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Steps");
  panel.innerHTML = '<div class="erga-steps-head">Steps</div><ol class="erga-steps-list"></ol>';
  const list = panel.querySelector("ol")!;
  document.body.append(panel, bar);
  const [toggle, back, next] = bar.querySelectorAll("button"),
    at = bar.querySelector(".erga-steps-at")!;
  // What the page says (null: no steps), the list's shape it was built for, and the steps' pictures: step -> { url, rev }.
  let steps: Steps | null = null,
    shape = "",
    timer = 0;
  const pics = new Map<number, { url: string; rev: number }>(),
    asked = new Set<string>();
  const send = (m: unknown) => ergaFrames.send(m);
  const open = () => !panel.hidden;
  const items = () => panel.querySelectorAll<HTMLElement>(".erga-step");
  const drop = () => {
    for (const p of pics.values()) URL.revokeObjectURL(p.url);
    pics.clear();
    asked.clear();
  };
  function picture(i: number) {
    const box = items()[i]?.querySelector(".erga-step-pic"),
      p = pics.get(i);
    if (!box) return;
    if (p) {
      let img = box.querySelector("img");
      if (!img) {
        box.textContent = "";
        img = box.appendChild(document.createElement("img"));
        img.alt = "";
      }
      if (img.src != p.url) img.src = p.url;
    } else if (box.querySelector("img") || !box.textContent) box.textContent = String(i + 1);
  }
  // The pictures of the steps in sight in the list, of this rev, that it hasn't yet: asked for once the page has stopped changing.
  function ask() {
    clearTimeout(timer);
    if (!steps?.images || !open()) return;
    timer = window.setTimeout(
      () => {
        const r = ergaFrames.frame.getBoundingClientRect(),
          w = 384,
          h = Math.round(w * (r.height / r.width || 9 / 16)),
          view = list.getBoundingClientRect();
        items().forEach((el, i) => {
          const b = el.getBoundingClientRect(),
            key = steps!.rev + ":" + i;
          if (b.bottom < view.top - 200 || b.top > view.bottom + 200 || pics.get(i)?.rev == steps!.rev || asked.has(key)) return;
          asked.add(key);
          send({ type: "erga-step-image", step: i, rev: steps!.rev, width: w, height: h });
        });
      },
      pics.size ? 400 : 0
    );
  }
  function build(s: Steps) {
    list.textContent = "";
    panel.classList.toggle("erga-steps-plain", !s.images);
    s.labels.forEach((label, i) => {
      const li = list.appendChild(document.createElement("li")),
        b = li.appendChild(document.createElement("button"));
      b.type = "button";
      b.className = "erga-step";
      b.dataset.step = String(i);
      b.setAttribute("aria-label", (label ? label + ", " : "") + "step " + (i + 1) + " of " + s.count);
      b.appendChild(document.createElement("span")).className = "erga-step-pic";
      const name = b.appendChild(document.createElement("span")),
        n = name.appendChild(document.createElement("b"));
      name.className = "erga-step-name";
      n.textContent = String(i + 1);
      name.appendChild(document.createElement("span")).textContent = label || "Step " + (i + 1);
      picture(i);
    });
  }
  function current() {
    if (!steps) return;
    const now = steps.current;
    items().forEach((el, i) => {
      if (i == now) el.setAttribute("aria-current", "step");
      else el.removeAttribute("aria-current");
    });
    if (open()) items()[now]?.scrollIntoView({ block: "nearest" });
  }
  function update(s: Steps | null) {
    const was = steps;
    steps = s && s.count > 0 ? s : null;
    bar.hidden = !steps;
    if (!steps) {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      shape = "";
      drop();
      return;
    }
    // Other steps: the old pictures may be of other steps. Otherwise they stay up until the new ones come.
    const now = steps.count + "\n" + steps.labels.join("\n") + "\n" + steps.images;
    if (now != shape) {
      shape = now;
      drop();
      build(steps);
    }
    at.textContent = steps.current + 1 + " / " + steps.count;
    bar.title = steps.labels[steps.current] || "";
    back.disabled = steps.current <= 0;
    next.disabled = steps.current >= steps.count - 1;
    current();
    if (!was || was.rev != steps.rev) ask();
    place();
  }
  // Under the page and over its right side (its left, if the editor's layout has the list left of the page), wherever the editor puts
  // the frame (the agent beside it), out of sight with it. Docked beside the page in the editor, the editor places the list.
  function place() {
    if (!steps) return;
    const frame = ergaFrames.frame,
      r = frame.getBoundingClientRect(),
      hidden = getComputedStyle(frame).visibility == "hidden" || !r.width;
    bar.style.visibility = panel.style.visibility = hidden ? "hidden" : "";
    bar.style.left = r.left + r.width / 2 + "px";
    bar.style.bottom = Math.max(12, innerHeight - r.bottom + 14) + "px";
    const docked = panel.classList.contains("erga-docked") && document.body.classList.contains("erga-editing");
    let left = false;
    try {
      const o = JSON.parse(localStorage.getItem("erga:layout:v1") || "null")?.order;
      left = Array.isArray(o) && o.indexOf("picker") < o.indexOf("doc");
    } catch {}
    panel.style.left = docked || !left ? "" : Math.max(8, r.left + 12) + "px";
    panel.style.right = docked ? "" : left ? "auto" : Math.max(8, innerWidth - r.right + 12) + "px";
    panel.style.top = docked ? "" : r.top + 12 + "px";
    // The pictures' shape is the frame's, as it is now (it changes with the window).
    panel.style.setProperty("--ar", r.width && r.height ? r.width + " / " + r.height : "16 / 9");
    panel.style.maxHeight = docked ? "" : Math.max(80, innerHeight - Math.max(12, innerHeight - r.bottom + 14) - 50 - r.top - 12) + "px";
  }
  function show(on: boolean) {
    panel.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
    if (on) {
      place();
      current();
      ask();
    }
  }
  addEventListener("message", (e) => {
    const m = e.data;
    if (!ergaFrames.from(e) || !m) return;
    if (m.type == "erga-steps") {
      const s = m.steps,
        ok =
          s &&
          Number.isInteger(s.count) &&
          s.count >= 0 &&
          s.count <= 1000 &&
          Number.isInteger(s.current) &&
          Number.isInteger(s.rev) &&
          Array.isArray(s.labels) &&
          s.labels.length == s.count &&
          s.labels.every((l: unknown) => typeof l == "string" && l.length <= 200);
      update(
        ok ? { count: s.count, current: Math.min(s.current, s.count - 1), labels: s.labels, images: s.images === true, rev: s.rev } : null
      );
    } else if (m.type == "erga-step-image" && steps && m.rev == steps.rev && Number.isInteger(m.step) && m.step < steps.count) {
      const old = pics.get(m.step);
      if (old) URL.revokeObjectURL(old.url);
      if (m.blob instanceof Blob && /^image\//.test(m.blob.type)) pics.set(m.step, { url: URL.createObjectURL(m.blob), rev: m.rev });
      else pics.delete(m.step);
      picture(m.step);
    }
  });
  const go = (m: { by?: number; to?: number }) => {
    if (steps) send({ type: "erga-step", ...m });
  };
  back.addEventListener("click", () => go({ by: -1 }));
  next.addEventListener("click", () => go({ by: 1 }));
  toggle.addEventListener("click", () => show(!open()));
  panel.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest?.<HTMLElement>(".erga-step");
    if (b) go({ to: Number(b.dataset.step) });
  });
  list.addEventListener("scroll", ask, { passive: true });
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!steps || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key == "Escape" && open()) {
      show(false);
      return;
    }
    if (e.key != "ArrowLeft" && e.key != "ArrowRight") return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.closest?.(".cm-editor"))) return;
    e.preventDefault();
    go({ by: e.key == "ArrowLeft" ? -1 : 1 });
  });
  new ResizeObserver(place).observe(ergaFrames.frame);
  addEventListener("resize", place);
  const watch = new MutationObserver(place);
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"], childList: true });
  // (The frame shows once the band has its colour: viewer-band-wait.ts's class on the root.)
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("transitionend", (e) => {
    if ((e.target as Element | null)?.id == "frame") place();
  });
}
