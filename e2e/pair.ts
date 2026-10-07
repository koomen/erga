// Production and staging as two dev servers that talk to each other
// (servers.pair in fixtures.ts), as admin-auth's tests need: each plays its
// deploy target on the mock Cloudflare (ERGA_DEPLOY_TARGET, ERGA_DEPLOY_MOCK,
// whose DEPLOY_HOOK_SECRET they share), each is pointed at the other
// (ERGA_PEER_ORIGIN), and a stand-in GitHub answers their live checks of an
// app (ERGA_GITHUB_ORIGIN). Production has its app (deploy/targets.json's
// client ID, and a secret here); staging has none.
//
// The stand-in knows production's app, and any client ID starting Ov23liTest,
// whose secret is `good-<client ID>`: so each test makes apps of its own.

import { createServer, type Server as HttpServer } from "node:http";
import { freePort, startServer, type Server } from "./server";

/** Production's app (deploy/targets.json) and its secret. */
export const PROD_APP = { clientId: "Ov23ctkY7oLarHcPA97b", secret: `prod-secret-${crypto.randomUUID()}` };
/** An app the stand-in GitHub knows, made for one test. */
export const newApp = () => { const clientId = `Ov23liTest${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`; return { clientId, secret: `good-${clientId}` }; };

export interface Pair {
  prod: Server;
  staging: Server;
  alive(): boolean;
  dispose(): void;
}

/** GitHub's token endpoint, as it answers a code that can't be real: which app, and whether its secret is right. */
function standInGitHub(): Promise<HttpServer> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let b: { client_id?: string; client_secret?: string } = {};
      try { b = JSON.parse(raw); } catch { /* not JSON */ }
      const id = b.client_id ?? "";
      const secret = id == PROD_APP.clientId ? PROD_APP.secret : id.startsWith("Ov23liTest") ? `good-${id}` : null;
      const [status, body] = secret == null ? [404, { error: "Not Found" }] : secret != b.client_secret ? [200, { error: "incorrect_client_credentials" }] : [200, { error: "bad_verification_code" }];
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export async function startPair(): Promise<Pair> {
  const github = await standInGitHub();
  const GITHUB = `http://127.0.0.1:${(github.address() as { port: number }).port}`;
  // Each names the other's address as it starts, so both ports are chosen first; one taken in between: both again.
  for (let attempt = 0; ; attempt++) {
    const prodPort = await freePort(), stagingPort = await freePort();
    const started = await Promise.allSettled([
      startServer({ port: prodPort, env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "production", GITHUB_CLIENT_SECRET: PROD_APP.secret, ERGA_GITHUB_ORIGIN: GITHUB, ERGA_PEER_ORIGIN: `http://127.0.0.1:${stagingPort}` } }),
      startServer({ port: stagingPort, env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging", ERGA_GITHUB_CLIENT_ID: "", ERGA_GITHUB_ORIGIN: GITHUB, ERGA_PEER_ORIGIN: `http://127.0.0.1:${prodPort}` } }),
    ]);
    if (started[0].status == "fulfilled" && started[1].status == "fulfilled") {
      const [prod, staging] = [started[0].value, started[1].value];
      return {
        prod, staging,
        alive: () => prod.alive() && staging.alive(),
        dispose() { prod.dispose(); staging.dispose(); github.close(); },
      };
    }
    for (const s of started) if (s.status == "fulfilled") s.value.dispose();
    const why = started.find((s) => s.status == "rejected") as PromiseRejectedResult;
    if (attempt >= 2 || !/port \d+ is taken/.test(String(why.reason))) { github.close(); throw why.reason; }
  }
}
