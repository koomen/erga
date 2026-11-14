// The AWS host of bun erga (deploy/aws/): the stacks' templates, setup's answers and steps on AWS, the first admin's SQL.
// No AWS here: the templates and the steps are pure.
import { expect, test } from "bun:test";
import type { Aws } from "../deploy/aws/cli";
import { deployScript, provisionScript, putObject } from "../deploy/aws/machine";
import { awsEntry, discoverOidc, firstSql } from "../deploy/aws/setup";
import { changeSetKind } from "../deploy/aws/stack";
import { type AwsShape, certificatesTemplate, NAT_USER_DATA, stackTemplate, TOKEN_PATHS } from "../deploy/aws/template";
import { proxySignInCheck } from "../deploy/own/facts";
import { addressOf, answersProblem, defaultAnswers, type Facts, githubManifest, parseAnswer, steps } from "../deploy/own/plan";

const shape: AwsShape = {
  stack: "erga",
  egress: { kind: "nat-instance" },
  domains: null,
  edge: { kind: "cloudfront", prefixList: "pl-82a045eb" },
};
const resources = (s: AwsShape) => stackTemplate(s).Resources as Record<string, { Type: string; Properties: Record<string, any> }>;

test("the machine is private: CloudFront's prefix list is its only way in, and it has no public address", () => {
  const r = resources(shape);
  expect(r.Firewall.Properties.SecurityGroupIngress).toEqual([
    { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, SourcePrefixListId: "pl-82a045eb", Description: "CloudFront" },
  ]);
  expect(r.Machine.Properties.SubnetId).toEqual({ Ref: "PrivateSubnet" });
  expect(r.Machine.Properties.NetworkInterfaces).toBeUndefined();
  expect(r.Machine.Properties.MetadataOptions.HttpTokens).toBe("required");
  // Each distribution reaches it as a VPC origin, and sets the forwarded headers celld trusts.
  for (const d of [r.AppDistribution, r.PagesDistribution]) {
    const c = d.Properties.DistributionConfig;
    expect(c.Origins[0].VpcOriginConfig).toMatchObject({ VpcOriginId: { "Fn::GetAtt": ["Origin", "Id"] } });
    expect(c.DefaultCacheBehavior.FunctionAssociations[0].EventType).toBe("viewer-request");
    expect(c.ViewerCertificate).toEqual({ CloudFrontDefaultCertificate: true });
  }
  expect(r.Forwarded.Properties.FunctionCode).toContain('r.headers["x-forwarded-host"] = { value: r.headers.host.value }');
  // The cache key has the host: each document's pages origin has its own files at the same paths.
  expect(r.CachePolicy.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers).toEqual(["Host"]);
  // The bucket outlives the stack: the documents are in it.
  expect((stackTemplate(shape).Resources as any).Bucket.DeletionPolicy).toBe("Retain");
});

test("the way out: a NAT machine, a NAT gateway, or the person's VPC with no network of ours", () => {
  expect(resources(shape).Nat.Type).toBe("AWS::EC2::Instance");
  expect(resources(shape).PrivateDefault.Properties.InstanceId).toEqual({ Ref: "Nat" });
  const gw = resources({ ...shape, egress: { kind: "nat-gateway" } });
  expect(gw.Nat.Type).toBe("AWS::EC2::NatGateway");
  const own = resources({ ...shape, egress: { kind: "vpc", vpcId: "vpc-1", subnetId: "subnet-2" } });
  expect(own.Vpc).toBeUndefined();
  expect(own.Nat).toBeUndefined();
  expect(own.Machine.Properties.SubnetId).toBe("subnet-2");
  expect(own.Firewall.Properties.VpcId).toBe("vpc-1");
});

