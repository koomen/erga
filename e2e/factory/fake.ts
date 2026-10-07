// A board of fixture tasks for the board's own tests (tests/factory-cards.ts, factory-chime.ts): the page's
// /api/factory requests are answered by the test (Playwright routing), so no VM runs and the plain dev server
// does. Each test makes its own fake, so its tasks are its own to change.

import type { BrowserContext, Page, Route } from "playwright-core";

export type FakeTask = Record<string, any> & { id: number; title: string; status: string; log: { at: string; message: string }[] };

export const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const slug = (id: number, title: string) => `task/${id}-` + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A task as /api/factory/tasks gives it, `min` minutes after its last update, with `log` as its last line. Ids count from 1 in each list. */
export function tasks(...list: [title: string, status: string, min: number, log: string, extra?: Record<string, unknown>][]): FakeTask[] {
  return list.map(([title, status, min, log, extra], i) => {
    const id = i + 1;
    return { id, title, description: "The ask.", status, branch: slug(id, title), base: "0123456789abcdef", log: [{ at: ago(min), message: log }], screenshots: [],
      updatedAt: ago(min), createdAt: ago(min + 30), url: null, error: null, vm: status == "queued" ? null : "vm-" + id, startAfter: [], mergeAfter: [], ...extra };
  });
}

export interface Fake {
  tasks: FakeTask[];
  /** What /api/factory says. */
  info: Record<string, unknown>;
  /** The body of each reply to /events (the page reconnects after its `retry:`). */
  events: () => string;
  /** A POST to /tasks/<id>/<step>: the reply's body. */
  step?: (id: number, step: string) => unknown;
  /** /shots/<file>: the image. */
  shot?: (file: string) => Buffer;
  /** How many times each path was asked for. */
  asked: Record<string, number>;
}

export const INFO = { enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } };

export function fake(list: FakeTask[], opts: Partial<Omit<Fake, "tasks" | "asked">> = {}): Fake {
  return { tasks: list, info: INFO, events: () => "retry: 150\n\n", asked: {}, ...opts };
}

/** Answers `target`'s /api/factory requests from `f` (anything it doesn't know goes to the server). */
export async function serve(target: Page | BrowserContext, f: Fake) {
  await target.route((url) => url.pathname == "/api/factory" || url.pathname.startsWith("/api/factory/"), async (route: Route) => {
    const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/api\/factory/, "");
    f.asked[path] = (f.asked[path] ?? 0) + 1;
    const reply = (body: string | Buffer, contentType = "application/json") => route.fulfill({ status: 200, contentType, body }).catch(() => {});
    const step = /^\/tasks\/(\d+)\/(\w+)$/.exec(path);
    if (path == "/events") return reply(f.events(), "text/event-stream");
    if (path.startsWith("/shots/") && f.shot) return reply(f.shot(path.slice(7)), "image/png");
    if (path == "/tasks") return reply(JSON.stringify(f.tasks));
    if (path == "") return reply(JSON.stringify(f.info));
    if (step && req.method() == "POST" && f.step) return reply(JSON.stringify(f.step(Number(step[1]), step[2])));
    return route.continue().catch(() => {});
  });
}

/** A small page as a PNG, as a task's screenshot shows one. */
export async function picture(page: Page, html: string, size = { width: 480, height: 300 }): Promise<Buffer> {
  await page.setViewportSize(size);
  await page.setContent(`<body style="margin:0;padding:24px;font:32px sans-serif;${html}</body>`);
  return page.screenshot();
}
