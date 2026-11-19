// What the verify suite may touch (dev/verify.ts, `bun erga verify`), as rules in code. Pure: tests/verify-suite.test.ts.
//
//   names    every resource that a run makes, and every one it deletes, is named erga-verify or erga-verify-<more>
//   hosts    every host is under one of the test zones of this machine's settings (config.ts). A test zone is under no
//            name of the settings' `refuse` list, and no registered instance (.erga/config.json) has a host at it or
//            under it
//   whole    a dedicated account: the account, its zones and its Zero Trust team are the suite's own, and hold nothing
//            else. `strangers` says what in them the suite did not make, and a run refuses to start while there is any
//            (dedicated.ts reads the accounts)
//   shared   an account that holds other work too (the settings say `shared`): only the two test zones are the suite's
//            own, and hold nothing else. The account's other zones, Workers, databases and buckets are not the
//            suite's: it does not read them, and never changes one. In the account's Zero Trust team, when the
//            settings name it, the suite makes and deletes only applications and identity providers of its own name
//   calls    in each kind of account, every call of Cloudflare's API goes through `apiProblem` before it is sent
//            (dedicated.ts, `guarded`), and every Worker that wrangler deploys through `workerProblem`: a call that
//            names anything but the suite's own is refused, a read too. What the rule does not know, it refuses
//
// The code holds no organization's name (AGENTS.md, rule 9): the names to refuse are this machine's, in `refuse`.

const NAME = /^erga-verify(-[a-z0-9-]+)?$/;

/** Whether the name is the suite's own. */
export const ours = (name: string) => NAME.test(name);

/** The name, when it is the suite's own; else it throws: a run deletes nothing else. */
export function mine(name: string): string {
  if (!ours(name)) throw new Error(`${name} is not a resource of the verify suite (erga-verify-...): it stays as it is.`);
  return name;
}

/** Whether `host` is `domain` or under it. */
export const under = (host: string, domain: string) => host == domain || host.endsWith(`.${domain}`);

/** Why `zone` can't be a test zone, or null. `instances`: each host that a registered instance has. */
export function zoneProblem(zone: string, o: { refuse: string[]; instances: string[] }): string | null {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(zone)) return `${zone || "(empty)"} is not a zone's name.`;
  const refused = o.refuse.find((r) => r && under(zone, r.toLowerCase()));
  if (refused) return `${zone} is under ${refused}, which this machine's settings refuse.`;
  const live = o.instances.find((h) => under(h, zone));
  if (live) return `${zone} holds ${live}, a registered instance's host: a test zone holds only the runs' hosts.`;
  return null;
}

/** Why `host` is not a run's host, or null: it is under a test zone. */
export const hostProblem = (host: string, zones: string[]): string | null =>
  zones.some((d) => d && under(host, d)) ? null : `${host} is under no test zone (${zones.filter(Boolean).join(", ") || "none is set"}).`;

/** A run's host on Cloudflare: a shell (s<n>.<shell>) or under it, or under a setting's content (c<n>.<content>). */
export const runHost = (host: string, c: { shell: string; content: string }) =>
  !!c.shell && !!c.content && [1, 2, 3, 4, 5, 6].some((n) => under(host, `s${n}.${c.shell}`) || under(host, `c${n}.${c.content}`));

/** What the accounts hold, as dedicated.ts read it. null: not read. */
export interface Held {
  cloudflare: {
    /** Each account that the API token reaches. */
    accounts: string[] | null;
    /**
     * By the zone's name: its account, its DNS records, its Workers routes, and its Custom Domains (each with the
     * Worker that has it); null: the token sees no such zone.
     */
    zones: Record<
      string,
      {
        account: string;
        records: { type: string; name: string }[];
        routes: string[];
        domains: { hostname: string; service: string }[];
      } | null
    >;
    /** The account's zones besides the two test zones. (A shared account: not looked at.) */
    otherZones: string[] | null;
    /** The account's Workers, D1 databases and R2 buckets, by name. (A shared account: not looked at.) */
    workers: string[] | null;
    databases: string[] | null;
    buckets: string[] | null;
    /** The account's Zero Trust team ("": it has none), its Access applications and its identity providers. (A shared account: not read.) */
    team: string | null;
    apps: string[] | null;
    providers: string[] | null;
  };
  aws: {
    /** The account that the profile reaches, and its CloudFormation stacks (us-east-1, where the runs' stacks go). */
    account: string | null;
    stacks: string[] | null;
  };
}

