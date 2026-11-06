// The page at /erga-clear on a document's pages origin (server/pages/worker.ts): it deletes what this origin keeps for
// offline (the replicas, the worker's copy, the worker), then tells the page that framed it (sign-out:
// client/inline/sign-out.ts). It deletes only, and reads nothing.

import { clearOffline } from "../common/offline";

export default function offlineClear(): void {
  void clearOffline().then(() => parent.postMessage({ type: "erga-cleared" }, "*"));
}
