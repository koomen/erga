// The agents' tools, as agents call them (POST /api/tools/<name> with a token, or a scripted turn of a person's
// agent): read, edit, the files, the pages, a page's own edits, and view_page and eval_in_page (the server's browser
// renders the page). A page is open only where a person must see the result. And no tool works on a document that
// the agent's person may not open.
import { expect, journey, servers, test, until } from "../helpers/fixtures";
import { DISK_MS, F, openEditor, type Editor } from "../helpers/editor";
import { idOf, runTool } from "../helpers/tools";
import { apisOf, edit, person, pixel, toolsOf, valueOf, type DocTools, type Person, type Tools } from "./panel";
import { eventsOf, joinRoom, type Joined } from "./room";
import { CODE, docOf, pdf, PLAYER, PNG, probe, SITE, slideBar, tone, viewButton, type LiveFacts } from "./samples";

const s = await servers.main();
/**
 * A bare server, with no homepage project yet: the first / there adopts an admin's old homepage. turn.e2e.ts uses the
 * same one (it has no agent key): a worker that runs both files starts it one time.
 */
const bare = await servers.of("agent-bare");

/** Logins of this file's own. */
const ADA = "ToolsAda",
  BO = "ToolsBo",
  DEE = "ToolsDee";
let people = 0;
/** A login that nobody has used yet. */
const someone = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++people).toString(36)}`;

/**
 * A render at once after the load. By default view_page waits 600 ms for the page's scripts to draw: these checks do
 * not need that. (turn.e2e.ts has a view_page with the default wait.)
 */
const SOON = { at_ms: 0 };

/** The tools with a token of the dev server's own person (DEV_LOGIN, "tester"), who owns the fixtures' documents. */
let own: Promise<Tools> | undefined;
const mine = () => (own ??= person(s, "tester").then((p) => p.tools()));

journey("the agents' tools on a page that a person has open", () => {
  let ed: Editor, id: string, t: DocTools, ada: Person, bo: Joined;
  /** What storage holds for the page's file. */
  const stored = async () => (await fetch(`${ed.address}/api/stored/index.html`)).text();
  /** How many of Ada's agent's changes to the document Undo can take back. */
  const undoable = async () =>
    ((await (await ada.get(`${new URL(ed.address).pathname}/api/agent/undo`)).json()) as { count: number }).count;

  test("document_api lists the page's edits; call_edit runs one, the file and the page show it; one that can't, says why", async ({
    tab,
  }) => {
    ed = await openEditor(tab, s, "page");
    id = await idOf(ed.address);
    t = (await mine()).on(id);
    // The agent's context gives the person's window size and mode.
    const size = await ed.eval<{ width: number; height: number }>(
      `(() => { const f = document.getElementById("frame"); return { width: f.clientWidth, height: f.clientHeight }; })()`
    );
    const context = await ed.eval<string>(`ergaPage.agentContext()`);
    expect(context).toContain(`${size.width}×${size.height} CSS pixels`);
    expect(context).toContain("light mode");
    const apis = await apisOf(t);
    expect(apis.map((a) => a.api)).toEqual(["erga/text"]);
    expect(apis[0].edits.map((e) => e.name)).toContain("replace_text");
    // With no path, the page is index.html.
    expect((await t.ok("document_api")).text).toBe((await t.ok("document_api", { path: "index.html" })).text);
    const done = await t.ok("call_edit", {
      path: "index.html",
      edit: "replace_text",
      input: { selector: "h1", find: "Launch", text: "Release" },
    });
    expect(done.text).toMatch(/^Replaced "Launch"\. Edited index\.html/);
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h1>Release notes</h1>");
    await expect.poll(() => ed.textOf("h1")).toBe("Release notes");
    await t.ok("call_edit", { path: "index.html", edit: "style", input: { selector: "p.lede", find: "ship them", style: "strong" } });
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<strong>ship them</strong>");
    expect(
      await t.fails("call_edit", { path: "index.html", edit: "replace_text", input: { selector: "h1", find: "Launch", text: "x" } })
    ).toMatch(/"Launch" isn't in the text of h1/);
    expect(await t.fails("call_edit", { path: "index.html", edit: "bold", input: {} })).toMatch(/erga\/text has no edit "bold"/);
  });

  test("the agent's edit reaches the others, with the agent as its author, and is stored; its conversation reaches only its person", async () => {
    ada = await person(s, ADA);
    bo = await joinRoom(ed.address, BO);
    // Bo's event channel, as a tab of Bo's has it: it listens the whole time.
    const channel = await eventsOf(ed.address, BO);

    const steps = [edit("<h1>Release notes", "<h1>Release notes, revised"), { text: "secret reply" }];
    const items = await ada.turn(id, steps, "a private question");
    await until(() => bo.str().includes("<h1>Release notes, revised"), 3000, "Bo sees the agent's edit");
    // Typed in a few steps (agents/document/workspace.ts, paced): each of them by the agent.
    const by = bo.seen.filter((x) => x.inserted && ", revised".includes(x.inserted));
    expect(by.length, JSON.stringify(bo.seen)).toBeGreaterThan(0);
    expect(
      by.every((x) => x.author == `${ADA}, via their agent` && x.kind == "agent"),
      `each change is by ${ADA}'s agent: ${JSON.stringify(bo.seen)}`
    ).toBe(true);
    expect(
      items.some((i) => i.kind == "tool" && i.name == "edit" && i.status == "done"),
      JSON.stringify(items)
    ).toBe(true);
    expect(items.some((i) => i.kind == "assistant" && i.text == "secret reply")).toBe(true);
    await until(async () => (await stored()).includes("<h1>Release notes, revised"), 5000, "the edit is stored");
    await expect.poll(() => ed.textOf("h1")).toBe("Release notes, revised");

    // The conversation is Ada's alone. One more event for everyone, after the turn (a folder made and deleted): when
    // Bo's channel has it, it has all that the turn sent to Bo. None of that is Ada's message or the agent's answer.
    await t.ok("new", { path: "after-the-turn/" });
    await t.ok("rm", { path: "after-the-turn" });
    await until(() => channel.text().includes(`"deleted":"after-the-turn"`), 5000, "Bo's channel gets the event after the turn");
    expect(channel.text()).not.toContain("private question");
    expect(channel.text()).not.toContain("secret reply");
    channel.close();
    const bos = await person(s, BO);
    expect((await bos.log()).items, "Bo's conversation is empty").toEqual([]);
    expect((await ada.log()).items.some((i) => i.kind == "user" && i.text?.startsWith("a private question @script"))).toBe(true);
  });

  test("an agent whose person can only view can't edit; made an editor, it edits", async () => {
    // Only those it's shared with: Bo and Ada may edit, Dee may only view.
    const share = async (login: string, role: string) =>
      expect((await runTool(s.root, "share_document", { document: id, login, role })).ok, `${login}: ${role}`).toBe(true);
    await share("*", "none");
    await share(BO, "editor");
    await share(DEE, "viewer");
    await share(ADA, "editor");
    // (Bo joins again: his socket from before the change of who may open the document no longer takes his edits.)
    bo.leave();
    bo = await joinRoom(ed.address, BO);
    const dee = await person(s, DEE);
    const tried = await dee.turn(id, [edit("<h1>Release notes", "<h1>Dee's notes"), { text: "Tried." }]);
    expect(
      tried.some((i) => i.kind == "tool" && i.status == "error" && !!i.detail),
      `the viewer's agent's edit is refused, with why: ${JSON.stringify(tried)}`
    ).toBe(true);
    expect(await stored()).not.toContain("Dee's notes");
    // Nor do the viewer's own edits, in the room or as a publish, go anywhere.
    const viewer = await joinRoom(ed.address, DEE);
    viewer.insertAfter("<h1>", "Dee typed. ");
    bo.insertAfter("<h1>", "Bo typed. ");
    await until(() => viewer.str().includes("Bo typed. "), 3000, "the viewer sees Bo's edit");
    const push = await dee.get(`${new URL(ed.address).pathname}/api/stored/index.html`, { method: "PUT", body: "<h1>Dee's page</h1>" });
    expect(push.status, "the viewer's publish is refused").toBe(403);
    // Bo's edit came after Dee's: when storage has Bo's, it would have Dee's too.
    await until(async () => (await stored()).includes("Bo typed. "), 5000, "Bo's edit is stored");
    expect(bo.str()).not.toContain("Dee");
    expect(await stored()).not.toContain("Dee");
    viewer.leave();
    // Made an editor, their agent edits.
    await share(DEE, "editor");
    await dee.turn(id, [edit("<h1>Bo typed. Release notes", "<h1>Dee's notes"), { text: "Done." }]);
    await until(() => bo.str().includes("<h1>Dee's notes"), 3000, "the agent's edit reaches Bo");
    await expect.poll(() => ed.textOf("h1")).toBe("Dee's notes, revised");
  });

  test("an outside agent with Ada's Share token edits as Ada's agent, and she can undo it", async () => {
    const path = new URL(ed.address).pathname;
    const share = async (rotate = false) => {
      const r = await ada.get(`${path}/api/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotate }),
      });
      return ((await r.json()) as { token: string }).token;
    };
    const token = await share();
    expect(token, "the share button gets a token").toMatch(/^erga_[\w-]{40,}$/);
    expect(await share(), "asking again gives the same one").toBe(token);
    const ext = (at: string, init: RequestInit = {}, as = token) =>
      fetch(s.root + at, { ...init, headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json" } });
    expect((await ext("/api/tools/whoami", { method: "POST", body: "{}" }, "erga_forged")).status, "the API needs a real token").toBe(401);
    type Listed = { name: string; parameters: { properties: { op: { description: string } } } };
    const listed = ((await (await ext("/api/tools")).json()) as { tools: Listed[] }).tools;
    expect(listed.find((x) => x.name == "edit")?.parameters.properties.op.description, "the tools are listed, and edit has write").toMatch(
      /^write\(/m
    );
    // The page rules are in MCP's instructions, one time.
    const init = await ext("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    expect(((await init.json()) as { result: { instructions: string } }).result.instructions).toMatch(/data-erga-noedit/);
    // As the Share card's prompt says: the tools, with the document's address as "document".
    const out = toolsOf(s.root, token).on(ed.address);
    expect((await out.ok("read", { path: "index.html" })).text, "read returns the file").toContain("<h1>Dee's notes");
    const before = await undoable();
    await out.ok("edit", edit("<h1>Dee's notes", "<h1>Dee's notes EXT").args);
    await until(() => bo.str().includes("Dee's notes EXT"), 3000, "Bo sees the outside agent's edit");
    // (A share token's edits are its person's, via it, under its label: agents/document/session.ts.)
    expect(bo.seen.at(-1)?.author).toBe(`${ADA}, via a shared agent (Share button)`);
    await expect.poll(() => ed.textOf("h1")).toBe("Dee's notes EXT, revised");
    const bad = await out.call("edit", { path: "index.html" });
    expect([bad.status, /edits/.test(bad.text)], `bad arguments say what is wrong: ${bad.text}`).toEqual([400, true]);
    expect((await out.call("nope")).status, "an unknown tool").toBe(404);
    expect(await undoable(), "Ada can undo it").toBe(before + 1);
    await ada.get(`${path}/api/agent/undo`, { method: "POST" });
    await until(() => !bo.str().includes("EXT"), 3000, "the undo takes it back");
    const next = await share(true);
    expect([(await ext("/api/tools")).status, (await ext("/api/tools", {}, next)).status], "a new token turns the old one off").toEqual([
      401, 200,
    ]);
    bo.leave();
    // (The outside agent's edit keeps the document's lock for some seconds more: agents/document/session.ts, IDLE_MS. No
    // step after this one edits this document's page as a person.)
  });

  const RED = [200, 0, 0];
  test("view_page shows the page in Erga's viewer, as its person sees it: the bars over the page, the page in its frame; a click acts in the frame", async () => {
    // A preview of the page with a red background, so the bars over it show apart from it.
    const view = await t.ok("view_page", {
      ...SOON,
      edits: [{ oldText: "</body>", newText: "<style>html, body { background: rgb(200, 0, 0) !important; }</style></body>" }],
    });
    expect(view.text).toContain("Shown as its person sees it, in Erga's viewer.");
    // The page's red, below the bars and in the middle of the window.
    const middle = await pixel(ed.page, view.images[0], 640, 500);
    expect(
      middle.every((v, i) => Math.abs(v - RED[i]) <= 3),
      `the pixel in the middle is ${middle}`
    ).toBe(true);
    // The person's avatar in the bar at the top right, over the page (the bars' glass takes the page's colour; the avatar doesn't).
    const avatar = await pixel(ed.page, view.images[0], 1248, 29);
    expect(avatar[1] + avatar[2], `the avatar's pixel is ${avatar}`).toBeGreaterThan(100);
    const shell = await t.ok("eval_in_page", {
      shell: true,
      expression: CODE.viewer,
    });
    expect(valueOf<object>(shell.text)).toEqual({ path: new URL(ed.address).pathname, frame: true, crumbs: true });

    const click = await t.ok("eval_in_page", {
      expression: CODE.bump,
    });
    const out = valueOf<{ count: string; framed: boolean; origin: string }>(click.text);
    expect([out.count, out.framed]).toEqual(["2", true]);
    expect(out.origin).not.toBe(new URL(s.root).origin);
    // The render is a copy: the person's page did not count the clicks.
    expect(await ed.textOf("#count")).toBe("0");
  });

  test("editor: true opens the page in the editor, with its controls; code in that window can't get the person's Share token", async () => {
    const view = await t.ok("view_page", { ...SOON, editor: true });
    expect(view.text).toContain("Shown as its person sees it, in Erga's editor.");
    expect(view.text).toContain("No script errors.");
    const shell = await t.ok("eval_in_page", {
      editor: true,
      shell: true,
      expression: CODE.editor,
    });
    const got = valueOf<{ body: string }>(shell.text);
    expect(got.body).not.toContain("erga_");
    // The server's browser is an agent: an agent never makes a token.
    expect(got).toEqual({
      editing: true,
      controls: true,
      share: true,
      status: 403,
      body: JSON.stringify({ ok: false, error: "An agent can't make tokens." }),
    });
    const page = await t.ok("eval_in_page", {
      editor: true,
      expression: `!!window.ergaFrame?.page && document.documentElement.hasAttribute("data-erga-editing")`,
    });
    expect(page.text.split("\n\n")[0]).toBe("true");
  });

  test("view_page by a person's agent, with none of that person's tabs open, gives a picture from the server's browser", async () => {
    const items = await (await person(s, BO)).turn(id, [{ tool: "page", args: { op: "view_page", ...SOON } }, { text: "ok" }]);
    const v = items.find((i) => i.kind == "tool" && i.name == "view_page");
    expect(!!v && v.status != "error" && !!v.image, `the tool answers a picture: ${JSON.stringify(v).slice(0, 300)}`).toBe(true);
  });
});

