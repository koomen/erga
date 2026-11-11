// The AWS host of bun erga (deploy/aws/): the stacks' templates, setup's answers and steps on AWS, the first admin's SQL.
// No AWS here: the templates and the steps are pure.
import { expect, test } from "bun:test";
import { awsEntry, discoverOidc, firstSql } from "../deploy/aws/setup";
import { type AwsShape, certificatesTemplate, stackTemplate, TOKEN_PATHS } from "../deploy/aws/template";
import { frontSignInCheck } from "../deploy/own/facts";
import { addressOf, answersProblem, defaultAnswers, type Facts, githubManifest, parseAnswer, steps } from "../deploy/own/plan";

const shape: AwsShape = {
  stack: "erga",
  egress: { kind: "nat-instance" },
  domains: null,
  front: { kind: "cloudfront", prefixList: "pl-82a045eb" },
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
  frontSecret: null,
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
    "deploy-production",
    "signin-production",
    "register-production",
  ]);
  expect(before.find((s) => s.state != "done")).toMatchObject({ id: "stack", who: "person" });
  expect(githubManifest(aws, facts(), "http://localhost/created")).toBeNull();
  // After it: the GitHub app's callback is CloudFront's address.
  const made = facts({
    stack: { name: "erga", status: "CREATE_COMPLETE", outputs: { AppHost: "d1.cloudfront.net" }, template: "applied" },
  });
  expect(addressOf(aws, "production", made)).toBe("d1.cloudfront.net");
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

// ------------------------------------------------------------------ the company's sign-in in front (a load balancer)

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
  front: { kind: "balancer", oidc },
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