test("with domains: the certificates in us-east-1's stack, the names in Route 53, a wildcard for the pages", () => {
  const domains = { app: "erga.example.com", appZone: "Z1", pages: "pages.example", pagesZone: "Z2" };
  const r = resources({ ...shape, domains });
  expect(r.PagesDistribution.Properties.DistributionConfig.Aliases).toEqual(["*.pages.example"]);
  expect(r.AppDistribution.Properties.DistributionConfig.ViewerCertificate.AcmCertificateArn).toEqual({ Ref: "AppCertificate" });
  expect(r.AppRecordA.Properties).toMatchObject({ HostedZoneId: "Z1", Name: "erga.example.com", Type: "A" });
  expect(r.PagesRecordAAAA.Properties).toMatchObject({ HostedZoneId: "Z2", Name: "*.pages.example", Type: "AAAA" });
  const certs = certificatesTemplate("erga", domains).Resources as Record<string, { Properties: Record<string, unknown> }>;
  expect(certs.PagesCertificate.Properties).toMatchObject({ DomainName: "*.pages.example", ValidationMethod: "DNS" });
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  bun: "1.4.2",
  origin: "https://github.com/koomen/erga.git",
  installed: true,
  head: "abcdef1234567890",
  login: { ok: true, accounts: [{ id: "123456789012", name: "arn:aws:sts::123456789012:assumed-role/admin/ada" }] },
  account: "123456789012",
  zones: [],
  workersSubdomain: null,
  stack: null,
  proxySecret: null,
  targets: {},
  secrets: [],
  ...over,
});
const aws = { ...defaultAnswers("ada"), provider: "aws" as const, host: "erga", awsProfile: "work", awsRegion: "eu-west-1" };

test("on AWS a short name needs no domain, and the address comes with the stack", () => {
  expect(parseAnswer("host", "erga")).toEqual({ value: "erga" });
  expect(parseAnswer("egress", "vpc-0a1/subnet-0b2")).toEqual({ value: "vpc-0a1/subnet-0b2" });
  expect("problem" in parseAnswer("awsRegion", "west")).toBe(true);
  expect(answersProblem(aws, [])).toBeNull();
  expect(answersProblem({ ...aws, pages: "pages.example" }, [])).toContain("pages=shared");
  expect(answersProblem({ ...aws, staging: "erga-staging" }, [])).toContain("Staging on AWS");
  expect(answersProblem({ ...aws, provider: "cloudflare" }, [])).toContain("short name");
  expect(answersProblem({ ...aws, host: "erga.example.com", pages: "pages.example" }, ["example.com"])).toContain("Route 53");

  // Before the stack: the stack is the next step (the person's), and there is no address for the GitHub app yet.
  const before = steps(aws, facts(), { ids: {} });
  expect(before.map((s) => s.id)).toEqual([
    "tools",
    "login",
    "decide",
    "stack",
    "github",
    "deploy-primary",
    "signin-primary",
    "register-primary",
  ]);
  expect(before.find((s) => s.state != "done")).toMatchObject({ id: "stack", who: "person" });
  expect(githubManifest(aws, facts(), "http://localhost/created")).toBeNull();
  // After it: the GitHub app's callback is CloudFront's address.
  const made = facts({
    stack: { name: "erga", status: "CREATE_COMPLETE", outputs: { AppHost: "d1.cloudfront.net" }, template: "applied" },
  });
  expect(addressOf(aws, "primary", made)).toBe("d1.cloudfront.net");
  expect(steps(aws, made, { ids: {} }).find((s) => s.state != "done")?.id).toBe("github");
  expect(githubManifest(aws, made, "http://localhost/created")?.callback_urls).toEqual(["https://d1.cloudfront.net/auth/github/callback"]);
  // A template changed on disk since it was applied: the stack step is to do again.
  const changed = facts({ stack: { ...made.stack!, template: "changed" } });
  expect(steps(aws, changed, { ids: {} }).find((s) => s.state != "done")?.id).toBe("stack");
});

test("the first admin goes only into a database with no admin, and a quote can't leave its string", () => {
  const sql = firstSql({ ...aws, admin: "ada", feedback: "ada/it's" });
  expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')");
  expect(sql).toContain(`'"ada/it''s"'`);
});

// ------------------------------------------------------------------ the proxy mode: the company's sign-in at a proxy

const oidc = {
  issuer: "https://idp.example.com/pool",
  authorize: "https://sign-in.example.com/oauth2/authorize",
  token: "https://sign-in.example.com/oauth2/token",
  userInfo: "https://sign-in.example.com/oauth2/userInfo",
  clientId: "client-1",
};
const balanced: AwsShape = {
  stack: "erga-example-com",
  egress: { kind: "nat-instance" },
  domains: { app: "erga.example.com", appZone: "Z1", pages: "pages.erga.example.com", pagesZone: "Z1" },
  edge: { kind: "proxy", oidc },
};
type Rule = { Properties: { Priority: number; Conditions: Record<string, any>[]; Actions: Record<string, any>[] } };
const rulesOf = (s: AwsShape) =>
  Object.entries(resources(s))
    .filter(([, r]) => r.Type == "AWS::ElasticLoadBalancingV2::ListenerRule")
    .map(([name, r]) => ({ name, ...(r as unknown as Rule).Properties }))
    .sort((a, b) => a.Priority - b.Priority);