journey("a deck: the slide bar, the keys and the agent's add_slide", () => {
  let ed: Editor;
  const shown = () => ed.frame<boolean[]>(`[...${F}.querySelectorAll("section.slide")].map((s) => !s.hidden)`);
  const clickBar = (act: string) => slideBar(ed, act);

  // The bug: after Undo of a slide moved down, the slide did not show in its old place, and the caret was lost.
  test("undo of the slide bar's ↓ shows the slide back in its place, with the caret in it", async ({ tab }) => {
    ed = await openEditor(tab, s, "slides");
    expect(await shown()).toEqual([true, false]);
    expect(await ed.frame<number>(`${F}.defaultView.ergaSteps.count()`)).toBe(2);
    await ed.clickEnd("h1");
    await clickBar("down");
    await expect.poll(shown).toEqual([false, true]);
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toContain(`<section class="slide" data-layout="title">\n    <h1>Launch plan</h1>`);
    await expect.poll(shown).toEqual([true, false]);
    await ed.shows(`
      # Launch plan|

      For the team
    `);
  });

  // The bug: a click on the slide bar left the caret out of the slide that shows, so typed text went nowhere.
  test("the slide bar's ↓, layout and Delete keep the caret, collapsed, in the slide that shows: typing adds to its text", async () => {
    await ed.clickEnd("h1");
    await clickBar("down");
    await expect.poll(shown).toEqual([false, true]);
    await ed.shows(`
      # Launch plan|

      For the team
    `);
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("<h1>Launch plan!</h1>");

    await clickBar("layout");
    await expect.poll(() => ed.source()).toContain(`<section class="slide" data-layout="content">\n    <h1>Launch plan!</h1>`);
    await ed.shows(`
      # Launch plan!|

      For the team
    `);

    await clickBar("add");
    await clickBar("delete");
    await expect.poll(shown).toEqual([false, true]);
    await ed.type("?");
    await expect.poll(() => ed.source()).toContain("<h1>Launch plan!?</h1>");
    await ed.shows(`
      # Launch plan!?|

      For the team
    `);
  });

  test("typing in a slide; ⌘⇧Enter adds a slide after it, shown, its title selected to type over; undo takes it back", async () => {
    await ed.type(" now");
    await expect.poll(() => ed.source()).toContain("<h1>Launch plan!? now</h1>");
    // Typed at once after the key: the new slide is there for it (the deck makes its edit in the key's own event).
    await ed.press("ControlOrMeta+Shift+Enter");
    await ed.type("Why");
    await expect.poll(shown).toEqual([false, false, true]);
    await expect
      .poll(() => ed.source())
      .toContain(
        `<p>For the team</p>\n  </section>\n  <section class="slide" data-layout="content">\n    <h2>Why</h2>\n    <ul>\n      <li>A point</li>\n    </ul>\n  </section>\n</body>`
      );
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h2>Why</h2>");
    expect(await ed.frame<number>(`${F}.defaultView.ergaSteps.current()`)).toBe(2);
    await ed.press("ControlOrMeta+z");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.count("section.slide")).toBe(2);
  });

  test("an agent's add_slide (call_edit) adds a slide to the deck; document_api lists the deck's own edits and erga/text's", async () => {
    const t = (await mine()).on(await idOf(ed.address));
    const apis = await apisOf(t);
    expect(apis.map((a) => a.api)).toEqual(["slides", "erga/text"]);
    expect(apis[0].edits.map((e) => e.name)).toEqual(["add_slide", "delete_slide", "move_slide", "set_layout"]);
    expect(apis[1].edits.map((e) => e.name)).toContain("replace_text");
    const before = await shown();
    expect(
      (await t.ok("call_edit", { path: "index.html", edit: "add_slide", input: { after: 2, layout: "title", title: "Thanks" } })).text
    ).toMatch(/^Made slides's add_slide\. Edited index\.html/);
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain(`<section class="slide" data-layout="title">\n    <h1>Thanks</h1>`);
    await expect.poll(() => ed.count("section.slide")).toBe(3);
    // The person's view stays on its slide.
    expect(await shown()).toEqual([...before, false]);
    // A slide with its points, in one call (the page: index.html, by default).
    expect(
      (await t.ok("call_edit", { edit: "add_slide", input: { after: 3, layout: "content", title: "Why", points: ["Fast", "A & B"] } })).text
    ).toMatch(/^Made slides's add_slide\./);
    expect((await t.ok("read", { path: "index.html" })).text).toMatch(
      /<h2>Why<\/h2>\s*<ul>\s*<li>Fast<\/li>\s*<li>A &amp; B<\/li>\s*<\/ul>/
    );
    expect(await t.fails("call_edit", { path: "index.html", edit: "delete_slide", input: { slide: 9 } })).toMatch(
      /no slide 9: the deck has slides 1 to 4/
    );
    expect(await t.fails("call_edit", { path: "index.html", edit: "move_slide", input: { slide: 3, by: -1 } })).toBe(
      "move_slide's input is wrong: to is required. document_api lists its input's schema."
    );
  });
});

journey("a page's own edits: its buttons, and call_edit", () => {
  let ed: Editor;
  const views = () => ed.frame<string[]>(`[...${F}.querySelectorAll(".map h3")].map((h) => h.textContent)`);
  const press = (name: string, button: string) => viewButton(ed, name, button);
  const START = ["Front page", "Documents", "New document", "Document", "Page", "Editor", "Settings", "Admin"];

  test("the page's buttons edit its source: add, delete, move, add under; each is one undo; the buttons take no caret", async ({ tab }) => {
    // The page asks another site for its fonts: it gets an empty stylesheet here, so no step waits on the internet.
    await tab.page.route(/^https:\/\/fonts\.googleapis\.com\//, (r) => r.fulfill({ contentType: "text/css", body: "" }));
    ed = await openEditor(tab, s, "page-api");
    expect(await views()).toEqual(START);
    expect(await ed.frame<boolean>(`${F}.documentElement.hasAttribute("data-erga-editing") && window.ergaEditor.editing`)).toBe(true);
    // A button is a button: a click on one that has nothing to do (the first view can't move up) puts no caret in the text.
    await press("Front page", "up");
    expect(await ed.caretIn("[data-erga-text]")).toBe(false);

    await press("Admin", "add");
    await expect.poll(views).toEqual([...START, "New view"]);
    // The new view's name is selected, to type over.
    await ed.type("Billing");
    await expect.poll(views).toEqual([...START, "Billing"]);
    expect(await ed.source()).toContain(
      `<h3>Admin</h3><p class="url">/admin</p></div>\n        </div>\n      </li>\n      <li>\n        <div class="view">\n          <div class="view-head"><h3>Billing</h3><p class="url">/path</p></div>\n        </div>\n      </li>\n    </ul>`
    );
    await press("Settings", "del");
    await expect.poll(views).toEqual(["Front page", "Documents", "New document", "Document", "Page", "Editor", "Admin", "Billing"]);
    await press("Admin", "up");
    await expect.poll(views).toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "Editor", "Billing"]);
    await press("Page", "child");
    await expect
      .poll(views)
      .toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "New view", "Editor", "Billing"]);
    expect(await ed.source()).toMatch(
      /<h3>Page<\/h3>[^]*?<\/div>\n {16}<ul class="branch">\n {18}<li>\n {20}<div class="view">\n {22}<div class="view-head"><h3>New view<\/h3>/
    );
    await ed.press("ControlOrMeta+z");
    await expect.poll(views).toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "Editor", "Billing"]);
  });

  test("document_api lists the page's own edits first; call_edit runs one in the sandbox, and the page shows it; a wrong input says why", async () => {
    const t = (await mine()).on(await idOf(ed.address));
    const apis = await apisOf(t);
    expect(apis.map((a) => a.api)).toEqual(["views", "erga/text"]);
    expect(apis[0].edits.map((e) => e.name)).toEqual(["add_view", "add_under", "delete_view", "move_view"]);
    // The fourth view at the top is Billing now.
    expect((await t.ok("call_edit", { path: "index.html", edit: "delete_view", input: { view: [4] } })).text).toMatch(
      /^Made views's delete_view\. Edited index\.html/
    );
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).not.toContain("<h3>Billing</h3>");
    await expect.poll(views).toEqual(["Front page", "Admin", "Documents", "New document", "Document", "Page", "Editor"]);
    expect(await t.fails("call_edit", { path: "index.html", edit: "move_view", input: { view: [1], by: -1 } })).toBe(
      "the first view can't move up"
    );
    expect(await t.fails("call_edit", { path: "index.html", edit: "delete_view", input: { view: [9] } })).toMatch(
      /delete_view can't be made: .*matches 0 elements/
    );
    // An input that its schema doesn't allow: call_edit says what is wrong, and the page's module never sees it.
    expect(await t.fails("call_edit", { path: "index.html", edit: "move_view", input: { view: [1, 0], by: 2 } })).toBe(
      "move_view's input is wrong: view.1: Expected a value greater than or equal to 1; by: Expected -1 | 1. document_api lists its input's schema."
    );
  });
});

