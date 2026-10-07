// Attachments in the editor's agent panel (src/page/attach-ui.ts), on the scripted model: files
// pasted, dropped and picked wait as chips; some are refused, with why; Send takes them, the model gets images as
// images and text files as text, and the conversation shows them, after a reload too. The factory's panel is the
// same code (e2e/factory/agent-paste.e2e.ts sends it an image).
import { expect, servers, test, until, type Tab } from "../fixtures";
import { openEditor, type Editor } from "../editor";

await servers.script();

/** The editor on a copy of the page fixture, its agent pane open and on, and files made in the tab: `__dt(...names)` holds them. */
async function open(tab: Tab) {
  const ed = await openEditor(tab, await servers.script(), "page");
  await ed.openAgent();
  await until(() => ed.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "true" && !document.getElementById("agent-hint").classList.contains("sticky")`), 5000, "the agent is on");
  await ed.eval(`(async () => {
    const pic = async (w, h, colour) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = colour; g.fillRect(0, 0, w, h); g.fillStyle = "#fff"; g.font = "bold " + (h / 4) + "px sans-serif"; g.fillText("Hi", w / 8, h / 2); return new Promise((r) => c.toBlob(r, "image/png")); };
    window.__files = {
      shot: new File([await pic(1200, 800, "#3a6ff0")], "image.png", { type: "image/png" }),
      big: new File([await pic(3000, 2000, "#e0623a")], "wide.png", { type: "image/png" }),
      csv: new File(["city,people\\nOslo,709000\\nBergen,291000\\n"], "data.csv", { type: "text/csv" }),
      pdf: new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }),
      huge: new File(["x".repeat(300 * 1024)], "huge.json", { type: "application/json" }),
    };
    window.__dt = (...names) => { const dt = new DataTransfer(); for (const n of names) dt.items.add(window.__files[n]); return dt; };
    return true;
  })()`);
  return ed;
}
/** The chips that are read and waiting, by their titles. */
const chips = (ed: Editor) => ed.eval<string[]>(`[...document.querySelectorAll(".agent-attachments .file-chip:not(.reading)")].map((c) => c.title)`);
const paste = (ed: Editor, ...names: string[]) => ed.eval(`document.getElementById("agent-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: __dt(...${JSON.stringify(names)}), bubbles: true, cancelable: true }))`);
const drag = (ed: Editor, type: string, ...names: string[]) => ed.eval(`document.getElementById("agent-log").dispatchEvent(new DragEvent(${JSON.stringify(type)}, { dataTransfer: __dt(...${JSON.stringify(names)}), bubbles: true, cancelable: true }))`);
const pick = (ed: Editor, ...names: string[]) => ed.eval(`(() => { const i = document.querySelector("#agent-form input[type=file]"); i.files = __dt(...${JSON.stringify(names)}).files; i.dispatchEvent(new Event("change")); return true; })()`);
const lit = (ed: Editor) => ed.eval<boolean>(`document.getElementById("agent").classList.contains("agent-drop")`);
/** The last message sent: its text, and its attachments (a picture as whether it shows one, a file by its title). */
const sent = (ed: Editor) => ed.eval<{ text: string; files: string[] }>(`(() => { const m = [...document.querySelectorAll("#agent-log .msg-user")].pop(); return { text: m?.firstChild?.textContent ?? "", files: [...m?.querySelectorAll(".file-chip") ?? []].map((c) => c.classList.contains("image") ? "img:" + !!c.querySelector("img")?.src.startsWith("data:image/") : c.title) }; })()`);

test("a pasted screenshot waits as a thumbnail above the box", async ({ tab }) => {
  const ed = await open(tab);
  await paste(ed, "shot");
  await expect.poll(() => chips(ed)).toHaveLength(1);
  expect((await chips(ed))[0]).toMatch(/^Pasted image\.png/);
  expect(await ed.eval<boolean>(`!!document.querySelector(".agent-attachments .file-chip.image img[src^='data:image/jpeg']")`)).toBe(true);
});

test("the panel lights up while files are dragged over it, and stops when they leave", async ({ tab }) => {
  const ed = await open(tab);
  await drag(ed, "dragenter", "csv");
  expect(await lit(ed)).toBe(true);
  expect(await ed.eval<string>(`getComputedStyle(document.getElementById("agent-log"), "::after").content`)).toContain("Drop files");
  await drag(ed, "dragleave", "csv");
  expect(await lit(ed)).toBe(false);
});

test("a dropped CSV waits as a chip with its name and size; a PDF and a too-big text file are refused, with why", async ({ tab }) => {
  const ed = await open(tab);
  await drag(ed, "dragenter", "csv");
  await drag(ed, "drop", "csv", "pdf", "huge");
  await expect.poll(() => chips(ed)).toEqual(["data.csv (38 B)"]);
  expect(await lit(ed)).toBe(false);
  const hint = await ed.eval<string>(`document.getElementById("agent-hint").hidden ? "" : document.getElementById("agent-hint").textContent`);
  expect(hint).toContain("“report.pdf” can't be attached: only images");
  expect(hint).toContain("“huge.json” is too big (300 KB): text files can be up to 256 KB");
});

test("the paperclip, in the box's row, attaches a picked picture; its × takes it out; Send can send files with no text", async ({ tab }) => {
  const ed = await open(tab);
  expect(await ed.eval<string | null>(`document.querySelector("#agent-form > .agent-attach")?.getAttribute("aria-label")`)).toBe("Attach files");
  await pick(ed, "big");
  await expect.poll(() => chips(ed)).toHaveLength(1);
  expect((await chips(ed))[0]).toMatch(/^wide\.png/);
  await ed.eval(`document.querySelector(".agent-attachments .file-chip button").click()`);
  await expect.poll(() => chips(ed)).toEqual([]);
  await pick(ed, "big");
  await expect.poll(() => chips(ed)).toHaveLength(1);
  await expect.poll(() => ed.eval<string>(`document.getElementById("agent-send").getAttribute("aria-disabled")`)).toBe("false");
});

test("Send takes the files: the model gets the pictures as images (the big one scaled down) and the CSV as text; the conversation shows them, after a reload too; the transcript keeps small thumbnails", async ({ tab }) => {
  const ed = await open(tab);
  await paste(ed, "shot");
  await expect.poll(() => chips(ed)).toHaveLength(1);
  await drag(ed, "drop", "csv");
  await expect.poll(() => chips(ed)).toHaveLength(2);
  await pick(ed, "big");
  await expect.poll(() => chips(ed)).toHaveLength(3);
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = 'What do these show? @script [{"inputs": true}]'; i.dispatchEvent(new Event("input")); i.focus(); return true; })()`);
  await ed.page.keyboard.press("Enter");
  expect(await chips(ed)).toEqual([]);
  expect(await ed.eval<boolean>(`document.querySelector(".agent-attachments").hidden`)).toBe(true);
  const reply = () => ed.eval<string>(`[...document.querySelectorAll("#agent-log .msg-assistant")].pop()?.textContent ?? ""`);
  await expect.poll(reply, { timeout: 10_000 }).toContain("images");
  const got = JSON.parse(await reply()) as { images?: string[]; files?: string[] };
  expect(got.images).toEqual(["image/png", "image/png"]);
  expect(got.files).toEqual(["data.csv"]);
  const want = ["img:true", "data.csv (38 B)", "img:true"];
  expect((await sent(ed)).files).toEqual(want);
  const log = await (await fetch(`${ed.address}/api/agent`)).json() as { log: { items: { kind: string; files?: { thumb?: string }[] }[] } };
  const item = log.log.items.find((i) => i.kind == "user" && i.files);
  expect(item?.files?.filter((f) => f.thumb).map((f) => f.thumb!.length < 60_000)).toEqual([true, true]);
  await ed.page.reload();
  await ed.loaded();
  await ed.openAgent();
  await expect.poll(async () => (await sent(ed)).files).toEqual(want);
});

test("the host refuses what the panel would: a PDF sent straight to the API, with a reason", async () => {
  const s = await servers.script();
  const { address } = await s.fixture("page");
  const r = await fetch(`${address}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", files: [{ name: "x.pdf", kind: "pdf", mimeType: "application/pdf", data: "", size: 1 }] }) });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { reason?: string }).reason).toContain("neither an image nor a text file");
});
