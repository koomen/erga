// Helpers for the agent's journeys (turn.e2e.ts, tools.e2e.ts): the person's agent panel on a page (a message sent,
// the answers, the turn's line), and a person who runs tools with a token.
//
// The agent runs on the scripted model (agents/models.ts): a message with `@script [steps]` plays the tool calls and
// the answers that it lists. No model is in the loop.
import { expect, until, type Page, type Server } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { runTool, textOf } from "../helpers/tools";

/** A scripted step: an edit of the page's file, exact text to new text. */
export const edit = (oldText: string, newText: string, path = "index.html") => ({
  tool: "edit",
  args: { path, edits: [{ oldText, newText }] },
});

/** A message with a script: the steps that the agent plays. */
export const script = (text: string, steps: object[]) => `${text} @script ${JSON.stringify(steps)}`;

/** Types a message into the agent's box and sends it with Enter, as a person does. */
export async function say(page: Page, text: string) {
  await page.focus("#agent-input");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

/** The agent's answers in the panel: each one's text. */
export const answers = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.textContent ?? ""));

/**
 * The agent's answers, and whether a turn is under way: the agent works, or a message is still on its way.
 * Trap: between the moment the server has a message and the moment it says that the agent works, the panel shows
 * neither. So "not at work" alone does not say that a turn has ended: wait for the turn's answer too.
 */
const state = (page: Page) =>
  page.evaluate(() => ({
    answers: [...document.querySelectorAll("#agent-log .msg-assistant")].map((e) => e.textContent ?? ""),
    working: document.getElementById("agent-fab")!.classList.contains("busy") || !!document.querySelector("#agent-log .msg-user.pending"),
  }));

/** Waits until the agent's last answer is `text`, and its turn has ended. */
export const answered = (page: Page, text: string, ms = 10_000) =>
  until(
    async () => {
      const s = await state(page);
      return s.answers.at(-1) == text && !s.working;
    },
    ms,
    `the agent answers "${text}"`,
    () => state(page)
  );

/** Waits until the agent has more than `n` answers (the count before the message went), and its turn has ended. */
export const turnEnded = (page: Page, n: number, ms = 10_000) =>
  until(
    async () => {
      const s = await state(page);
      return s.answers.length > n && !s.working;
    },
    ms,
    "the agent's turn ends",
    () => state(page)
  );

/** The panel is open and the agent is on: its model shows. */
export const agentOn = (page: Page) =>
  until(
    () =>
      page.evaluate(
        () => document.body.classList.contains("agent-open") && document.getElementById("agent-model")!.textContent == "script (test model)"
      ),
    10_000,
    "the agent is on"
  );

/** Whether the agent's pane is open, and a person can use it. */
export const paneOpen = (page: Page) =>
  page.evaluate(() => document.body.classList.contains("agent-open") && !document.getElementById("agent")!.inert);

/** The turn's line as the panel shows it: its text and its buttons; null while it is hidden. */
export const turnLine = (page: Page) =>
  page.evaluate(() => {
    const t = document.getElementById("agent-turn")!;
    if (t.hidden) return null;
    const buttons = [...t.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => `[${b.textContent}]`);
    return [t.querySelector("span")!.textContent, ...buttons].join(" ");
  });

/** A button of the panel's head (agent-undo, agent-redo): "off", or its tip. */
export const button = (page: Page, id: string) =>
  page.evaluate((id) => {
    const b = document.getElementById(id)!;
    return b.getAttribute("aria-disabled") == "true" ? "off" : (b.dataset.tip ?? "");
  }, id);

type Content = { type: string; text?: string; data?: string; mimeType?: string };
/** A tool's answer: its status, its text (the error's, when it failed), its pictures and its content. */
export interface Answer {
  status: number;
  ok: boolean;
  text: string;
  images: string[];
  content: Content[];
}
type Args = Record<string, unknown>;

