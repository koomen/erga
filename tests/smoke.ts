// Opens real documents in the page editor, types into the first heading, and screenshots.
//   bun tests/smoke.ts <path> [name]
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { F, frameAt } from "./tab";
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, basename, dirname } from "path";
const target = process.argv[2];
const name = process.argv[3] ?? basename(target).replace(/\W+/g, "-");
const dir = mkdtempSync(join(tmpdir(), "erga-smoke-"));
const isFile = statSync(target).isFile();
cpSync(isFile ? dirname(target) : target, dir, { recursive: true });
const host = await startHost(isFile ? join(dir, basename(target)) : dir);
const browser = await Browser.launch();
const p = await browser.page();
await p.open(`${host.base}/`, { clear: false, width: 1200, height: 900 });
await Bun.sleep(800);
const units = await p.frame<number>(`${F}.querySelectorAll("[data-erga-id]").length`);
const locked = await p.frame<number>(`${F}.querySelectorAll(".erga-locked").length`);
const f = await frameAt(p);
const r = await p.frame<{x:number;y:number}|null>(`(() => { const el = ${F}.querySelector("h1[data-erga-id], h2[data-erga-id], p[data-erga-id]"); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return { x: ${f.x} + r.left + r.width * 0.98 + 2, y: ${f.y} + r.top + r.height / 2 }; })()`);
const before = await p.eval<string>("ergaPage.state.doc.toString()");
if (r) { await p.click(r.x, r.y); await p.type(" edited"); await Bun.sleep(200); }
const after = await p.eval<string>("ergaPage.state.doc.toString()");
console.log(`${name}: ${units} units, ${locked} locked, source changed: ${before != after}, errors: ${p.errors.length}`);
for (const e of p.errors) console.log("  ", e.split("\n")[0]);
await p.frame(`${F}.defaultView.scrollTo(0, 0)`);
await Bun.sleep(300);
mkdirSync(SHOTS, { recursive: true });
await p.screenshot(`${SHOTS}/smoke-${name}.png`);
console.log(`picture: ${SHOTS}/smoke-${name}.png`);
browser.close(); await host.dispose(); rmSync(dir, { recursive: true, force: true });
