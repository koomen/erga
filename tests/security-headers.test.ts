// What every answer tells a browser about how it may use it (server/security.ts): HSTS over HTTPS, the site's own
// origin framed only by itself, its pages' policy; a document's own HTML keeps its policy; the pages origin names its
// viewer itself. e2e/full/security/headers.e2e.ts checks each kind of page on a running server.
import { expect, test } from "bun:test";
import { FRAME_POLICY, HSTS, PAGE_POLICY, withSecurity } from "../server/security.ts";

const html = (headers: Record<string, string> = {}) => new Response("<!doctype html><p>x</p>", { headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
const at = (u: string) => new URL(u);

test("a page of the site's own: no other site's frame, no plugins, no <base> elsewhere, and HTTPS only", async () => {
  const r = withSecurity(html(), at("https://erga.dev/docs"), "site");
  expect(r.headers.get("content-security-policy")).toBe(PAGE_POLICY);
  expect(PAGE_POLICY).toContain("frame-ancestors 'self'");
  expect(PAGE_POLICY).toContain("object-src 'none'");
  expect(PAGE_POLICY).toContain("base-uri 'self'");
  expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(r.headers.get("strict-transport-security")).toBe(HSTS);
  expect(HSTS).toBe("max-age=31536000; includeSubDomains");
  expect(await r.text()).toBe("<!doctype html><p>x</p>");
});

test("on this machine, no HSTS (it would hold localhost to HTTPS for a year)", () => {
  for (const u of ["http://localhost:4712/docs", "https://localhost:4712/docs", "http://127.0.0.1:4400/", "https://abcd1234-ada.localhost:4712/t/x/"]) {
    expect(withSecurity(html(), at(u), "site").headers.get("strict-transport-security"), u).toBeNull();
  }
});

test("anything else of the site's own (JSON, a file): the frame rule only", () => {
  const r = withSecurity(Response.json({ ok: true }), at("https://erga.dev/api/release"), "site");
  expect(r.headers.get("content-security-policy")).toBe(FRAME_POLICY);
  expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
});

test("a document's own HTML keeps its own policy: its sandbox, and the frame rule added; the homepage's, as it is", () => {
  const file = withSecurity(html({ "Content-Security-Policy": "sandbox" }), at("https://erga.dev/d/abcd1234/doc/index.html"), "site");
  expect(file.headers.get("content-security-policy")).toBe(`sandbox, ${FRAME_POLICY}`);
  const home = withSecurity(html({ "Content-Security-Policy": "frame-ancestors 'self'" }), at("https://erga.dev/"), "site");
  expect(home.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  expect(home.headers.get("x-frame-options")).toBe("SAMEORIGIN");
});

test("a document's page on its pages origin: its own frame rule (its viewer), nothing of the site's, and HTTPS only", () => {
  const r = withSecurity(html({ "Content-Security-Policy": "frame-ancestors https://erga.dev" }), at("https://abcd1234-ada.erga-pages.dev/t/x/index.html"), "pages");
  expect(r.headers.get("content-security-policy")).toBe("frame-ancestors https://erga.dev");
  expect(r.headers.get("x-frame-options")).toBeNull();
  expect(r.headers.get("strict-transport-security")).toBe(HSTS);
});

test("a WebSocket's answer goes as it is", () => {
  const ws = { status: 101, headers: new Headers() } as Response;
  expect(withSecurity(ws, at("https://erga.dev/d/abcd1234/room"), "site")).toBe(ws);
});

test("a cookie that one document's page set for every page (erga-pages.dev isn't on the Public Suffix List yet) never reaches the document", async () => {
  const { pagesDoor, pagesToken } = await import("../server/documents/pages-origin.ts");
  const token = await pagesToken("s", "ada", "abcd1234", "https://erga.dev");
  let seen: Request | null = null;
  const platform = {
    secret: "s",
    directory: { route: async () => ({ id: "abcd1234", owner: "ada", test: false }) },
    docs: { fetch: async (_: unknown, r: Request) => { seen = r; return new Response("x", { headers: { "Content-Type": "text/plain" } }); } },
  } as never;
  const url = new URL(`https://abcd1234-ada.erga-pages.dev/t/${token}/data.txt`);
  const r = await pagesDoor(new Request(url, { headers: { Cookie: "tossed=1" } }), url, { owner: "ada", id: "abcd1234" }, platform);
  expect(await r.text()).toBe("x");
  expect(seen!.headers.get("cookie")).toBeNull();
});
