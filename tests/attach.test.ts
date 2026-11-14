// The rules for files attached to an agent message.
import { expect, test } from "bun:test";
import { agentApi } from "../agents/person/routes";
import { PersonAgents } from "../agents/person/sessions";
import { respond } from "../server/http";
import type { Platform } from "../server/platform";
import { objectSql } from "./helpers/memory-sql";
import { pngOf } from "./helpers/png";
import { checkAttachments, classify, fileRefs, MAX_FILES, MAX_IMAGE_DATA, MAX_TEXT_BYTES, messageContent, refusal } from "../shared/attach";

test("images and text-like files can be attached; others can't", () => {
  expect(classify("shot.png", "image/png")).toEqual({ kind: "image", mimeType: "image/png" });
  expect(classify("photo.JPG", "")).toEqual({ kind: "image", mimeType: "image/jpeg" });
  for (const n of ["notes.md", "data.csv", "x.json", "app.tsx", "Makefile", "main.py"]) expect(classify(n, "")?.kind).toBe("text");
  expect(classify("whatever", "text/plain")?.kind).toBe("text");
  expect(classify("report.pdf", "application/pdf")).toBeNull();
  expect(classify("song.mp3", "audio/mpeg")).toBeNull();
  expect(classify("pic.bmp", "image/bmp")).toBeNull();
});

test("refusals say why", () => {
  expect(refusal("report.pdf", "application/pdf", 10)).toContain("only images (PNG, JPEG, GIF, WebP) and text files");
  expect(refusal("big.csv", "text/csv", MAX_TEXT_BYTES + 1)).toContain("text files can be up to 256 KB");
  expect(refusal("huge.png", "image/png", 21 * 1024 * 1024)).toContain("images can be up to 20.0 MB");
  expect(refusal("ok.png", "image/png", 1000)).toBeNull();
});

test("the server checks what it's sent", () => {
  expect(checkAttachments(undefined)).toEqual([]);
  expect(checkAttachments("x")).toBeString();
  expect(checkAttachments(Array.from({ length: MAX_FILES + 1 }, () => ({ name: "a.txt", kind: "text", mimeType: "text/plain", data: "", size: 0 })))).toContain(`at most ${MAX_FILES}`);
  expect(checkAttachments([{ name: "a.pdf", kind: "pdf", mimeType: "application/pdf", data: "", size: 1 }])).toContain("neither an image nor a text file");
  expect(checkAttachments([{ name: "a.bmp", kind: "image", mimeType: "image/bmp", data: "AAAA", size: 3 }])).toContain("isn't a PNG");
  expect(checkAttachments([{ name: "a.png", kind: "image", mimeType: "image/png", data: "A".repeat(MAX_IMAGE_DATA + 4), size: 1 }])).toContain("too big");
  // A picture of more px a side than the model takes in a long conversation (shared/picture.ts); 3000 px passes.
  const png = (w: number, h: number) => [{ name: "a.png", kind: "image", mimeType: "image/png", data: pngOf(w, h), size: 1 }];
  expect(checkAttachments(png(3001, 800))).toBe("“a.png” is 3001×800 px: more than the 3000 px a side that the model takes");
  expect(checkAttachments(png(3000, 3000))).toMatchObject([{ name: "a.png" }]);
  expect(checkAttachments([{ name: "a.png", kind: "image", mimeType: "image/png", data: "not base64!", size: 1 }])).toContain("not base64");
  expect(checkAttachments([{ name: "a.txt", kind: "text", mimeType: "text/plain", data: "x".repeat(MAX_TEXT_BYTES + 1), size: 1 }])).toContain("too big");
  const ok = checkAttachments([{ name: "a.png", kind: "image", mimeType: "image/png", data: "AAAA", size: 3, thumb: "javascript:alert(1)" }]);
  expect(Array.isArray(ok) && ok[0].thumb).toBeUndefined(); // only a data: image survives as a thumbnail
});

test("the model gets images as images and text files as text, after the message", () => {
  expect(messageContent("hi")).toBe("hi");
  const files = [
    { name: "a.csv", kind: "text" as const, mimeType: "text/csv", data: "x,y\n1,2", size: 7 },
    { name: "s.png", kind: "image" as const, mimeType: "image/png", data: "AAAA", size: 3, thumb: "data:image/jpeg;base64,AA" },
  ];
  const c = messageContent("Look", files) as { type: string; text?: string; data?: string; mediaType?: string }[];
  expect(c[0]).toEqual({ type: "text", text: `Look\n\n<file name="a.csv">\nx,y\n1,2\n</file>\n\n(Attached image: s.png)` });
  expect(c[1]).toEqual({ type: "file", mediaType: "image/png", data: "AAAA" });
  expect(fileRefs(files)).toEqual([
    { name: "a.csv", kind: "text", size: 7 },
    { name: "s.png", kind: "image", size: 3, thumb: "data:image/jpeg;base64,AA" },
  ]); // An image the server kept: the agent gets its blob, to add it to a document.
  const kept = messageContent("Add it", [{ ...files[1], blob: "ab".repeat(32) }]) as { text?: string }[];
  expect(kept[0].text).toContain(`- s.png: {"blob": "${"ab".repeat(32)}"}`);
  expect(kept[0].text).toContain(`{"images/s.png": {"blob": "…"}}`);
});

// The agent's API (agents/person/routes.ts) with a person's agent that is on (the scripted model): the route's answer.
test("the server refuses what the panel would: a PDF sent straight to the agent's API, with a reason", async () => {
  const script = { own: {}, server: {}, mode: "server" as const, off: [], model: "script" as const, effort: "medium" as const };
  const platform = {
    agentSettings: async () => script,
    directory: { users: { isAdmin: async () => false, actsAsAdmin: async () => false } },
    sessionOf: async () => ({ login: "ada", name: "Ada" }),
    personAgent: () => agents,
  } as unknown as Platform;
  const agents = new PersonAgents({ sql: objectSql(), platform });
  const send = (body: unknown) =>
    respond(
      agentApi,
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify(body),
      }),
      platform
    );
  const r = await send({ text: "hi", files: [{ name: "x.pdf", kind: "pdf", mimeType: "application/pdf", data: "", size: 1 }] });
  expect(r.status).toBe(409);
  expect(((await r.json()) as { reason?: string }).reason).toContain("neither an image nor a text file");
  // Nothing of it reached the conversation.
  expect((await agents.conversation("ada")).items).toEqual([]);
});
