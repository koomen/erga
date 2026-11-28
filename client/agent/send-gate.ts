// The one "can send now" gate of the agent panel (person-agent.ts), for each way a message goes: Send or Enter in the
// box, and the editor's own "Fix with agent" buttons. Files attached go with the box's message, so it doesn't go while
// one is still being read.

export type SendPath = "box" | "editor";

export interface SendFacts {
  /** Why the agent is off, or null when it's on. */
  off: string | null;
  /** Why a disconnected local agent can't take messages right now, or null when connected. */
  disconnected?: string | null;
  /** Files attached and still being read. */
  reading: number;
  /** The message's text, and how many files are attached and read. */
  text: string;
  files: number;
}

/** Why a message can't go by this path now, or null if it can. Never a silent no. */
export function canSend(path: SendPath, f: SendFacts): string | null {
  if (f.off) return f.off;
  if (f.disconnected) return f.disconnected;
  if (path == "editor") return null;
  if (f.reading) return "Reading the attached files…";
  if (!f.text.trim() && !f.files) return "Type a message to send it.";
  return null;
}
