// A hosted agent in the panel: an agent with an address, which speaks AG-UI (agui-agent.ts stands in for it, with no
// model in the loop). An admin adds it; the person picks it in the head's menu and signs in at the agent; a turn shows
// its text and its own tool calls; a call that waits gets the person's Approve; Stop closes the stream. The page talks
// to the agent itself: Erga's own agent hears nothing of it.
//
// An attached session in the panel: an agent that runs somewhere else, whose helper opened a link to the person's agent
// (a scripted helper stands in for it). The menu lists it; the panel's message goes down the link; a prompt typed in
// the terminal shows as one; a permission card says that the terminal asks too; Stop is a cancel.
import { expect, goto, journey, servers, test, type Page } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";
import { scriptedAgent, scriptedHelper, type ScriptedAgent, type ScriptedHelper } from "./agui-agent";
import { answered, answers, calls, paneOpen, person, say } from "./panel";
import { newToken } from "../helpers/new-token";

const s = await servers.main();
const ADA = "HostedAda",
  LIN = "LinkLin";

const agui = (text: string, steps: object[]) => `${text} @agui ${JSON.stringify(steps)}`;
const head = (page: Page) => page.evaluate(() => `${document.getElementById("agent-who")!.textContent} ▾`);
/** The menu's rows, once the panel has read who it can show. */
const rows = (page: Page) => page.evaluate(() => [...document.querySelectorAll("#agent-menu .row b")].map((b) => b.textContent));
const hint = (page: Page) =>
  page.evaluate(() => (document.getElementById("agent-hint")!.hidden ? null : document.getElementById("agent-hint")!.textContent));
const busy = (page: Page) => page.evaluate(() => document.getElementById("agent-fab")!.classList.contains("busy"));
const sendLabel = (page: Page) => page.evaluate(() => document.getElementById("agent-send")!.textContent);

journey("a hosted agent in the panel", () => {
  let page: Page, agent: ScriptedAgent;

  test("an admin adds the agent; the person picks it in the head's menu, and signs in at the agent for the first message", async ({
    tab,
  }) => {
    page = tab.page;
    tab.strict = false; // (The agent's 401 is a console error of the browser's.)
    agent = await scriptedAgent({ signIn: true });
    expect((await runTool(s.root, "set_setting", { key: "agents", value: [{ name: "Helper", url: agent.url }] })).ok).toBe(true);
    await goto(page, `${s.root}/documents?user=${ADA}`);
    await expect.poll(() => paneOpen(page)).toBe(true);
    await expect.poll(() => rows(page)).toEqual(["Erga's agent", "Helper", "Connect an agent…"]);
    await page.click("#agent-who");
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("#agent-menu .row")].map((r) => `${r.getAttribute("aria-checked")}: ${r.textContent}`)
      )
    ).toEqual(["true: Erga's agentBuilt in · script (test model)✓", `false: Helper${new URL(agent.url).host}`, "null: Connect an agent…"]);
    await page.click('#agent-menu .row[data-agent="Helper"]');
    await expect.poll(() => head(page)).toBe("Helper ▾");
    expect(await page.evaluate(() => document.getElementById("agent-model")!.textContent)).toBe("");
    expect(await page.evaluate(() => (document.getElementById("agent-input") as HTMLTextAreaElement).placeholder)).toBe("Ask Helper…");

    // No sign-in at the agent yet: the panel asks for it, and the message goes when the person comes back.
    await say(page, agui("Hello", [{ say: "Hello, Ada." }]));
    await expect.poll(() => hint(page)).toContain(`Sign in to Helper (${new URL(agent.url).host})`);
    expect(await busy(page)).toBe(false);
    const [signIn] = await Promise.all([page.waitForEvent("popup"), page.click('#agent-hint button[data-sign="yes"]')]);
    await signIn.waitForLoadState();
    expect(signIn.url()).toBe(`${agent.origin}/`);
    await signIn.close();
    await page.click('#agent-hint button[data-sign="again"]');
    await answered(page, "Hello, Ada.");
    expect(await hint(page)).toBeNull();
    expect(agent.inputs.at(-1)).toMatchObject({ protocolVersion: "1.0", context: [{ description: "What the person has open in Erga" }] });
  });

  test("a turn shows the agent's text; a call that ended has no line; the next run has the thread so far", async () => {
    await say(
      page,
      agui("Find it", [
        { say: "I'll look." },
        { call: "search", args: { query: "ryokan in Kyoto" }, result: "Tawaraya" },
        { say: "It is Tawaraya." },
      ])
    );
    await answered(page, "It is Tawaraya.");
    expect((await answers(page)).slice(-2)).toEqual(["I'll look.", "It is Tawaraya."]);
    expect(await calls(page), "a call that ended has no line after the turn").toEqual([]);
    expect(agent.inputs.at(-1)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("a call that waits shows the agent's card; Approve starts the run that has the answer", async () => {
    const before = agent.inputs.length;
    await say(
      page,
      agui("Book it", [
        { call: "calendar.create_event", args: { title: "Kyoto", day: "2027-03-02" } },
        { ask: "Add an event to your calendar", after: [{ say: "Booked." }] },
      ])
    );
    await page.waitForSelector("#agent-log .msg-tool.asking");
    expect(await page.evaluate(() => document.querySelector("#agent-log .msg-tool.asking > span")!.textContent)).toBe(
      "Helper asks to:Add an event to your calendarcalendar.create_eventtitle: Kyotoday: 2027-03-02"
    );
    expect(await busy(page)).toBe(false);
    await page.click('#agent-log .msg-tool.asking button[data-answer="approve"]');
    await answered(page, "Booked.");
    expect(agent.inputs.length).toBe(before + 2);
    expect(agent.inputs.at(-1)!.resume).toMatchObject([{ status: "resolved", payload: { approved: true } }]);
  });

  test("a call that runs shows with the agent's name; Stop closes the stream; the conversation stays after a reload; Erga's own agent comes back", async () => {
    await say(page, agui("Go on", [{ say: "Working." }, { call: "search", args: { query: "ryokan in Kyoto" } }, { hold: true }]));
    await expect.poll(() => sendLabel(page)).toBe("Stop");
    await expect.poll(() => calls(page)).toEqual(["Helper: search ryokan in Kyoto"]);
    await expect.poll(async () => (await answers(page)).at(-1)).toBe("Working.");
    await page.click("#agent-send");
    await expect.poll(() => agent.cut()).toBe(1);
    await expect.poll(() => busy(page)).toBe(false);
    expect(await sendLabel(page)).toBe("Send");

    await page.reload();
    await expect.poll(() => head(page)).toBe("Helper ▾");
    await expect.poll(async () => (await answers(page)).slice(-2)).toEqual(["Booked.", "Working."]);

    await page.click("#agent-who");
    await page.click('#agent-menu .row[data-agent=""]');
    await expect.poll(() => head(page)).toBe("Agent ▾");
    await expect.poll(() => page.evaluate(() => document.getElementById("agent-model")!.textContent)).toBe("script (test model)");
    expect(await answers(page), "Erga's own agent heard nothing").toEqual([]);

    // With no hosted agent on the server, the menu has Erga's own agent, and how to connect one.
    expect((await runTool(s.root, "set_setting", { key: "agents", reset: true })).ok).toBe(true);
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.getElementById("agent-model")!.textContent)).toBe("script (test model)");
    await expect.poll(() => rows(page)).toEqual(["Erga's agent", "Connect an agent…"]);
    await agent.stop();
  });
});

