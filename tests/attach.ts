// Attachments in the editor's agent panel (src/page/attach-ui.ts), with the
// scripted model: a screenshot pasted into the box, a CSV dropped on the
// panel and a picture picked with the paperclip wait as chips (one removed
// with its ×); a PDF and a too-big text file are refused with a hint; the
// panel lights up while files are dragged over it; Send takes them, the
// model gets the images as images and the CSV as text, and the conversation
// shows them, after a reload too. The factory's panel is the same code
// (tests/factory.ts sends it an image).
//   bun tests/attach.ts

import { Browser, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { cpSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : "\n     " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};
async function until(f: () => Promise<boolean> | boolean, ms: number) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await Bun.sleep(100); }
  return f();
}

const dir = mkdtempSync(join(tmpdir(), "erga-attach-"));
cpSync(`${ROOT}tests/fixtures/page`, dir, { recursive: true });
const host = await startHost(dir, { env: { ERGA_AGENT_MODEL: "script" } });
const browser = await Browser.launch();
try {
  const p = await browser.page();
  await p.open(`${host.base}#edit`, { width: 1280, height: 800 });
  await p.openAgent();
  await until(() => p.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "true" && !document.getElementById("agent-hint").classList.contains("sticky")`), 10_000);

  // Files made in the page: a picture (a canvas), a CSV, a PDF, a big text file.
  await p.eval(`(async () => {
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
  const chips = () => p.eval<string[]>(`[...document.querySelectorAll(".agent-attachments .file-chip")].map((c) => c.title)`);

  // Paste a screenshot into the box.
  await p.eval(`document.getElementById("agent-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: __dt("shot"), bubbles: true, cancelable: true }))`);
  await until(async () => (await chips()).length == 1, 5000);
  check("a pasted screenshot waits as a thumbnail above the box", (await chips())[0]?.startsWith("Pasted image.png") && await p.eval<boolean>(`!!document.querySelector(".agent-attachments .file-chip.image img[src^='data:image/jpeg']")`), await chips());

  // Drag files over the panel: it lights up, and lets go when they leave.
  await p.eval(`document.getElementById("agent-log").dispatchEvent(new DragEvent("dragenter", { dataTransfer: __dt("csv"), bubbles: true, cancelable: true }))`);
  check("the panel lights up while files are dragged over it", await p.eval<boolean>(`document.getElementById("agent").classList.contains("agent-drop") && getComputedStyle(document.getElementById("agent-log"), "::after").content.includes("Drop files")`));
  await p.eval(`document.getElementById("agent-log").dispatchEvent(new DragEvent("dragleave", { dataTransfer: __dt("csv"), bubbles: true, cancelable: true }))`);
  check("and stops when they leave", !(await p.eval<boolean>(`document.getElementById("agent").classList.contains("agent-drop")`)));
  // Then drop a CSV, a PDF and a too-big file on the log.
  await p.eval(`document.getElementById("agent-log").dispatchEvent(new DragEvent("dragenter", { dataTransfer: __dt("csv"), bubbles: true, cancelable: true }))`);
  await p.eval(`document.getElementById("agent-log").dispatchEvent(new DragEvent("drop", { dataTransfer: __dt("csv", "pdf", "huge"), bubbles: true, cancelable: true }))`);
  await until(async () => (await chips()).length == 2, 5000);
  const hint = await p.eval<string>(`document.getElementById("agent-hint").hidden ? "" : document.getElementById("agent-hint").textContent`);
  check("a dropped CSV is attached as a chip with its name and size", (await chips())[1] == "data.csv (40 B)" && !(await p.eval<boolean>(`document.getElementById("agent").classList.contains("agent-drop")`)), await chips());
  check("a PDF and a too-big text file are refused, with why", hint.includes("“report.pdf” can't be attached: only images") && hint.includes("“huge.json” is too big (300 KB): text files can be up to 256 KB"), hint);

  // Pick a picture too big for the model with the paperclip: it's scaled down. Then remove it with its ×.
  await p.eval(`(() => { const i = document.querySelector("#agent-form input[type=file]"); i.files = __dt("big").files; i.dispatchEvent(new Event("change")); return true; })()`);
  await until(async () => (await chips()).length == 3, 8000);
  check("the paperclip attaches a picked picture", (await chips())[2]?.startsWith("wide.png"), await chips());
  check("the paperclip is in the box's row", await p.eval<boolean>(`document.querySelector("#agent-form > .agent-attach")?.getAttribute("aria-label") == "Attach files"`));
  await p.eval(`document.querySelectorAll(".agent-attachments .file-chip")[2].querySelector("button").click()`);
  check("its × takes it out", (await chips()).length == 2, await chips());
  await p.eval(`(() => { const i = document.querySelector("#agent-form input[type=file]"); i.files = __dt("big").files; i.dispatchEvent(new Event("change")); return true; })()`);
  await until(async () => (await chips()).length == 3, 8000);
  check("Send can send files with no text", await p.eval<boolean>(`document.getElementById("agent-send").getAttribute("aria-disabled") == "false"`));
  await p.screenshot(join(SHOTS, "attach-chips.png"));

  // Send, with the script that says what the model got.
  await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = 'What do these show? @script [{"inputs": true}]'; i.dispatchEvent(new Event("input")); return true; })()`);
  await p.key("Enter");
  check("sending clears the chips", (await chips()).length == 0 && await p.eval<boolean>(`document.querySelector(".agent-attachments").hidden`));
  const reply = async () => p.eval<string>(`[...document.querySelectorAll("#agent-log .msg-assistant")].pop()?.textContent ?? ""`);
  await until(async () => (await reply()).includes("images"), 15_000);
  let got: { images?: string[]; files?: string[] } = {};
  try { got = JSON.parse(await reply()); } catch {}
  check("the model gets both pictures as images, the big one scaled down, and the CSV as text", JSON.stringify(got.images) == '["image/png","image/png"]' && JSON.stringify(got.files) == '["data.csv"]', got);
  const sent = async () => p.eval<{ text: string; files: string[] }>(`(() => { const m = [...document.querySelectorAll("#agent-log .msg-user")].pop(); return { text: m?.firstChild?.textContent ?? "", files: [...m?.querySelectorAll(".file-chip") ?? []].map((c) => c.classList.contains("image") ? "img:" + !!c.querySelector("img")?.src.startsWith("data:image/") : c.title) }; })()`);
  const want = JSON.stringify(["img:true", "data.csv (40 B)", "img:true"]);
  check("the message shows in the conversation with its attachments", JSON.stringify((await sent()).files) == want, await sent());
  const log = await (await fetch(`${host.base}/api/agent`)).json() as { log: { items: { kind: string; files?: { thumb?: string }[] }[] } };
  const item = log.log.items.find((i) => i.kind == "user" && i.files);
  check("the transcript keeps a small thumbnail, not the picture", !!item && item.files!.filter((f) => f.thumb).every((f) => f.thumb!.length < 60_000), item?.files?.map((f) => f.thumb?.length));
  await p.screenshot(join(SHOTS, "attach-sent.png"));

  // A reload: the conversation still shows them.
  await p.open(`${host.base}#edit`, { width: 1280, height: 800, clear: false });
  await p.openAgent();
  await until(async () => (await sent()).files.length == 3, 10_000);
  check("after a reload, the conversation still shows the attachments", JSON.stringify((await sent()).files) == want, await sent());

  // The host refuses what the panel would have: a PDF sent straight to the API.
  const r = await fetch(`${host.base}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", files: [{ name: "x.pdf", kind: "pdf", mimeType: "application/pdf", data: "", size: 1 }] }) });
  check("the host refuses other kinds of files, with a reason", r.status == 400 && ((await r.json()) as { reason?: string }).reason?.includes("neither an image nor a text file") == true, r.status);
} finally {
  await browser.close();
  await host.dispose();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
