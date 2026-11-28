#!/usr/bin/env bun
// Deterministic architecture demo verifier CLI (Layers 1-5):
//
//   bun run verify-demo demos/chat-native-bridge.spec.ts
//   bun run verify-demo demos/chat-native-bridge.spec.ts --html path/to/index.html
//   bun run verify-demo demos/chat-native-bridge.spec.ts --no-trace --json
//
// Runs L1 Static Grounding, L2 Executable Oracles (gate(), bridge-schema.ts, *Step()),
// L3 Lifecycle Typestate across all toggle combos, L4 Real Execution Traces, and
// optionally L5 Playwright DOM/Scrubber verification at desktop (1058px) and phone (390px)
// in both light and dark color schemes.

import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { encodeLedger, type DemoSpec, type VerificationIssue, type VerificationLedger } from "../shared/demo-spec.ts";
import { verifyDemoSpec } from "./verify-demo-core.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
};

export interface DomAuditResult {
  readonly issues: readonly VerificationIssue[];
  readonly measuredDurs: Record<string, Record<string, number>>;
}

/** Layer 5: verifies rendered HTML + shadow DOM in headless Chromium at desktop & phone in light & dark mode. */
export async function verifyDemoDom(htmlPath: string): Promise<DomAuditResult> {
  const abs = resolve(htmlPath);
  const rootDir = dirname(abs);
  const fileName = abs.slice(rootDir.length + 1);
  const issues: VerificationIssue[] = [];
  const measuredDurs: Record<string, Record<string, number>> = {};

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      let p = join(rootDir, decodeURIComponent(u.pathname));
      if (existsSync(join(p, "index.html"))) p = join(p, "index.html");
      if (!existsSync(p)) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(p), { headers: { "Content-Type": MIME[extname(p)] || "application/octet-stream" } });
    },
  });

  const browser = await chromium.launch();
  try {
    const url = `http://127.0.0.1:${server.port}/${fileName}`;
    const views: readonly { name: string; width: number; height: number; scheme: "light" | "dark" }[] = [
      { name: "desktop-light", width: 1058, height: 920, scheme: "light" },
      { name: "desktop-dark", width: 1058, height: 920, scheme: "dark" },
      { name: "phone-light", width: 390, height: 844, scheme: "light" },
      { name: "phone-dark", width: 390, height: 844, scheme: "dark" },
    ];

    for (const v of views) {
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: v.scheme });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() == "error") errors.push(`console.error: ${m.text()}`);
      });

      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page
        .waitForFunction(
          () => {
            const d = document.getElementById("demo");
            return Boolean(d?.shadowRoot?.querySelector(".node"));
          },
          null,
          { timeout: 6000 }
        )
        .catch(() => {
          issues.push({
            layer: "L5",
            code: "DEMO_NOT_MOUNTED",
            where: v.name,
            message: errors.length ? errors.join("; ") : "#demo did not render any .node inside shadowRoot within 6 s",
          });
        });

      const res = await page.evaluate(() => {
        const host = document.getElementById("demo");
        const sr = host?.shadowRoot;
        if (!sr) return { missingRoot: true, overlaps: [], clipped: [], badSpots: [], durs: null };

        const cards = [...sr.querySelectorAll(".node")] as HTMLElement[];
        const rects = cards
          .filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              n: el.dataset.n || el.className,
              l: Math.round(r.left),
              t: Math.round(r.top),
              r: Math.round(r.right),
              b: Math.round(r.bottom),
              overflow: el.scrollHeight - el.clientHeight,
            };
          });

        const overlaps: string[] = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i],
              b = rects[j];
            if (a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1) {
              overlaps.push(`${a.n} overlaps ${b.n}`);
            }
          }
        }
        const clipped = rects.filter((x) => x.overflow > 4).map((x) => `${x.n} (+${x.overflow}px)`);

        // Collect chips across default mode and alternate deploy toggle (e.g. AWS-only key-GATE_KEY)
        const seenChips = new Set<string>([...sr.querySelectorAll("[data-c]")].map((el) => (el as HTMLElement).dataset.c!));
        const depBtns = [...sr.querySelectorAll("[data-dep]")] as HTMLButtonElement[];
        for (const btn of depBtns) {
          if (btn.getAttribute("aria-pressed") != "true") {
            btn.click();
            for (const el of sr.querySelectorAll("[data-c]")) seenChips.add((el as HTMLElement).dataset.c!);
          }
        }

        const badSpots: string[] = [];
        for (const row of document.querySelectorAll("tr[data-spot]")) {
          const ids = (row as HTMLElement).dataset.spot!.split(/\s+/).filter(Boolean);
          const anyFound = ids.some((id) => seenChips.has(id));
          if (!anyFound) badSpots.push(ids.join(" "));
        }

        const api = (window as unknown as { __ergaDemoApi?: { durs?: () => Record<string, number> } }).__ergaDemoApi;
        return { missingRoot: false, overlaps, clipped, badSpots, durs: api?.durs?.() ?? null };
      });

      if (res.durs) measuredDurs[v.name] = res.durs;
      for (const e of errors) issues.push({ layer: "L5", code: "CONSOLE_ERROR", where: v.name, message: e });
      if (res.missingRoot) issues.push({ layer: "L5", code: "MISSING_SHADOW_ROOT", where: v.name, message: "#demo has no shadowRoot" });
      for (const o of res.overlaps) issues.push({ layer: "L5", code: "NODE_OVERLAP", where: v.name, message: o });
      for (const c of res.clipped) issues.push({ layer: "L5", code: "NODE_CLIPPED", where: v.name, message: c });
      for (const s of res.badSpots) {
        issues.push({ layer: "L5", code: "BROKEN_DATA_SPOT", where: v.name, message: `tr[data-spot="${s}"] matched 0 chips` });
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
  }

  return { issues, measuredDurs };
}

