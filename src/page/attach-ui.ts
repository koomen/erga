// Attaching files to a message, in both agents' panels (main.ts, the
// editor's; factory-agent.ts, the factory's): drop them on the panel, paste
// them (a screenshot, say) into the box, or pick them with the paperclip.
// They wait as chips above the box, each with its ×, until the message goes.
// Images go to the model as images (scaled down here when they're bigger than
// it takes), text files as text; anything else, or too big, is refused with a
// hint that says why (attach.ts has the rules). The styles are style.css's
// (.agent-attachments, .agent-attach, .agent-drop).

import { classify, fileRefs, kb, MAX_FILES, MAX_IMAGE_DATA, refusal, type Attachment, type FileRef } from "./attach";

export interface AttachOptions {
  /** The whole panel: drops anywhere on it attach. */
  pane: HTMLElement;
  /** The compose form: the paperclip goes first in it, the chips just above it. */
  form: HTMLElement;
  input: HTMLTextAreaElement;
  /** Says why a file wasn't attached. */
  hint(text: string): void;
  /** The list changed (the panel redraws Send). */
  changed(): void;
}

export interface Attachments {
  /** What's attached and read, ready to send. */
  readonly files: Attachment[];
  /** Files still being read. */
  readonly reading: number;
  /** Takes them all out (once sent). */
  clear(): void;
  add(files: Iterable<File>): Promise<void>;
  /** Puts back files read before (kept across a reload for a new release: live.ts). */
  restore(files: Attachment[]): void;
}

const dataUrl = (blob: Blob) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = () => fail(r.error); r.readAsDataURL(blob); });
const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((ok, fail) => c.toBlob((b) => b ? ok(b) : fail(new Error("the browser couldn't encode it")), type, q));

/** Draws a picture no bigger than `max` on its longer side, on white for JPEG. */
function draw(img: ImageBitmap, max: number, type: string): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const g = c.getContext("2d")!;
  if (type == "image/jpeg") { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** An image as the model takes it (scaled down if it's too big), with its thumbnail. */
async function readImage(file: File, mimeType: string): Promise<{ mimeType: string; data: string; thumb: string }> {
  const img = await createImageBitmap(file);
  try {
    const thumb = await dataUrl(await toBlob(draw(img, 240, "image/jpeg"), "image/jpeg", 0.8));
    const b64 = (u: string) => u.slice(u.indexOf(",") + 1);
    // Small enough as it is: sent untouched (an animated GIF stays animated).
    if (file.size * 4 / 3 <= MAX_IMAGE_DATA && Math.max(img.width, img.height) <= 2000) return { mimeType, data: b64(await dataUrl(file)), thumb };
    for (const [max, type, q] of [[2000, "image/png"], [2000, "image/jpeg", 0.85], [1400, "image/jpeg", 0.8]] as [number, string, number?][]) {
      const blob = await toBlob(draw(img, max, type), type, q);
      if (blob.size * 4 / 3 <= MAX_IMAGE_DATA) return { mimeType: type, data: b64(await dataUrl(blob)), thumb };
    }
    throw new Error("it stays too big, even scaled down");
  } finally { img.close(); }
}

/** The chip for one attachment: a thumbnail for an image, the name and size for a text file. */
export function fileChip(f: FileRef, remove?: () => void): HTMLElement {
  const el = document.createElement("span");
  el.className = `file-chip ${f.kind}`;
  el.title = `${f.name} (${kb(f.size)})`;
  if (f.kind == "image" && f.thumb) {
    const img = document.createElement("img");
    img.src = f.thumb;
    img.alt = f.name;
    el.append(img);
  } else {
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = kb(f.size);
    el.append(name, size);
  }
  if (remove) {
    const x = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: `Remove ${f.name}` });
    x.setAttribute("aria-label", `Remove ${f.name}`);
    x.addEventListener("click", remove);
    el.append(x);
  }
  return el;
}

