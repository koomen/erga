// Helpers for the Authentication page's tests (/admin/auth; auth-apps.ts, worker/auth-settings.ts) on the
// production-staging pair (servers.pair, e2e/pair.ts).

import { expect, type Pair } from "../fixtures";
import { mint, signIn } from "./staging";

export { newApp, PROD_APP } from "../pair";

/** A POST of /admin/auth's form on `root`, as the admin (locally a request with no cookie is DEV_LOGIN's). */
export const form = (root: string, fields: Record<string, string>) => fetch(`${root}/admin/auth`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams(fields) });
/** A server's sign-in status, and the other's as it reports it. */
export const status = async (root: string) => (await (await fetch(`${root}/admin/auth/status`)).json()) as { here: any; other: any };

/** An admin tool on `root` with an admin token: what it answered. */
export async function tools(root: string) {
  const token = await mint(root, await signIn(root), "admin");
  const call = async (name: string, args: unknown = {}) => (await (await fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json()) as { ok: boolean; content?: { text: string }[]; error?: string };
  return { token, call };
}

/** The pair as it starts, whatever a test before left: production's own app and nothing waiting; staging with no app. */
export async function reset(p: Pair) {
  expect((await form(p.prod.root, { do: "discard", server: "here" })).ok).toBe(true);
  const t = await tools(p.prod.root);
  const r = await t.call("clear_sign_in_app", { server: "other", force: true });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect((await status(p.staging.root)).here.check.state).toBe("not_set_up");
}
