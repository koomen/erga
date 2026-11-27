// What the page's first script (client/inline/reader.ts) offers the scripts it loads into the page: the editor
// (libs/text/ui/frame.ts) and Erga's page tools (client/page-tools/tools.ts). Types only.

import type { ReaderConfig } from "../../shared/page-html";

/** An ask for Erga's page tools (client/page-tools/tools.ts) from the viewer: the live page's. */
export type ToolAsk = { type: "erga-live"; id: number; req: unknown; frame?: { sandbox: string | null; allow: string | null } };

declare global {
  interface Window {
    /** This script, for the editor and the page tools: its config, and what they tell it or take from it. */
    __ergaReader?: {
      config: ReaderConfig;
      /**
       * The keys pressed before the editor's script ran, on a page that loaded again with the focus in its text; and
       * the end of that hold: the editor takes the keys, or it stops.
       */
      keys: { held: { key: string; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }[]; letGo(): void };
      /** The editor put the page back where it was. */
      placed?(): void;
      /** Non-HTML files of the document changed (their paths in it): "skip" if unused, "restyled" if hot-swapped, else "reload". */
      applyFiles?(paths: string[]): Promise<"skip" | "restyled" | "reload">;
      /** The viewer's last word on editing (erga-mode), which the editor reads as it loads, and hears after. */
      mode?: unknown;
      /** The viewer's last word on the zoom (erga-zoomed), which the editor reads as it loads, and hears after. */
      zoomed?: unknown;
      /** The viewer's last word on comments (erga-comments: shown or hidden), for the editor as it loads. */
      comments?: unknown;
      /** The page tools are here: they answer each ask, those that waited for them first. */
      tools?(answer: (ask: ToolAsk) => void): void;
    };
  }
}