test("a long drag drops too: the drop is the person's own gesture", async ({ tab }) => {
  // A page's own edit must come soon after a click or a key (5 s; here 100 ms, at this page's timescale).
  const HELD = 0.02 * 5000;
  const ed = await openEditor(tab, s, "page-api-todo", { timescale: 0.02 });
  const order = () => ed.frame<string[]>(`[...${F}.querySelectorAll("ul.todo > li p")].map((p) => p.textContent)`);
  expect(await order()).toEqual(["Milk", "Eggs", "Bread", "Butter"]);
  await ed.frame(`${F}.addEventListener("pointerdown", () => (window.__down = performance.now()), true)`);
  // Butter's grip, dragged above Milk, and held there longer than that.
  const from = await ed.rectOf("ul.todo > li:nth-child(4) .grip");
  const to = await ed.rectOf("ul.todo > li:nth-child(1)");
  const mouse = ed.page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 8; i++) await mouse.move(from.x, from.y + ((to.y - 6 - from.y) * i) / 8);
  await until(() => ed.frame<boolean>(`performance.now() - window.__down > ${HELD * 2}`), 5000, "the person holds the item");
  await mouse.up();
  await expect.poll(order).toEqual(["Butter", "Milk", "Eggs", "Bread"]);
  await expect.poll(() => ed.source()).toMatch(/<li><p>Butter<\/p><\/li>\s*<li><p>Milk<\/p><\/li>/);
});