/**
 * Why the Cloudflare account is not the suite's to run in, as lines; none: it is. The token reaches the settings'
 * account only, and the two test zones are that account's. The zones' DNS records, routes and Custom Domains are all
 * the suite's (a run that stopped left them: `bun erga verify remove` takes them away). One kind of record is not a
 * run's and may stay: the NS records that hand a name of a zone to Route 53, for the settings' two AWS zones.
 * A dedicated account: it has no zone but the two, its team is the settings', and its Workers, databases and buckets,
 * and the team's Access applications and identity providers, are all the suite's.
 * A shared account: the rest of it is not the suite's, and is not looked at, but for the team's name.
 */
export function cloudflareStrangers(
  l: {
    cloudflare: { account: string; shell: string; content: string; team: string; shared: boolean };
    aws: { shell: string; content: string };
  },
  h: Held["cloudflare"]
): string[] {
  const c = l.cloudflare;
  const out: string[] = [];
  const some = (list: string[]) => `${list.slice(0, 4).join(", ")}${list.length > 4 ? `, and ${list.length - 4} more` : ""}`;
  if (!h.accounts) out.push("The API token's accounts were not read.");
  else if (h.accounts.length != 1 || h.accounts[0] != c.account)
    out.push(
      `The API token reaches ${h.accounts.length} accounts (${some(h.accounts.map((a) => `...${a.slice(-6)}`))}): the suite's token reaches only ...${c.account.slice(-6)}.`
    );
  for (const name of [c.shell, c.content]) {
    const z = h.zones[name];
    if (!z) {
      out.push(`The API token sees no zone ${name}.`);
      continue;
    }
    if (z.account != c.account) out.push(`The zone ${name} is in another account than ...${c.account.slice(-6)}.`);
    const delegated = (r: { type: string; name: string }) => r.type == "NS" && (r.name == l.aws.shell || r.name == l.aws.content);
    const records = z.records.filter((r) => !runHost(r.name, c) && !delegated(r)).map((r) => `${r.type} ${r.name}`);
    if (records.length) out.push(`The zone ${name} has DNS records that the suite did not make: ${some(records)}.`);
    const routes = z.routes.filter((r) => !runHost(r.replace(/\/.*$/, "").replace(/^\*\./, ""), c));
    if (routes.length) out.push(`The zone ${name} has Workers routes that the suite did not make: ${some(routes)}.`);
    const domains = z.domains.filter((d) => !runHost(d.hostname, c) || !ours(d.service)).map((d) => `${d.hostname} (${d.service})`);
    if (domains.length) out.push(`The zone ${name} has Custom Domains that the suite did not make: ${some(domains)}.`);
  }
  const team = () => {
    if (h.team == null) out.push("The account's Zero Trust team was not read.");
    else if (h.team != c.team) out.push(`The account's Zero Trust team is ${h.team || "not set up"}, not ${c.team}.`);
  };
  if (c.shared) {
    if (c.team) team();
    return out;
  }
  if (!h.otherZones) out.push("The account's zones were not read.");
  else if (h.otherZones.length) out.push(`The account has zones besides the two test zones: ${some(h.otherZones)}.`);
  /** A kind of thing in the account, by name: all the suite's, or a line that names the others. */
  const all = (names: string[] | null, what: string, where = "The account") => {
    if (!names) out.push(`${where}'s ${what} were not read.`);
    else if (names.some((n) => !ours(n)))
      out.push(`${where} has ${what} that the suite did not make: ${some(names.filter((n) => !ours(n)))}.`);
  };
  all(h.workers, "Workers");
  all(h.databases, "D1 databases");
  all(h.buckets, "R2 buckets");
  if (c.team) {
    team();
    all(h.apps, "Access applications", "The team");
    all(h.providers, "Access identity providers", "The team");
  }
  return out;
}