/** A rule's values to match, each condition's list. */
const valuesOf = (c: Record<string, any>): unknown[] =>
  (c.HostHeaderConfig ?? c.PathPatternConfig ?? c.HttpHeaderConfig ?? c.QueryStringConfig ?? c.SourceIpConfig).Values;

test("a proxy in front: the sign-in on the app's address, and no CloudFront", () => {
  const r = resources(balanced);
  expect(Object.values(r).filter((x) => x.Type.startsWith("AWS::CloudFront::"))).toEqual([]);
  // The machine lets in the proxy only; the proxy is public, in two zones.
  expect(r.Firewall.Properties.SecurityGroupIngress).toEqual([
    {
      IpProtocol: "tcp",
      FromPort: 8080,
      ToPort: 8080,
      SourceSecurityGroupId: { Ref: "ProxyFirewall" },
      Description: "The proxy",
    },
  ]);
  expect(r.Proxy.Properties).toMatchObject({ Scheme: "internet-facing", Subnets: [{ Ref: "PublicSubnet" }, { Ref: "PublicSubnetB" }] });
  expect(r.Machine.Properties.SubnetId).toEqual({ Ref: "PrivateSubnet" });
  // Its health check asks the machine itself, a path with no sign-in.
  expect(r.Targets.Properties).toMatchObject({
    Port: 8080,
    HealthCheckPath: "/api/deploys/version",
    Targets: [{ Id: { Ref: "Machine" } }],
  });
  // One certificate, in this stack and region: the app's name and the pages' wildcard. The names point at the proxy.
  expect(r.Certificate.Properties).toMatchObject({ DomainName: "erga.example.com", SubjectAlternativeNames: ["*.pages.erga.example.com"] });
  expect(r.PagesRecord.Properties).toMatchObject({ HostedZoneId: "Z1", Name: "*.pages.erga.example.com", Type: "A" });
  expect(r.AppRecord.Properties.AliasTarget.DNSName).toEqual({ "Fn::GetAtt": ["Proxy", "DNSName"] });
  // Any other host: nothing.
  expect(r.Listener.Properties.DefaultActions[0]).toMatchObject({ Type: "fixed-response", FixedResponseConfig: { StatusCode: "404" } });
  const t = stackTemplate(balanced) as { Parameters: Record<string, unknown>; Outputs: Record<string, unknown> };
  expect(t.Parameters.AppCertificate).toBeUndefined();
  expect(t.Outputs.Proxy).toEqual({ Value: { Ref: "Proxy" } });

  // The last rule: everything else on the app's address signs in first. The client's secret is a reference: never a value.
  const rules = rulesOf(balanced);
  const signIn = rules.at(-1)!;
  expect(signIn.name).toBe("SignInRule");
  expect(signIn.Conditions.map(valuesOf)).toEqual([["erga.example.com"]]);
  expect(signIn.Actions.map((a) => a.Type)).toEqual(["authenticate-oidc", "forward"]);
  expect(signIn.Actions[0].AuthenticateOidcConfig).toMatchObject({
    Issuer: oidc.issuer,
    AuthorizationEndpoint: oidc.authorize,
    TokenEndpoint: oidc.token,
    UserInfoEndpoint: oidc.userInfo,
    ClientId: "client-1",
    ClientSecret: { "Fn::Sub": "{{resolve:secretsmanager:${OidcSecret}:SecretString}}" },
    Scope: "openid email",
  });
  expect(t.Parameters.OidcSecret).toMatchObject({ Default: "erga/erga-example-com/oidc-client-secret" });
});

