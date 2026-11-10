// view_page right after an edit. The server's browser holds the page still for the picture (hold), takes it, and lets
// the page go on (release). The page once loaded again between the two: the viewer's page followed the edit, as a
// person's open page does. The render tools were gone with the old page, and the call failed with "Cannot read
// properties of undefined (reading 'release')". Now the page in the server's browser does not follow changes, and a
// page that loads again for any other reason gets the tools again.

import { expect, test } from "bun:test";
import { renderTools } from "../cloudflare/render-tools.ts";
import { Directory } from "../server/directory/index.ts";
import { documentRoutes } from "../server/documents/index.ts";
import { respond } from "../server/http.ts";
import type { Platform, Session } from "../server/platform.ts";
import { memory } from "./helpers/memory-sql";

/** A page in a browser, as the render tools see it: `reload` loads it again, with nothing of Erga's in it. */
function fakePage() {
  const state = { tools: false, installs: 0, calls: [] as string[] };
  const run = async <T>(expression: string): Promise<T> => {
    const call = /__ergaRender;[^]*\["(\w+)"\]/.exec(expression)?.[1] ?? /__ergaRender\["(\w+)"\]/.exec(expression)?.[1];
    if (!call) {
      state.tools = true;
      state.installs++;
      return undefined as T;
    }
    const value = call == "hold" ? { at: 600 } : undefined;
    // An expression that reads the tool straight off the page, as the code did: the browser's own error for a field of
    // something that is not there.
    if (!/__ergaRender;/.test(expression)) {
      if (!state.tools) throw new TypeError(`Cannot read properties of undefined (reading '${call}')`);
      state.calls.push(call);
      return value as T;
    }
    if (!state.tools) return { gone: true } as T;
    state.calls.push(call);
    return { value } as T;
  };
  return { state, run, reload: () => void (state.tools = false) };
}

test("the page loads again between hold and release: release still works, on the page as it is now", async () => {
  const page = fakePage();
  const call = renderTools(page.run);
  expect(await call("hold", 600, null, false)).toEqual({ at: 600 } as never);
  page.reload();
  await call("release");
  expect([page.state.calls, page.state.installs]).toEqual([["hold", "release"], 2]);
});

test("the viewer's page in the server's browser does not follow the document's changes; a person's page does", async () => {
  const dir = new Directory(memory(), { admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "ada");
  const { doc } = await dir.add({ id: "racerace", owner: "ada", title: "Race", created: 1, expires: null });
  let session: Session = { login: "ada", name: "Ada" };
  const platform = {
    sessionOf: async () => session,
    directory: dir,
    secret: "secret-".repeat(6),
    dev: () => false,
    pagesDomain: () => "erga-pages.test",
    edge: { cache: null, background: (work: Promise<unknown>) => void work.catch(() => {}) },
    docs: { view: async () => ({ role: "owner", name: null, test: false, ver: "l1", file: "index.html", canonical: "", shares: 0 }) },
  } as unknown as Platform;
  const follows = async () =>
    (await (await respond(documentRoutes, new Request(`https://erga.test/ada/${doc.slug}`), platform)).text()).includes('name="erga-ver"');
  expect(await follows()).toBe(true);
  // The server's browser, for view_page (a view cookie's session).
  session = { login: "ada", name: "Ada", onlyDoc: doc.id, view: true };
  expect(await follows()).toBe(false);
});
