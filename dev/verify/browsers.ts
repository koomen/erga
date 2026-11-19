// The verify harness's checks in real browsers (dev/verify.ts): Playwright's Chromium, Firefox and WebKit, headless,
// each with a new profile, against the deployed hosts. A person signs in at the test issuer's form, one time; then the
// "editor" (stub.ts) opens three documents in a frame, a document with a hostile script, the sign-out page, and a
// second person signs in. What the browser did is read from its own requests and answers (`trail`): the gate's
// answers have no x-stub header, the origin's have one ("*" in a trail).
//
// Safari itself runs through safaridriver (--browsers safari), which a person turns on one time
// (`safaridriver --enable`, and "Allow remote automation" in Safari's settings). Until then its row says "not run".
//
// A browser that keeps no cookie set in a frame on another site can't end the gate's hand-off (gate/core.ts names the
// first versions that can). Playwright's WebKit keeps none, and Safari keeps none before 26.2 on macOS 26.2. In a
// setting with the hand-off, such a browser's frame must show the gate's page for it, each time, and ask nothing more:
// that is its pass (UNSUPPORTED), and the rows of an open document are not its rows. Any other browser must open the
// document.

import { type BrowserContext, type BrowserType, chromium, firefox, type Page, webkit } from "playwright-core";
import { ORIGIN } from "./http.ts";
import { framesKeepCookies } from "./prereqs.ts";
import { docHost, otherSite, type Report, type Run, sh } from "./run.ts";

/** Access's own sign-out, on the shell's host (gate/core.ts, signOutAt). */
const ACCESS_OUT = "/cdn-cgi/access/logout";
const TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };
const LIMIT = 20_000;
/** Where Cloudflare's analytics script comes from. */
export const BEACON = "static.cloudflareinsights.com";
/** The check that an unsupported browser passes, and the words of the gate's page for it (gate/core.ts, unsupported). */
export const UNSUPPORTED = "An unsupported browser sees a clear page in the document's frame, each time, and the frame asks nothing more";
export const UNSUPPORTED_SAYS = "This browser can't open documents on this server";

interface Result {
  cookie: string;
  who: string;
  file: number;
  socket: string;
}
interface Hostile {
  cookie: string;
  read: number | string;
  send: string;
  tossed: string;
  after: number;
}

/** Waits until `ready` gives a value (asked each 50 ms); null after LIMIT. */
async function wait<T>(ready: () => T | Promise<T>, limit = LIMIT): Promise<T | null> {
  const end = Date.now() + limit;
  for (;;) {
    const v = await Promise.resolve(ready()).catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((done) => setTimeout(done, 50));
  }
}
const resultOf = <T>(tab: Page, limit = LIMIT) =>
  wait(() => tab.evaluate(() => (window as unknown as { result?: unknown }).result) as Promise<T | undefined>, limit);

