// view_page and eval_in_page render the page in Erga's real viewer, as its person sees it: the bars over the page, the
// page in its frame on the pages origin; editor: true opens the editor. Code runs in the page's frame, or with shell:
// true in the viewer's own window.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor } from "../../helpers/editor";
import { agentTools, CAPTURES, expectColour, pixel } from "./view-page";

await servers.main();

const RED = [200, 0, 0];
/** A preview of the page with a red background, so the bars over it show apart from it. */
const red = { edits: [{ oldText: "</body>", newText: "<style>html, body { background: rgb(200, 0, 0) !important; }</style></body>" }] };

async function open(tab: Parameters<typeof openEditor>[0]) {
  const s = await servers.main();
  const ed = await openEditor(tab, s, "page");
  return { ed, root: s.root, ...(await agentTools(s, ed.address)) };
}

test("the picture shows the viewer's bars over the page, and the page in its frame", CAPTURES, async ({ tab }) => {
  const { ed, tool } = await open(tab);
  const view = await tool("view_page", red);
  expect(view.text).toContain("Shown as its person sees it, in Erga's viewer.");
  // The page's red, below the bars and in the middle of the window.
  await expectColour(ed, view.images[0], 640, 500, RED);
  // The person's avatar in the bar at the top right, over the page (the bars' glass takes the page's colour; the avatar doesn't).
  const avatar = await pixel(ed, view.images[0], 1248, 29);
  expect(avatar[1] + avatar[2], `the avatar's pixel is ${avatar}`).toBeGreaterThan(100);
  const shell = JSON.parse(
    (
      await tool("eval_in_page", {
        shell: true,
        expression: `({ path: location.pathname, frame: new URL(document.getElementById("frame").src).origin != location.origin, crumbs: !!document.querySelector(".erga-crumbs") })`,
      })
    ).text.split("\n\n")[0]
  );
  expect(shell).toEqual({ path: new URL(ed.address).pathname, frame: true, crumbs: true });
});

test("a click on the page's button in the viewer acts in the frame", async ({ tab }) => {
  const { tool, root } = await open(tab);
  const out = JSON.parse(
    (
      await tool("eval_in_page", {
        expression: `document.getElementById("bump").click(); document.getElementById("bump").click(); return { count: document.getElementById("count").textContent, framed: window.top !== window, origin: location.origin };`,
      })
    ).text.split("\n\n")[0]
  );
  expect(out.count).toBe("2");
  expect(out.framed).toBe(true);
  expect(out.origin).not.toBe(new URL(root).origin);
});

test("editor: true opens the page in the editor, with the editor's controls", CAPTURES, async ({ tab }) => {
  const { tool } = await open(tab);
  const view = await tool("view_page", { editor: true });
  expect(view.text).toContain("Shown as its person sees it, in Erga's editor.");
  expect(view.text).toContain("No script errors.");
  const shell = JSON.parse(
    (
      await tool("eval_in_page", {
        editor: true,
        shell: true,
        expression: `({ editing: document.body.classList.contains("erga-editing"), controls: !!document.getElementById("erga-editor"), share: !!document.querySelector("#erga-editor [aria-label*='Share' i], #erga-editor [title*='Share' i]") })`,
      })
    ).text.split("\n\n")[0]
  );
  expect(shell).toEqual({ editing: true, controls: true, share: true });
  const page = await tool("eval_in_page", {
    editor: true,
    expression: `!!window.ergaFrame?.page && document.documentElement.hasAttribute("data-erga-editing")`,
  });
  expect(page.text.split("\n\n")[0]).toBe("true");
});

test("code in the viewer's window can't get the person's Share token: the server's browser is an agent", async ({ tab }) => {
  const { tool } = await open(tab);
  const out = JSON.parse(
    (
      await tool("eval_in_page", {
        editor: true,
        shell: true,
        expression: `const r = await fetch(location.pathname + "/api/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return { status: r.status, body: await r.text() };`,
      })
    ).text.split("\n\n")[0]
  );
  expect(out.body).not.toContain("erga_");
  expect(out).toEqual({ status: 403, body: JSON.stringify({ ok: false, error: "An agent can't make tokens." }) });
});
