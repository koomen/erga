// The server's own browser (view_page, eval_in_page: local development's Chrome, and the AWS host's) reaches no
// private address: a page can't make it look at a service that listens only on the machine or in its private network
// (cloudflare/render.ts, shared/private-address.ts). Erga's own two addresses, the app's and the pages', stay reachable.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { unique } from "../access/access";
import { agentTools, CAPTURES } from "../page/view-page";

await servers.script();

/** A service of the machine's own, as an admin page or a metadata service is: what it was asked, in order. */
async function privateService() {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" }).end("<h1>SECRET-KEY-123</h1>");
  });
  server.unref();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { asked, port: (server.address() as { port: number }).port, close: () => server.close() };
}

const page = (port: number) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Report</title></head>
<body style="margin:0;background:#fff">
<h1 id="title">Quarterly report</h1>
<iframe id="direct" src="http://127.0.0.1:${port}/framed" width="600" height="200"></iframe>
<iframe id="name" src="http://localhost:${port}/by-name" width="600" height="100"></iframe>
<img id="image" src="http://127.0.0.1:${port}/image.png">
<link rel="stylesheet" href="http://[::1]:${port}/style.css">
<iframe id="nested" srcdoc="&lt;iframe src='http://127.0.0.1:${port}/nested'&gt;&lt;/iframe&gt;"></iframe>
</body></html>
`;

test("a page that frames and loads a private address: the render asks it nothing, and the page's own content shows", CAPTURES, async () => {
  const s = await servers.script();
  const service = await privateService();
  try {
    const dir = join(s.scratch, "docs", unique("private-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), page(service.port));
    const { tool } = await agentTools(s, await s.open(dir));
    const shot = await tool("view_page", {});
    expect(shot.images.length).toBe(1);
    // The page itself rendered, from Erga's own addresses.
    expect((await tool("eval_in_page", { expression: `document.getElementById("title").textContent` })).text).toContain("Quarterly report");
    // Its script can't reach the service either: by fetch, by a frame made later, or as text it could read back.
    const tried = await tool("eval_in_page", {
      expression: `const r = {};
r.fetch = await fetch("http://127.0.0.1:${service.port}/fetch").then((x) => x.text(), (e) => "refused");
r.noCors = await fetch("http://127.0.0.1:${service.port}/no-cors", { mode: "no-cors" }).then(() => "sent", () => "refused");
const f = document.createElement("iframe"); f.src = "http://127.0.0.1:${service.port}/later";
const loaded = new Promise((ok) => { f.onload = ok; f.onerror = ok; });
document.body.append(f);
await loaded;
return r;`,
      timeout: 5000,
    });
    expect(JSON.parse(tried.text.split("\n\n")[0])).toEqual({ fetch: "refused", noCors: "refused" });
    expect(tried.text).not.toContain("SECRET-KEY-123");
    expect(service.asked).toEqual([]);
  } finally {
    service.close();
  }
});
