// Helpers of the steady journeys (steady.e2e.ts): the agent's box and its scripted run, and files dropped or pasted
// on a page of a document that the server keeps.
import { editor, F, type Editor } from "../helpers/editor";
import { agentClosed, expect, settle, until, type Server, type Tab } from "../helpers/fixtures";
import { idOf, runTool } from "../helpers/tools";

/** The agent's box: what it holds, whether the panel is open, and how many messages went. */
export const agentBox = (ed: Editor) =>
  ed.eval<{ text: string; open: boolean; sent: number }>(
    `({ text: document.getElementById("agent-input").value, open: document.body.classList.contains("agent-open"), sent: document.querySelectorAll(".msg-user").length })`
  );

/** A new conversation with the person's agent, as the panel's "New conversation" button starts one. */
export async function newConversation(server: Server) {
  const r = await fetch(`${server.root}/api/agent/conversation`, { method: "DELETE", headers: { Origin: server.root } });
  expect(r.ok, `a new conversation: ${r.status}`).toBe(true);
}

/**
 * The page's frame has stopped moving in the tab: it slides over as the agent's panel opens or closes, and a click
 * aimed while it moves lands on the panel.
 */
export const pageStill = async (ed: Editor) => {
  // (Two frames: a slide that a change of class starts has started.)
  await settle(ed.page);
  await until(
    () =>
      ed.eval<boolean>(
        `(() => { const f = document.getElementById("frame"); return !document.getAnimations().some((a) => a.playState == "running" && a.effect?.target?.contains(f)); })()`
      ),
    5000,
    "the page is still"
  );
};

/** Has the person's agent play `steps` (the scripted model, agents/models.ts): a message typed in its box, sent with Enter. */
export async function agentPlays(ed: Editor, steps: object[]) {
  await ed.page.focus("#agent-input");
  await ed.page.keyboard.insertText(`Edit @script ${JSON.stringify(steps)}`);
  await ed.page.keyboard.press("Enter");
}

/** The note on the page while someone holds the lock for source edits, or "". */
export const lockNote = (ed: Editor) => ed.frame<string>(`${F}.querySelector("erga-note")?.shadowRoot?.textContent ?? ""`);

const DROP_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch notes</title></head>
<body>
  <h1>Launch notes</h1>
  <p class="lede">Build <em>cool</em> things and ship them.</p>
  <p class="empty"><br></p>
  <p class="tail">We came down before the rain.</p>