async function one(name: string, run: Run, report: Report): Promise<void> {
  const add = (check: string, ok: boolean | null, note = "") => report.add(check, ok, note, name);
  const shell = `https://${run.shell}`;
  const sso = run.who != "oauth";
  const other = otherSite(run);
  const handOff = sso && other;
  const browser = await TYPES[name].launch({ headless: true });
  /** Every answer: its status ("*": the origin's), host and path. */
  const trail: string[] = [];
  /** Where the tab is, and what it shows: for a run that stops. */
  let at = async () => "";
  try {
    const context = await browser.newContext();
    add("The browser", true, `${name} ${browser.version()}`);
    /** Every request of a frame inside the tab. */
    const inFrame: { from: string; to: string; page: boolean }[] = [];
    let accept = "";
    const watch = (c: BrowserContext, into: string[]) =>
      c.on("response", (r) => {
        const u = new URL(r.url());
        // (Not Cloudflare's own addresses on each host: its analytics beacon. But Access's own sign-out.)
        if (!u.pathname.startsWith("/cdn-cgi/") || u.pathname == ACCESS_OUT)
          into.push(`${r.status()}${r.headers()["x-stub"] ? "*" : ""} ${u.host}${u.pathname}`);
      });
    watch(context, trail);
    context.on("request", (r) => {
      if (r.url().includes("/_edge/accept?")) accept = r.url();
      try {
        const f = r.frame();
        if (f.parentFrame()) inFrame.push({ from: f.url(), to: r.url(), page: r.isNavigationRequest() });
      } catch {}
    });
    const sockets: string[] = [];
    const tab = await context.newPage();
    at = async () =>
      `${tab.url().split("?")[0]}, which says "${(await tab.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 120)}"`;
    tab.on("websocket", (ws) => sockets.push(ws.url()));
    const count = (re: RegExp, from = 0) => trail.slice(from).filter((t) => re.test(t)).length;
    /** How many times the issuer showed its form: each one is a sign-in that a person makes. */
    const FORM = new RegExp(`^200 ${new URL(run.idp.url).host.replace(/\./g, "\\.")}/authorize$`);

    /** Signs in at the issuer's form, as a person does (through the gate's sign-in, or Access's). True: back on the shell, signed in. */
    const signIn = async (who: string) => {
      await tab.goto(sso ? `${shell}/` : `${shell}/auth/sign-in?next=/`);
      if (!sso) await tab.click("#go");
      await tab.fill("input[name=who]", who);
      await tab.fill("input[name=pass]", run.idp.password);
      await Promise.all([tab.waitForURL(`${shell}/`), tab.click("#go")]);
      return JSON.parse(await tab.innerText("body")).caller as { kind: string; sub: string; email?: string };
    };
    const pageSteps = (from: number) => trail.slice(from).filter((s) => / d\d\.|_edge/.test(s) && !/whoami|file|room/.test(s));
    /** Opens a document in the editor: the document's own account of itself, and the time it took. */
    const open = async (n: number, limit = LIMIT) => {
      const from = trail.length;
      const t = Date.now();
      await tab.goto(`${shell}/editor?doc=${n}`);
      const result = await resultOf<Result>(tab, limit);
      return { result, ms: Date.now() - t, steps: pageSteps(from), from };
    };
    /** What the document's frame shows. */
    const frameSays = () =>
      tab
        .frameLocator("#doc")
        .locator("body")
        .innerText({ timeout: 5000 })
        .catch(() => "");

    const ada = await signIn("ada");
    add(
      "Sign-in at the issuer, one time",
      ada.kind == "person" && (run.who == "access" ? ada.email == "ada@example.com" : ada.sub == "sub-ada") && count(FORM) == 1,
      JSON.stringify(ada)
    );
    add("A script on the shell reads no cookie", (await tab.evaluate(() => document.cookie)) == "", "");

    // The first document. With the hand-off, a browser that keeps no cookie of the frame's ends at the gate's page.
    const first = await open(1, handOff ? 6000 : LIMIT);
    const step = (re: RegExp) => first.steps.find((s) => re.test(s)) ?? "not asked";
    const unsupported = handOff && !first.result && (await frameSays()).includes(UNSUPPORTED_SAYS);
    if (handOff)
      add(
        "__Host-member (SameSite=None) comes with the vouch, in the frame",
        step(/_edge\/vouch/).startsWith("200 "),
        step(/_edge\/vouch/)
      );
    if (unsupported) {
      // The gate's page, after the hand-off's three steps; a second document the same; and then no request more.
      const second = await open(2, 3000);
      const again = (await frameSays()).includes(UNSUPPORTED_SAYS);
      const still = trail.length;
      const more = await wait(() => trail.length > still, 2000);
      const three = (steps: string[]) => steps.length == 3 && steps[2].startsWith("400 ") && steps[2].endsWith("/_edge/accept");
      add(
        UNSUPPORTED,
        name != "chromium" && name != "firefox" && three(first!.steps) && three(second.steps) && again && !more,
        `the first document: ${first!.steps.join(" > ")}; the second: ${second.steps.join(" > ")}; ${more ? "then more requests" : "then no request more"}`
      );
    } else if (first) {
      if (handOff) {
        add(
          "The nonce (Partitioned, set in the frame) comes to the accept",
          step(/_edge\/accept/).startsWith("200 "),
          step(/_edge\/accept/)
        );
        add(
          "The member cookie (Partitioned, set in the frame) comes to the document",
          (first.steps.at(-1) ?? "").startsWith(`200* ${docHost(run, 1)}`),
          first.steps.join(" > ")
        );
      }
      add(
        "The first document opens",
        !!first.result,
        first.result ? `${first.ms} ms, ${first.steps.length} page requests` : first.steps.join(" > ")
      );
      if (first.result) {
        const r = first.result;
        add("A3: the document's script reads no cookie", r.cookie == "", r.cookie || "document.cookie is empty");
        add(
          "A1: the document's own requests (a file, the room's socket) pass the gate",
          r.file == 200 && r.who == (sso ? "member" : "none") && r.socket == r.who,
          `caller ${r.who}; file ${r.file}; socket ${r.socket}`
        );
      }
      const later = [await open(2), await open(3)];
      add(
        "Invariant 1: three documents open after one sign-in, with no sign-in page again",
        !!first.result && later.every((l) => l.result) && count(FORM) == 1,
        `${count(FORM)} sign-in`
      );
      add(
        "A later document opens with one page request (no hand-off)",
        later.every((l) => l.result && l.steps.length == 1),
        later.map((l) => `${l.ms} ms, ${l.steps.length} page requests`).join("; ")
      );
      add(
        "Speed: the first document, and a later one",
        first.result && later[0].result ? true : null,
        `${first.ms} ms; ${later.map((l) => l.ms).join(" and ")} ms`
      );
      // The frame's requests: the gate's pages move it (the hand-off); the document's own go to its own origin.
      // (Firefox can give a frame no address yet for a request: then a request to a document's host counts as its own.)
      // The stub's own requests, apart from those of the analytics script that Cloudflare adds to a zone's pages
      // (which then posts to /cdn-cgi/rum on the page's own host).
      const originOf = (u: string) => (/^https?:/.test(u) ? new URL(u).origin : "");
      const added = (u: string) => new URL(u).host == BEACON || new URL(u).pathname.startsWith("/cdn-cgi/");
      const own = inFrame.filter((r) => !r.page && !added(r.to));
      const beacons = inFrame.filter((r) => !r.page && new URL(r.to).host == BEACON);
      const away = [
        ...own
          .filter((r) => originOf(r.to) != originOf(r.from) && !(originOf(r.from) == "" && /^https:\/\/d\d\./.test(r.to)))
          .map((r) => r.to),
        ...sockets.filter((s) => !s.startsWith(`wss://d`)),
      ];
      add(
        "Invariant 4: the document's requests and socket go to its own origin",
        own.length > 0 && !away.length,
        `${own.length} requests, ${sockets.length} sockets${away.length ? `; away: ${away.slice(0, 3).join(", ")}` : ""}`
      );
      add(
        "Invariant 4: nothing that the platform adds to a frame's page asks another origin (Cloudflare's analytics script)",
        !beacons.length,
        beacons.length
          ? `${beacons.length} requests to ${BEACON}, from a script that Cloudflare Web Analytics adds`
          : "no request of an added script"
      );

      // A document with a hostile script.
      const id = crypto.randomUUID();
      await tab.goto(`${shell}/editor?doc=1&page=hostile&id=${id}`);
      const h = await resultOf<Hostile>(tab);
      const seen = (await tab.evaluate(
        async (ids) => (await fetch("/_stub/seen", { method: "POST", body: JSON.stringify(ids) })).json(),
        [`${id}-read`, `${id}-send`]
      )) as Record<string, { caller: { kind: string } }>;
      const kinds = [`${id}-read`, `${id}-send`].map((k) => seen[k]?.caller.kind ?? "not seen");
      if (!h) add("A hostile document's script", false, "the page did not answer");
      else {
        add("A3: a hostile document's script reads no cookie", h.cookie == "", h.cookie);
        add(
          "A hostile document's script does not reach the shell as the person",
          other ? kinds.every((k) => k != "person") && h.read != 200 : null,
          `its read: ${h.read}; the origin heard: ${kinds.join(", ")}${other ? "" : " (same site: the browser sends the Lax shell cookie; Erga's own checks stop it)"}`
        );
        add(
          "A cookie of the member cookie's name, set by a script, changes nothing",
          h.after == 200,
          `set: ${h.tossed || "refused by the browser"}; the next request: ${h.after}`
        );
      }

      // The ticket, used again: in another browser context (no nonce), and in this one (its nonce is done).
      if (handOff) {
        const fresh = await browser.newContext();
        const replay = await (await fresh.newPage()).goto(accept).catch(() => null);
        const held = (await fresh.cookies()).filter((c) => c.name == "member").length;
        await fresh.close();
        const again = await (await context.newPage()).goto(accept).catch(() => null);
        add(
          "A2: the ticket, used again in another browser context and in this one, is refused",
          !!accept && replay?.status() == 400 && held == 0 && again?.status() == 400,
          `${replay?.status()} and ${again?.status()}`
        );
      }
    }

    // Sign-out: the page asks the gate, loads the content's sign-out frame, then a document.
    const mark = trail.length;
    await tab.goto(shell + ORIGIN.signOut);
    {
      const ended = await wait(
        async () => {
          if (await tab.evaluate(() => (window as unknown as { result?: unknown }).result)) return "the document opened";
          if (!sso) return null;
          // (No member cookie on the shell: the vouch sends the frame to sign in; behind Access, it answers 401.)
          return count(new RegExp(`^401 (${docHost(run, 1)}|${run.shell}/_edge/vouch)`), mark) || count(/\/authorize$/, mark)
            ? "refused"
            : null;
        },
        sso ? LIMIT : 4000
      );
      if (sso)
        add(
          "A7: after sign-out, the content's member cookie is gone: a document does not open",
          ended == "refused",
          `${ended}; ${trail
            .slice(mark)
            .filter((s) => / d1\.|_edge|authorize/.test(s))
            .join(" > ")}`
        );
      else add("OAuth: after sign-out a document still opens, as nobody", ended == "the document opened", String(ended));
    }
    // Behind Access the person's sign-in is Access's: sign-out ends it too. The sign-out page goes on by itself to
    // Access's own sign-out, as Erga's page does (stub.ts, ?on): after the gate's cookies, and after the content's frame.
    if (run.who == "access") {
      const from = trail.length;
      await tab.goto(`${shell}${ORIGIN.signOut}?on`).catch(() => null);
      const went = await wait(
        async () => (count(new RegExp(`${run.shell.replace(/\./g, "\\.")}${ACCESS_OUT}$`), from) ? "went" : null),
        LIMIT
      );
      const steps = trail.slice(from).filter((s) => /_edge\/sign-out$|signed-out$|access\/logout$/.test(s));
      const frame = steps.findIndex((s) => /_edge\/sign-out$/.test(s));
      const last = steps.findIndex((s) => s.endsWith(ACCESS_OUT));
      // (WebKit reports no answer for Access's own sign-out, though the browser goes there: seen 2026-11-19. Then the
      // proof is what follows: the shell asks for Access's sign-in again.)
      const again =
        went == "went"
          ? null
          : await tab.goto(`${shell}/`).then(
              () => tab.url().startsWith(run.idp.url),
              () => false
            );
      add(
        "Access: the sign-out page goes on to Access's own sign-out by itself, after the gate's sign-out and the content's frame",
        (went == "went" && last >= 0 && (!other || (frame >= 0 && frame < last))) || again === true,
        `${steps.join(" > ")}${again == null ? "" : `; then the shell ${again ? "asks for Access's sign-in again" : "does not ask for a sign-in"}`}`
      );
    }
    await tab.goto(`${shell}/`);
    const out = sso ? tab.url().startsWith(run.idp.url) : JSON.parse(await tab.innerText("body")).caller.kind == "none";
    add(
      run.who == "access"
        ? "After sign-out (the gate's, then Access's own, with no step of the suite's) the shell knows nobody"
        : "After sign-out the shell knows nobody",
      out,
      sso ? tab.url().split("?")[0] : ""
    );

    // A second member, in the same browser.
    const bob = await signIn("bob");
    const isBob = run.who == "access" ? bob.email == "bob@example.com" : bob.sub == "sub-bob";
    if (unsupported) add("A second person signs in", isBob, JSON.stringify(bob));
    else {
      // The accept's mark of the first hand-off (20 seconds) may still be there: until it ends, the gate
      // answers the frame its page, not a new hand-off.
      const since = Date.now();
      let fourth = await open(3, 3000);
      const refused = fourth.steps.join(" > ");
      while (!fourth.result && Date.now() - since < 40_000) fourth = await open(3, 3000);
      add(
        "A second person signs in and opens a document",
        isBob && !!fourth.result && (!handOff || fourth.steps.length == 4),
        `${JSON.stringify(bob)}; ${fourth.steps.length} page requests${refused == fourth.steps.join(" > ") ? "" : `; first ${refused}, then it opened after ${Math.round((Date.now() - since) / 1000)} s (the accept's 20 s mark)`}`
      );
    }
    if (process.env.VERIFY_TRAIL) console.log(trail.map((t) => `  ${name}: ${t}`).join("\n"));
  } catch (e) {
    add("The run", false, `${String(e).split("\n")[0]} The tab is at ${await at()}; its last answers: ${trail.slice(-4).join(" > ")}`);
  } finally {
    await browser.close();
  }
}

/**
 * Safari itself, through safaridriver (WebDriver): sign-in, three documents. It has no list of the browser's requests,
 * so it tells only whether each document opened, what the document said, and what its frame shows. Whether this Safari
 * can end the hand-off is its version's and the system's to say (prereqs.ts, framesKeepCookies): one that can't must
 * show the gate's page for it. It opens only the run's hosts, in a session of its own, which ends with the run.
 */
async function safari(run: Run, report: Report): Promise<void> {
  const add = (check: string, ok: boolean | null, note = "") => report.add(check, ok, note, "safari");
  const port = 4460 + Math.floor(Math.random() * 500);
  const driver = Bun.spawn(["safaridriver", "-p", String(port)], { stdout: "ignore", stderr: "ignore" });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const v = ((await r.json()) as { value: unknown }).value as Record<string, unknown> | null;
    if (!r.ok) throw new Error(String(v?.message ?? r.status));
    return v;
  };
  let session = "";
  try {
    await wait(() => fetch(`http://127.0.0.1:${port}/status`).then((r) => r.ok), 5000);
    const made = await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } }).catch((e) => String(e));
    if (typeof made == "string" || !made) return add("Safari", null, `safaridriver made no session: ${made}`);
    session = `/session/${made.sessionId}`;
    const version = String((made.capabilities as Record<string, unknown>).browserVersion);
    const system = sh(["sw_vers", "-productVersion"]).trim();
    const keeps = framesKeepCookies(version, system);
    add("The browser", true, `Safari ${version} on macOS ${system}${keeps ? "" : ": it keeps no cookie of a frame on another site"}`);
    const go = (url: string) => call("POST", `${session}/url`, { url });
    const js = <T>(script: string) => call("POST", `${session}/execute/sync`, { script, args: [] }) as Promise<T>;
    const element = async (css: string) =>
      Object.values((await call("POST", `${session}/element`, { using: "css selector", value: css }))!)[0] as string;
    const type = async (css: string, text: string) => call("POST", `${session}/element/${await element(css)}/value`, { text });
    /** What the document's frame shows (WebDriver reads a frame of another origin; a script of the tab can't). */
    const frameSays = async () => {
      const id = await element("#doc").catch(() => "");
      if (!id) return "";
      await call("POST", `${session}/frame`, { id: { "element-6066-11e4-a52e-4f735466cecf": id } });
      const text = await js<string>("return document.body ? document.body.innerText : ''").catch(() => "");
      await call("POST", `${session}/frame`, { id: null });
      return text;
    };
    const shell = `https://${run.shell}`;
    const sso = run.who != "oauth";
    const handOff = sso && otherSite(run);
    await go(sso ? `${shell}/` : `${shell}/auth/sign-in?next=/`);
    // (The page's own click on its link: safaridriver's click on a link gave an error with no words, in Safari 18.6.)
    if (!sso) await js("document.getElementById('go').click()");
    await wait(() => js<boolean>("return !!document.querySelector('input[name=who]')"));
    await type("input[name=who]", "ada");
    // (Enter sends the form. Trap: a click on its button did nothing in Safari 18.6 at times: Safari's own offer for a
    // password field takes the first click.)
    await type("input[name=pass]", `${run.idp.password}\uE007`);
    const who = await wait(() => js<string>(`return location.href == "${shell}/" ? document.body.innerText : ""`));
    const ada = who ? (JSON.parse(who).caller as { sub?: string; email?: string }) : null;
    add(
      "Sign-in at the issuer, one time",
      !!ada && (run.who == "access" ? ada.email == "ada@example.com" : ada.sub == "sub-ada"),
      who?.slice(0, 80) ??
        `not back on the shell: the tab is at ${(await js<string>("return location.href").catch(() => "?")).split("?")[0]}, which says "${(await js<string>("return document.body ? document.body.innerText.slice(0, 80) : ''").catch(() => "")).replace(/\s+/g, " ")}"`
    );
    add("A script on the shell reads no cookie", (await js<string>("return document.cookie")) == "", "");
    const open = async (n: number, limit = LIMIT) => {
      const t = Date.now();
      await go(`${shell}/editor?doc=${n}`);
      const result = await wait(() => js<Result | null>("return window.result || null"), limit);
      return { result, ms: Date.now() - t };
    };
    if (handOff && !keeps) {
      const says: string[] = [];
      for (const n of [1, 2]) {
        const { result } = await open(n, 4000);
        says.push(result ? "the document opened" : (await frameSays()).split("\n")[0] || "nothing");
      }
      add(
        UNSUPPORTED,
        says.every((s) => s == UNSUPPORTED_SAYS),
        `the first document's frame: "${says[0]}"; the second: "${says[1]}"`
      );
      return;
    }
    const docs = [await open(1), await open(2), await open(3)];
    const r = docs[0].result;
    add("The first document opens", !!r, r ? `${docs[0].ms} ms` : `the frame shows: "${(await frameSays()).split("\n")[0]}"`);
    if (r) add("A3: the document's script reads no cookie", r.cookie == "", r.cookie);
    if (r)
      add(
        "A1: the document's own requests (a file, the room's socket) pass the gate",
        r.file == 200 && r.who == (sso ? "member" : "none") && r.socket == r.who,
        `caller ${r.who}; file ${r.file}; socket ${r.socket}`
      );
    add(
      "Invariant 1: three documents open after one sign-in, with no sign-in page again",
      docs.every((d) => d.result),
      docs.map((d) => `${d.ms} ms`).join("; ")
    );
    add("Speed: the first document, and a later one", docs.every((d) => d.result) ? true : null, docs.map((d) => `${d.ms} ms`).join("; "));
  } catch (e) {
    add("The run", false, String(e).split("\n")[0]);
  } finally {
    if (session) await call("DELETE", session).catch(() => null);
    driver.kill();
  }
}

export async function browserChecks(run: Run, report: Report, names: string[]): Promise<void> {
  for (const name of names) {
    if (name in TYPES) await one(name, run, report);
    else if (name == "safari") await safari(run, report);
    else throw new Error(`No browser "${name}".`);
  }
}
