// The homepage's model (window.ergaLLM, client/inline/home-llm.ts): the homepage isn't in the viewer, so a signed-out
// visitor's call shows the sign-in dialog in the page itself, the viewer's own (client/common/sign-in-dialog.ts).
import { expect, servers, test } from "../../helpers/fixtures";
import { deployed, fresh, openHome, resetLanding } from "./home";
import type {} from "../../../client/common/page-llm";
import { signInState } from "../access/access";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

test("signed out, the homepage's ergaLLM.ask() gets sign_in and the page shows the sign-in dialog", async ({ tab }) => {
  const server = await servers.short();
  // (Signed out, the route answers sign_in before it reads page_llm.)
  await fresh(server);
  await deployed(server);
  const p = tab.page;
  await openHome(p, server.root);
  const code = await p.evaluate(() =>
    window.ergaLLM!.ask({ messages: [{ role: "user", content: "Hi" }] }).then(
      () => "answered",
      (e: Error & { code?: string }) => e.code
    )
  );
  expect(code).toBe("sign_in");
  await expect
    .poll(() => signInState(p))
    .toEqual({ hosts: 1, open: true, choices: [["Continue with GitHub", `/auth/github?next=${encodeURIComponent("/_home")}`]] });
  await p.keyboard.press("Escape");
  await expect.poll(async () => (await signInState(p)).open).toBe(false);
});
