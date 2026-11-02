// Erga's page tools, in the document's own page (tools.js): the agent's view_page and eval_in_page, which render the
// page afresh in a hidden frame (capture.ts), and the live page's tools, which read and act on the page as it runs
// (live-page-tab.ts). They are Erga's, apart from the editing libraries (libs/): the page's first script
// (client/inline/reader.ts) loads this one when the viewer first asks for a tool, and hands it each ask. The viewer
// (client/shell/page-requests.ts) sends the text to render, from its copy of the room; the answer goes back to it.

import { captureView } from "./capture";
import { LivePage } from "./live-page-tab";
import { encodePath } from "../../document/pages";
import { insertHead } from "../../shared/page-html";
import type { ViewRequest, ViewResult } from "../../shared/agent-log";
import type { LiveRequest } from "../../shared/live-page";
import type { ToolAsk } from "../common/reader-api";

const reader = window.__ergaReader!;
const { shell: SHELL, prefix: BASE } = reader.config;
/** This page's own folder: where its relative links and files resolve. */
const HERE = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
// (A stack frame of a script from where this one is, the app's /_erga/, is Erga's code: the editor's or these tools'.)
const live = new LivePage(BASE, new URL(".", import.meta.url).href);
live.attach(window);

const tell = (m: unknown) => window.parent.postMessage(m, SHELL);

function answer(ask: ToolAsk): void {
  if (ask.type == "erga-live") {
    if (ask.frame) live.pageFrame = ask.frame;
    live
      .answer(ask.req as LiveRequest)
      .catch((e: Error) => ({ error: `The page couldn't answer: ${e.message}` }))
      .then((result) => tell({ type: "erga-lived", id: ask.id, result }));
    return;
  }
  // Another page of the document (dir: its folder) renders at its own address, at its start; this one at its hash.
  const base = ask.dir != null ? BASE + encodePath(ask.dir) : HERE;
  captureView(ask.req as ViewRequest, insertHead(ask.text, `<base href="${base}">`), ask.dir != null ? "" : location.hash)
    .catch((err: Error): ViewResult => ({ width: 0, height: 0, errors: [], error: `Couldn't capture the page: ${err.message}` }))
    .then((result) => tell({ type: "erga-captured", id: ask.id, result }));
}

reader.tools!(answer);