/** What a call of Cloudflare's API may name (`apiProblem`): the settings' account, and what in it is the suite's. */
export interface Scope {
  account: string;
  /** The Zero Trust team that the settings name ("": none; then no call names Access). */
  team: string;
  /** The two test zones' names. */
  shell: string;
  content: string;
  /** The two test zones, by ID: the zone's name. */
  zones: Record<string, string>;
  /** Each D1 database that a call names, by ID: its name, as the account says it ("": the account has none). */
  databases: Record<string, string>;
  /** Each Access application and identity provider that a call names, by ID: its name, as the team says it. */
  access: Record<string, string>;
}

/** The kinds of binding that a Worker of the suite's may have. Each one that names a thing of the account names one of the suite's. */
const BINDINGS = [
  "plain_text",
  "secret_text",
  "json",
  "assets",
  "browser",
  "worker_loader",
  "durable_object_namespace",
  "d1",
  "r2_bucket",
  "service",
];
const text = (v: unknown) => (typeof v == "string" ? v : "");
const fields = (v: unknown) => (v && typeof v == "object" ? (v as Record<string, unknown>) : {});

/** Why a Worker's upload may not have this binding (Cloudflare's metadata form), or null. */
function bindingProblem(binding: unknown, s: Scope): string | null {
  const b = fields(binding);
  const type = text(b.type);
  if (!BINDINGS.includes(type)) return `a binding of the kind ${type || "(none)"}`;
  if (type == "d1") {
    const ids = [b.id, b.database_id].filter((v) => v != null);
    if (!ids.length || !ids.every((id) => ours(s.databases[text(id)] ?? ""))) return "a database that is not the suite's";
  }
  if (type == "r2_bucket" && !ours(text(b.bucket_name))) return `the bucket ${text(b.bucket_name)}`;
  if (type == "service" && !ours(text(b.service))) return `the Worker ${text(b.service)}`;
  if (b.script_name != null && !ours(text(b.script_name))) return `the Worker ${text(b.script_name)}`;
  return null;
}

/**
 * Why the suite does not send a call of Cloudflare's API, or null: it names only the suite's own. `path`: the call's
 * path after /client/v4, with no query. `body`: its JSON; for a Worker's upload, its form's `metadata`.
 * A list of the account's names (its Workers, databases, buckets, zones) is read; nothing else of a thing that is not
 * the suite's is read, changed or deleted, and nothing of the whole account is changed.
 */