</body>
</html>
`;

/**
 * A new project of DEV_LOGIN's that the server keeps (as on a deployment: a document on disk takes only text files),
 * with DROP_PAGE as its page blog/post and `files`, open in the editor at that page, in the test's tab.
 */
export async function openDropPage(tab: Tab, server: Server, files: Record<string, string> = {}) {
  const at = (await fetch(`${server.root}/new?kind=project`, { redirect: "manual" })).headers.get("location")!.replace(/[?&]edit$/, "");
  const address = new URL(at, server.root).pathname;
  const id = await idOf(`${server.root}${address}`);
  for (const [path, body] of Object.entries({ "index.html": DROP_PAGE, "blog/post.html": DROP_PAGE, ...files }))
    expect((await fetch(`${server.root}/d/${id}/api/files/${path}`, { method: "PUT", body })).status).toBe(200);
  // Someone who keeps the agent pane closed, and the editor's check that the page shows its HTML (as openEditor).
  await agentClosed(tab.page);
  await tab.page.addInitScript(() => {
    if (window.top == window) (window as unknown as { __ergaCheck: boolean }).__ergaCheck = true;
  });
  tab.strict = true;
  await tab.page.goto(`${server.root}${address}/blog/post?edit`);
  const ed = editor(tab.page, { address: `${server.root}${address}`, dir: "", file: "" });
  await ed.loaded();
  await settle(tab.page);
  return {
    ed,
    /** The document's files, by their paths. */
    files: async () =>
      ((await runTool(server.root, "ls", { document: id })).result as { entries: { path: string; type: string }[] }).entries
        .filter((e) => e.type != "folder")
        .map((e) => e.path),
  };
}

type Made = { name: string; type: string; png?: boolean };
/** Makes the files in the page's frame, in a DataTransfer (`dt`). */
const make = (files: Made[]) => `
    const png = () => { const c = document.createElement("canvas"); c.width = 40; c.height = 30; const g = c.getContext("2d"); g.fillStyle = "#3a6ff0"; g.fillRect(0, 0, 40, 30); return new Promise((r) => c.toBlob(r, "image/png")); };
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(files)}) dt.items.add(new File([f.png ? await png() : "some notes"], f.name, { type: f.type }));`;

/** A PNG image, for a drop or a paste. */
export const png = (name: string): Made[] => [{ name, type: "image/png", png: true }];

/**
 * The editor takes a drop: it's on the page, which isn't loading again (an edit the editor can't patch in makes the
 * page afresh, a moment after it shows in the text). A person can't drop sooner.
 */
const takesDrop = (ed: Editor) =>
  until(
    () => ed.frame<boolean>(`!!window.ergaFrame?.page && !ergaFrame.reloading && !ergaFrame.page.rendering`),
    10_000,
    "the editor takes a drop"
  );

/**
 * Drops files made in the page's frame at boundary `i` of the first text of `selector` (0: before its first character;
 * an element with no text: at its start), in the middle of its line, or near the top or bottom of the element
 * (`half`): a dragover, then the drop. Returns whether the page stopped the browser's own drop (which would open the
 * file) both times, and whether the dragover showed where the drop goes.
 */
export const drop = async (ed: Editor, selector: string, i: number, files: Made[], half?: "top" | "bottom") => {
  await takesDrop(ed);
  return ed.frame<{ stopped: boolean; shown: boolean }>(`(async () => {${make(files)}
    const el = ${F}.querySelector(${JSON.stringify(selector)}), t = ${F}.createTreeWalker(el, 4).nextNode();
    const rg = ${F}.createRange(), first = ${i} == 0;
    if (t) { rg.setStart(t, first ? 0 : ${i} - 1); rg.setEnd(t, first ? 1 : ${i}); } else rg.selectNodeContents(el);
    const r = t ? rg.getBoundingClientRect() : el.getBoundingClientRect(), x = first ? r.left + 1 : r.right - 1, box = el.getBoundingClientRect();
    const y = ${JSON.stringify(half ?? "")} == "top" ? box.top + 3 : ${JSON.stringify(half ?? "")} == "bottom" ? box.bottom - 3 : r.top + r.height / 2, at = ${F}.elementFromPoint(x, y);
    const over = new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
    at.dispatchEvent(over);
    const shown = !!${F}.querySelector("erga-drop-caret, erga-drop-image");
    const dropped = new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
    at.dispatchEvent(dropped);
    return { stopped: over.defaultPrevented && dropped.defaultPrevented, shown };
  })()`);
};

/** Pastes files made in the page's frame (a clipboard with files only, as a screenshot is) where the caret is. */
export const pasteFiles = async (ed: Editor, files: Made[]) => {
  await takesDrop(ed);
  return ed.frame(`(async () => {${make(files)}
    ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
};

/** The images on the page: their src as written, and whether each has loaded. */
export const images = (ed: Editor) =>
  ed.frame<{ src: string; alt: string; loaded: boolean }[]>(
    `[...${F}.querySelectorAll("body img")].map((i) => ({ src: i.getAttribute("src"), alt: i.alt, loaded: i.complete && i.naturalWidth > 0 }))`
  );

/**
 * How long a drop or paste may take to go in: an upload, and, if the page loads again meanwhile (an edit the editor
 * can't patch in), the wait for the room to have its edits and the page that comes.
 */
export const UPLOAD = { timeout: 10_000 };

/** An image in a line of text, as the source has it. */
export const IMG = (path: string) => `<img src="${path}" alt="${path.slice(path.lastIndexOf("/") + 1)}">`;
/** An image dropped between blocks, as the source has it: centred, a paragraph of its own. */
export const CENTRED = (path: string) =>
  `<p style="text-align: center"><img style="max-width: 100%; height: auto" src="${path}" alt="${path.slice(path.lastIndexOf("/") + 1)}"></p>`;
