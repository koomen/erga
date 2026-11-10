// For whoever may edit, at the top of a document's page (server/pages/viewer.ts, editingHead). The page holds the
// editor's shell already, inert (its styles and its controls, client/editor.html), so going into the editor fetches no
// page and waits for no stylesheet. Opened with ?edit, it starts at once, as the page parses: the shell's styles go on,
// the document's socket opens (ergaConnect: the room and the person's events on one WebSocket, whose first messages are
// the document's details and its whole text), and the editor's script (`scripts`: it and its first chunks) is fetched.
//
// Reloaded in the editor (by hand, or for a new release), the page opens as the editor was, from its first frame: its
// layout and its controls, as the editor kept them (client/shell/main.ts, "shell"; client/live/restore.ts, under `restoreKey`).
// Only for the window's same size, and at the same address.

type Kept = {
  url: string;
  at: number;
  used?: number;
  hand?: boolean;
  keep?: {
    shell?: { width: number; height: number; body: string[]; parts: Record<string, string>; style: string; html: string[] };
    editor?: ErgaRestored["editor"];
  };
};

export default function viewerEditingHead(scripts: string[], restoreKey: string): void {
  window.ergaConnect = () => {
    // The editor's start (its hello and the document's whole text: shared/room-socket.ts), on the connection this page
    // came on, and the document's one socket, which needs a connection of its own: both at once. libs/text/ui/collab.ts takes
    // them over (the socket with what came on it before then).
    const was = window.ergaSocket;
    if (was && was.readyState < 2) return was;
    const base = document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')!.content,
      user = new URLSearchParams(location.search).get("user")?.trim();
    window.ergaStart = fetch(base + "/api/start" + (user ? "?user=" + encodeURIComponent(user) : "")).then(
      (r) => (r.ok ? r.arrayBuffer() : null),
      () => null
    );
    // The edit key for the page's editor (client/shell/editor.ts takes it over), asked for now too, not after the first
    // sync: unless this tab holds one that lasts (the editor's RENEW_MS).
    const q = user ? "?user=" + encodeURIComponent(user) : "";
    let held: { expires?: number } | null = null;
    try {
      held = JSON.parse(sessionStorage.getItem("erga:edit-key:" + base.replace(/\/+$/, "") + q) || "null");
    } catch {}
    if (!(held && held.expires! - Date.now() > 300_000))
      window.ergaKey = fetch(base + "/api/key" + q, { method: "POST" }).catch(() => null);
    const ws: WebSocket & { early?: (string | ArrayBuffer)[] } = new WebSocket(
      (location.protocol == "https:" ? "wss://" : "ws://") +
        location.host +
        base +
        "/api/room?events=1" +
        (user ? "&user=" + encodeURIComponent(user) : "")
    );
    ws.binaryType = "arraybuffer";
    const early: (string | ArrayBuffer)[] = (ws.early = []);
    ws.onmessage = (e) => early.push(e.data);
    return (window.ergaSocket = ws);
  };
  window.ergaShellStyle = () => {
    if (document.getElementById("erga-shell-style")) return;
    const s = (document.getElementById("erga-shell") as HTMLTemplateElement).content
      .querySelector("style")!
      .cloneNode(true) as HTMLStyleElement;
    s.id = "erga-shell-style";
    document.documentElement.dataset.theme = "light";
    document.head.append(s);
  };
  if (!ergaEditAddress()) return;
  ergaConnect();
  for (const href of scripts) document.head.append(Object.assign(document.createElement("link"), { rel: "modulepreload", href }));
  ergaShellStyle();
  try {
    const s = JSON.parse(sessionStorage.getItem(restoreKey) || "null") as Kept | null,
      me = performance.timeOrigin;
    const shell = s?.keep?.shell,
      root = document.documentElement;
    if (
      s &&
      shell &&
      s.url == location.pathname + location.search &&
      (s.used == null || s.used == me) &&
      s.at <= me + 1000 &&
      me - s.at < 60000 &&
      (!s.hand || (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type == "reload") &&
      shell.width == innerWidth &&
      shell.height == innerHeight
    ) {
      window.ergaRestored = { body: shell.body, parts: shell.parts, editor: s.keep!.editor };
      root.style.cssText += ";" + shell.style;
      root.classList.add(...shell.html);
    }
  } catch {}
}
