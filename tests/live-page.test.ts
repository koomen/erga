// The live page's logs (shared/live-page.ts): the console collapses identical
// messages and filters by level, pattern and time; the network log reads
// Resource Timing and Erga's Server-Timing and adds what the page's fetch saw;
// and the document's files go out with the right content type and byte ranges.

import { expect, test } from "bun:test";
import { ConsoleLog, describeConsole, describeNetwork, fromTiming, mergeHooked, parseSince, queryConsole, queryEvents, queryNetwork, type EventEntry } from "../shared/live-page";
import { byteRange } from "../document/blobs";
import { docFile, mimeOf } from "../document/host";

test("the console collapses identical messages into one entry, with a count and the first and last time", () => {
  const log = new ConsoleLog();
  for (let i = 0; i < 49_000; i++) log.add("warn", "AudioContext was not allowed to start", "page", 1000 + i);
  for (let i = 0; i < 49_000; i++) log.add("warn", "The play() request was interrupted", "page", 2000 + i);
  log.add("warn", "AudioContext was not allowed to start", "editor", 5000);
  log.add("error", "AudioContext was not allowed to start", "page", 6000);
  const all = log.entries();
  expect(all.length).toBe(4);
  expect(log.total).toBe(98_002);
  const first = all.find((e) => e.source == "page" && e.level == "warn" && e.text.startsWith("AudioContext"))!;
  expect(first).toMatchObject({ count: 49_000, first: 1000, last: 49_999 });
  // The most recently seen last.
  expect(all.at(-1)!.level).toBe("error");
  expect(describeConsole({ ...queryConsole(all, {}), total: log.total, dropped: 0 })).toMatch(/\[×49000, .*\] warn \(page\): The play\(\) request was interrupted/);
});

test("the console keeps its newest distinct messages, and counts the ones it dropped", () => {
  const log = new ConsoleLog(3);
  for (const t of ["a", "b", "c", "d"]) log.add("log", t, "page", 0);
  log.add("log", "b", "page", 1);
  expect(log.entries().map((e) => e.text)).toEqual(["c", "d", "b"]);
  expect(log.dropped).toBe(1);
  log.add("log", "x".repeat(5000), "page", 2);
  expect(log.entries().at(-1)!.text.length).toBeLessThan(2100);
});

test("the console filters by level, by pattern (a regular expression, or plain text when it isn't one) and by since", () => {
  const log = new ConsoleLog();
  log.add("error", "Uncaught TypeError: x is undefined", "page", 100);
  log.add("warn", "Deprecated API", "editor", 200);
  log.add("log", "loaded track.m4a", "page frame player.html", 300);
  log.add("debug", "tick", "page", 400);
  const all = log.entries();
  expect(queryConsole(all, { levels: ["error", "warn"] }).entries.map((e) => e.level)).toEqual(["error", "warn"]);
  expect(queryConsole(all, { pattern: "\\.m4a$" }).entries.map((e) => e.text)).toEqual(["loaded track.m4a"]);
  expect(queryConsole(all, { pattern: "x is (" }).entries.length).toBe(0); // not a regular expression: plain text
  expect(queryConsole(all, { pattern: "TYPEERROR" }).entries.length).toBe(1);
  expect(queryConsole(all, { pattern: "player" }).entries.length).toBe(1); // the source counts too
  expect(queryConsole(all, { since: 250 }).entries.map((e) => e.text)).toEqual(["loaded track.m4a", "tick"]);
  const r = queryConsole(all, { limit: 2 });
  expect(r).toMatchObject({ matched: 4 });
  expect(r.entries.map((e) => e.text)).toEqual(["loaded track.m4a", "tick"]);
});

test("since reads an ISO time, ms since the epoch, or how long ago", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  expect(parseSince("30s", now)).toBe(now - 30_000);
  expect(parseSince("5m ago", now)).toBe(now - 300_000);
  expect(parseSince("2h", now)).toBe(now - 7_200_000);
  expect(parseSince("2026-10-16T11:59:00Z", now)).toBe(now - 60_000);
  expect(parseSince(String(now - 5), now)).toBe(now - 5);
  expect(parseSince(undefined, now)).toBeNull();
  expect(() => parseSince("yesterday-ish", now)).toThrow(/isn't a time/);
});

test("the network log reads Resource Timing: status, type, size, timing, and how each request was served", () => {
  const origin = 1_700_000_000_000;
  const base = "https://p.erga.dev/t/tok/doc/";
  const audio = fromTiming({
    name: `${base}track.m4a`, initiatorType: "audio", startTime: 120.4, duration: 33.6, responseStatus: 206, contentType: "audio/mp4",
    transferSize: 1300, encodedBodySize: 1024, decodedBodySize: 1024,
    serverTiming: [{ name: "doc", description: "1 call" }, { name: "file", description: "room bytes 0-1023/88000 type audio/mp4" }],
  }, origin, base, "page");
  expect(audio).toMatchObject({ url: `${base}track.m4a`, at: origin + 120, duration: 34, status: 206, type: "audio/mp4", size: 1024, via: "erga", initiator: "audio", contentRange: "bytes 0-1023/88000", erga: "room bytes 0-1023/88000 type audio/mp4" });
  expect(fromTiming({ name: "https://cdn.example.com/a.js", startTime: 0, duration: 5, transferSize: 0, decodedBodySize: 900 }, origin, base, "page").via).toBe("cache");
  expect(fromTiming({ name: "https://cdn.example.com/a.js", startTime: 0, duration: 5, workerStart: 3 }, origin, base, "page").via).toBe("service worker");
  expect(fromTiming({ name: "https://cdn.example.com/a.js", startTime: 0, duration: 5, transferSize: 900 }, origin, base, "page frame x.html")).toMatchObject({ via: "network", frame: "page frame x.html" });
  expect(describeNetwork({ entries: [audio], matched: 1, dropped: 0 })).toMatch(/GET .*track\.m4a {2}206 {2}audio\/mp4 {2}1 KB {2}Content-Range: bytes 0-1023\/88000 {2}34 ms {2}\(audio, via erga\)/);
});

