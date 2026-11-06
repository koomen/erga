// The question celld's Caddy asks before it gets a certificate for a new name (deploy/celld/cdn.ts): only a document's
// own pages origin, of a document that exists, gets one (server/documents/pages-origin.ts, isDocumentsHost).
import { expect, test } from "bun:test";
import { isDocumentsHost } from "../server/documents/index.ts";
import type { Platform } from "../server/platform.ts";

const directory = { route: async (id: string) => (id == "abcd1234" ? { id, owner: "ada" } : null) };
const own = { pagesDomain: () => "pages.test", pagesShared: () => null, directory } as unknown as Platform;
const shared = { pagesDomain: () => "localhost", pagesShared: () => "pages.test", directory } as unknown as Platform;
const asks = (host: string, p = own) => isDocumentsHost(new URL(`https://${host}/erga-host`), p);

test("a certificate only for the pages origin of a document that exists, under its owner", async () => {
  expect(await asks("abcd1234-ada.pages.test")).toBe(true);
  expect(await asks("abcd1234-bob.pages.test"), "another owner").toBe(false);
  expect(await asks("zzzz9999-ada.pages.test"), "no such document").toBe(false);
  expect(await asks("pages.test"), "the pages domain itself").toBe(false);
  expect(await asks("abcd1234-ada.other.test"), "another domain").toBe(false);
  expect(await asks("pages.test", shared), "a shared pages host").toBe(false);
});