test("what passes the proxy without the sign-in: the pages by their token, the token paths, a keyed request, the server's browser", () => {
  const rules = rulesOf(balanced);
  // First, a caller's own X-Forwarded-Host is refused: celld would take it for the host.
  expect(rules[0]).toMatchObject({ name: "RefuseForwardedHost", Priority: 1 });
  expect(rules[0].Conditions[0].HttpHeaderConfig).toEqual({ HttpHeaderName: "X-Forwarded-Host", Values: ["?*"] });
  expect(rules[0].Actions[0].FixedResponseConfig.StatusCode).toBe("400");
  const open = rules.filter((r) => r.Actions.length == 1 && r.Actions[0].Type == "forward");
  const by = Object.fromEntries(open.map((r) => [r.name, r.Conditions.map(valuesOf)]));
  // A document's own address: its files by their token and the offline worker, never the app's pages.
  expect(by.PagesRule).toEqual([["*.pages.erga.example.com"], ["/t/*", "/erga-sw.js", "/erga-clear"]]);
  // The app's address: MCP and its OAuth for the client, the operations, the CLI's token request, the deploy's checks.
  const tokens = open.filter((r) => r.name.startsWith("TokenRule"));
  expect(tokens.every((r) => r.Conditions[0].HostHeaderConfig.Values[0] == "erga.example.com")).toBe(true);
  const paths = tokens.flatMap((r) => r.Conditions[1].PathPatternConfig.Values);
  expect(paths).toEqual(TOKEN_PATHS.flat());
  for (const p of ["/mcp", "/oauth/token", "/oauth/register", "/api/tools/*", "/api/auth/poll", "/api/ops", "/api/health"])
    expect(paths).toContain(p);
  // Where a person approves an agent, signs in or is an admin stays behind the sign-in.
  expect(paths.filter((p) => /^\/(oauth\/authorize|tokens|auth|admin)\b/.test(p) || p == "/*")).toEqual([]);
  expect(by.KeyRule).toEqual([["erga.example.com"], ["/d/*/api/*"], [{ Key: "key", Value: "*" }]]);
  // The server's own browser comes from the NAT's address: a fixed one.
  expect(by.OwnBrowserRule).toEqual([["erga.example.com"], [{ "Fn::Sub": "${NatAddress.PublicIp}/32" }]]);
  expect(resources(balanced).NatAddress.Properties.InstanceId).toEqual({ Ref: "Nat" });
  expect(resources({ ...balanced, egress: { kind: "nat-gateway" } }).NatAddress.Type).toBe("AWS::EC2::EIP");
  // No more rules than these, and each within a proxy's limits: 5 values a rule, 3 a condition, 5 wildcards.
  expect(open.length + 2).toBe(rules.length);
  for (const r of rules) {
    const values = r.Conditions.flatMap(valuesOf);
    expect(values.length).toBeLessThanOrEqual(5);
    expect(Math.max(...r.Conditions.map((c) => valuesOf(c).length))).toBeLessThanOrEqual(3);
    expect((JSON.stringify(values).match(/[*?]/g) ?? []).length).toBeLessThanOrEqual(5);
  }
});

const viaProxy = {
  ...defaultAnswers("ada@example.com"),
  provider: "aws" as const,
  host: "erga.example.com",
  pages: "pages.erga.example.com",
  preset: "company" as const,
  awsRegion: "us-west-2",
  signIn: "proxy" as const,
  oidc: "https://idp.example.com/pool",
  oidcClient: "client-1",
};

