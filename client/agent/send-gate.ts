// The one "can send now" gate of the agent panel (person-agent.ts), for each way a message goes: Send or Enter in the
// box, a pause in voice mode, and the editor's own "Fix with agent" buttons. Files attached go with the box's message
// and the voice message, so neither goes while one is still being read.

export type SendPath = "box" | "voice" | "editor";

export interface SendFacts {
  /** Why the agent is off, or null when it's on. */
  off: string | null;
  /** Voice mode is on. */
  voice: boolean;
  /** Files attached and still being read. */
  reading: number;
  /** The message's text, and how many files are attached and read. */
  text: string;
  files: number;
}

/** Why a message can't go by this path now, or null if it can. Never a silent no. */
export function canSend(path: SendPath, f: SendFacts): string | null {
  if (f.off) return f.off;
  if (path == "editor") return null;
  if (path == "box" && f.voice) return "Voice mode is on: what you say is sent when you pause.";
  if (f.reading) return "Reading the attached files…";
  if (!f.text.trim() && !f.files) return "Type a message to send it.";
  return null;
}
