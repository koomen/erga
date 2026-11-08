// The AWS host of bun erga (deploy/aws/): the stacks' templates, setup's answers and steps on AWS, the first admin's SQL.
// No AWS here: the templates and the steps are pure.
import { expect, test } from "bun:test";
import { firstSql } from "../deploy/aws/setup";
import { type AwsShape, certificatesTemplate, stackTemplate } from "../deploy/aws/template";
import { addressOf, answersProblem, defaultAnswers, type Facts, githubManifest, parseAnswer, steps } from "../deploy/own/plan";

const shape: AwsShape = { stack: "erga", egress: { kind: "nat-instance" }, domains: null, cloudFrontPrefixList: "pl-82a045eb" };
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