test("setup in the proxy mode on AWS: an email for the admin, pages under the app's name, no GitHub app", () => {
  const zones = ["erga.example.com"];
  expect(parseAnswer("oidc", "https://idp.example.com/pool/")).toEqual({ value: "https://idp.example.com/pool" });
  expect("problem" in parseAnswer("oidc", "http://idp.example.com")).toBe(true);
  expect(answersProblem(viaProxy, zones)).toBeNull();
  expect(answersProblem({ ...viaProxy, admin: "ada" }, zones)).toContain("email address");
  expect(answersProblem({ ...viaProxy, oidcClient: "" }, zones)).toContain("client ID");
  expect(answersProblem({ ...viaProxy, egress: "vpc-0a1/subnet-0b2" }, zones)).toContain("own network");
  expect(answersProblem({ ...viaProxy, host: "erga", pages: "shared" }, zones)).toContain("needs a domain");
  expect(answersProblem({ ...viaProxy, pages: "erga.example.com" }, zones)).toContain("name of their own");
  expect(answersProblem({ ...viaProxy, pages: "pages.other.org" }, zones)).toContain("Route 53");
  expect(answersProblem({ ...viaProxy, oidc: "" }, zones)).toContain("issuer's URL");
  // The mode is an answer of its own: the proxy's values with the oauth mode, or on the other host, say what to change.
  expect(answersProblem({ ...viaProxy, signIn: "oauth", admin: "ada" }, zones)).toContain("signIn=proxy");
  expect(answersProblem({ ...viaProxy, provider: "cloudflare" }, zones)).toContain("on AWS");
  // In the oauth mode, the pages still need a zone apart from the app's.
  expect(answersProblem({ ...viaProxy, signIn: "oauth", oidc: "", admin: "ada" }, zones)).toContain("whole zone");

  const f = facts({ zones, proxySecret: false });
  const list = steps(viaProxy, f, { ids: {} });
  expect(list.map((s) => s.id)).toEqual([
    "tools",
    "login",
    "decide",
    "secret",
    "stack",
    "deploy-primary",
    "signin-primary",
    "register-primary",
  ]);
  const secret = list.find((s) => s.id == "secret")!;
  expect(secret).toMatchObject({ who: "person", state: "todo" });
  expect(secret.next).toContain("erga/erga-example-com/oidc-client-secret");
  expect(steps(viaProxy, facts({ zones, proxySecret: true }), { ids: {} }).find((s) => s.state != "done")?.id).toBe("stack");

  // The server learns whose header is the sign-in from the stack's proxy: the proxy mode's setting.
  const entry = awsEntry(
    viaProxy,
    "primary",
    "123456789012",
    { AppHost: "erga.example.com", Proxy: "arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/x/1" },
    {}
  );
  expect(JSON.parse(entry.vars.PROXY_SIGN_IN)).toEqual({
    kind: "aws-alb",
    signer: "arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/x/1",
    issuer: "https://idp.example.com/pool",
    client: "client-1",
  });
  expect(entry.vars.GITHUB_CLIENT_ID).toBe("");
  // No proxy known yet: a value the server reads as no proxy (nobody signs in), never the oauth mode.
  expect(awsEntry(viaProxy, "primary", "1", { AppHost: "erga.example.com" }, {}).vars.PROXY_SIGN_IN).toBe("{}");
  expect(awsEntry(aws, "primary", "123456789012", { AppHost: "d1.cloudfront.net" }, {}).vars.PROXY_SIGN_IN).toBeUndefined();
  // The first deploy writes no user's row (the admin has no username yet): they wait as a person added by their email,
  // with the role admin; and everybody who passes the sign-in may write.
  const sql = firstSql(viaProxy);
  expect(sql).toContain("INSERT INTO people (provider, handle, role, created) SELECT 'proxy', 'ada@example.com', 'admin'");
  expect(sql).toContain("INSERT INTO access_rules (kind, value, access, created) SELECT 'everybody', '', 'write'");
  expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')");
  expect(sql).not.toContain("INSERT INTO users");
  // The oauth mode's first admin is a user, by their GitHub login.
  expect(firstSql(aws)).toMatch(/^INSERT INTO users \(login, name, role, created\) SELECT 'ada', 'ada', 'admin', \d+ WHERE NOT EXISTS/);
});

test("the sign-in's endpoints come from its issuer, and the check sees the proxy send a browser there", async () => {
  const document = {
    issuer: oidc.issuer,
    authorization_endpoint: oidc.authorize,
    token_endpoint: oidc.token,
    userinfo_endpoint: oidc.userInfo,
  };
  const issuer = (d: unknown) =>
    (async (url: string) =>
      url == `${oidc.issuer}/.well-known/openid-configuration`
        ? Response.json(d)
        : new Response("", { status: 404 })) as unknown as typeof fetch;
  const { clientId: _, ...endpoints } = oidc;
  expect(await discoverOidc(oidc.issuer, issuer(document))).toEqual(endpoints);
  await expect(discoverOidc(oidc.issuer, issuer({ ...document, issuer: "https://other.example.com" }))).rejects.toThrow("another issuer");
  await expect(discoverOidc(oidc.issuer, issuer({ ...document, token_endpoint: "http://sign-in.example.com/token" }))).rejects.toThrow(
    "https token_endpoint"
  );
  await expect(discoverOidc("https://none.example.com", issuer(document))).rejects.toThrow("didn't answer");

  const proxy = (location: string) => (async () => new Response("", { status: 302, headers: { location } })) as unknown as typeof fetch;
  const to = (client: string, back: string) =>
    `${oidc.authorize}?client_id=${client}&redirect_uri=${encodeURIComponent(back)}&response_type=code`;
  const alb = { clientId: "client-1", callback: "https://erga.example.com/oauth2/idpresponse" };
  const check = (location: string, expects: { to?: string; clientId?: string; callback?: string } = alb) =>
    proxySignInCheck(proxy(location), "erga.example.com", expects);
  expect(await check(to("client-1", "https://erga.example.com/oauth2/idpresponse"))).toBe("ok");
  expect(await check(to("client-2", "https://erga.example.com/oauth2/idpresponse"))).toMatchObject({
    bad: expect.stringContaining("client-2"),
  });
  expect(await check("https://erga.example.com/auth/github")).toMatchObject({
    bad: expect.stringContaining("not to the sign-in at the proxy"),
  });
  // Cloudflare Access sends a browser to the team's address: another team's is refused.
  const access = { to: "example.cloudflareaccess.com" };
  expect(await check("https://example.cloudflareaccess.com/cdn-cgi/access/login/erga.example.com?kid=1", access)).toBe("ok");
  expect(await check("https://other.cloudflareaccess.com/cdn-cgi/access/login/erga.example.com", access)).toMatchObject({
    bad: expect.stringContaining("not to example.cloudflareaccess.com"),
  });
});