export function apiProblem(method: string, path: string, body: unknown, s: Scope): string | null {
  const no = (why: string) => `The verify suite does not send ${method} ${path}: ${why}. Nothing was sent.`;
  const read = method == "GET";
  const b = fields(body);
  if (!/^(\/[\w.*%@+-]+)+$/.test(path) || path.split("/").includes("..")) return no("it is no path of the API");
  const hosts = { shell: s.shell, content: s.content };
  const host = (name: unknown) => runHost(text(name).replace(/^\*\./, "").toLowerCase(), hosts);
  if (path == "/accounts" || path == "/zones") return read ? null : no("it changes more than the suite's own");

  const zone = /^\/zones\/([^/]+)(\/.*)?$/.exec(path);
  if (zone) {
    const rest = zone[2] ?? "";
    if (!s.zones[zone[1]]) return no("the zone is not a test zone");
    if (read)
      return ["", "/dns_records", "/workers/routes", "/ssl/universal/settings", "/ssl/certificate_packs"].includes(rest)
        ? null
        : no("the suite reads a zone's records, routes and certificates only");
    if (method == "POST" && rest == "/dns_records") return host(b.name) ? null : no(`${text(b.name) || "the record"} is not a run's host`);
    if (method == "POST" && rest == "/workers/routes")
      return host(text(b.pattern).replace(/\/.*$/, "")) && ours(text(b.script))
        ? null
        : no(`the route ${text(b.pattern)} to ${text(b.script)} is not a run's`);
    return no("the suite does not change a zone so");
  }

  const acc = `/accounts/${s.account}`;
  if (!s.account || (path != acc && !path.startsWith(`${acc}/`))) return no("it is not in the settings' account");
  const rest = path.slice(acc.length);
  // The account itself, and the lists of its names.
  if (
    ["", "/workers/scripts", "/workers/subdomain", "/workers/domains", "/d1/database", "/r2/buckets", "/rum/site_info/list"].includes(rest)
  ) {
    if (read) return null;
    if (method == "POST" && (rest == "/d1/database" || rest == "/r2/buckets"))
      return ours(text(b.name)) ? null : no(`${text(b.name) || "(no name)"} is not a name of the suite's`);
    if (method == "PUT" && rest == "/workers/domains")
      return host(b.hostname) && ours(text(b.service)) && s.zones[text(b.zone_id)]
        ? null
        : no(`the Custom Domain ${text(b.hostname)} of ${text(b.service)} is not a run's`);
    return no("it changes more than the suite's own");
  }
  // A file of a Worker's static assets: it goes up with the token of an upload that began at one of the suite's Workers.
  if (method == "POST" && /^\/workers\/assets\/upload(\/[^/]+)?$/.test(rest)) return null;
  const worker = /^\/workers\/scripts\/([^/]+)(\/.*)?$/.exec(rest);
  if (worker) {
    if (!ours(worker[1])) return no(`the Worker ${worker[1]} is not the suite's`);
    if (method != "PUT" || worker[2]) return null;
    const bad = ((fields(b.metadata).bindings ?? []) as unknown[]).map((x) => bindingProblem(x, s)).find(Boolean);
    return bad
      ? no(`the Worker would have ${bad}`)
      : Array.isArray(fields(b.metadata).bindings)
        ? null
        : no("the upload names no bindings");
  }
  const database = /^\/d1\/database\/([^/]+)(\/.*)?$/.exec(rest);
  if (database) return ours(s.databases[database[1]] ?? "") ? null : no("the database is not the suite's");
  const bucket = /^\/r2\/buckets\/([^/]+)(\/.*)?$/.exec(rest);
  if (bucket) return ours(bucket[1]) ? null : no(`the bucket ${bucket[1]} is not the suite's`);
  // The Zero Trust team that the settings name: its name, the lists of its applications and identity providers, and
  // the suite's own applications (for a run's hosts only) and identity providers.
  const access = /^\/access\/(organizations|apps|identity_providers)(?:\/([^/]+)(\/.*)?)?$/.exec(rest);
  if (access) {
    if (!s.team) return no("the settings name no Zero Trust team");
    const [, kind, id] = access;
    if (id)
      return kind != "organizations" && ours(s.access[id] ?? "")
        ? null
        : no("it is not an application or identity provider of the suite's");
    if (read) return null;
    if (method != "POST" || kind == "organizations") return no("it changes the team");
    // (A request with no values makes nothing: Cloudflare refuses it after it checked the permission. prereqs.ts)
    if (!Object.keys(b).length) return null;
    if (!ours(text(b.name))) return no(`${text(b.name) || "(no name)"} is not a name of the suite's`);
    const protectedHosts = kind == "apps" ? [b.domain, ...((b.self_hosted_domains ?? []) as unknown[])] : [];
    const strange = [
      ...protectedHosts.filter((h) => !host(text(h).replace(/\/.*$/, ""))),
      ...(b.destinations != null ? ["its destinations"] : []),
    ];
    return strange.length || (kind == "apps" && !protectedHosts.length)
      ? no(`the application would be at ${strange.map(text).join(", ") || "no host"}, not at a run's host`)
      : null;
  }
  return no("the suite's rule does not know this call");
}

/** A Worker's settings for wrangler, as the suite writes them (cloudflare.ts, deployWorker). */
const WORKER_KEYS = [
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "vars",
  "routes",
  "services",
  "durable_objects",
  "migrations",
];