test("a page can't make its own edits when nobody clicked: as it loads, say", async ({ tab }) => {
  const ed = await openEditor(tab, s, "page-api-load");
  await expect.poll(() => ed.frame<{ ok: boolean; error: string } | undefined>(`window.result`)).toBeTruthy();
  const r = await ed.frame<{ ok: boolean; error: string }>(`window.result`);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/just clicked or pressed a key/);
  expect(await ed.source()).toContain(`<p id="note">Nobody clicked.</p>`);
});

test("path renders another page than the open one, with edits too; the person's tab stays on the deck", async ({ tab }) => {
  const ed = await openEditor(tab, s, "glide");
  const t = (await mine()).on(await idOf(ed.address));
  const h1 = `document.querySelector("h1").textContent`;
  const notes = await t.ok("eval_in_page", { path: "notes.html", expression: h1 });
  expect(notes.text).toMatch(/^"Speaker notes"/);
  expect(notes.text).toContain("[Rendered notes.html.]");
  const edited = await t.ok("eval_in_page", {
    path: "notes.html",
    expression: h1,
    edits: [{ oldText: "Speaker notes", newText: "Notes, in the preview" }],
  });
  expect(edited.text).toMatch(/^"Notes, in the preview"/);
  expect(edited.text).toContain("A preview: 1 edit applied to a copy of notes.html");
  const seen = await t.ok("view_page", { ...SOON, path: "notes.html" });
  expect(seen.images).toHaveLength(1);
  expect(seen.text).toContain("of notes.html");
  expect(await ed.frame<string>(`document.querySelector(".current h2").textContent`)).toBe("First frame");
});