test("the plan of a new stack can run again: the stack that waits for its first change set is still new", () => {
  expect(changeSetKind("erga", "us-west-2", null)).toBe("CREATE");
  // `setup <host> stack` shows the plan, and leaves this status; `stack --yes` plans again, then applies.
  expect(changeSetKind("erga", "us-west-2", "REVIEW_IN_PROGRESS")).toBe("CREATE");
  expect(changeSetKind("erga", "us-west-2", "UPDATE_COMPLETE")).toBe("UPDATE");
  expect(() => changeSetKind("erga", "us-west-2", "UPDATE_IN_PROGRESS")).toThrow("busy");
  expect(() => changeSetKind("erga", "us-west-2", "ROLLBACK_COMPLETE")).toThrow("delete the stack");
});

test("an upload to the bucket is one request: the key lets the admins encrypt, and a file in parts needs kms:Decrypt", async () => {
  const calls: string[][] = [];
  await putObject((async (...args: string[]) => void calls.push(args)) as Aws, "bucket", "releases/v1.tgz", "/tmp/v1.tgz");
  expect(calls).toEqual([["s3api", "put-object", "--bucket", "bucket", "--key", "releases/v1.tgz", "--body", "/tmp/v1.tgz"]]);
  const statements: { Sid: string; Action: string[] }[] = (stackTemplate(shape).Resources as any).Key.Properties.KeyPolicy.Statement;
  expect(statements.filter((s) => s.Sid.includes("admins")).flatMap((s) => s.Action)).not.toContain("kms:Decrypt");
});

test("the NAT machine's script runs at each start, gives dnf a swap file, and adds its rule one time", () => {
  expect((stackTemplate(shape).Resources as any).Nat.Properties.UserData).toEqual({ "Fn::Base64": NAT_USER_DATA });
  expect(NAT_USER_DATA).toContain("- [scripts-user, always]");
  const script = NAT_USER_DATA.slice(NAT_USER_DATA.indexOf("#!/bin/bash"), NAT_USER_DATA.indexOf("--//--"));
  expect(script.indexOf("swapon /swap")).toBeLessThan(script.indexOf("dnf install"));
  expect(script).toContain("iptables -t nat -C $rule 2> /dev/null || iptables -t nat -A $rule");
  // The script is good bash.
  expect(Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(script) }).exitCode).toBe(0);
});

test("the machine reads its secrets by the path its role allows; the first release loads the Worker before the migrations", () => {
  const script = deployScript({ bucket: "bucket", region: "us-west-2", stack: "erga", version: "v1" });
  // The first release: celld's node has no lease before it has a deployment, and the migrations need that node.
  const at = script.indexOf("if aws s3 ls s3://bucket/fleet/nodes/");
  const [later, first] = script.slice(at, script.indexOf("\nfi\n", at)).split("\nelse\n");
  expect(later.indexOf("\n  migrate")).toBeLessThan(later.indexOf("\n  load"));
  expect(first.indexOf("  load")).toBeLessThan(first.indexOf("\n  migrate"));
  expect([later.indexOf("\n  migrate"), first.indexOf("  load")].every((i) => i >= 0)).toBe(true);
  expect(script).toContain("aws ssm get-parameters-by-path --path /erga/erga --with-decryption");
  expect(JSON.stringify((stackTemplate(shape).Resources as any).Role)).toContain(':parameter/erga/erga"');
});

test("celld has a listener of its own on the loopback, and the machine's setup fails when celld doesn't listen", () => {
  const script = provisionScript({ bucket: "bucket", region: "us-west-2" });
  expect(script).toContain("CELLD_ADDR=0.0.0.0:8080");
  expect(script).toContain("Environment=CELLD_INTERNAL_ADDR=127.0.0.1:");
  expect(script).toContain(`listens || { echo "celld doesn't start:`);
});
