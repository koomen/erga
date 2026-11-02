// The globals the inline scripts of a document's page make for each other (server/pages/viewer.ts puts them in the
// page): the document's frame, the address with ?edit or without, the band's colour, and the editor's start.

/** The document's frame (#frame, the page on its pages origin), whether a message came from it, and sending to it. */
interface ErgaFrames {
  pages: string;
  readonly frame: HTMLIFrameElement;
  from(e: MessageEvent): boolean;
  send(m: unknown): void;
  /** The address of the page the frame shows, on its pages origin (the metas erga-pages and erga-page). */
  src(): string;
  /** How much larger than its own size the frame shows (the editor's zoom: libs/text/ui/zoom.ts). */
  scale(): number;
}

/** What the editor kept for its reload, as the page opens with it (viewer-editing-head.ts; client/shell/main.ts keeps it). */
interface ErgaRestored {
  body: string[];
  parts?: Record<string, string>;
  editor?: { mode?: string; scroll: number };
}

declare var ergaFrames: ErgaFrames;
/** Whether the page's address has ?edit. */
declare var ergaEditAddress: () => boolean;
/** `path` with ?edit, or without (`on`), the rest of the address's query kept. */
declare var ergaWithEdit: (path: string, on: boolean) => string;
/** The address of the page shown now: the document's, and its page's. */
declare var ergaPageAddress: () => string;
/** Sets the band's colour, or the one remembered for document `id`, and the controls' tone to suit; answers the tone. */
declare var ergaBand: (id: string, color?: string) => string;
/** The document's socket, opening (or open). */
declare var ergaConnect: () => WebSocket;
/** The editor's styles, on the page. */
declare var ergaShellStyle: () => void;
/** The editor's controls, on the page (inert until its code runs). */
declare var ergaControls: () => HTMLElement;
declare var ergaRestored: ErgaRestored | undefined;
