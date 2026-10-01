// Opens real documents in the page editor, types into the first heading, and screenshots.
//   bun tests/smoke.ts <path> [name]
import { Browser, ROOT, SHOTS } from "./cdp";
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, basename, dirname } from "path";
const target = process.argv[2];
const name = process.argv[3] ?? basename(target).replace(/\W+/g, "-");
const port = 4700 + Math.floor(Math.random() * 200);
const dir = mkdtempSync(join(tmpdir(), "erga-smoke-"));
const isFile = statSync(target).isFile();
cpSync(isFile ? dirname(target) : target, dir, { recursive: true });
const host = Bun.spawn(["bun", `${ROOT}open.ts`, isFile ? join(dir, basename(target)) : dir, "--port", String(port), "--no-open"], { stdout: "pipe", stderr: "pipe" });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/doc`)).ok) break; } catch {} await Bun.sleep(100); }
const browser = await Browser.launch();
const p = await browser.page();
await p.open(`http://127.0.0.1:${port}/`, { clear: false, width: 1200, height: 900 });
await Bun.sleep(800);
const F = `document.getElementById("frame").contentDocument`;
const units = await p.eval<number>(`${F}.querySelectorAll("[data-erga-id]").length`);
const locked = await p.eval<number>(`${F}.querySelectorAll(".erga-locked").length`);
const r = await p.eval<{x:number;y:number}|null>(`(() => { const el = ${F}.querySelector("h1[data-erga-id], h2[data-erga-id], p[data-erga-id]"); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); const f = document.getElementById("frame").getBoundingClientRect(); return { x: f.left + r.left + r.width * 0.98 + 2, y: f.top + r.top + r.height / 2 }; })()`);
const before = await p.eval<string>("ergaPage.state.doc.toString()");
if (r) { await p.click(r.x, r.y); await p.type(" edited"); await Bun.sleep(200); }
const after = await p.eval<string>("ergaPage.state.doc.toString()");
console.log(`${name}: ${units} units, ${locked} locked, source changed: ${before != after}, errors: ${p.errors.length}`);
for (const e of p.errors) console.log("  ", e.split("\n")[0]);
await p.eval(`${F}.defaultView.scrollTo(0, 0)`);
await Bun.sleep(300);
mkdirSync(SHOTS, { recursive: true });
await p.screenshot(`${SHOTS}/smoke-${name}.png`);
console.log(`picture: ${SHOTS}/smoke-${name}.png`);
browser.close(); host.kill(); rmSync(dir, { recursive: true, force: true });
