// Cloudflare's API as it really answers (control/deploys/cloudflare-api.ts), not as its API schema says: the assets'
// upload session answered `"errors": null, "messages": null` (recorded 2026-10-29 from api.cloudflare.com, its JWT
// swapped for one of the same shape). The client read that as no answer at all, and every deploy stopped at "Upload
// the editor's files" (no upload token came back). dev/mock-cloudflare.ts answers the same way now.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Cloudflare, DeployError } from "../control/deploys/cloudflare-api";
import { uploadAssets } from "../control/deploys/account";

const claims = { iss: "https://api.workers.cloudflare.com", wrangler_single_asset_uploads: false, edge_kv: false };
const JWT = `cfwau_eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** The upload session's answer, as recorded (pretty-printed, field order and all). */
const SESSION = JSON.stringify(
  { result: { jwt: JWT, buckets: [["0123456789abcdef0123456789abcdef"]] }, success: true, errors: null, messages: null },
  null,
  2
);

/** A fetch that answers each call in turn with `answers`, and keeps the calls. */
function cloudflare(...answers: Response[]) {
  const calls: string[] = [];
  const cf = new Cloudflare("token", (async (input: string) => {
    calls.push(String(input));
    return answers.shift()!;
  }) as never);
  return { cf, calls };
}
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(e));

test("an answer with errors and messages null: its result, as Cloudflare sent it", async () => {
  const { cf } = cloudflare(new Response(SESSION, { headers: { "content-type": "application/json" } }));
  const r = await run(cf.request("POST", "/accounts/a/workers/scripts/w/assets-upload-session", "start uploading"));
  expect(r._tag).toBe("Success");
  expect(r._tag == "Success" && r.success).toEqual({ jwt: JWT, buckets: [["0123456789abcdef0123456789abcdef"]] });
});

test("the editor's files go up on Cloudflare's real answers: the session, then the bucket, then the completion token", async () => {
  const bytes = new TextEncoder().encode("hello");
  // The session asks for whatever hash the file has: the answer names it.
  const { assetHash } = await import("../control/deploys/account");
  const hash = await assetHash("/probe.txt", bytes);
  const { cf, calls } = cloudflare(
    new Response(SESSION.replace("0123456789abcdef0123456789abcdef", hash)),
    new Response(JSON.stringify({ result: { jwt: "completion" }, success: true, errors: null, messages: null }), { status: 201 })
  );
  const r = await run(uploadAssets(cf, "/accounts/a", "w", { "/probe.txt": bytes }));
  expect(r).toMatchObject({ _tag: "Success", success: "completion" });
  expect(calls.map((c) => c.replace(/^.*\/client\/v4/, ""))).toEqual([
    "/accounts/a/workers/scripts/w/assets-upload-session",
    "/accounts/a/workers/assets/upload?base64=true",
  ]);
});

test("a refusal still says Cloudflare's words; a refusal of another shape is left out, not the answer", async () => {
  const { cf } = cloudflare(
    Response.json(
      { result: null, success: false, errors: [{ code: 10000, message: "Authentication error" }, { code: "odd" }], messages: null },
      { status: 403 }
    )
  );
  const r = await run(cf.request("POST", "/x", "upload the Worker"));
  expect(r._tag).toBe("Failure");
  const e = r._tag == "Failure" ? (r.failure as DeployError) : null;
  expect(e?.status).toBe(403);
  expect(e?.message).toContain("Authentication error [code 10000]");
});
