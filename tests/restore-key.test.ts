// The document's page reads what the editor kept for a reload before any of the editor's code
// has loaded, so it names the place in sessionStorage itself: the same as restore.ts's.
import { expect, test } from "bun:test";
import { RESTORE_KEY as front } from "../server/routes";
import { RESTORE_KEY } from "../client/restore";

test("the document's page reads the editor's kept state where restore.ts keeps it", () => {
  expect(front).toBe(RESTORE_KEY);
});
