// The verify harness's journeys in real browsers, against the real Erga behind the gate (dev/verify.ts, erga.ts):
// Playwright's Chromium, Firefox and WebKit, headless, each with a new profile. The gate's sign-in is the only one:
// ada signs in at the test issuer's form, one time, and Erga hears her from the gate. Then, as a person does:
//
//   her list of documents   Erga runs the gate's hand-off early there, in a hidden frame (server/identity/caller.ts,
//                           handOff), where the documents are on another site
//   her three documents     each opens in the real editor (driven with the suite's own helpers, e2e/helpers/editor.ts,
//                           as deploy/aws/check.ts does), takes text typed with real keys, and the server has the text
//   bob                     in a second browser context: the document shared with him opens, another of ada's does not
//   a ticket again          the hand-off's ticket, in another context and in this one: refused
//   sign-out                by the account menu; then a document's frame does not open, and the shell asks for sign-in
//
// What a browser did is read from its own requests and answers (`watch`): each page request with its frame and its
// status ("hop": the gate's page that goes on by itself), every answer of 400 and more, every socket, and each request
// of a frame's own document: Erga's apart from those of the analytics script that Cloudflare adds to a zone's pages.
//
// Trap: Playwright's WebKit keeps no cookie that a frame on another site sets, so it can't end the hand-off (gate/core.ts
// names the first browsers that can). Where the documents are on another site, such a browser's frame must show the
// gate's page for it, each time, and ask nothing more: that is its pass (browsers.ts, UNSUPPORTED). The rows of an
// open document are not its rows. Chromium and Firefox must open the document.
// Trap: Firefox can still say a frame's last address (about:blank, a step of the hand-off) for a request of the
// document that has just come. Such a request must at least be to a document's host.

import { type Browser, type BrowserContext, type BrowserType, chromium, firefox, type Frame, type Page, webkit } from "playwright-core";
import { openEditor } from "../../e2e/helpers/editor";
import type { Tab } from "../../e2e/helpers/fixtures";
import { clickOn } from "../../e2e/helpers/press";
import type { Server } from "../../e2e/helpers/server";
import { BEACON, UNSUPPORTED, UNSUPPORTED_SAYS } from "./browsers.ts";
import { ergas, pageOf, person } from "./erga.ts";
import { ask } from "./http.ts";
import { otherSite, type Report, type Run, warmHost } from "./run.ts";

const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };

/** Waits until `ready` gives a value (asked each 100 ms); null after `limit`. */
async function wait<T>(ready: () => T | Promise<T>, limit: number): Promise<T | null> {
  const end = Date.now() + limit;
  for (;;) {
    const v = await Promise.resolve()
      .then(ready)
      .catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** A document's address has its pass in it: left out of what the rows say. */
const short = (url: string) => new URL(url).host + new URL(url).pathname.replace(/^\/t\/[^/]+/, "/t/…");

/** What a browser context does from now on: see the top. */
function watch(context: BrowserContext, run: Run) {
  const hosts = new Set(run.erga!.docs.map((d) => d.host));
  const warm = warmHost(run);
  const seen = {
    /** Each page request's answer: "<its frame> <status>[ hop] <address>". */
    pages: [] as string[],
    refused: [] as string[],
    /** The requests of a frame's own document that are Erga's, and those of them to another origin. */
    own: 0,
    away: new Set<string>(),
    /** The requests of Cloudflare's analytics script, by the page that it is in. */
    injected: new Set<string>(),
    sockets: [] as string[],
    /** Each request for Erga's service worker's script, by its host. */
    workers: [] as string[],
    /** The last address of the accept host, with its ticket. */
    accept: "",
    /** The page requests from `from` on, once no new one came for 1.5 s. */
    async settled(from: number) {
      let last = -1;
      let since = Date.now();
      await wait(() => {
        if (seen.pages.length != last) [last, since] = [seen.pages.length, Date.now()];
        return seen.pages.length > from && Date.now() - since > 1500;
      }, 10_000);
      return seen.pages.slice(from);
    },
  };
  // A frame is named by where its first page request goes: the hand-off's steps after that are in the same frame.
  const names = new WeakMap<Frame, string>();
  const named = (f: Frame, to: URL) => {
    if (!f.parentFrame()) return "tab";
    if (!names.has(f)) names.set(f, to.host == warm ? "warm frame" : hosts.has(to.host) ? "document frame" : "frame");
    return names.get(f)!;
  };
  context.on("response", (r) => {
    const q = r.request();
    // (Not Erga's own question after a socket that never opened, client/live/socket.ts: its answer is a 4xx by design.)
    if (r.status() >= 400 && !q.headers()["x-erga-check"]) seen.refused.push(`${r.status()} ${q.method()} ${short(r.url())}`);
    if (!q.isNavigationRequest()) return;
    const hop = r.headers()["content-security-policy"] == "default-src 'none'";
    seen.pages.push(`${named(q.frame(), new URL(r.url()))} ${r.status()}${hop ? " hop" : ""} ${short(r.url())}`);
  });
  context.on("request", (r) => {
    if (r.url().includes("/_edge/accept?")) seen.accept = r.url();
    if (new URL(r.url()).pathname == "/erga-sw.js") seen.workers.push(new URL(r.url()).host);
    try {
      const f = r.frame();
      if (!f.parentFrame() || r.isNavigationRequest()) return;
      const to = new URL(r.url());
      const from = f.url().startsWith("http") ? new URL(f.url()) : null;
      if (to.host == BEACON || to.pathname.startsWith("/cdn-cgi/"))
        return void seen.injected.add(`${from?.host ?? f.url()} asked ${to.host}${to.pathname.replace(/\/v[0-9a-f]{16,}$/, "")}`);
      seen.own++;
      const there = from && (hosts.has(from.host) || from.host == warm);
      if (there ? to.origin != from.origin : !hosts.has(to.host))
        seen.away.add(`${from ? short(f.url()) : f.url()} asked ${short(r.url())}`);
    } catch {
      // (A service worker's request has no frame.)
    }
  });
  context.on("page", (p) => p.on("websocket", (ws) => seen.sockets.push(new URL(ws.url()).host)));
  return seen;
}

/** Signs in as a person does: a page of the shell, the gate, the issuer's form, and back. */
async function signInAt(tab: Page, run: Run, who: string) {
  const list = `https://${run.shell}/documents`;
  await tab.goto(list);
  await tab.fill("input[name=who]", who);
  await tab.fill("input[name=pass]", run.idp.password);
  await Promise.all([tab.waitForURL(list), tab.click("#go")]);
}

/** Opens a document in the editor, in `tab`: the editor, or why it did not load and where the tab's frames are. */
async function edit(tab: Page, address: string) {
  const stand: Tab = { page: tab, errors: [], strict: false, own: () => Promise.reject(new Error("no server of its own")) };
  const at = { fixture: async () => ({ dir: "", address }) } as unknown as Server;
  return openEditor(stand, at, "", { allowErrors: true, timescale: 1 }).catch((e: Error) => {
    const frames = tab
      .frames()
      .slice(1)
      .map((f) => short(f.url()));
    return `${e.message.split("\n")[0]}; the tab's frames are at ${frames.join(", ") || "nothing"}`;
  });
}

async function one(name: string, run: Run, report: Report, browser: Browser): Promise<void> {
  const add = (check: string, ok: boolean | null, note = "") => report.add(check, ok, note, name);
  const shell = `https://${run.shell}`;
  const docs = run.erga!.docs;
  const handOff = otherSite(run);
  const view = { viewport: { width: 1100, height: 800 } };
  const context = await browser.newContext(view);
  add("The browser", true, `${name} ${browser.version()}`);
  const seen = watch(context, run);
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  const count = (re: RegExp, from = 0) => seen.pages.slice(from).filter((p) => re.test(p)).length;
  const of = (frame: string, from = 0) => seen.pages.slice(from).filter((p) => p.startsWith(`${frame} `));

  // --- sign-in, and the list of documents
  const t0 = Date.now();
  await signInAt(tab, run, "ada");
  const listed = await wait(async () => (await tab.innerText("body")).includes("Verify 1"), 10_000);
  add(
    "Sign-in at the issuer's form, one time; Erga's list shows ada's documents",
    count(/\/_edge\/callback$/) == 1 && !!listed,
    seen.pages.join(" > ")
  );
  if (handOff) {
    // The list's hidden frame: its steps end with an answer that is not the gate's page.
    const warm =
      (await wait(() => (/ hop /.test(of("warm frame").at(-1) ?? " hop ") ? null : of("warm frame")), 10_000)) ?? of("warm frame");
    const ms = Date.now() - t0;
    const step = (re: RegExp) => warm.find((s) => re.test(s)) ?? "not asked";
    add(
      "Early hand-off, in the list's hidden frame: the content's host sends the frame to the vouch",
      / 200 hop /.test(warm[0] ?? ""),
      warm[0] ?? "no hidden frame"
    );
    add(
      "Early hand-off: __Host-member (SameSite=None) comes with the vouch, in the frame",
      step(/_edge\/vouch/).includes(" 200 hop"),
      step(/_edge\/vouch/)
    );
    // A browser that keeps no cookie of the frame's: the accept answers the gate's page for it. Its rows end here.
    if (name != "chromium" && name != "firefox" && step(/_edge\/accept/).includes(" 400 ")) {
      const shows = async (address: string) => {
        const from = seen.pages.length;
        await tab.goto(`${shell}${address}?edit`);
        const steps = (await seen.settled(from)).filter((p) => p.startsWith("document frame "));
        const frame = tab.frames().find((f) => f.url().includes("/_edge/accept"));
        const says = frame ? await frame.innerText("body").catch(() => "") : "";
        return { steps, says: says.split("\n")[0] };
      };
      const first = await shows(docs[0].address);
      if (process.env.VERIFY_SHOTS) await tab.screenshot({ path: `${process.env.VERIFY_SHOTS}/unsupported-${run.n}-${name}.png` });
      const second = await shows(docs[1].address);
      const three = (steps: string[]) => steps.length == 3 && / 400 .*\/_edge\/accept$/.test(steps[2]);
      add(
        UNSUPPORTED,
        [first, second].every((v) => three(v.steps) && v.says == UNSUPPORTED_SAYS),
        [first, second].map((v) => `${v.steps.join(" > ") || "no page request"}: "${v.says}"`).join("; ")
      );
      await signOut();
      return;
    }
    add(
      "Early hand-off: the nonce (Partitioned, set in the frame) comes to the accept",
      step(/_edge\/accept/).includes(" 200 hop"),
      step(/_edge\/accept/)
    );
    add(
      "Early hand-off: the member cookie (Partitioned, set in the frame) comes back to the content's host",
      warm.length == 4 && warm[3].startsWith(`warm frame 200 ${warmHost(run)}`),
      `${warm.join(" > ")}; ${ms} ms from the sign-in's start`
    );
  }
  const signedIn = seen.pages.length;

  // --- the three documents
  const ada = await person(run, "ada");
  const visit = async (d: (typeof docs)[number]) => {
    const from = seen.pages.length;
    const t = Date.now();
    const ed = await edit(tab, shell + d.address);
    const ms = Date.now() - t;
    const steps = of("document frame", from);
    if (typeof ed == "string") return { loaded: false, said: ed, ms, steps, shown: false, saved: false, cookie: "", worker: "" };
    const cookie = await ed.frame<string>("document.cookie");
    const words = `Typed in ${name} at ${new Date().toISOString()}`;
    // A paragraph of its own, after the seed's one-line paragraph: a click at the end of longer text lands inside it.
    await ed.clickEnd("p:not(.erga-locked)");
    await ed.type(`\n${words}`);
    const shown = !!(await wait(async () => (await ed.visible()).includes(words), 5000));
    const saved = !!(await wait(async () => (await pageOf(run, ada, d.address)).includes(words), 15_000));
    // Same site: the page registers Erga's worker itself, some time after it loads (client/common/offline.ts): here, now.
    // Behind the gate on another site the page asks for none (pages-origin.ts, workerFor): what it has registered.
    const worker = await ed.frame<string>(
      handOff
        ? `navigator.serviceWorker.getRegistrations().then((all) => all.length ? "registered" : "none", (e) => String(e))`
        : `navigator.serviceWorker.register("/erga-sw.js").then(() => "registered", (e) => String(e))`
    );
    return { loaded: true, said: "", ms, steps, shown, saved, cookie, worker };
  };
  const first = await visit(docs[0]);
  add("The first document: the real editor loads, with its document's frame", first.loaded, first.loaded ? `${first.ms} ms` : first.said);
  add(
    "The first document opens with one page request in its frame (the hand-off ran before it)",
    first.steps.length == 1 && first.steps[0].startsWith(`document frame 200 ${docs[0].host}`),
    first.steps.join(" > ") || "no page request"
  );
  add(
    "The first document: text typed with real keys shows on the page, and the server has it",
    first.loaded ? first.shown && first.saved : null,
    first.loaded ? `shown: ${first.shown}; saved (read with a tool call): ${first.saved}` : "the editor did not load"
  );
  add(
    "A3: the document's script reads no cookie",
    first.loaded ? first.cookie == "" : null,
    first.loaded ? first.cookie || "document.cookie is empty" : ""
  );
  const later = [await visit(docs[1]), await visit(docs[2])];
  const again = count(/sign-in|\/authorize$/, signedIn);
  const all = [first, ...later];
  add(
    "Invariant 1: three documents open and take an edit after one sign-in, with no sign-in page again",
    all.every((v) => v.loaded && v.shown && v.saved) && again == 0,
    `${all.map((v) => (v.loaded ? `loaded, shown ${v.shown}, saved ${v.saved}` : v.said)).join("; ")}; ${again} page requests to a sign-in after the first`
  );
  add(
    "A later document opens with one page request in its frame",
    later.every((v) => v.loaded && v.steps.length == 1),
    later.map((v) => v.steps.join(" > ") || "no page request").join("; ")
  );
  add(
    "Speed: the first document, and a later one",
    all.every((v) => v.loaded) ? true : null,
    `${first.ms} ms; ${later.map((v) => v.ms).join(" and ")} ms`
  );
  if (handOff)
    add(
      "A document's page on another site, behind the gate, asks for no service worker (the gate would refuse its requests)",
      all.some((v) => v.loaded) ? all.every((v) => !v.loaded || v.worker == "none") && !seen.workers.some((h) => h != run.shell) : null,
      `registered: ${all.map((v) => v.worker || "-").join(", ")}; requests for the worker's script on a document's host: ${seen.workers.filter((h) => h != run.shell).length}`
    );
  else
    add(
      "The document's origin registers Erga's service worker (the page's offline copy)",
      first.loaded ? first.worker == "registered" : null,
      first.worker.replace(/https:\/\/[^/'\s]+/g, "<the document's host>")
    );

  // --- Invariant 4. A frame's page requests are the gate's (the hand-off); its document's own requests stay on its
  // origin, and a socket goes to the shell (the editor's) or to a document's host (the page's).
  const hosts = new Set(docs.map((d) => d.host));
  const lost = [...seen.away, ...seen.sockets.filter((h) => h != run.shell && !hosts.has(h)).map((h) => `a socket to ${h}`)];
  add(
    "Invariant 4: Erga's own requests in a document's frame go only to the frame's own origin",
    all.some((v) => v.loaded) ? seen.own > 0 && !lost.length : null,
    `${seen.own} requests in frames; sockets: ${seen.sockets.filter((h) => h == run.shell).length} to the shell, ${seen.sockets.filter((h) => hosts.has(h)).length} to documents' hosts${lost.length ? `; away: ${lost.join(", ")}` : ""}`
  );
  const beacons = [...seen.injected].filter((i) => i.includes(` asked ${BEACON}`));
  add(
    "Invariant 4: nothing that the platform adds to a frame's page asks another origin (Cloudflare's analytics script)",
    !beacons.length,
    [...seen.injected].join(", ") || "no request of an added script"
  );
  add(
    "No answer of 400 or more, and no script error",
    !seen.refused.length && !errors.length,
    [...seen.refused, ...errors].slice(0, 6).join("; ") || `${seen.pages.length} page requests`
  );

  // --- bob, in a second context
  const second = await browser.newContext(view);
  const seenBob = watch(second, run);
  const tabBob = await second.newPage();
  await signInAt(tabBob, run, "bob");
  const shared = await edit(tabBob, shell + docs[2].address);
  const text = typeof shared == "string" ? "" : await shared.visible();
  const other = await tabBob.goto(shell + docs[0].address);
  add(
    "bob, in a second browser context, opens the document shared with him in the editor; another of ada's does not open",
    text.includes("The seed wrote this") && !!other && other.status() >= 400,
    `${typeof shared == "string" ? shared : "the shared document's editor loaded"}; the other document: ${other?.status()}; ${seenBob.pages.filter((p) => !p.startsWith("tab ")).join(" > ")}`
  );
  await second.close();

  // --- the ticket, used again: in another browser context (no nonce), and in this one (its nonce is done)
  if (handOff) {
    const fresh = await browser.newContext();
    const replay = await (await fresh.newPage()).goto(seen.accept).catch(() => null);
    const held = (await fresh.cookies()).filter((c) => c.name == "member").length;
    await fresh.close();
    const twice = await (await context.newPage()).goto(seen.accept).catch(() => null);
    add(
      "A2: the ticket, used again in another browser context and in this one, is refused",
      !!seen.accept && replay?.status() == 400 && held == 0 && twice?.status() == 400,
      seen.accept ? `${replay?.status()} and ${twice?.status()}` : "the browser asked the accept host nothing"
    );
  }

  await signOut();
  if (process.env.VERIFY_TRAIL) console.log(seen.pages.map((p) => `  ${name}: ${p}`).join("\n"));

  /**
   * Sign-out, as a person does it. Before and after: a frame of a document's host, in a page of the shell's site (a
   * page that Playwright answers: the frame's request, and the cookies with it, are the browser's own). And a copy of
   * the shell cookie from before it.
   */
  async function signOut() {
    const framed = `https://frame.${run.shell}/`;
    await context.route(framed, (r) =>
      r.fulfill({ contentType: "text/html", body: `<!doctype html><iframe src="https://${docs[0].host}/erga-warm"></iframe>` })
    );
    const frameOf = async () => {
      const from = seen.pages.length;
      const p = await context.newPage();
      await p.goto(framed);
      const steps = (await seen.settled(from)).filter((s) => !s.startsWith("tab "));
      await p.close();
      return { steps, opened: steps.some((s) => s.startsWith(`document frame 200 ${docs[0].host}`)) };
    };
    const before = await frameOf();
    const copy = (await context.cookies(shell)).find((c) => c.name == "__Host-erga");
    const mark = seen.pages.length;
    await tab.goto(`${shell}/documents`);
    await clickOn(tab, "[data-erga-account] button");
    await clickOn(tab, `.erga-account-menu a[href="/auth/logout"]`);
    const asks = await wait(() => tab.url().startsWith(run.idp.url), 15_000);
    const out = seen.pages.slice(mark).filter((p) => /logout|sign-out/.test(p));
    const kept = (await context.cookies())
      .filter((c) => /^(__Host-erga|__Host-member|member)$/.test(c.name))
      .map((c) => `${c.name} at ${c.domain}`);
    add(
      "Sign-out by the account menu: the gate ends its cookies, on the content's site too, and the shell asks for sign-in",
      !!asks && !kept.length && (!handOff || !before.opened || out.some((p) => / 200 .*\/_edge\/sign-out$/.test(p))),
      `${out.join(" > ")}; the tab is at ${tab.url().split("?")[0]}; the gate's cookies left: ${kept.join(", ") || "none"}`
    );
    const after = await frameOf();
    add(
      "A7: after sign-out a document's frame does not open (before it, the same frame opened)",
      before.opened ? !after.opened : null,
      `before: ${before.steps.join(" > ")}; after: ${after.steps.join(" > ")}`
    );
    // The gate keeps no state: it takes the copy's signature for good until its end. Erga refuses it by its time (the
    // person signed out since). A request that is not a page gets the refusal only; a page gets a redirect to itself
    // that has the gate end the browser's cookies (server/identity/admit.ts, signedOut: CloudFront runs no response
    // function on an answer of 400 or more). Either way the ask stays inside.
    const cookie = copy ? `${copy.name}=${copy.value}` : "";
    const old = copy
      ? await ask(`${shell}/api/tools/whoami`, { body: "{}", headers: { "content-type": "application/json", origin: shell, cookie } })
      : null;
    const page = copy ? await ask(`${shell}/documents`, { dest: "document", headers: { cookie } }) : null;
    const ends = (a: typeof page) => !!a && a.set.some((l) => l.startsWith("__Host-erga=;") && l.includes("Max-Age=0"));
    add(
      "A copy of the shell cookie from before the sign-out names nobody: Erga refuses it, and a page has the gate end it",
      !!old &&
        !!page &&
        old.status == 401 &&
        ergas(old) &&
        !old.headers.has("x-erga-gate") &&
        page.status == 302 &&
        ends(page) &&
        !page.headers.has("x-erga-gate"),
      old && page
        ? `a request: ${old.status} from ${ergas(old) ? "Erga" : "the gate"}; a page: ${page.status}, the cookie ${ends(page) ? "ends" : "stays"}; Erga's ask (x-erga-gate) ${old.headers.has("x-erga-gate") || page.headers.has("x-erga-gate") ? "reached the browser" : "did not reach the browser"}`
        : "the browser had no shell cookie"
    );
  }
}

export async function journeys(run: Run, report: Report, names: string[]): Promise<void> {
  for (const name of names) {
    if (!(name in TYPES)) throw new Error(`The journeys run in chromium, firefox and webkit: no "${name}".`);
    const browser = await TYPES[name].launch({ headless: true });
    try {
      await one(name, run, report, browser);
    } catch (e) {
      report.add("The run", false, String(e).split("\n")[0], name);
    } finally {
      await browser.close();
    }
  }
}
