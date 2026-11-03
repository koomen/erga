// view_page's and eval_in_page's tools in the page, for the server's browser (cloudflare/render.ts), which runs this
// in the page once it has loaded: window.__ergaRender (client/page-tools/capture.ts). Never in a person's page.

import { pageRender } from "../page-tools/capture";

export default function installPageRender(): void {
  (window as Window & { __ergaRender?: unknown }).__ergaRender = pageRender(window);
}
