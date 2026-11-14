// Files dropped or pasted on the page in the editor (input.ts takes them): each gets its place in the document's files
// here, an image in images/ and any other file in files/, under its own name or, if a file has that name already, the
// name with -2, -3, ... before its extension. A folder's files keep the folder: images/<folder>/<name>. The editor puts
// the file's element on the page at once (an image with its size, read here), and hands the file to the viewer, which
// sends its bytes (client/shell/uploads.ts).

/** The folder a file goes in. */
const folderFor = (file: File) => (file.type.startsWith("image/") ? "images" : "files");

/** A name as it can be in the document: no folders, no dot at the start. */
const cleanName = (name: string) => name.replace(/[/\\]/g, "-").replace(/^\.+/, "").trim() || "file";

/** `name`, or with -2, -3, ... before its extension, the first that isn't `taken`. */
function unique(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name,
    ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) if (!taken(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}

/** The path `file` gets in the document: `taken`, the paths the document has (lower case), gets it too. */
export function pathFor(file: File, taken: Set<string>): string {
  // (A dropped folder's file says where in the folder it was: input.ts, filesIn.)
  const under = ((file as { rel?: string }).rel ?? "").split("/").filter(Boolean).map(cleanName);
  const dir = [folderFor(file), ...under].join("/");
  const path = `${dir}/${unique(cleanName(file.name), (n) => taken.has(`${dir}/${n}`.toLowerCase()))}`;
  taken.add(path.toLowerCase());
  return path;
}

/** An image's size in px, read from the file (a few milliseconds); nothing for a file that isn't a picture the browser reads. */
export async function imageSize(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith("image/")) return {};
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    /* not a bitmap (an SVG): an image element reads it */
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {};
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}
