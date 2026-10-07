// A task, start to ready to merge (tests/factory.ts, 2).
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

// A simulated VM does the whole task.
const ONE_TASK = { timeout: TASK_MS + 15_000 };

test("a task added on the board shows its card, and moves to Ready to merge by itself, with its thumbnail", ONE_TASK, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.getElementById("new")`), 15_000, "a New task button");
  const id = await f.nextId();
  await b.click("#new");
  await b.fill("#t-title", "Say hello on the front page");
  await b.fill("#t-desc", "Put a short hello under the front page's heading.");
  await b.click("#create");
  await expect.poll(async () => (await b.column("queued")) + (await b.column("working"))).toContain("Say hello");
  await f.until(id, "complete");
  await expect.poll(() => b.column("ready-to-merge")).toContain("Say hello");
  await expect.poll(() => b.eval<boolean>(`(() => { const ims = [...document.querySelectorAll('[data-open="${id}"] .thumbs img')]; return ims.length > 0 && ims.every((i) => i.complete && i.naturalWidth > 0); })()`)).toBe(true);
  expect((await f.task(id)).branch).toBe(`task/${id}-say-hello-on-the-front-page`);
});

test("a finished task: its branch pushed from staging, a screenshot that is served, a summary, a preview with the change, and Claude Code given the factory_model setting", ONE_TASK, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const id = await f.make("Say hello again", "Put a short hello under the front page's heading.");
  await f.until(id, "complete");
  const t = await f.task(id);
  expect(t.branch).toBe(`task/${id}-say-hello-again`);
  expect(t.screenshots.length).toBe(1);
  expect(t.summary).toContain("note on the front page");
  expect(t.url).toBeTruthy();
  const b = f.branches();
  expect(b[t.branch]).toBe(t.commit);
  expect(t.base).toBe(b.staging);
  expect(await (await fetch(t.url.replace("//localhost:", "//127.0.0.1:"))).text()).toContain(`Made by the factory, task #${id}`);
  const shot = await fetch(`${s.root}/api/factory/shots/${t.screenshots[0].file}`);
  expect(shot.ok && shot.headers.get("content-type") == "image/png").toBe(true);
  expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(5000);
  expect(t.log.some((l) => l.message.includes("--model opus"))).toBe(true);
});
