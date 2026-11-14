// The files of a drop from the computer, a folder's files with it, and the path each gets in the document: for the
// page's editor (libs/text/ui/input.ts, uploads.ts), the file tree (client/shell/tree-files.ts) and the agent's panel.

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

/**
 * The path `file` gets in the folder `dir` of the document ("": its top): under its own name, or, if a file has that
 * name already, the name with -2, -3, ... before its extension. A dropped folder's file keeps the folder. `taken`, the
 * paths the document has (lower case), gets it too.
 */
export function placeIn(dir: string, file: File, taken: Set<string>): string {
  // (A dropped folder's file says where in the folder it was: droppedFiles.)
  const under = ((file as { rel?: string }).rel ?? "").split("/").filter(Boolean).map(cleanName);
  const at = [...dir.split("/").filter(Boolean), ...under].join("/"),
    inDir = (n: string) => (at ? `${at}/${n}` : n);
  const path = inDir(unique(cleanName(file.name), (n) => taken.has(inDir(n).toLowerCase())));
  taken.add(path.toLowerCase());
  return path;
}

/**
 * The files of a drop. `plain`: as the browser gives them at once (a folder is one entry there, not a file to read).
 * `all`: with a folder among them, every file, each folder's in its place, by name (a file of a folder has `rel`, its
 * path from the folder's parent, with "/" at its end); they come a moment later. Null: no folder, `plain` is all.
 *
 * Trap: the drop's entries are the event's. Call this in the event's own handler, before any await.
 */
export function droppedFiles(dt: DataTransfer | null): { plain: File[]; all: Promise<File[]> | null } {
  const plain = [...(dt?.files ?? [])];
  const entries = [...(dt?.items ?? [])].filter((i) => i.kind == "file").map((i) => i.webkitGetAsEntry?.() ?? null);
  if (!entries.some((x) => x?.isDirectory)) return { plain, all: null };
  const all = Promise.all(
    entries.map((x, i) => (x?.isDirectory ? filesIn(x as FileSystemDirectoryEntry) : [plain[i]].filter(Boolean)))
  ).then((lists) => lists.flat());
  return { plain, all };
}

/** Every file in a dropped folder, by name, the folders in it too: each with its path from the folder's parent (`rel`). */
async function filesIn(dir: FileSystemDirectoryEntry, under = ""): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  const reader = dir.createReader();
  // (A reader gives a folder's entries in parts, until a part is empty.)
  for (;;) {
    const part = await new Promise<FileSystemEntry[]>((done) => reader.readEntries(done, () => done([])));
    if (!part.length) break;
    entries.push(...part);
  }
  const out: File[] = [];
  const here = `${under}${dir.name}/`;
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory) out.push(...(await filesIn(e as FileSystemDirectoryEntry, here)));
    else {
      const file = await new Promise<File | null>((done) => (e as FileSystemFileEntry).file(done, () => done(null)));
      if (file) out.push(Object.assign(file, { rel: here }));
    }
  }
  return out;
}
