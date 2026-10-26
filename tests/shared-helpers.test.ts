// The small helpers every part shares: shared/html.ts, shared/bytes.ts, shared/time.ts, shared/http.ts.

import { expect, test } from "bun:test";
import { base64, base64url, fromBase64, fromBase64url, hex, randomToken, sha256, sha256Hex } from "../shared/bytes";
import { dateTag, esc, jsonInScript } from "../shared/html";
import { json } from "../shared/http";
import { plural, sleep, timeAgo } from "../shared/time";

test("esc escapes the five characters HTML gives a meaning, in text and in either quote", () => {
  expect(esc(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;");
  expect(esc("plain")).toBe("plain");
});

test("jsonInScript can't end its <script> element", () => {
  const s = jsonInScript({ html: "</script><script>alert(1)</script>" });
  expect(s).not.toContain("<");
  expect(JSON.parse(s)).toEqual({ html: "</script><script>alert(1)</script>" });
});

test("dateTag shows the UTC date, with the time in full for the reader's script", () => {
  const t = Date.UTC(2026, 9, 26, 23, 30);
  expect(dateTag(t)).toBe(`<time datetime="2026-10-26T23:30:00.000Z">2026-10-26</time>`);
  expect(dateTag(t, "day")).toBe(`<time class="day" datetime="2026-10-26T23:30:00.000Z">2026-10-26</time>`);
});

test("base64 and base64url go both ways, base64url with no padding, for any length", () => {
  const bytes = new Uint8Array([251, 255, 0, 62, 63]);
  expect(base64(bytes)).toBe("+/8APj8=");
  expect(base64url(bytes)).toBe("-_8APj8");
  expect([...fromBase64("+/8APj8=")]).toEqual([...bytes]);
  expect([...fromBase64url("-_8APj8")]).toEqual([...bytes]);
  expect(base64(bytes.buffer)).toBe("+/8APj8=");
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  expect([...fromBase64(base64(big))]).toEqual([...big]);
  expect(() => fromBase64("not base64!")).toThrow();
});

test("hex and sha256", async () => {
  expect(hex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hex(await sha256(new TextEncoder().encode("abc")))).toBe(await sha256Hex("abc"));
});

test("randomToken is base64url of n random bytes", () => {
  const t = randomToken(18);
  expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(randomToken(18)).not.toBe(t);
  expect(randomToken()).toHaveLength(43);
});

test("plural, sleep and timeAgo", async () => {
  expect(plural(1, "file")).toBe("1 file");
  expect(plural(3, "file")).toBe("3 files");
  expect(plural(2, "person", "people")).toBe("2 people");
  const t = Date.now();
  await sleep(5);
  expect(Date.now() - t).toBeGreaterThanOrEqual(4);
  const now = Date.UTC(2026, 9, 26, 12);
  expect(timeAgo(now - 10_000, now)).toBe("just now");
  expect(timeAgo(now - 5 * 60_000, now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-5, "minute"));
  expect(timeAgo(now - 86_400_000, now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-1, "day"));
});

test("json is never cached, and takes more headers", async () => {
  const r = json({ ok: true }, 201, { "X-A": "1" });
  expect(r.status).toBe(201);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("x-a")).toBe("1");
  expect(await r.json()).toEqual({ ok: true });
});
