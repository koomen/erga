// Helpers for the tests of the settings a deploy fixes (server.config.ts,
// ERGA_SERVER_CONFIG) and the admin page's settings (admin.ts): /admin in the
// tab, signed in as the dev server's DEV_LOGIN (an admin).

import type { Page } from "playwright-core";
import { until, type Server } from "../fixtures";

/** /admin in `page`, once a setting's row is there; `at(key, expr)` evaluates `expr` with `li` its row. */
export async function adminPage(page: Page, server: Server) {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${server.root}/auth/github?next=/admin`);
  await until(() => page.evaluate(() => location.pathname == "/admin" && !!document.querySelector('li.setting[data-key="delete_docs_after_hours"]')), 5_000, "the admin page opens");
  const at = <T = unknown>(key: string, expr: string) => page.evaluate(`(() => { const li = document.querySelector('li.setting[data-key="${key}"]'); return ${expr}; })()`) as Promise<T>;
  /** POST /admin/settings from the page (its origin, its cookie). */
  const setting = (body: Record<string, string>) => page.evaluate((body) => fetch("/admin/settings", { method: "POST", body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: await r.text() })), body);
  return { page, at, setting };
}

/** Someone signed in on `server` who isn't an admin (a login of their own): their session cookie. */
export async function plainCookie(server: Server, prefix = "plain") {
  const r = await fetch(`${server.root}/auth/github?as=${prefix}${crypto.randomUUID().slice(0, 8)}&next=/docs`, { redirect: "manual" });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c))!;
}