journey("an attached session in the panel", () => {
  let page: Page, helper: ScriptedHelper;
  /** The frames that came down the link since the last look. */
  let seen = 0;
  const down = async (n = 1) => {
    await expect.poll(() => helper.got.length).toBe(seen + n);
    seen += n;
    return helper.got.at(-1)!;
  };
  const run = (runId: string, more: object = {}) => ({ threadId: "s1", runId, ...more });
  const model = (page: Page) => page.evaluate(() => document.getElementById("agent-model")!.textContent);

  test("a session attaches with its person's agent token: the menu lists it, and the panel shows it when picked", async ({ tab }) => {
    page = tab.page;
    const lin = await person(s, LIN);
    await goto(page, `${s.root}/documents?user=${LIN}`);
    await expect.poll(() => paneOpen(page)).toBe(true);
    await expect.poll(() => model(page)).toBe("script (test model)");
    // "Connect an agent…" says how a session attaches: the two lines that install this server's plugin in Claude Code.
    await page.click("#agent-who");
    await page.click("#agent-menu .row.more");
    expect(await page.evaluate(() => document.querySelector("#agent-hint .agent-connect")!.textContent)).toBe(
      `To attach a Claude Code session, install Erga's plugin there (one time):/plugin marketplace add ${s.root}/agents/marketplace.json\n/plugin install erga@erga` +
        "CopyThen, in a session: /erga:attach"
    );
    const market = (await (await fetch(`${s.root}/agents/marketplace.json`)).json()) as {
      plugins: { name: string; source: { url: string } }[];
    };
    expect(market.plugins).toMatchObject([{ name: "erga", source: { source: "archive", url: `${s.root}/agents/erga.zip` } }]);
    const zip = await fetch(market.plugins[0].source.url);
    expect([zip.status, new TextDecoder().decode((await zip.arrayBuffer()).slice(0, 2))]).toEqual([200, "PK"]);
    // The link is an agent's: a person's own sign-in is refused there.
    expect((await lin.get("/api/agent/link")).status).toBe(401);
    const { token } = await newToken(s.root, { label: "Claude Code (erga)", scope: "documents" }, lin.cookie);
    helper = await scriptedHelper(s.root, token, { session: "s1", agent: "Claude Code", where: "lin-laptop, ~/trip", model: "Fable 5.2" });
    // The session attached: the lines that say how go away, and the menu lists it.
    await expect.poll(() => hint(page)).toBeNull();
    await page.click("#agent-who");
    expect(await page.evaluate(() => document.querySelector("#agent-menu .row:nth-child(2)")!.textContent)).toBe(
      "Claude Codelin-laptop, ~/trip · attached"
    );
    await page.click('#agent-menu .row[data-agent="link:s1"]');
    await expect.poll(() => head(page)).toBe("Claude Code ▾");
    await expect.poll(() => model(page)).toBe("Fable 5.2");
    expect(
      await page.evaluate(() => [
        (document.getElementById("agent-input") as HTMLTextAreaElement).placeholder,
        document.getElementById("agent-reset")!.hidden,
      ])
    ).toEqual(["Ask Claude Code…", true]);
  });

  test("a message from the panel goes down the link; the session's text and its own tool call show", async () => {
    await say(page, "Add a map of our days");
    const input = await down();
    expect(input).toMatchObject({
      threadId: "s1",
      messages: [{ role: "user", content: "Add a map of our days" }],
      context: [{ description: "What the person has open in Erga" }],
    });
    const id = String(input.runId);
    helper.say({ type: "RUN_STARTED", ...run(id) });
    helper.say({ type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "I'll draw it." });
    helper.say({ type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Write" });
    helper.say({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"file_path":"map.js"}' });
    helper.say({ type: "TOOL_CALL_END", toolCallId: "c1" });
    await expect.poll(() => calls(page)).toEqual(["Claude Code: Write map.js"]);
    expect(await sendLabel(page)).toBe("Stop");
    helper.say({ type: "TOOL_CALL_RESULT", messageId: "m2", toolCallId: "c1", content: "ok" });
    helper.say({ type: "TEXT_MESSAGE_CHUNK", messageId: "m3", delta: "The map is on the page." });
    helper.say({ type: "RUN_FINISHED", ...run(id), outcome: { type: "success" } });
    await answered(page, "The map is on the page.");
  });

  test("a prompt typed in the terminal shows as one; a permission card says the terminal asks too; Approve goes down as the answer", async () => {
    const typed = { ...run("t2"), messages: [{ id: "u2", role: "user", content: "Use winter.jpg as the background" }] };
    helper.say({ type: "RUN_STARTED", ...run("t2"), input: typed });
    helper.say({ type: "TOOL_CALL_START", toolCallId: "c2", toolCallName: "Bash" });
    helper.say({ type: "TOOL_CALL_ARGS", toolCallId: "c2", delta: '{"command":"sips -Z 1600 winter.jpg"}' });
    helper.say({ type: "TOOL_CALL_END", toolCallId: "c2" });
    helper.say({
      type: "RUN_FINISHED",
      ...run("t2"),
      outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "permission", toolCallId: "c2" }] },
    });
    await page.waitForSelector("#agent-log .msg-tool.asking");
    expect(await page.evaluate(() => [...document.querySelectorAll("#agent-log .msg-user")].at(-1)!.textContent)).toBe(
      "in the terminalUse winter.jpg as the background"
    );
    expect(await page.evaluate(() => document.querySelector("#agent-log .msg-tool.asking > span")!.textContent)).toBe(
      "Claude Code asks to run:Bashcommand: sips -Z 1600 winter.jpgAlso asked in the terminal. The first answer counts."
    );
    await page.click('#agent-log .msg-tool.asking button[data-answer="approve"]');
    expect(await down()).toMatchObject({
      threadId: "s1",
      messages: [],
      resume: [{ interruptId: "i1", status: "resolved", payload: { approved: true } }],
    });
    helper.say({ type: "RUN_STARTED", ...run("t3", { parentRunId: "t2" }) });
    helper.say({ type: "TOOL_CALL_RESULT", messageId: "m4", toolCallId: "c2", content: "ok" });
    helper.say({ type: "TEXT_MESSAGE_CHUNK", messageId: "m5", delta: "The photo is the background now." });
    helper.say({ type: "RUN_FINISHED", ...run("t3") });
    await answered(page, "The photo is the background now.");
  });

  test("Stop goes down as a cancel; when the session leaves, the panel says that it is not attached", async () => {
    helper.say({
      type: "RUN_STARTED",
      ...run("t4"),
      input: { ...run("t4"), messages: [{ id: "u4", role: "user", content: "Tidy the folder" }] },
    });
    await expect.poll(() => sendLabel(page)).toBe("Stop");
    await page.click("#agent-send");
    expect(await down()).toEqual({ cancel: "t4" });
    helper.say({ type: "RUN_FINISHED", ...run("t4"), outcome: { type: "cancelled" } });
    await expect.poll(() => sendLabel(page)).toBe("Send");
    helper.leave();
    await expect.poll(() => hint(page)).toBe("Claude Code is not attached.In a Claude Code session, type:/erga:attachCopy");
    expect(await page.evaluate(() => document.getElementById("agent-send")!.getAttribute("aria-disabled"))).toBe("true");
    await expect.poll(async () => (await answers(page)).length, { message: "the conversation stays in the panel" }).toBe(3);
  });
});