/**
 * Why wrangler may not deploy a Worker with these settings, or null: its name is the suite's, each of its hosts is a
 * Custom Domain at a run's host, and it binds nothing of the account but Workers of the suite's and its own classes.
 */
export function workerProblem(config: Record<string, unknown>, c: { shell: string; content: string }): string | null {
  const name = text(config.name);
  if (!ours(name)) return `${name || "(no name)"} is not a Worker of the verify suite (erga-verify-...): it is not deployed.`;
  const no = (why: string) => `${name} is not deployed: ${why}.`;
  const unknown = Object.keys(config).filter((k) => !WORKER_KEYS.includes(k));
  if (unknown.length) return no(`the suite's rule does not know the setting ${unknown.join(", ")}`);
  for (const r of (config.routes ?? []) as unknown[]) {
    const route = fields(r);
    if (route.custom_domain !== true || Object.keys(route).some((k) => k != "pattern" && k != "custom_domain"))
      return no(`${text(route.pattern) || "a route"} is not a Custom Domain`);
    if (!runHost(text(route.pattern), c)) return no(`${text(route.pattern)} is not a run's host`);
  }
  for (const s of (config.services ?? []) as unknown[])
    if (!ours(text(fields(s).service))) return no(`it would bind the Worker ${text(fields(s).service)}`);
  for (const d of (fields(config.durable_objects).bindings ?? []) as unknown[])
    if (fields(d).script_name != null) return no("it would bind another Worker's class");
  return null;
}

/**
 * Why the AWS account is not the suite's to run in, as lines; none: it is the settings' account. A dedicated account:
 * each stack in it is the suite's. A shared account: its other stacks are not the suite's, and are not looked at.
 */
export function awsStrangers(l: { aws: { account: string; shared: boolean } }, h: Held["aws"]): string[] {
  const out: string[] = [];
  if (!h.account) out.push("The AWS profile's account was not read.");
  else if (h.account != l.aws.account)
    out.push(`The AWS profile reaches the account ...${h.account.slice(-4)}, not the settings' (...${l.aws.account.slice(-4)}).`);
  if (l.aws.shared) return out;
  if (!h.stacks) out.push("The account's CloudFormation stacks were not read.");
  else if (h.stacks.some((s) => !ours(s))) {
    const other = h.stacks.filter((s) => !ours(s));
    out.push(
      `The AWS account has ${other.length} CloudFormation stacks that the suite did not make (${other.slice(0, 4).join(", ")}${other.length > 4 ? ", ..." : ""}): it is not the suite's own.`
    );
  }
  return out;
}

/** What a call of the AWS CLI may name (`awsProblem`). */
export interface AwsScope {
  /** The settings' profile: no call names another. */
  profile: string;
  /** The two Route 53 test zones, by ID. */
  zones: string[];
  /** Each resource's ID and each output of the stacks that have the suite's name, as CloudFormation says them. */
  ids: string[];
}

/** A parameter of a stack of the suite's: /erga/<stack>/..., /erga-gate/<stack>/..., /erga-live/<stack>. */
const parameter = (name: string) => {
  const m = /^\/(?:erga|erga-gate|erga-live)\/([^/]+)(?:\/[\w.-]*)?$/.exec(name);
  return !!m && ours(m[1]);
};

/**
 * Why the suite does not run a command of the AWS CLI, or null: it names only the suite's own. `args`: the command's
 * words after `aws`. A stack, a bucket, a function and a parameter count by the suite's name; a machine, a key, a
 * secret and a store by an ID that a stack of the suite's has. The account's names are listed (its stacks, its
 * zones); nothing else of a thing that is not the suite's is read, changed or deleted. What the rule does not know,
 * it refuses.
 */