function printSummary(ledger: VerificationLedger, domChecked: boolean): void {
  const status = ledger.ok ? "PASS" : "FAIL";
  const parts = [
    `${ledger.combosChecked} combos`,
    `${ledger.hopsChecked} hops`,
    `${ledger.gateChecks} gate()`,
    `${ledger.frameChecks} frames`,
    `${ledger.machineChecks} machines`,
    `${ledger.tracesChecked} traces`,
    ...(domChecked ? ["DOM 4 views"] : []),
    `${ledger.elidedCount} elided`,
    `${ledger.plannedCount} planned`,
  ];
  console.log(`${status}  ${ledger.id} [${ledger.status}] · ${parts.join(" · ")}`);
  if (ledger.plannedItems.length) {
    console.log(`  planned (${ledger.plannedItems.length}): ${ledger.plannedItems.join(", ")}`);
  }
  for (const iss of ledger.issues) {
    console.log(`  FAIL [${iss.layer} ${iss.code}] ${iss.where}: ${iss.message}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const specArg = args.find((a) => !a.startsWith("-"));
  if (!specArg) {
    console.error("Usage: bun run verify-demo <spec.ts> [--html <index.html>] [--no-trace] [--json]");
    process.exit(2);
  }
  const htmlIdx = args.indexOf("--html");
  const htmlPath = htmlIdx >= 0 ? args[htmlIdx + 1] : undefined;
  const runTrace = !args.includes("--no-trace");
  const asJson = args.includes("--json");

  const mod = (await import(resolve(specArg))) as { default?: DemoSpec };
  if (!mod.default) {
    console.error(`Spec file "${specArg}" must default-export a DemoSpec.`);
    process.exit(2);
  }

  let ledger = await verifyDemoSpec(mod.default, { trace: runTrace });
  if (htmlPath) {
    const dom = await verifyDemoDom(htmlPath);
    const issues = [...ledger.issues, ...dom.issues];
    ledger = { ...ledger, ok: issues.length == 0, issues };
  }

  if (asJson) console.log(encodeLedger(ledger));
  else printSummary(ledger, Boolean(htmlPath));
  process.exit(ledger.ok ? 0 : 1);
}
