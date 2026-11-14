// The rule for a picture that goes to a model (shared/picture.ts), and the messages held to it (agents/models.ts,
// fitPictures): a picture's size from its header, the sizes at the model's limits, a tall page in parts, and a long
// conversation's old pictures.

import { expect, test } from "bun:test";
import { fitPictures } from "../agents/models";
import { fromBase64 } from "../shared/bytes";
import { base64PictureSize, PICTURE, PICTURES, pictureParts, pictureSize, tooLarge } from "../shared/picture";
import { pngOf } from "./helpers/png";

test("a picture's size comes from its header: PNG, JPEG (after a long header), GIF and WebP", () => {
  expect(pictureSize(fromBase64(pngOf(1280, 4200)))).toEqual({ width: 1280, height: 4200 });
  const gif = new Uint8Array(40);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
  expect(pictureSize(gif)).toEqual({ width: 800, height: 600 });
  // A JPEG: an APP1 segment of 70 000 bytes in two parts (EXIF, a color profile), then the frame's header.
  const app = (n: number) => [0xff, 0xe1, (n + 2) >> 8, (n + 2) & 255, ...new Array<number>(n).fill(7)];
  const jpeg = new Uint8Array([
    0xff,
    0xd8,
    ...app(40_000),
    ...app(30_000),
    0xff,
    0xc2,
    0,
    17,
    8,
    0x0b,
    0xb9,
    0x0f,
    0xa0,
    3,
    ...new Array(20).fill(0),
  ]);
  expect(pictureSize(jpeg)).toEqual({ width: 4000, height: 3001 });
  // As base64, past the first 64 KB that are read first.
  expect(base64PictureSize(Buffer.from(jpeg).toString("base64"))).toEqual({ width: 4000, height: 3001 });
  const webp = new Uint8Array(40);
  webp.set([..."RIFF"].map((c) => c.charCodeAt(0)));
  webp.set(
    [..."WEBPVP8X"].map((c) => c.charCodeAt(0)),
    8
  );
  webp.set([0xff, 0x0b, 0, 0x57, 0x02, 0], 24);
  expect(pictureSize(webp)).toEqual({ width: 3072, height: 600 });
  expect(pictureSize(new Uint8Array(40))).toBeNull();
  expect(base64PictureSize("not base64 !")).toBeNull();
});

test("the limits: 3000 px a side and 10 MB of base64 pass, one more does not", () => {
  expect(tooLarge({ width: 3000, height: 3000 }, PICTURE.data)).toBeNull();
  expect(tooLarge({ width: 3001, height: 10 }, 100)).toBe("3001×10 px: more than the 3000 px a side that the model takes");
  expect(tooLarge({ width: 1280, height: 4200 }, 100)).toContain("1280×4200 px");
  expect(tooLarge({ width: 10, height: 10 }, PICTURE.data + 1)).toContain("MB as base64");
  // A size that the header doesn't say passes: the bytes still count.
  expect(tooLarge(null, 100)).toBeNull();
});

test("a tall capture goes in equal parts, each one the model reads whole; a short one stays whole", () => {
  expect(pictureParts(1280, 800)).toEqual([800]);
  expect(pictureParts(1280, 2576)).toEqual([2576]);
  expect(pictureParts(1280, 2577)).toEqual([1289, 1288]);
  // The whole page of the report: 1280 px wide, 4200 px tall.
  expect(pictureParts(1280, 4200)).toEqual([2100, 2100]);
  // A wide window: the model's 4784 patches of 28 px give 55 rows of patches at 2400 px.
  expect(pictureParts(2400, 4200)).toEqual([1400, 1400, 1400]);
  for (const [w, h] of [
    [320, 4200],
    [1280, 4000],
    [1456, 4200],
    [2000, 3999],
    [2400, 4200],
  ]) {
    const parts = pictureParts(w, h);
    expect(parts.reduce((a, b) => a + b)).toBe(h);
    for (const p of parts) {
      expect(Math.max(w, p)).toBeLessThanOrEqual(PICTURE.edge);
      expect(Math.ceil(w / PICTURE.patch) * Math.floor(p / PICTURE.patch)).toBeLessThanOrEqual(PICTURE.patches);
    }
  }
});

