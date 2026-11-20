// The gate in front of an instance on AWS (SSO: gate/mounts/cloudfront.ts, gate/mounts/lambda.ts): what the deploy
// does for it besides the stacks (deploy/aws/template.ts has its resources).
//
//   the code       each of the gate's four CloudFront Functions and its Lambda@Edge function, built for this instance
//                  (gate/build.ts): its settings are in the code, since nothing at the edge has environment variables.
//                  The templates carry the code
//   the edge key   one random value in the functions' KeyValueStore, which signs every cookie and token of the gate.
//                  CloudFormation can't write a store's key: the deploy puts it there one time, after the us-east-1
//                  stack made the store and before a distribution exists. It is made on this machine, goes to the
//                  store, and is kept nowhere else: Erga never holds it
//
// The gate's two other secrets are not this file's: the key that the distributions send the machine (GATE_KEY) is the
// stack's own secret, which AWS makes (template.ts, GateKey; the machine reads it at each deploy: machine.ts); the
// client secret of the organization's sign-in is a parameter that the user's own page writes (setup.ts,
// putOidcSecret), and only the Lambda reads it.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFunction, buildLambda } from "../../gate/build.ts";
import { type Config, SIGN_IN_DAYS } from "../../gate/core.ts";
import { gateParam } from "../deployer/aws";
import { gateHash } from "../release";
import type { Aws } from "./cli";
import { type AwsShape, GATE_PARTS, type GateCode, idpSecretParam, type Oidc } from "./template";

/** Records which gate the stacks have now (deploy/release.ts, gateHash), after setup applied them. */
export const putGateHash = (aws: Aws, stack: string, hash = gateHash()) =>
  aws("ssm", "put-parameter", "--name", gateParam(stack), "--type", "String", "--overwrite", "--value", hash);

/** The name of the organization's sign-in in the gate (one issuer: the gate's sign-in goes straight to it). */
const IDP = "sso";
/** CloudFormation's limit on a Lambda function's code in a template (ZipFile). */
export const INLINE_MAX = 4096;

/**
 * The gate's settings for an instance: its hosts, and the organization's sign-in. Only people with a proof come in.
 * `days`: how long a sign-in lasts (--sign-in-days). Erga's own setting (sign_in_days) doesn't reach this gate.
 */
export const gateSettings = (d: NonNullable<AwsShape["domains"]>, oidc: Oidc, days = SIGN_IN_DAYS): Omit<Config, "key"> => ({
  shell: d.app,
  content: d.pages,
  https: true,
  open: false,
  idp: { [IDP]: { authorize: oidc.authorize, client: oidc.clientId, scope: "openid email profile" } },
  oauth: true,
  hours: days * 24,
});

/**
 * The gate's code for an instance (template.ts, GateCode). `region`: where the Lambda reads the client's secret
 * (us-east-1, the Lambda's own region). `days`: gateSettings'.
 */
export async function gateCode(
  stack: string,
  d: NonNullable<AwsShape["domains"]>,
  oidc: Oidc,
  region: string,
  days?: number
): Promise<GateCode> {
  const config = gateSettings(d, oidc, days);
  const functions = Object.fromEntries(
    await Promise.all(GATE_PARTS.map(async (part) => [part, await buildFunction(part, config)]))
  ) as GateCode["functions"];
  const built = await buildLambda({
    shell: d.app,
    region,
    idp: { [IDP]: { issuer: oidc.issuer, token: oidc.token, client: oidc.clientId, secret: idpSecretParam(stack) } },
  });
  // The build is a module; CloudFormation's inline code is a script (index.js).
  const lambda = built.replace(/export\s*\{\s*([\w$]+) as handler\s*\};?\s*$/, "exports.handler=$1;");
  if (lambda == built) throw new Error("The gate's Lambda@Edge build has no handler.");
  if (lambda.length > INLINE_MAX)
    throw new Error(`The gate's Lambda@Edge function is ${lambda.length} characters: CloudFormation takes ${INLINE_MAX} inline at most.`);
  return { functions, lambda };
}

/**
 * Puts the edge key in the gate's KeyValueStore (`store`: its ARN, the us-east-1 stack's output), unless it has one: a new key
 * would end every sign-in and every agent's token. The key goes through a file of this user's only, never a command
 * line (a process list shows a command's words, and the CLI takes a value that starts with "-" for an option), and
 * the file goes at once. The result: whether it made one.
 */
export async function putEdgeKey(aws: Aws, store: string): Promise<boolean> {
  const has = await aws("cloudfront-keyvaluestore", "get-key", "--kvs-arn", store, "--key", "key").then(
    () => true,
    (e: Error) => {
      if (/ResourceNotFound|not found/i.test(e.message)) return false;
      throw e;
    }
  );
  if (has) return false;
  const { ETag } = await aws<{ ETag: string }>("cloudfront-keyvaluestore", "describe-key-value-store", "--kvs-arn", store);
  const dir = mkdtempSync(join(tmpdir(), "erga-edge-key-"));
  const file = join(dir, "key");
  writeFileSync(file, randomBytes(48).toString("base64url"), { mode: 0o600 });
  try {
    await aws("cloudfront-keyvaluestore", "put-key", "--kvs-arn", store, "--key", "key", "--value", `file://${file}`, "--if-match", ETag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return true;
}
