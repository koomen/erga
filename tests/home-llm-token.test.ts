// The homepage's page token (server/home/llm-token.ts): good for its document, for an hour, signed with this server's
// secret; refused when it's old, for another document, signed elsewhere, changed, or missing.

import { expect, test } from "bun:test";
import { pageToken, PAGE_TOKEN_MS, tokenOk } from "../server/home/index.ts";

test("a page token is good for its document for an hour, and for nothing else", async () => {
  const t = 1_800_000_000_000;
  const token = await pageToken("secret", "home1234", t);
  expect(await tokenOk("secret", token, "home1234", t)).toBe(true);
  expect(await tokenOk("secret", token, "home1234", t + PAGE_TOKEN_MS - 1)).toBe(true);
  // Expired.
  expect(await tokenOk("secret", token, "home1234", t + PAGE_TOKEN_MS)).toBe(false);
  // Another document's.
  expect(await tokenOk("secret", token, "other123", t)).toBe(false);
  // Another server's.
  expect(await tokenOk("another", token, "home1234", t)).toBe(false);
  // Changed: a later expiry with the old signature.
  const [, sig] = /\.([^.]+)$/.exec(token)!;
  const later = Buffer.from(JSON.stringify({ v: { doc: "home1234" }, e: (t + 2 * PAGE_TOKEN_MS) / 1000 })).toString("base64url");
  expect(await tokenOk("secret", `${later}.${sig}`, "home1234", t + PAGE_TOKEN_MS)).toBe(false);
  // None.
  expect(await tokenOk("secret", undefined, "home1234", t)).toBe(false);
  expect(await tokenOk("secret", "", "home1234", t)).toBe(false);
});