export function attachments(o: AttachOptions): Attachments {
  const { pane, form, input } = o;
  // In the order they were added; a slot with no file yet is still being read.
  let slots: { file?: Attachment }[] = [];
  const files = () => slots.flatMap((s) => s.file ? [s.file] : []);
  const reading = () => slots.filter((s) => !s.file).length;

  const tray = document.createElement("div");
  tray.className = "agent-attachments";
  tray.hidden = true;
  form.before(tray);
  const picker = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true });
  picker.accept = "image/png,image/jpeg,image/gif,image/webp,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.toml,.js,.ts,.tsx,.jsx,.py,.html,.css,.svg,.xml,.sql,.sh";
  const clip = Object.assign(document.createElement("button"), { type: "button", className: "icon-btn agent-attach", title: "Attach files: images, or text files such as code, Markdown, CSV and JSON. You can also drop or paste them here." });
  clip.setAttribute("aria-label", "Attach files");
  clip.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 6.9"/></svg>`;
  form.prepend(clip, picker);
  clip.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { add([...picker.files ?? []]); picker.value = ""; });

  function render() {
    tray.textContent = "";
    tray.hidden = !slots.length;
    for (const s of slots) {
      if (s.file) { tray.append(fileChip(fileRefs([s.file])[0], () => { slots = slots.filter((x) => x != s); render(); input.focus(); })); continue; }
      const r = document.createElement("span");
      r.className = "file-chip reading";
      r.textContent = "Reading…";
      tray.append(r);
    }
    o.changed();
  }

  async function add(list: Iterable<File>) {
    const why: string[] = [];
    const todo: File[] = [];
    for (const file of list) {
      // A pasted screenshot comes as "image.png"; say what it is.
      const name = file.name && file.name != "image.png" ? file.name : `Pasted image${file.type == "image/png" || !file.type ? ".png" : "." + (file.type.split("/")[1] ?? "png")}`;
      const no = refusal(name, file.type, file.size);
      if (no) { why.push(no); continue; }
      if (slots.length + todo.length >= MAX_FILES) { why.push(`At most ${MAX_FILES} files can go with one message.`); break; }
      todo.push(new File([file], name, { type: file.type }));
    }
    if (why.length) o.hint(why.join(" "));
    const mine = todo.map(() => ({} as { file?: Attachment }));
    slots.push(...mine);
    render();
    await Promise.all(todo.map(async (file, i) => {
      const c = classify(file.name, file.type)!;
      try {
        if (c.kind == "image") mine[i].file = { name: file.name, kind: "image", size: file.size, ...await readImage(file, c.mimeType) };
        else {
          const text = await file.text();
          if (text.includes("\u0000")) throw new Error("it isn't text");
          mine[i].file = { name: file.name, kind: "text", mimeType: c.mimeType, data: text, size: file.size };
        }
      } catch (e) {
        slots = slots.filter((x) => x != mine[i]);
        o.hint(`“${file.name}” can't be attached: ${e instanceof Error ? e.message : String(e)}.`);
      }
      render();
    }));
  }

  // Dropping: the panel lights up while files are dragged over it. Drags
  // that aren't files (text, a link) are left alone.
  let depth = 0;
  const isFiles = (e: DragEvent) => [...e.dataTransfer?.types ?? []].includes("Files");
  pane.addEventListener("dragenter", (e) => { if (!isFiles(e)) return; e.preventDefault(); depth++; pane.classList.add("agent-drop"); });
  pane.addEventListener("dragover", (e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
  pane.addEventListener("dragleave", (e) => { if (!isFiles(e)) return; if (--depth <= 0) { depth = 0; pane.classList.remove("agent-drop"); } });
  pane.addEventListener("drop", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    pane.classList.remove("agent-drop");
    add([...e.dataTransfer!.files]);
    input.focus();
  });
  // Pasting files (a screenshot from the clipboard) attaches them; pasting text types it, as ever.
  input.addEventListener("paste", (e) => {
    const pasted = [...e.clipboardData?.files ?? []];
    if (!pasted.length) return;
    e.preventDefault();
    add(pasted);
  });

  return {
    get files() { return files(); },
    get reading() { return reading(); },
    clear() { slots = []; render(); },
    add,
    restore(list) {
      const ok = list.filter((f) => f && typeof f.name == "string" && (f.kind == "image" || f.kind == "text") && typeof f.data == "string").slice(0, MAX_FILES - slots.length);
      slots.push(...ok.map((file) => ({ file })));
      render();
    },
  };
}