test("the document tools work on any of your documents, named by address, URL, slug or id; a failure says why; someone else's document only once it is shared", async () => {
  const p = await person(s, someone("w")),
    other = await person(s, someone("o"));
  const t = await p.tools();
  const files = {
    "index.html": `<!doctype html><title>x</title><h1>Hello from a folder</h1><img src="img/dot.png">`,
    "img/dot.png": { base64: PNG },
  };
  const pub = await t.create({ title: "Published app", files });
  expect(pub.address).toBe(`/${p.login}/published-app`);
  let r = await t.call("read", { document: pub.address, path: "index.html" });
  expect(r.status).toBe(200);
  expect(r.text).toContain("Hello from a folder");
  r = await t.call("read", { document: s.root + pub.address, path: "img/dot.png" });
  expect(r.content[0]?.type).toBe("image");
  r = await t.call("edit", {
    document: "published-app",
    path: "index.html",
    edits: [{ oldText: "Hello from a folder", newText: "Hello, edited by an agent" }],
  });
  expect(r.status).toBe(200);
  expect(await (await p.get(`/d/${pub.id}/doc/index.html`)).text()).toContain("Hello, edited by an agent");
  r = await t.call("edit", { document: pub.id, path: "index.html", edits: [{ oldText: "not there", newText: "x" }] });
  expect(r.status).toBe(400);
  expect(r.text.length).toBeGreaterThan(0);
  expect((await t.call("read", { document: "/nobody/nothing", path: "index.html" })).status).toBe(404);
  expect((JSON.parse((await t.call("list_documents")).text) as { id: string }[]).some((d) => d.id == pub.id)).toBe(true);
  // There is no second route by the document's URL: the old one, and the host's own, point to /api/tools.
  for (const path of [`/d/${pub.id}/api/tools/read`, `${pub.address}/api/ext/tools/read`]) {
    const old = await fetch(`${s.root}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: '{"path": "index.html"}',
    });
    expect(`${path}: ${old.status}`).toBe(`${path}: 404`);
  }

  // Someone else's document: the agent can't open it until it is shared with its person; then it reads it, but only the owner may delete it.
  const theirs = (await other.run<{ id: string; address: string }>("create_document", { title: "Theirs" })).result!;
  expect((await t.call("read", { document: theirs.address, path: "index.html" })).status).toBe(403);
  expect((await other.run("share_document", { document: theirs.id, login: p.login, role: "editor" })).status).toBe(200);
  expect((await t.call("read", { document: theirs.address, path: "index.html" })).status).toBe(200);
  r = await t.call("delete_document", { document: theirs.address });
  expect(r.status).toBe(403);
  expect(r.text).toMatch(/owner/);
});

test("the file tools on a document of many pages: ls, new, read, mv, grep and rm, by a token and by the person's agent; PDFs by kind, words and page", async () => {
  const p = await person(s, someone("f"));
  const t = await p.tools();
  const doc = await t.create({
    title: "Pages test",
    kind: "project",
    files: SITE,
  });
  const d = t.on(doc.id);
  type Ls = { entries: { path: string; type: string; kind?: string; mime?: string }[] };
  const ls = async (args: Record<string, string> = {}) => JSON.parse((await d.ok("ls", args)).text) as Ls;
  const files = (l: Ls) => l.entries.filter((e) => e.type != "folder").map((f) => f.path);
  const all = await ls();
  expect(files(all).sort()).toEqual(["about.html", "blog/blog.css", "blog/index.html", "blog/post.html", "index.html", "style.css"]);
  expect(all.entries.find((f) => f.path == "about.html")).toMatchObject({ type: "page", kind: "text" });
  expect(all.entries.find((f) => f.path == "blog")).toMatchObject({ type: "folder" });
  await d.ok("new", { path: "notes/2026/" });
  expect(files(await ls({ path: "notes/2026" }))).toEqual([]);
  await d.ok("new", { path: "notes/2026/first" });
  expect((await d.ok("read", { path: "notes/2026/first.html" })).text).toContain("<h1>Untitled</h1>");
  await d.ok("mv", { from: "notes", to: "journal" });
  expect(files(await ls({ glob: "journal/**/*.html" }))).toEqual(["journal/2026/first.html"]);
  expect((await d.ok("grep", { pattern: "two folders down" })).text.startsWith("blog/post.html:")).toBe(true);
  await d.ok("rm", { path: "journal" });
  expect(JSON.stringify((await ls()).entries)).not.toContain("journal");
  expect(await d.fails("rm", { path: "index.html" })).toMatch(/own page/);

  // The person's agent makes, moves, lists and deletes on the same tree.
  const calls = await p.turn(
    doc.id,
    [
      { tool: "edit", args: { op: "new", path: "drafts/" } },
      { tool: "edit", args: { op: "new", path: "drafts/idea.html" } },
      { tool: "edit", args: { op: "mv", from: "drafts/idea.html", to: "drafts/plan.html" } },
      { tool: "read", args: { op: "ls", path: "drafts" } },
      { tool: "edit", args: { op: "rm", path: "drafts" } },
      { text: "Done." },
    ],
    "Tidy up"
  );
  expect(calls.filter((c) => c.kind == "tool").map((c) => c.status)).toEqual(["done", "done", "done", "done", "done"]);
  expect(JSON.stringify((await ls()).entries)).not.toContain("drafts");

  // PDFs: ls says each file's kind, grep finds words by page, read gives the PDF as a document, over the API and over MCP.
  const put = (path: string, body: Uint8Array<ArrayBuffer>) => p.get(`/d/${doc.id}/api/files/${path}`, { method: "PUT", body });
  expect((await put("receipts/2026-03-goodwill.pdf", pdf("Goodwill Industries", "Charitable contribution receipt"))).status).toBe(200);
  expect((await put("receipts/2026-11-redcross.pdf", pdf("Thank you for your charitable gift"))).status).toBe(200);
  expect((await ls({ path: "receipts" })).entries.find((f) => f.path == "receipts/2026-03-goodwill.pdf")).toMatchObject({
    kind: "file",
    mime: "application/pdf",
  });
  const grep = await d.ok("grep", { pattern: "charitable", ignoreCase: true, glob: "receipts/*.pdf" });
  expect(grep.text.split("\n")).toEqual([
    "receipts/2026-03-goodwill.pdf:2: Charitable contribution receipt",
    "receipts/2026-11-redcross.pdf:1: Thank you for your charitable gift",
  ]);
  const read = await d.ok("read", { path: "receipts/2026-03-goodwill.pdf" });
  expect(read.text).toContain("2 pages (PDF");
  const part = read.content.find((c) => c.type == "document")!;
  expect(part.mimeType).toBe("application/pdf");
  expect(atob(part.data!).startsWith("%PDF-")).toBe(true);
  const over = await t.mcp("read", { document: doc.id, path: "receipts/2026-03-goodwill.pdf" });
  expect(over.isError).toBeFalsy();
  const resource = over.content.find((c) => c.type == "resource")!.resource!;
  expect(resource.mimeType).toBe("application/pdf");
  expect(atob(resource.blob).startsWith("%PDF-")).toBe(true);
});

// The bug: the render's token named the caller, not the document's owner, so the page's own files gave 404.
test("with no tab open: in a document of another person's that the caller may edit, the render loads the page's script and image; a page with no steps says so", async () => {
  const owner = await person(s, someone("r")),
    p = await person(s, someone("c"));
  const theirs = (await owner.run<{ id: string }>("create_document", { title: "Render owner" })).result!;
  expect((await owner.run("share_document", { document: theirs.id, login: p.login, role: "editor" })).ok).toBe(true);
  await probe((await p.tools()).on(theirs.id), SOON);

  // A page with no steps library: a step's number says that it has no steps; a hash opens the render there.
  const t = (await mine()).on(await idOf((await s.fixture("one-line")).address));
  expect(await t.fails("view_page", { step: "2" })).toMatch(/The page has no steps: it loads no steps library \(erga\/steps\)/);
  expect((await t.ok("eval_in_page", { ...SOON, expression: "location.hash", step: "#2" })).text).toMatch(
    /^"#2"[\s\S]*Opened at #2 \(the page has no steps\)/
  );
});

test("the agent reads the person's live page and clicks play: the audio plays, and the console, the events and the requests say so", async ({
  tab,
}) => {
  const owner = await person(s, "tester");
  const tools = await mine();
  const doc = await tools.create({
    title: "Player",
    slug: someone("player-"),
    files: { "index.html": PLAYER, "tone.wav": { base64: tone() } },
  });
  const t = tools.on(doc.id);
  const p = tab.page;
  tab.strict = true;
  await p.setViewportSize({ width: 1200, height: 800 });
  await p.goto(`${s.root}${doc.address}?edit`);
  const ready = () =>
    p
      .evaluate(() => ["erga-editor-ready", "erga-editing", "erga-listening"].every((c) => document.body.classList.contains(c)))
      .catch(() => false);
  await until(ready, 10_000, "the editor is ready");

  // The console, with the page's 1000 warnings as one line.
  const consoled = await until(
    async () => {
      const r = await t.call("page_log", { kind: "console", level: ["warn"], pattern: "AudioContext" });
      return r.ok && /×1000/.test(r.text) ? r : null;
    },
    10_000,
    "the console's warnings"
  );
  expect(consoled!.text).toMatch(/\[×1000, [\d:.]+–[\d:.]+\] warn \(page\): The AudioContext was not allowed to start/);
  // The page's media and permissions, without code: its frame may autoplay, and never go full screen.
  const facts = await until(
    async () => {
      const r = await t.call("page_log", { kind: "frames" });
      const f = r.ok ? (JSON.parse(r.text.slice(0, r.text.lastIndexOf("\n"))) as LiveFacts) : null;
      return f?.find((x) => x.frame == "page")?.media?.[0]?.readyState.startsWith("4") ? f : null;
    },
    10_000,
    "the page's audio loads"
  );
  const page = facts!.find((f) => f.frame == "page")!;
  expect(page.allow).toBe("autoplay; fullscreen 'none'");
  expect(page.autoplay).toMatchObject({ allowsFeature: true, fullscreen: false });
  expect(page.media?.[0]).toMatchObject({ element: "<audio#track>", paused: true });
  expect(facts![0]).toMatchObject({ frame: "the editor (the tab itself)", editorFrame: { allow: "autoplay; fullscreen 'none'" } });
  // The tab shows the person a line each time the agent looks at their page.
  const line = () => p.evaluate(() => document.getElementById("agent-live-text")?.textContent ?? "");
  await expect.poll(line).toMatch(/The agent read the page's media and permissions/);
  // Nothing in the agent's panel to switch on.
  expect(await p.locator("#agent-control").count()).toBe(0);

  // The person clicks into the agent's box, to ask: a real click in the tab (the user activation that the page's media may play on).
  if (await p.locator("#agent-input").isHidden()) await p.locator("#agent-fab").click();
  await p.locator("#agent-input").click();

  // The agent clicks play, through the editor's handlers: untrusted, so no activation of its own, but the audio plays.
  const clicked = await t.ok("page_input", { selector: "#play" });
  expect(clicked.text).toMatch(/Clicked <button#play> at \(\d+, \d+\): pointerdown, mousedown, pointerup, mouseup, click\./);
  expect(clicked.text).toMatch(/Trusted: false/);
  // (Whatever the page's frame has: the test's own calls into the tab count as gestures. In a person's browser it has
  // none, and play() succeeds on the activation of the tab above it, which Chrome checks when autoplay is delegated.)
  expect(clicked.text).toMatch(
    /User activation in the page's frame: before isActive (true|false), hasBeenActive (true|false); after isActive (true|false), hasBeenActive (true|false)\./
  );
  expect(clicked.text).toMatch(/"element":"<audio#track>"[^}]*"paused":false/);
  expect(clicked.text).toMatch(/log \(page\): playing/);
  await expect.poll(line).toBe("The agent clicked #play");
  // The media keeps playing: its time moves on.
  const playing = await until(
    async () => {
      const r = await t.call("eval_in_page", {
        live: true,
        expression: `(() => { const a = document.querySelector("#track"); return { paused: a.paused, t: a.currentTime, error: a.error }; })()`,
      });
      const v = r.ok ? (JSON.parse(r.text.slice(0, r.text.indexOf("\n"))) as { paused: boolean; t: number; error: unknown }) : null;
      return v && !v.paused && v.t > 0.2 ? v : null;
    },
    5000,
    "the audio plays"
  );
  expect(playing!.error).toBeNull();

  // The events: the agent's click, untrusted, and nobody consumed it.
  expect((await t.ok("page_log", { kind: "events", since: "1m" })).text).toMatch(
    /click on <button#play>, sent by the agent, untrusted: nobody consumed it/
  );
  // The requests: the audio file, from Erga's server, as audio/wav.
  const net = await t.ok("page_log", { kind: "network", pattern: "tone\\.wav" });
  expect(net.text).toMatch(/GET {2}doc\/tone\.wav {2}20[06] {2}audio\/wav/);
  expect(net.text).not.toMatch(/\/t\/ey/); // the token in the files' address stays in the tab
  expect(net.text).toMatch(/via erga/);
  // A key that Erga takes for itself (⌘S / Ctrl+S, its own save): the events say that Erga's page script consumed it.
  const key = await t.ok("page_input", { key: "s", modifiers: ["meta", "ctrl"], selector: "p" });
  expect(key.text).toMatch(/Pressed a key on <p>: keydown \(default prevented\), keyup\./);
  expect((await t.ok("page_log", { kind: "events", since: "10s" })).text).toMatch(
    /keydown on <p>, sent by the agent, untrusted: the editor called preventDefault \(its listener on window, capture phase\)/
  );

  // The owner's own agent has the same tools, in the document open on their page.
  const turn = await owner.turn(
    doc.id,
    [{ tool: "page", args: { op: "page_log", kind: "console", pattern: "playing" } }, { text: "It plays." }],
    "Why is it quiet?"
  );
  expect(turn.find((i) => i.name == "page_log")?.status).toBe("done");
});

test("versions with from or to: since the agent's last turn, between two versions, for one file, and nothing changed", async () => {
  const owner = await person(s, someone("v"));
  const t = await owner.tools();
  const doc = await t.create({
    title: "Versions",
    files: { "index.html": "<!doctype html>\n<title>Versions</title>\n<h1>Notes</h1>\n<p>Hello.</p>\n" },
  });
  const d = t.on(doc.id);
  type State = { current: { id: string }; total: number; pending: boolean };
  const versions = async () => (await owner.run<State>("versions", { document: doc.id })).result!;
  const room = await joinRoom(`${s.root}${doc.address}`, owner.login);
  try {
    // Each turn of the agent is one version.
    const before = (await versions()).total;
    await owner.turn(doc.id, [edit("</h1>", " alpha</h1>"), { text: "Done." }]);
    await until(async () => (await versions()).total == before + 1, 5000, "the first turn's version");
    await owner.turn(doc.id, [edit("</h1>", " agent-done</h1>"), { text: "Done." }]);
    await until(async () => room.str().includes("agent-done") && (await versions()).total == before + 2, 5000, "the second turn's version");
    const turn = (await versions()).current;
    room.insertAfter("agent-done", " live-now");
    await expect.poll(async () => (await versions()).pending).toBe(true);
    let v = await d.ok("versions", { from: "last_turn" });
    expect(v.text.startsWith(`From ${turn.id} (where your last turn ended) to current`), v.text.slice(0, 200)).toBe(true);
    expect(v.text).toContain("--- a/index.html\n+++ b/index.html\n@@ ");
    expect(v.text).toMatch(/^\+.*live-now/m);
    expect(v.text).toMatch(/^-.*agent-done/m);
    const [a, b] = [`v${before}`, `v${before + 1}`];
    v = await d.ok("versions", { from: a, to: b, path: "index.html", context: 0 });
    expect(v.text.startsWith(`From ${a} to ${b} in index.html: 1 file(s) differ`), v.text.slice(0, 200)).toBe(true);
    expect(v.text).toMatch(/^\+.*alpha/m);
    expect(v.text).not.toContain("agent-done");
    expect((await d.ok("versions", { from: b, to: String(before + 1) })).text).toBe(`No changes from ${b} to ${b}.`);
    expect(await d.fails("versions", { from: "v99" })).toContain('no version "v99"');
  } finally {
    room.leave();
  }
});

// The bug (production): the homepage project adopted from an admin's /<admin>/landing is owned by "-home", but its host
// still kept the admin it was made with, and the render's token named that admin: the page's own files gave 404.
test("in the homepage project adopted from an admin's document (owner -home), the render loads the page's script and image", async () => {
  const admin = await (await person(bare, "tester")).tools("admin");
  // The old homepage, /tester/landing, made before anything opened / (which would make a homepage project of its own).
  const made = await admin.create({ files: { "index.html": "<!doctype html><title>Erga</title><h1>Old</h1>" }, slug: "landing" });
  expect((await runTool(bare.root, "set_setting", { key: "landing_document", value: made.id })).error).toBeUndefined();
  // The first / (signed out) adopts it.
  const front = await fetch(`${bare.root}/`, { redirect: "manual", headers: { Cookie: `erga_signed_out_${new URL(bare.root).port}=1` } });
  expect(docOf(await front.text())).toBe(made.id);
  await probe(admin.on("/_home"), SOON);
});