const picture = (data: string) => ({ type: "file", mediaType: "image/png", data });
const seen = (id: string, data: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      id,
      name: "page",
      isFailure: false,
      result: "Screenshot",
      modelOutput: [picture(data), { type: "text", text: "Screenshot" }],
    },
  ],
});
const said = (text: string) => ({
  role: "assistant",
  content: [
    { type: "reasoning", text: "Hm." },
    { type: "text", text },
  ],
});
const texts = (m: { content: unknown }) => JSON.stringify(m.content);

test("messages with every picture inside the rule pass as they are", () => {
  const messages = [{ role: "user", content: "Look." }, said("I look."), seen("a", pngOf(1280, 2100)), said("Done.")];
  expect(fitPictures(messages)).toBe(messages);
});

test("an old picture that is too large has words in its place, with its size; the turns lose their thinking", () => {
  const pdf = { type: "file", mediaType: "application/pdf", data: "JVBERi0=" };
  const messages = [
    { role: "user", content: [{ type: "text", text: "Look." }, picture(pngOf(4000, 3001)), pdf] },
    said("I look."),
    seen("a", pngOf(1280, 4200)),
    said("Done."),
  ];
  const fitted = fitPictures(messages);
  expect(fitted.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(texts(fitted[0])).toContain("[A picture was here. It is 4000×3001 px: more than the 3000 px a side that the model takes.");
  // A PDF is not a picture: it stays.
  expect(texts(fitted[0])).toContain("application/pdf");
  expect(texts(fitted[2])).toContain("It is 1280×4200 px");
  expect(JSON.stringify(fitted)).not.toContain("image/png");
  expect(JSON.stringify(fitted)).not.toContain("reasoning");
  // The messages themselves are as they were: the store keeps them.
  expect(texts(messages[2])).toContain("image/png");
});

test("a long conversation: over the most pictures, the oldest leave until the low mark; the same start each time after", () => {
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: "Look, many times." }];
  for (let i = 0; i <= PICTURES.high.count; i++) messages.push(said(`Look ${i}.`), seen(`c${i}`, pngOf(1280, 800)));
  const left = (ms: readonly { content: unknown }[]) => ms.filter((m) => texts(m).includes("image/png")).length;
  // At the most, all stay.
  expect(left(fitPictures(messages.slice(0, -2)))).toBe(PICTURES.high.count);
  // One more: the oldest leave, and words say so.
  const fitted = fitPictures(messages);
  expect(left(fitted)).toBe(PICTURES.low.count);
  expect(texts(fitted[2])).toContain("[An old picture was here.");
  expect(texts(fitted.at(-1)!)).toContain("image/png");
  // The turns before the pictures left go without their thinking: the model saw other messages before them.
  expect(JSON.stringify(fitted)).not.toContain("reasoning");
  // The conversation goes on: what was sent stays as it was sent (the model's cache, and its thinking after, hold).
  const more = [...messages, said("More."), seen("d", pngOf(1280, 800)), said("And more.")];
  const again = fitPictures(more);
  expect(again.slice(0, fitted.length)).toEqual([...fitted]);
  expect(left(again)).toBe(PICTURES.low.count + 1);
  expect(texts(again.at(-1)!)).toContain("reasoning");
});

test("pictures of many bytes: over the most bytes together, the oldest leave", () => {
  // Each picture: 4 MB of base64 (a header, then zeros).
  const big = pngOf(1280, 800, 3 * 1024 * 1024);
  const messages = Array.from({ length: PICTURES.high.data / big.length + 1 }, (_, i) => seen(`c${i}`, big));
  const fitted = fitPictures(messages);
  const bytes = fitted.reduce((n, m) => n + (texts(m).includes("image/png") ? big.length : 0), 0);
  expect(bytes).toBeLessThanOrEqual(PICTURES.low.data);
  expect(bytes).toBeGreaterThan(PICTURES.low.data - big.length);
});