export function awsProblem(args: string[], s: AwsScope): string | null {
  const words = [...args];
  const given: Record<string, string> = {};
  // (The CLI's own options, which each call has: the profile, the region, the form of the answer.)
  for (const name of ["--profile", "--region", "--output"]) {
    const at = words.indexOf(name);
    if (at >= 0) given[name] = words.splice(at, 2)[1] ?? "";
  }
  const [service = "", op = "", ...rest] = words;
  const no = (why: string) => `The verify suite does not run aws ${service} ${op}: ${why}. Nothing ran.`;
  if (words.some((w) => ["--profile", "--region", "--output", "--endpoint-url"].includes(w) || /^--(profile|region|endpoint-url)=/.test(w)))
    return no("an option of the CLI is there two times, or in a form that the rule does not read");
  if ("--profile" in given && given["--profile"] != s.profile) return no(`the profile ${given["--profile"]} is not the settings'`);
  /** An option's value. Null: the option is not there, or two times. */
  const opt = (name: string) =>
    rest.filter((w) => w == name || w.startsWith(`${name}=`)).length == 1 ? (rest[rest.indexOf(name) + 1] ?? null) : null;
  const named = (v: string | null) => (v != null && ours(v) ? null : no(`${v ?? "no name"} is not a name of the suite's`));
  const own = (v: string | null) => (v != null && s.ids.includes(v) ? null : no(`${v ?? "no ID"} is not of a stack of the suite's`));
  const param = (v: string | null) =>
    v != null && parameter(v) ? null : no(`${v ?? "no name"} is not a parameter of a stack of the suite's`);
  const filter = (v: string | null, key: string) =>
    v?.startsWith(`${key}=`) && !v.includes(",", key.length) ? v.slice(key.length + 1) : null;
  switch (`${service} ${op}`) {
    case "sts get-caller-identity":
    case "configure get":
    case "route53 list-hosted-zones":
    case "cloudformation list-stacks":
      return null;
    case "route53 get-hosted-zone":
      return s.zones.includes((opt("--id") ?? "").replace("/hostedzone/", "")) ? null : no("the zone is not a test zone");
    case "ec2 describe-managed-prefix-lists":
      // (AWS's own list of CloudFront's addresses.)
      return opt("--filters") == "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing"
        ? null
        : no("it is not AWS's own list");
    case "ec2 describe-instances":
      return own(opt("--instance-ids"));
    case "ssm send-command":
      return opt("--document-name") == "AWS-RunShellScript"
        ? own(opt("--instance-ids"))
        : no("it is not a shell script on the suite's machine");
    case "ssm get-command-invocation":
      return own(opt("--instance-id"));
    case "ssm describe-instance-information":
      return own(filter(opt("--filters"), "Key=InstanceIds,Values"));
    case "ssm put-parameter":
      if (opt("--key-id") != null && !ours((opt("--key-id") ?? "").replace(/^alias\/erga-/, "")))
        return no("the key is not of a stack of the suite's");
      return param(opt("--name"));
    case "ssm get-parameter":
    case "ssm delete-parameter":
      return param(opt("--name"));
    case "ssm get-parameters-by-path":
      return param(opt("--path"));
    case "ssm describe-parameters":
      return param(filter(opt("--parameter-filters"), "Key=Name,Values"));
    case "s3api put-object":
    case "s3api head-object":
      return named(opt("--bucket"));
    case "s3 rb":
      return rest[0]?.startsWith("s3://") ? named(rest[0].slice(5)) : no("it names no bucket");
    case "cloudfront describe-function":
    case "cloudfront test-function":
      return named(opt("--name"));
    case "cloudfront-keyvaluestore get-key":
    case "cloudfront-keyvaluestore put-key":
    case "cloudfront-keyvaluestore describe-key-value-store":
      return own(opt("--kvs-arn"));
    case "secretsmanager get-secret-value":
      return own(opt("--secret-id"));
    case "kms describe-key":
      return own(opt("--key-id"));
    case "resourcegroupstaggingapi get-resources":
      return named(filter(opt("--tag-filters"), "Key=erga,Values"));
  }
  // A stack: each command of CloudFormation, for a stack with the suite's name.
  if (service == "cloudformation") return named(opt("--stack-name"));
  return no("the suite's rule does not know this command");
}
