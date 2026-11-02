// The viewer's own shortcuts, as a key pressed in the page must be known there: the page's first script
// (client/inline/reader.ts) passes them on to the viewer while editing, and the editor in the page leaves them be.

/** The parts of a keydown the shortcuts look at. */
export interface Keys {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Whether a key is one of the viewer's shortcuts (client/shell/main.ts, appShortcut). */
export function isAppShortcut(e: Keys, isMac: boolean): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey,
    key = e.key.toLowerCase();
  if (e.key == "Escape") return true;
  if (!mod) return false;
  // The page's zoom (libs/text/ui/zoom.ts): the viewer sets it.
  if (!e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) return true;
  if (e.shiftKey) return key == "p";
  return key == "j" || key == "k" || key == "/" || key == "?" || key == "s";
}