test("a load balancer in front: the sign-in on the app's address, and no CloudFront", () => {
  const r = resources(balanced);
  expect(Object.values(r).filter((x) => x.Type.startsWith("AWS::CloudFront::"))).toEqual([]);
  // The machine lets in the balancer only; the balancer is public, in two zones.
  expect(r.Firewall.Properties.SecurityGroupIngress).toEqual([
    {
      IpProtocol: "tcp",
      FromPort: 8080,
      ToPort: 8080,
      SourceSecurityGroupId: { Ref: "BalancerFirewall" },
      Description: "The load balancer",
    },
  ]);
  expect(r.Balancer.Properties).toMatchObject({ Scheme: "internet-facing", Subnets: [{ Ref: "PublicSubnet" }, { Ref: "PublicSubnetB" }] });
  expect(r.Machine.Properties.SubnetId).toEqual({ Ref: "PrivateSubnet" });
  // Its health check asks the machine itself, a path with no sign-in.
  expect(r.Targets.Properties).toMatchObject({
    Port: 8080,
    HealthCheckPath: "/api/deploys/version",
    Targets: [{ Id: { Ref: "Machine" } }],
  });
  // One certificate, in this stack and region: the app's name and the pages' wildcard. The names point at the balancer.
  expect(r.Certificate.Properties).toMatchObject({ DomainName: "erga.example.com", SubjectAlternativeNames: ["*.pages.erga.example.com"] });
  expect(r.PagesRecord.Properties).toMatchObject({ HostedZoneId: "Z1", Name: "*.pages.erga.example.com", Type: "A" });
  expect(r.AppRecord.Properties.AliasTarget.DNSName).toEqual({ "Fn::GetAtt": ["Balancer", "DNSName"] });
  // Any other host: nothing.
  expect(r.Listener.Properties.DefaultActions[0]).toMatchObject({ Type: "fixed-response", FixedResponseConfig: { StatusCode: "404" } });
  const t = stackTemplate(balanced) as { Parameters: Record<string, unknown>; Outputs: Record<string, unknown> };
  expect(t.Parameters.AppCertificate).toBeUndefined();
  expect(t.Outputs.Balancer).toEqual({ Value: { Ref: "Balancer" } });

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

test("what passes the load balancer without the sign-in: the pages by their token, the token paths, a keyed request, the server's browser", () => {
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
  // No more rules than these, and each within a balancer's limits: 5 values a rule, 3 a condition, 5 wildcards.
  expect(open.length + 2).toBe(rules.length);
  for (const r of rules) {
    const values = r.Conditions.flatMap(valuesOf);
    expect(values.length).toBeLessThanOrEqual(5);
    expect(Math.max(...r.Conditions.map((c) => valuesOf(c).length))).toBeLessThanOrEqual(3);
    expect((JSON.stringify(values).match(/[*?]/g) ?? []).length).toBeLessThanOrEqual(5);
  }
});

const front = {
  ...defaultAnswers("ada@example.com"),
  provider: "aws" as const,
  host: "erga.example.com",
  pages: "pages.erga.example.com",
  preset: "company" as const,
  awsRegion: "us-west-2",
  oidc: "https://idp.example.com/pool",
  oidcClient: "client-1",
};

test("setup with a sign-in in front: an email for the admin, pages under the app's name, no GitHub app", () => {
  const zones = ["erga.example.com"];
  expect(parseAnswer("oidc", "https://idp.example.com/pool/")).toEqual({ value: "https://idp.example.com/pool" });
  expect("problem" in parseAnswer("oidc", "http://idp.example.com")).toBe(true);
  expect(answersProblem(front, zones)).toBeNull();
  expect(answersProblem({ ...front, admin: "ada" }, zones)).toContain("email address");
  expect(answersProblem({ ...front, oidcClient: "" }, zones)).toContain("client ID");
  expect(answersProblem({ ...front, egress: "vpc-0a1/subnet-0b2" }, zones)).toContain("own network");
  expect(answersProblem({ ...front, host: "erga", pages: "shared" }, zones)).toContain("needs a domain");
  expect(answersProblem({ ...front, pages: "erga.example.com" }, zones)).toContain("name of their own");
  expect(answersProblem({ ...front, pages: "pages.other.org" }, zones)).toContain("Route 53");
  expect(answersProblem({ ...front, provider: "cloudflare" }, zones)).toContain("on AWS");
  // Without it, the pages still need a zone apart from the app's.
  expect(answersProblem({ ...front, oidc: "", admin: "ada" }, zones)).toContain("whole zone");

  const f = facts({ zones, frontSecret: false });
  const list = steps(front, f, { ids: {} });
  expect(list.map((s) => s.id)).toEqual([
    "tools",
    "login",
    "decide",
    "secret",
    "stack",
    "deploy-production",
    "signin-production",
    "register-production",
  ]);
  const secret = list.find((s) => s.id == "secret")!;
  expect(secret).toMatchObject({ who: "person", state: "todo" });
  expect(secret.next).toContain("erga/erga-example-com/oidc-client-secret");
  expect(steps(front, facts({ zones, frontSecret: true }), { ids: {} }).find((s) => s.state != "done")?.id).toBe("stack");

  // The server learns whose header is the sign-in, and who the first admin is, from the stack's balancer.
  const entry = awsEntry(
    front,
    "production",
    "123456789012",
    { AppHost: "erga.example.com", Balancer: "arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/x/1" },
    {}
  );
  expect(JSON.parse(entry.vars.FRONT_SIGN_IN)).toEqual({
    signer: "arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/x/1",
    issuer: "https://idp.example.com/pool",
    client: "client-1",
    admin: "ada@example.com",
  });
  expect(awsEntry(aws, "production", "123456789012", { AppHost: "d1.cloudfront.net" }, {}).vars.FRONT_SIGN_IN).toBeUndefined();
  // The first deploy writes no admin's row (they have no username yet): everybody who passes the sign-in may write.
  const sql = firstSql(front);
  expect(sql).toContain("INSERT INTO access_rules (kind, value, access, created) SELECT 'everybody', '', 'write'");
  expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')");
  expect(sql).not.toContain("INSERT INTO users");
});

test("the sign-in's endpoints come from its issuer, and the check sees the load balancer send a browser there", async () => {
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

  const balancer = (location: string) => (async () => new Response("", { status: 302, headers: { location } })) as unknown as typeof fetch;
  const to = (client: string, back: string) =>
    `${oidc.authorize}?client_id=${client}&redirect_uri=${encodeURIComponent(back)}&response_type=code`;
  expect(
    await frontSignInCheck(balancer(to("client-1", "https://erga.example.com/oauth2/idpresponse")), "erga.example.com", "client-1")
  ).toBe("ok");
  expect(
    await frontSignInCheck(balancer(to("client-2", "https://erga.example.com/oauth2/idpresponse")), "erga.example.com", "client-1")
  ).toMatchObject({ bad: expect.stringContaining("client-2") });
  expect(await frontSignInCheck(balancer("https://erga.example.com/auth/github"), "erga.example.com", "client-1")).toMatchObject({
    bad: expect.stringContaining("not to the sign-in in front"),
  });
});
