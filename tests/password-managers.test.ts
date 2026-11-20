// Erga has no sign-in field: people sign in with GitHub or Google. So no password manager has anything to fill or to
// save here, and each field a person types in tells them to stay away: 1Password offered "Save in 1Password" on a
// document's Address, and to fill a login to share with. Each `<input>` for text (a title, an address, a search, a
// number, a login, a key) and each `<textarea>` in the app's own markup carries all four attributes below.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const ATTRS = ['autocomplete="off"', "data-1p-ignore", 'data-lpignore="true"', "data-bwignore"];
/** An input's types that take no typed text. */
const NO_TEXT = /\btype="(?:hidden|checkbox|radio|file|date)"/;

function sources(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "client", "server", "libs"], { cwd: ROOT }).stdout.toString().trim().split("\n");
  return out.filter((f) => /\.(ts|html)$/.test(f));
}

test("each field a person types in tells password managers to ignore it", () => {
  const found: string[] = [];
  const wrong: string[] = [];
  for (const f of sources()) {
    for (const tag of readFileSync(resolve(ROOT, f), "utf8").match(/<(?:input|textarea)\b[^>]*>/g) ?? []) {
      // (A pattern that finds an input in a page's source is no field. A box that nobody types in has nothing to fill.)
      if (tag.includes("\\") || NO_TEXT.test(tag) || /\breadonly\b/.test(tag)) continue;
      found.push(f);
      const missing = ATTRS.filter((a) => !tag.includes(a));
      if (missing.length) wrong.push(`${f}: ${tag.slice(0, 80)}… has no ${missing.join(", ")}`);
    }
  }
  expect(wrong).toEqual([]);
  // The scan finds the fields it must: the title and the address, the share fields, the quick search, the username
  // step, the admin's fields, the keys, the comment box and the agent's.
  for (const f of [
    "client/editor.html",
    "server/pages/documents.ts",
    "server/identity/accounts.ts",
    "server/admin/users.ts",
    "server/admin/settings.ts",
    "server/admin/agents.ts",
    "server/admin/auth.ts",
    "client/agent/settings-dialog.ts",
    "client/common/quick-search.ts",
    "client/common/comment-box.ts",
    "client/pages/page-head.ts",
    "server/admin/access.ts",
    "server/pages/agent.ts",
    "libs/text/ui/controls.ts",
  ])
    expect(found).toContain(f);
});
