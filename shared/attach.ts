// Files attached to a message for an agent: the rules both agents' panels
// and both servers (document/host.ts for the document agent,
// agents/admin/sessions.ts for the admin's) go by. Images go to the model as
// images; text-like files (code, Markdown, CSV, JSON...) as text, after the
// message. Anything else is refused, with a reason the person can act on.
// The transcript keeps only a small thumbnail of each image (FileRef), so
// the conversation shows what was attached without carrying the pictures.

/** One attachment as sent: an image (base64, no data: prefix) or a text file's contents. */
export interface Attachment {
  name: string;
  kind: "image" | "text";
  mimeType: string;
  data: string;
  /** The original file's size, in bytes. */
  size: number;
  /** An image's thumbnail, as a small data: URL, for the transcript. */
  thumb?: string;
}

/** An attachment as the transcript shows it. */
export interface FileRef { name: string; kind: "image" | "text"; size: number; thumb?: string }

export const MAX_FILES = 8;
/** A text file's limit. */
export const MAX_TEXT_BYTES = 256 * 1024;
/** An image file's limit as picked; bigger pictures are scaled down to fit MAX_IMAGE_DATA before they're sent. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** An image as the model takes it: base64 characters (the model's limit is 5 MB). */
export const MAX_IMAGE_DATA = 5 * 1024 * 1024;
const MAX_THUMB = 200 * 1024;

export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXT = new Set(("txt md markdown csv tsv json jsonl ndjson yaml yml toml ini cfg conf env log xml svg html htm css scss sass less " +
  "js mjs cjs jsx ts mts cts tsx vue svelte py rb go rs java kt swift c h cc cpp hpp cs php pl lua r sql sh bash zsh fish " +
  "diff patch tex bib rst org adoc gitignore dockerfile makefile").split(" "));
const TEXT_MIME = /^(text\/|application\/(json|ld\+json|xml|javascript|x-javascript|typescript|x-sh|x-yaml|yaml|toml|sql|x-ndjson)$|image\/svg\+xml$)/;

const ext = (name: string) => { const base = name.toLowerCase().split("/").pop()!; const i = base.lastIndexOf("."); return i >= 0 ? base.slice(i + 1) : base; };

/** What a file can be sent as, from its name and type; null: neither. */
export function classify(name: string, mimeType: string): { kind: "image" | "text"; mimeType: string } | null {
  const e = ext(name);
  if (Object.values(IMAGE_TYPES).includes(mimeType)) return { kind: "image", mimeType };
  if (!mimeType && IMAGE_TYPES[e]) return { kind: "image", mimeType: IMAGE_TYPES[e] };
  if (TEXT_EXT.has(e) || TEXT_MIME.test(mimeType)) return { kind: "text", mimeType: mimeType || "text/plain" };
  return null;
}

export const kb = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Why this file can't be attached, or null. */
export function refusal(name: string, mimeType: string, size: number): string | null {
  const c = classify(name, mimeType);
  if (!c) return `“${name}” can't be attached: only images (PNG, JPEG, GIF, WebP) and text files (code, Markdown, CSV, JSON) can.`;
  if (c.kind == "image" && size > MAX_IMAGE_BYTES) return `“${name}” is too big (${kb(size)}): images can be up to ${kb(MAX_IMAGE_BYTES)}.`;
  if (c.kind == "text" && size > MAX_TEXT_BYTES) return `“${name}” is too big (${kb(size)}): text files can be up to ${kb(MAX_TEXT_BYTES)}.`;
  return null;
}

/** Checks attachments a server was sent: the list, or why it's refused. */
export function checkAttachments(v: unknown): Attachment[] | string {
  if (v == null) return [];
  if (!Array.isArray(v)) return "the attachments aren't a list";
  if (v.length > MAX_FILES) return `at most ${MAX_FILES} files can go with one message`;
  const out: Attachment[] = [];
  for (const a of v as Record<string, unknown>[]) {
    if (!a || typeof a != "object" || typeof a.name != "string" || typeof a.data != "string" || typeof a.mimeType != "string") return "an attachment is malformed";
    const name = a.name.slice(0, 200) || "file";
    const size = Number(a.size) || 0;
    if (a.kind == "image") {
      if (!Object.values(IMAGE_TYPES).includes(a.mimeType)) return `“${name}” isn't a PNG, JPEG, GIF or WebP image`;
      if (a.data.length > MAX_IMAGE_DATA || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) return `“${name}” is too big, or not base64`;
      const thumb = typeof a.thumb == "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(a.thumb) && a.thumb.length <= MAX_THUMB ? a.thumb : undefined;
      out.push({ name, kind: "image", mimeType: a.mimeType, data: a.data, size, thumb });
    } else if (a.kind == "text") {
      if (a.data.length > MAX_TEXT_BYTES) return `“${name}” is too big: text files can be up to ${kb(MAX_TEXT_BYTES)}`;
      out.push({ name, kind: "text", mimeType: a.mimeType.slice(0, 100), data: a.data, size });
    } else return `“${name}” is neither an image nor a text file`;
  }
  return out;
}

export const fileRefs = (files: Attachment[]): FileRef[] => files.map((f) => ({ name: f.name, kind: f.kind, size: f.size, ...(f.thumb ? { thumb: f.thumb } : {}) }));

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** A message for the model: the text, each text file after it, and each image; a plain string when nothing's attached. */
export function messageContent(text: string, files: Attachment[] = []): string | Part[] {
  if (!files.length) return text;
  const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
  const texts = files.filter((f) => f.kind == "text").map((f) => `<file name="${attr(f.name)}">\n${f.data}\n</file>`);
  const images = files.filter((f) => f.kind == "image");
  const names = images.map((f) => f.name).join(", ");
  const body = [text, ...texts, ...(images.length ? [`(Attached image${images.length > 1 ? "s" : ""}: ${names})`] : [])].filter(Boolean).join("\n\n");
  return [{ type: "text", text: body }, ...images.map((f): Part => ({ type: "image", data: f.data, mimeType: f.mimeType }))];
}
