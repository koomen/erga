// Screenshot of two people on one page (Bo's view of Ada's edits), written to a temp folder (cdp.ts, SHOTS).
//   bun tests/multi-shot.ts
import { Browser, ROOT, SHOTS } from "./cdp";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const port = 4500 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), "erga-shot-"));
cpSync(`${ROOT}tests/fixtures/page`, dir, { recursive: true });
const host = Bun.spawn(["bun", `${ROOT}open.ts`, dir, "--port", String(port), "--no-open"], { stdout: "ignore", stderr: "inherit" });
const browser = await Browser.launch();
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/doc`)).ok) break; } catch {} await Bun.sleep(100); }
  const F = `document.getElementById("frame").contentDocument`;
  const open = async (user: string) => { const p = await browser.page(); await p.open(`http://127.0.0.1:${port}/?user=${user}`, { clear: false, width: 1100, height: 700 }); await Bun.sleep(600); return p; };
  const ada = await open("Ada"), bo = await open("Bo");
  const clickEnd = async (p: typeof ada, sel: string) => {
    const r = await p.eval<{ x: number; y: number }>(`(() => { const r = ${F}.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const f = document.getElementById("frame").getBoundingClientRect(); return { x: f.left + r.right - 2, y: f.top + r.top + r.height / 2 }; })()`);
    await p.click(r.x, r.y);
    await Bun.sleep(80);
  };
  await bo.eval(`document.getElementById("btn-track").click()`);
  await clickEnd(ada, "p");
  await ada.type(" Edited together.");
  await Bun.sleep(300);
  await clickEnd(bo, "li:last-child");
  await bo.type(" (soon)");
  await clickEnd(ada, "h1");
  await Bun.sleep(400);
  await bo.eval(`document.body.classList.remove("chrome-hidden")`);
  await Bun.sleep(300);
  mkdirSync(SHOTS, { recursive: true });
  await bo.screenshot(`${SHOTS}/page-multi.png`);
  console.log(`picture: ${SHOTS}/page-multi.png`);
} finally {
  browser.close(); host.kill(); rmSync(dir, { recursive: true, force: true });
}
