// The page's live log for the editor (shared/live-page.ts, liveWatch): its console, events and requests, from its first
// moment, on a page someone may edit (server/pages/reader.ts).

import { EVENT_TYPES, liveWatch } from "../../shared/live-page";

export default function pageLiveWatch(): void {
  liveWatch({ events: true, net: true, types: EVENT_TYPES });
}
