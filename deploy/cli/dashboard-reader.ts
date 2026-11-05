// The dashboard's reader (deploy/cli/dashboard.ts starts it): a worker thread that runs readState on each message. git
// and gh run synchronously (observe.ts), for seconds: here they don't stop the dashboard's server, which keeps
// answering the page (a job's output, a run's log) while a read runs.

import { readState } from "./observe";

declare const self: Worker;

self.onmessage = async () => {
  try {
    self.postMessage({ state: await readState() });
  } catch (e) {
    self.postMessage({ error: (e as Error).message });
  }
};
