// Every decision about who may pass is in gate/ (gate/core.ts says which file holds what). This test keeps it so: no
// other code of the app or its deploy names one of the gate's paths, the header of Cloudflare Access's proof, or the
// headers that the gate alone writes. Such code takes them from gate/core.ts, by name: a list of open paths, or a
// check of a proof, has one place to be.
//
// When this fails: move the check into gate/, or import the gate's constant (SIGN_IN, CALLBACK, RESOURCE, PATTERNS,
// ACCESS_OPEN, FRONT, CALLER) in place of the text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import { ACCESS_OPEN, CALLER, FRONT, PATTERNS } from "../gate/core.ts";

const ROOT = resolve(import.meta.dir, "..");
/** The app and its deploy. (dev/, tests/ and e2e/ check the gate from outside, by its addresses.) */
const FOLDERS = ["server", "cloudflare", "deploy", "agents", "document", "client", "shared", "libs"];
/** The gate's own: its paths, Access's proof (its header and its cookie), and the gate's two headers to Erga. */
const OWN = ["/_edge/", ...PATTERNS.forms, "/.well-known/oauth-", "cf-access-jwt-assertion", "CF_Authorization", FRONT, CALLER];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name == "node_modules" ? [] : files(p);
    return /\.(ts|js|json|jsonc)$/.test(name) ? [p] : [];
  });
}

test("no code outside gate/ names a path of the gate's, Access's proof, or a header that the gate alone writes", () => {
  const found: string[] = [];
  for (const file of FOLDERS.flatMap((f) => files(join(ROOT, f))))
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // (A comment may name them: it tells a reader where to look.)
        if (/^\s*(\/\/|\/?\*)/.test(line)) return;
        for (const text of OWN)
          if (line.toLowerCase().includes(text.toLowerCase())) found.push(`${relative(ROOT, file)}:${i + 1}: ${text}`);
      });
  expect(found).toEqual([]);
});

test("the gate's lists are whole: each path that Access must let through is one that the gate answers by its own values", () => {
  // The agents' paths with a form, and the two fixed documents, are open with no proof; so is the vouch (its proof
  // is the member cookie) and /mcp (its proof is the agent's token). A new path of the gate's that carries no Access
  // proof goes into ACCESS_OPEN, or Access stops it: tests/gate-mounts.test.ts asks each one behind Access.
  for (const path of PATTERNS.forms) expect(ACCESS_OPEN).toContain(path);
  expect(ACCESS_OPEN.filter((p) => p.startsWith("/.well-known/oauth-")).length).toBe(2);
  expect(ACCESS_OPEN).toContain("/_edge/vouch");
  expect(ACCESS_OPEN).toContain("/mcp");
});