test("the network log adds what the page's fetch saw (method, Range, Content-Range, errors), and keeps a request the timing missed", () => {
  const entries = [
    { url: "https://x.test/a", at: 1000, duration: 10, via: "network", frame: "page" },
    { url: "https://x.test/a", at: 5000, duration: 10, via: "network", frame: "page" },
  ];
  const merged = mergeHooked(entries, [
    { url: "https://x.test/a", method: "GET", range: "bytes=0-99", status: 206, contentRange: "bytes 0-99/1000", type: "audio/mpeg", at: 5003, via: "fetch" },
    { url: "https://x.test/gone", method: "POST", error: "TypeError: Failed to fetch", at: 6000, via: "fetch" },
  ]);
  expect(merged[0].range).toBeUndefined();
  expect(merged[1]).toMatchObject({ method: "GET", range: "bytes=0-99", status: 206, contentRange: "bytes 0-99/1000" });
  expect(merged[2]).toMatchObject({ url: "https://x.test/gone", method: "POST", error: "TypeError: Failed to fetch" });
  expect(queryNetwork(merged, { failed: true }).entries.map((e) => e.url)).toEqual(["https://x.test/gone"]);
  expect(queryNetwork(merged, { pattern: "audio/" }).entries.length).toBe(1);
  expect(queryNetwork(merged, { since: 4000, limit: 1 })).toMatchObject({ matched: 2, entries: [{ url: "https://x.test/gone" }] });
});

test("the event log gives the latest events since a time", () => {
  const e = (at: number): EventEntry => ({ at, type: "click", target: "<button#play>", trusted: true, defaultPrevented: false, consumed: [], frame: "page" });
  expect(queryEvents([e(1), e(2), e(3)], { since: 2 }).entries.map((x) => x.at)).toEqual([2, 3]);
  expect(queryEvents([e(1), e(2), e(3)], { limit: 1 })).toMatchObject({ matched: 3, entries: [{ at: 3 }] });
});

test("the document's audio and video files go out with their content types", () => {
  expect(mimeOf("song.m4a")).toBe("audio/mp4");
  expect(mimeOf("Song.M4A")).toBe("audio/mp4");
  expect(mimeOf("a.aac")).toBe("audio/aac");
  expect(mimeOf("a.ogg")).toBe("audio/ogg");
  expect(mimeOf("a.oga")).toBe("audio/ogg");
  expect(mimeOf("a.opus")).toMatch(/^audio\/ogg/);
  expect(mimeOf("a.wav")).toBe("audio/wav");
  expect(mimeOf("a.flac")).toBe("audio/flac");
  expect(mimeOf("a.mp3")).toBe("audio/mpeg");
  expect(mimeOf("a.m4v")).toBe("video/mp4");
  expect(mimeOf("a.mov")).toBe("video/quicktime");
  expect(docFile("song.m4a", new Uint8Array(10)).type).toBe("audio/mp4");
});

test("the document's files answer a byte range (206), as audio and video ask", () => {
  const bytes = new Uint8Array(100).map((_, i) => i);
  const whole = docFile("a.m4a", bytes);
  expect(whole).toMatchObject({ status: 200, headers: { "Accept-Ranges": "bytes" } });
  expect(whole.headers["Server-Timing"]).toBe('file;desc="room bytes 0-99/100 type audio/mp4"');
  const part = docFile("a.m4a", bytes, null, "bytes=10-19", "stored");
  expect(part.status).toBe(206);
  expect(part.headers["Content-Range"]).toBe("bytes 10-19/100");
  expect([...part.body!]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(part.headers["Server-Timing"]).toContain("stored bytes 10-19/100");
  expect(docFile("a.m4a", bytes, null, "bytes=0-").headers["Content-Range"]).toBe("bytes 0-99/100");
  expect(docFile("a.m4a", bytes, null, "bytes=90-500").headers["Content-Range"]).toBe("bytes 90-99/100");
  expect(docFile("a.m4a", bytes, null, "bytes=-5").body!.length).toBe(5);
  expect(docFile("a.m4a", bytes, null, "bytes=100-").status).toBe(416);
  // Several ranges, or a header it doesn't understand: the whole file.
  expect(docFile("a.m4a", bytes, null, "bytes=0-1,5-6").status).toBe(200);
  expect(byteRange("items=0-1", 100)).toBeNull();
  // Unchanged since the browser had it: still a 304.
  expect(docFile("a.m4a", bytes, whole.headers.ETag, "bytes=0-1").status).toBe(304);
});
