// Erga's page tools, in the document's own page (tools.js): the live page's tools (page_log, page_input, eval_in_page
// with live), which read and act on the page as it runs (live-page-tab.ts). They are Erga's, apart from the editing
// libraries (libs/): the page's first script (client/inline/reader.ts) loads this one when the viewer first asks for a
// tool, and hands it each ask; the answer goes back to the viewer (client/shell/page-requests.ts). view_page renders
// on the server instead (cloudflare/render.ts).

import { LivePage } from "./live-page-tab";
import type { LiveRequest } from "../../shared/live-page";
import type { ToolAsk } from "../common/reader-api";

const reader = window.__ergaReader!;
const { shell: SHELL, prefix: BASE } = reader.config;
// (A stack frame of a script from where this one is, the app's /_erga/, is Erga's code: the editor's or these tools'.)
const live = new LivePage(BASE, new URL(".", import.meta.url).href);
live.attach(window);

const tell = (m: unknown) => window.parent.postMessage(m, SHELL);

function answer(ask: ToolAsk): void {
  if (ask.frame) live.pageFrame = ask.frame;
  live
    .answer(ask.req as LiveRequest)
    .catch((e: Error) => ({ error: `The page couldn't answer: ${e.message}` }))
    .then((result) => tell({ type: "erga-lived", id: ask.id, result }));
}

reader.tools!(answer);