/** The tools as an outside agent calls them (POST /api/tools/<name>), with an agent token. */
export function toolsOf(root: string, token: string) {
  const call = async (name: string, args: Args = {}): Promise<Answer> => {
    const a = await runTool<Content[]>(root, name, args, { token });
    const content = Array.isArray(a.result) ? a.result : [];
    return {
      status: a.status,
      ok: a.ok,
      text: a.ok ? textOf(a.result) : (a.error ?? ""),
      images: content.filter((c) => c.type == "image").map((c) => c.data!),
      content,
    };
  };
  return {
    token,
    call,
    /** The tools on one document: `ok` gives a call's answer and fails unless it passed; `fails` gives the error's text. */
    on(document: string) {
      return {
        call: (name: string, args: Args = {}) => call(name, { document, ...args }),
        async ok(name: string, args: Args = {}) {
          const a = await call(name, { document, ...args });
          expect(a.ok, `${name}: ${a.text}`).toBe(true);
          return a;
        },
        async fails(name: string, args: Args = {}) {
          const a = await call(name, { document, ...args });
          expect(a.ok, `${name} must fail: ${a.text.slice(0, 200)}`).toBe(false);
          return a.text;
        },
      };
    },
    /** A tool's answer over MCP (POST /mcp, tools/call), with the same token. */
    async mcp(name: string, args: Args) {
      const r = await fetch(`${root}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      type Result = { content: { type: string; text?: string; resource?: { mimeType: string; blob: string } }[]; isError?: boolean };
      return ((await r.json()) as { result: Result }).result;
    },
    /** A new document of the token's person (create_document): its id and address. */
    async create(args: Args) {
      const a = await call("create_document", args);
      expect(a.ok, `create_document: ${a.text}`).toBe(true);
      return JSON.parse(a.text) as { id: string; address: string };
    },
  };
}
export type Tools = ReturnType<typeof toolsOf>;
export type DocTools = ReturnType<Tools["on"]>;

/** The page's edits, as document_api lists them: each API's name and its edits. */
export const apisOf = async (t: DocTools) =>
  (JSON.parse((await t.ok("document_api", { path: "index.html" })).text) as { apis: { api: string; edits: { name: string }[] }[] }).apis;

/**
 * A person signed in on the server (`login`): their requests (with their session cookie), their agent's turns, and
 * the tools with an agent token of theirs (`tools()`, made as Settings makes one).
 */
export async function person(server: Server, login: string) {
  const root = server.root;
  const r = await fetch(`${root}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in as ${login}: ${r.status}`);
  const get = (path: string, init: RequestInit = {}) =>
    fetch(root + path, {
      redirect: "manual",
      ...init,
      headers: { Cookie: cookie, Origin: root, ...(init.headers as Record<string, string>) },
    });
  const log = async () => ((await (await get("/api/agent/conversation")).json()) as { log: Log }).log;
  return {
    login: login.toLowerCase(),
    cookie,
    get,
    log,
    /** An operation as this person, as their pages run it (POST /api/tools/<name> with their cookie). */
    run: <T = any>(name: string, args: Args = {}) => runTool<T>(root, name, args, { cookie }),
    /** The tools with an agent token of theirs (`scope`: documents, or admin for an admin). */
    async tools(scope = "documents") {
      const made = await newToken(root, { label: "Agent tools test", scope }, cookie);
      if (!made.token) throw new Error(`no token for ${login}: ${made.error}`);
      return toolsOf(root, made.token);
    },
    /** A scripted turn of their agent, from the page of the document `doc` (its id); the turn's items, once it has ended. */
    async turn(doc: string, steps: object[], text = "Test") {
      const before = (await log()).items.length;
      const sent = await get("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: script(text, steps), doc }),
      });
      expect(sent.ok, `the agent takes the message (${sent.status})`).toBe(true);
      let now = await log();
      await until(
        async () => {
          now = await log();
          return !now.busy && now.items.length > before + 1;
        },
        10_000,
        `${login}'s agent ends its turn`,
        () => now
      );
      return now.items.slice(before);
    },
  };
}
export type Person = Awaited<ReturnType<typeof person>>;

export type Item = { kind: string; text?: string; name?: string; status?: string; detail?: string; image?: string };
interface Log {
  items: Item[];
  busy: boolean;
}

/** The first JSON value of a tool's answer (eval_in_page gives the value, a blank line, then its notes). */
export const valueOf = <T = unknown>(text: string): T => JSON.parse(text.split("\n\n")[0]);

/** The colour of one pixel of a picture (a PNG in base 64), decoded in the tab. */
export const pixel = (page: Page, png: string, x: number, y: number) =>
  page.evaluate(
    ({ png, x, y }) =>
      new Promise<number[]>((ok) => {
        const i = new Image();
        i.onload = () => {
          const c = document.createElement("canvas");
          c.width = i.width;
          c.height = i.height;
          const g = c.getContext("2d")!;
          g.drawImage(i, 0, 0);
          ok([...g.getImageData(x, y, 1, 1).data].slice(0, 3));
        };
        i.src = `data:image/png;base64,${png}`;
      }),
    { png, x, y }
  );
