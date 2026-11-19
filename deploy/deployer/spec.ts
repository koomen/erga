// An instance's spec: what a deploy needs to know about the instance, and nothing else. One spec and one release give
// one deploy: the spec names the repository and the branch whose releases the instance runs, the target (where it is,
// on Cloudflare or on AWS), its plain settings and the names of its secrets. It holds no secret's value: the values
// stay on the instance's platform. The instance holds its spec; a machine and the deployer in the cloud read the same one.
//
// The deployer holds a credential that can run code in someone's account, and the spec's names go into API paths, into
// a shell script on AWS's machine and into the release's address on GitHub. So each name has a strict pattern, and an
// unknown key is an error: read a spec only with decodeSpec.
//
// Trap: a name here is never trusted because it came from the instance. A pattern that gets wider (a "/", a space, a
// quote, "..") is a way into a path or a script.

import * as Schema from "effect/Schema";

/** Text of at most `max` characters that matches `pattern`. The length is first, and a text over it never meets the pattern. */
const text = (pattern: RegExp, max: number) => Schema.String.check(Schema.isMaxLength(max).abort(), Schema.isPattern(pattern));

/** A DNS name in lower case, with a dot: example.com, erga.example.com. */
const Host = text(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 253);
/** A name of Cloudflare's: a Worker, a database, a workers.dev subdomain. */
const Name = text(/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/, 63);

/**
 * The repository on GitHub whose releases the instance runs, as github.com/<owner>/<name>, in GitHub's own case. The
 * release's address is the lower-case form: make it where the release is fetched, not here.
 */
const Repo = text(/^github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/, 200);
/** A branch's name: no "..", and no "-" in front (a command would read it as an option). */
const Branch = text(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/, 200);

/**
 * The name of a setting or a secret, as the server reads it: GITHUB_CLIENT_ID. Never one of the deploy's own names
 * (ERGA_VERSION, PAGES_HOST): the deploy sets those, from the release and the target.
 */
const Variable = text(/^(?!ERGA_|PAGES_)[A-Z][A-Z0-9_]*$/, 64);

/** An instance on Cloudflare: a Worker and its database in one account, the app's address, and where documents' pages run. */
const Cloudflare = Schema.Struct({
  kind: Schema.Literal("cloudflare"),
  account: text(/^[0-9a-f]{32}$/, 32),
  worker: Name,
  database: Name,
  /** The account's workers.dev subdomain: a workers.dev app and shared pages need it. */
  subdomain: Schema.optionalKey(Name),
  /** The app's address: <worker>.<subdomain>.workers.dev, or a hostname on one of the account's zones. */
  app: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("workers.dev") }),
    Schema.Struct({ kind: Schema.Literal("domain"), zoneName: Host, hostname: Host }),
  ]),
  /** Documents' pages: one shared host, <worker>-pages.<subdomain>.workers.dev, or an origin each under a domain of a zone. */
  pages: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("shared") }),
    Schema.Struct({ kind: Schema.Literal("zone"), zoneName: Host, domain: Schema.optionalKey(Host) }),
  ]),
  /** The custom domains for publishing. */
  domains: Schema.optionalKey(Schema.Array(Host).check(Schema.isUnique())),
}).check(
  Schema.makeFilter((t) =>
    t.subdomain || (t.app.kind == "domain" && t.pages.kind == "zone") ? true : "a workers.dev app and shared pages need the subdomain"
  )
);

/** An instance on AWS: its stack, and what the stack made. */
const Aws = Schema.Struct({
  kind: Schema.Literal("aws"),
  account: text(/^[0-9]{12}$/, 12),
  region: text(/^[a-z]{2}(-[a-z]+)+-[0-9]$/, 32),
  stack: text(/^[A-Za-z][A-Za-z0-9-]*$/, 128),
  bucket: text(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 63),
  /** The machine's EC2 id. */
  machine: text(/^i-[0-9a-f]{8,17}$/, 19),
  /** With a gate in front: the secret (its ARN, in Secrets Manager) that holds the key that the gate sends the machine. */
  gate: Schema.optionalKey(text(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/, 512)),
  /** The app's host: its domain, or its CloudFront name. */
  app: Host,
  /** Documents' pages: one shared CloudFront name, or an origin each under a domain. */
  pages: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("shared"), host: Host }),
    Schema.Struct({ kind: Schema.Literal("domain"), domain: Host }),
  ]),
});

const Spec = Schema.Struct({
  repo: Repo,
  branch: Branch,
  target: Schema.Union([Cloudflare, Aws]),
  /** The server's plain settings, by name: the same text on each deploy. */
  settings: Schema.Record(Variable, Schema.String),
  /** The names of the secrets that the instance holds. Never a value. */
  secrets: Schema.Array(Variable).check(Schema.isUnique()),
}).check(
  Schema.makeFilter((s) => {
    const both = s.secrets.filter((name) => Object.hasOwn(s.settings, name));
    return both.length ? `a name is a setting or a secret, not both: ${both.join(", ")}` : true;
  })
);
export type Spec = typeof Spec.Type;
export type CloudflareTarget = typeof Cloudflare.Type;
export type AwsTarget = typeof Aws.Type;

/** The spec in a value from outside (the instance's database, a file), or a SchemaError that names each wrong part. */
export const decodeSpec = Schema.decodeUnknownEffect(Spec, { onExcessProperty: "error", errors: "all" });
