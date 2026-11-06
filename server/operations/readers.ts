// Who reads a document, and whether its readers may ask their agent (share_document: login "*", reader_agent), decided
// before share_document writes anything:
//
//   private(agent) --share "*"--------------> public (the agent goes, and stays off: the stored value is false)
//   public         --stop "*"---------------> private(off)
//   private(agent) --reader_agent on or off--> private(on or off)
//   public         --reader_agent on---------> refused (a document anyone may open never gives readers their agent)
//
// One call may ask several: they apply together, and a refusal writes nothing. Decides only: no IO.

/** A document's readers: private (only the people it's shared with), with their agent or not; or public ("*"). */
export type Readers = { state: "private"; agent: boolean } | { state: "public" };

/** What one share_document asks: "*" on (a role) or off, and the readers' agent on or off. */
export interface ReadersAsk {
  anyone?: boolean;
  agent?: boolean;
}

export const NO_AGENT_WHEN_PUBLIC =
  "Anyone with the link can open this document, so readers can't use their agent on it. Stop sharing it with anyone first.";

/** The readers after `ask`, and the reader_agent value to store (undefined: as it is); or why not. */
export function readersStep(now: Readers, ask: ReadersAsk): { next: Readers; agent?: boolean } | { refused: string } {
  if (ask.anyone ?? now.state == "public") {
    if (ask.agent === true) return { refused: NO_AGENT_WHEN_PUBLIC };
    return { next: { state: "public" }, ...(now.state == "private" || ask.agent === false ? { agent: false } : {}) };
  }
  const agent = ask.agent ?? (now.state == "private" && now.agent);
  return { next: { state: "private", agent }, ...(ask.agent != null ? { agent } : {}) };
}
