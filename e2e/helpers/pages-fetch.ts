// A request to a document's pages origin (<id>-<owner>.localhost:<port>) from a test: browsers send <anything>.localhost
// to this machine; Node's fetch doesn't, and won't send a Host header of its own, so node:http asks.
import { request } from "node:http";

export function pagesFetch(u: string, headers: Record<string, string> = {}): Promise<Response> {
  const url = new URL(u);
  if (!url.hostname.endsWith(".localhost")) return fetch(u, { headers });
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { ...headers, Host: url.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 0;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The page at `u` as its frame asks for it (a frame's document: it comes with what the viewer and the editor need). */
export const framed = (u: string, headers: Record<string, string> = {}) => pagesFetch(u, { ...headers, "Sec-Fetch-Dest": "iframe" });
