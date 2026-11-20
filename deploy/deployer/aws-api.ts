// AWS's API with the keys of one role, for the deployer in the cloud (aws-cloud.ts): each call is signed (Signature
// Version 4) and sent with fetch. Two services: Systems Manager (its JSON calls) and S3 (one upload). There is no SDK:
// the deployer's folder imports only Effect, and the same code runs in a test with a fetch of the test's own.
//
// Trap: the keys go only into the signature. No error and no log line of this file holds a key, a signature or a
// request's headers.

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Schema from "effect/Schema";
import { DeployError, type Fetch } from "./cloudflare-api";

/** A role's keys, as the Lambda's runtime gives them: they last for the function's run, and AWS changes them. */
export interface AwsKeys {
  id: string;
  secret: string;
  token?: string;
}

/** A call that AWS refused: `code` is AWS's own name of the refusal (ParameterNotFound, AccessDeniedException). */
export class AwsRefusal extends DeployError {
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super({ message, status });
    this.code = code;
  }
}

const text = new TextEncoder();
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Hex.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const hmac = async (key: Uint8Array<ArrayBuffer>, message: string) => {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, text.encode(message)));
};

/** One request to sign: its path has only plain characters (no query, nothing to encode), and `headers` has the host. */
export interface Signed {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * The request's headers with AWS's signature (Signature Version 4): the date, the session's token when the keys have
 * one, and Authorization. Every header of the request is signed.
 */
export async function sign(req: Signed, keys: AwsKeys, region: string, service: string, now: number): Promise<Record<string, string>> {
  if (!/^\/[A-Za-z0-9/._-]*$/.test(req.path)) throw new DeployError({ message: `"${req.path}" is not a path that this code signs.` });
  const at = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = at.slice(0, 8);
  const headers: Record<string, string> = {
    ...req.headers,
    "x-amz-date": at,
    ...(keys.token ? { "x-amz-security-token": keys.token } : {}),
  };
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([n, v]) => [n.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonical = [req.method, req.path, "", ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), await sha256(req.body)].join(
    "\n"
  );
  const scope = `${day}/${region}/${service}/aws4_request`;
  let key = await hmac(text.encode(`AWS4${keys.secret}`), day);
  for (const part of [region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = Hex.encode(await hmac(key, ["AWS4-HMAC-SHA256", at, scope, await sha256(text.encode(canonical))].join("\n")));
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${keys.id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** AWS's refusal of a JSON call: its name (`__type`, with or without a prefix) and its words. */
const Refused = Schema.Struct({
  __type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  Message: Schema.optionalKey(Schema.String),
});
const refusedOf = Schema.decodeUnknownOption(Schema.fromJsonString(Refused));

/** AWS's API in one region, with one role's keys. Every call says what it is for (`what`), so a refusal says what could not be done. */
export class Aws {
  constructor(
    private keys: AwsKeys,
    readonly region: string,
    private fetch: Fetch = globalThis.fetch
  ) {}

  /** One signed request: AWS's answer, whatever its status. */
  private send(service: string, host: string, req: Omit<Signed, "headers"> & { headers?: Record<string, string> }, what: string) {
    return Effect.gen({ self: this }, function* () {
      // Every request goes to AWS: a bucket's or a region's name that makes another host is refused.
      if (!/^[a-z0-9][a-z0-9.-]*\.amazonaws\.com$/.test(host))
        return yield* new DeployError({ message: `"${host}" is not a host of AWS's.` });
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: async () => {
          const headers = await sign({ ...req, headers: { ...req.headers, host } }, this.keys, this.region, service, now);
          const { host: _, ...sent } = headers;
          return this.fetch(`https://${host}${req.path}`, { method: req.method, headers: sent, body: req.body });
        },
        catch: (e) =>
          e instanceof DeployError
            ? e
            : new DeployError({
                message: `Couldn't reach AWS to ${what}: ${e instanceof Error ? e.message : String(e)}. Try again in a moment.`,
              }),
      });
    });
  }

  /**
   * One call of Systems Manager (SendCommand, GetParameter, ...): its answer, as `schema` reads it. A refusal is an
   * AwsRefusal with AWS's name for it; an answer that the schema can't read is a refusal too.
   */
  ssm<A>(operation: string, input: Record<string, unknown>, schema: Schema.Codec<A>, what: string): Effect.Effect<A, DeployError> {
    return Effect.gen({ self: this }, function* () {
      const r = yield* this.send(
        "ssm",
        `ssm.${this.region}.amazonaws.com`,
        {
          method: "POST",
          path: "/",
          headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AmazonSSM.${operation}` },
          body: text.encode(JSON.stringify(input)),
        },
        what
      );
      const body = yield* Effect.promise(() => r.text().catch(() => ""));
      if (r.status != 200) {
        const refused = refusedOf(body);
        const said = refused._tag == "Some" ? refused.value : {};
        const code = (said.__type ?? "").split("#").at(-1) ?? "";
        const why = said.message ?? said.Message ?? "";
        return yield* new AwsRefusal(
          `AWS refused to ${what} (${[r.status, code, why.slice(0, 300)].filter(Boolean).join(": ")}).`,
          r.status,
          code
        );
      }
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body || "{}").pipe(
        Effect.mapError(
          (e) => new DeployError({ message: `AWS answered in a way Erga doesn't understand when it tried to ${what}: ${e.message}` })
        )
      );
    });
  }

  /**
   * Puts one object in a bucket, in one request (a file in parts would need kms:Decrypt, which the role does not
   * have). The bucket's own rule encrypts it.
   */
  putObject(bucket: string, key: string, bytes: Uint8Array<ArrayBuffer>, what: string): Effect.Effect<void, DeployError> {
    return Effect.gen({ self: this }, function* () {
      const hash = yield* Effect.promise(() => sha256(bytes));
      const r = yield* this.send(
        "s3",
        `${bucket}.s3.${this.region}.amazonaws.com`,
        { method: "PUT", path: `/${key}`, headers: { "x-amz-content-sha256": hash }, body: bytes },
        what
      );
      if (r.status == 200) return;
      // S3 answers in XML: its name of the refusal, and nothing else of its answer.
      const body = yield* Effect.promise(() => r.text().catch(() => ""));
      const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(body)?.[1] ?? "";
      return yield* new AwsRefusal(`AWS refused to ${what} (${[r.status, code].filter(Boolean).join(": ")}).`, r.status, code);
    });
  }
}
