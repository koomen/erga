// Erga has no sign-in field: people sign in with GitHub or Google. A field that only looks like one (a login to
// share with, a username to choose, a key pasted once) tells password managers to stay away, or 1Password offers
// to fill it. Each `<input>` in the markup whose name, id, placeholder or label names a login, a user, a key, a
// token, an email, a secret or a password, or whose type is password, carries all four attributes below.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const ATTRS = ['autocomplete="off"', "data-1p-ignore", 'data-lpignore="true"', "data-bwignore"];
const LOOKS_LIKE_SIGN_IN =
  /\b(?:name|id|placeholder|aria-label)="[^"]*\b(?:login|user(?:name)?|e-?mail|token|key|secret|password|handle)\b|\btype="password"/i;

function sources(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "client", "server", "libs"], { cwd: ROOT }).stdout.toString().trim().split("\n");
  return out.filter((f) => /\.(ts|html)$/.test(f));
}

test("each field that looks like a sign-in field tells password managers to ignore it", () => {
  const found: string[] = [];
  const wrong: string[] = [];
  for (const f of sources()) {
    for (const tag of readFileSync(resolve(ROOT, f), "utf8").match(/<input\b[^>]*>/g) ?? []) {
      // A value made in code (`${esc(e.key)}`) names no field, and a hidden input has no box to fill.
      const own = tag.replace(/\$\{[^}]*\}/g, "");
      if (/\btype="hidden"/.test(own) || !LOOKS_LIKE_SIGN_IN.test(own)) continue;
      found.push(f);
      const missing = ATTRS.filter((a) => !tag.includes(a));
      if (missing.length) wrong.push(`${f}: ${tag.slice(0, 80)}… has no ${missing.join(", ")}`);
    }
  }
  expect(wrong).toEqual([]);
  // The scan finds the fields it must: the share fields, the username step, the admin's fields, the keys.
  for (const f of [
    "client/editor.html",
    "server/pages/docs.ts",
    "server/identity/accounts.ts",
    "server/admin/users.ts",
    "server/admin/settings.ts",
    "server/admin/api-keys.ts",
    "server/admin/auth.ts",
    "client/agent/settings-dialog.ts",
  ])
    expect(found).toContain(f);
});
