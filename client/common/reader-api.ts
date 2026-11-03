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
      /** The page's steps may have changed (the editor changed its text). */
      changed?(): void;
      /** The editor put the page back where it was. */
      placed?(): void;
      /** The viewer's last word on editing (erga-mode), which the editor reads as it loads, and hears after. */
      mode?: unknown;
      /** The page tools are here: they answer each ask, those that waited for them first. */
      tools?(answer: (ask: ToolAsk) => void): void;
    };
  }
}
