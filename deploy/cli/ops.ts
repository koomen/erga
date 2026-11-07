// The CLI's side of an instance's ops token: it asks the server for one (the device flow, scope "ops"), an admin
// approves it in the browser, and the CLI reads the instance's deploy facts with it (GET /api/ops). Both are
// server/api.ts's. `bun erga register` and `bun erga login` call these; they keep the token.

import * as Schema from "effect/Schema";

/** The app's address: its workers.dev address, or a hostname on one of the account's zones (deploy/pipeline/pipeline.ts, Target). */
const App = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workers.dev") }),
  Schema.Struct({
    kind: Schema.Literal("domain"),
    zoneId: Schema.optionalKey(Schema.String),
    zoneName: Schema.String,
    hostname: Schema.String,
  }),
]);
/** Where documents' pages run: the shared workers.dev host, or a domain of their own (Target's pages). */
const Pages = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("shared") }),
  Schema.Struct({
    kind: Schema.Literal("zone"),
    zoneId: Schema.optionalKey(Schema.String),
    zoneName: Schema.String,
    domain: Schema.optionalKey(Schema.String),
  }),
]);

/**
 * Where a deploy finds an instance on Cloudflare: the pipeline's own names for it, and the Worker's plain settings as
 * the pipeline sent them (deploy/pipeline/account.ts, deployFacts).
 */
export const CloudflareFacts = Schema.Struct({
  account: Schema.String,
  worker: Schema.String,
  database: Schema.String,
  subdomain: Schema.optionalKey(Schema.String),
  app: App,
  pages: Pages,
  /** The homepage's own domain, if it has one (Target's home). */
  home: Schema.optionalKey(Schema.String),
  vars: Schema.Record(Schema.String, Schema.String),
});

/**
 * Where a deploy finds an instance on AWS: its stack and what the stack made (deploy/aws/deploy.ts, awsFacts), and the
 * Worker's plain settings.
 */
export const AwsFacts = Schema.Struct({
  aws: Schema.Struct({
    account: Schema.String,
    region: Schema.String,
    stack: Schema.String,
    bucket: Schema.String,
    machine: Schema.String,
    /** The app's host: its domain, or its CloudFront name. */
    app: Schema.String,
    /** Documents' pages: one shared CloudFront name, or an origin each under a domain. */
    pages: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("shared"), host: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("domain"), domain: Schema.String }),
    ]),
  }),
  vars: Schema.Record(Schema.String, Schema.String),
});
export type AwsFacts = typeof AwsFacts.Type;

export const DeployFacts = Schema.Union([CloudflareFacts, AwsFacts]);
export type DeployFacts = typeof DeployFacts.Type;

/** What GET /api/ops answers: the commit the instance runs, its target, its host, and its deploy facts (null locally). */
const OpsFacts = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
  host: Schema.String,
  deploy: Schema.NullOr(DeployFacts),
});
export type OpsFacts = typeof OpsFacts.Type;

const Asked = Schema.Struct({ code: Schema.String, approve_url: Schema.String, interval: Schema.Number, expires_in: Schema.Number });
const Polled = Schema.Struct({
  status: Schema.String,
  token: Schema.optionalKey(Schema.String),
  login: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

type Site = (url: string, init?: RequestInit) => Promise<Response>;

const post = (url: string, body: object, site: Site = fetch) =>
  site(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** The server's error in its own words, or the status. */
const failed = async (r: Response, what: string) =>
  new Error(`${what}: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`}`);

/**
 * Asks `origin` for an ops token: `say` gets the link an admin opens to approve it, and the call waits until they
 * approve (the token and their login) or deny it, or the request lapses (an error).
 */
export async function askOpsToken(
  origin: string,
  o: { label?: string; say?: (line: string) => void; site?: Site } = {}
): Promise<{ token: string; login: string }> {
  const r = await post(`${origin}/api/auth/request`, { label: o.label ?? "bun erga", scope: "ops" }, o.site);
  if (!r.ok) throw await failed(r, `${origin} gave no sign-in`);
  const asked = Schema.decodeUnknownSync(Asked)(await r.json());
  (o.say ?? console.log)(`Open ${asked.approve_url} as an admin, and approve it.`);
  const until = Date.now() + asked.expires_in * 1000;
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, asked.interval * 1000));
    const p = await post(`${origin}/api/auth/poll`, { code: asked.code }, o.site);
    const got = Schema.decodeUnknownSync(Polled)(await p.json());
    if (got.status == "approved" && got.token && got.login) return { token: got.token, login: got.login };
    if (got.status != "pending") throw new Error(`No ops token: ${got.error ?? got.status}`);
  }
  throw new Error("No ops token: nobody approved it in time.");
}

/** The instance's deploy facts, with its ops token (an error if the token doesn't work: expired, revoked, not an admin's). */
export async function readOps(origin: string, token: string, site: Site = fetch): Promise<OpsFacts> {
  const r = await site(`${origin}/api/ops`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw await failed(r, `${origin} refused the ops token`);
  return Schema.decodeUnknownSync(OpsFacts)(await r.json());
}
