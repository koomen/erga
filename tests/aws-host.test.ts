// The AWS host of bun erga (deploy/aws/): the stacks' templates, the instance's entry from the answers, the first rows'
// SQL. No AWS here: the templates are pure. (The flow's AWS lane: tests/own.test.ts.)
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aws } from "../deploy/aws/cli";
import { liveOnAws } from "../deploy/aws/deploy";
import { gateCode, gateSettings, INLINE_MAX, putEdgeKey } from "../deploy/aws/gate";
import { deployScript, factsScript, healthScript, provisionScript, putObject, sqlScript } from "../deploy/aws/machine";
import { ADMIN_SQL, adminIn, awsEntry, discoverOidc, firstSql } from "../deploy/aws/setup";
import { changeSetKind, writeTemplates } from "../deploy/aws/stack";
import {
  type AwsShape,
  certificatesTemplate,
  GATE_PARTS,
  type GateCode,
  idpSecretParam,
  NAT_USER_DATA,
  paramPath,
  stackTemplate,
  TEMPLATE_MAX,
} from "../deploy/aws/template";
import { instanceReader } from "../deploy/cli/running";
import { liveParam } from "../deploy/deployer/aws";
import { signInOf } from "../deploy/own/facts";
import { noAnswers, pagesProblem, varsOf } from "../deploy/own/plan";

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
  // (CloudFront refuses a function that writes the scheme, with a 502 for each request: the server needs no header for it.)
  expect(r.Forwarded.Properties.FunctionCode).not.toContain("x-forwarded-proto");
  // The cache key has the host: each document's pages origin has its own files at the same paths.
  expect(r.CachePolicy.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers).toEqual(["Host"]);
  // The bucket outlives the stack: the documents are in it.
  expect((stackTemplate(shape).Resources as any).Bucket.DeletionPolicy).toBe("Retain");
});

test("the way out: a NAT machine, a NAT gateway, or the user's VPC with no network of ours", () => {
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

const aws = {
  ...noAnswers("erga.example.com"),
  where: "aws" as const,
  profile: "work",
  region: "eu-west-1",
  signIn: "organization" as const,
  organization: "it's",
};

test("on AWS the entry comes from the stack's outputs, and the pages need a domain that fits the edge", () => {
  const entry = awsEntry(
    { ...aws, pages: "example-pages.com" },
    "123456789012",
    { AppHost: "erga.example.com", Bucket: "b", Machine: "i-1" },
    "Iv1.ada"
  );
  expect(entry).toMatchObject({
    host: "erga.example.com",
    profile: "work",
    aws: {
      account: "123456789012",
      region: "eu-west-1",
      stack: "erga-example-com",
      bucket: "b",
      machine: "i-1",
      app: "erga.example.com",
      pages: { kind: "domain", domain: "example-pages.com" },
    },
  });
  expect(entry.vars).toMatchObject({ GITHUB_CLIENT_ID: "Iv1.ada" });
  expect(entry.vars.PROXY_SIGN_IN).toBeUndefined();
  // The CLI's default profile is no profile of the entry.
  expect("profile" in awsEntry({ ...aws, profile: "default" }, "1", {}, undefined)).toBe(false);
  // CloudFront in front: the pages take a whole zone that is not the app's. With the organization's sign-in: a name under it too.
  const zones = ["example.com", "example-pages.com"];
  expect(pagesProblem({ ...aws, pages: "example-pages.com" }, zones)).toBeNull();
  expect(pagesProblem({ ...aws, pages: "pages.erga.example.com" }, zones)).toContain("whole zone");
  expect(pagesProblem({ ...aws, pages: "example.com" }, zones)).toContain("another domain than the app's");
  expect(pagesProblem({ ...aws, signIn: "sso" }, zones)).toBeNull();
  expect(pagesProblem({ ...aws, signIn: "sso", pages: "example.com" }, zones)).toContain("name of their own");
  expect(pagesProblem({ ...aws, signIn: "sso", pages: "pages.other.org" }, zones)).toContain("Route 53");
});

test("the first rows go only into a database with no admin, and a quote can't leave its string", () => {
  const sql = firstSql(aws);
  expect(sql).toMatch(
    /^INSERT INTO access_rules \(kind, value, access, created\) SELECT 'github_org', 'it''s', 'write', \d+ WHERE NOT EXISTS \(SELECT 1 FROM users WHERE role = 'admin'\) ON CONFLICT/
  );
  // Nobody is named an admin: the user who opens setup's one-time link becomes it.
  expect(sql).not.toContain("INSERT INTO users");
  expect(firstSql({ ...aws, signIn: "invite" })).toBe("");
});

// ------------------------------------------------------------------ the gate in front: the organization's sign-in (SSO)

const oidc = {
  issuer: "https://idp.example.com/pool",
  authorize: "https://sign-in.example.com/oauth2/authorize",
  token: "https://sign-in.example.com/oauth2/token",
  clientId: "client-1",
};
const domains = { app: "erga.example.com", appZone: "Z1", pages: "example-pages.com", pagesZone: "Z2" };
const code: GateCode = { functions: { edge: "E()", agents: "A()", request: "R()", response: "S()" }, lambda: "exports.handler=h;" };
const gated: AwsShape = {
  stack: "erga-example-com",
  egress: { kind: "nat-instance" },
  domains,
  edge: { kind: "gate", prefixList: "pl-82a045eb", code },
};
type Behavior = {
  PathPattern?: string;
  CachePolicyId: unknown;
  FunctionAssociations: { EventType: string; FunctionARN: { Ref: string } }[];
  LambdaFunctionAssociations?: { EventType: string; LambdaFunctionARN: unknown; IncludeBody: boolean }[];
};
/** A distribution's behaviors by path ("*": the default), each with its viewer-request function and whether the Lambda is its origin request. */
const behaviorsOf = (d: { Properties: Record<string, any> }) =>
  Object.fromEntries(
    [d.Properties.DistributionConfig.DefaultCacheBehavior, ...(d.Properties.DistributionConfig.CacheBehaviors ?? [])].map((b: Behavior) => [
      b.PathPattern ?? "*",
      {
        request: b.FunctionAssociations.find((f) => f.EventType == "viewer-request")!.FunctionARN.Ref,
        response: b.FunctionAssociations.find((f) => f.EventType == "viewer-response")?.FunctionARN.Ref,
        lambda: b.LambdaFunctionAssociations?.map((l) => `${l.EventType}${l.IncludeBody ? " with the body" : ""}`).join() ?? null,
      },
    ])
  );

test("the gate in front: its four functions on both distributions, and the key that only CloudFront and the machine know", () => {
  const r = resources(gated);
  // The machine is as private as without the gate: CloudFront's prefix list only, a VPC origin, no public address.
  expect(r.Firewall.Properties.SecurityGroupIngress).toEqual([
    { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, SourcePrefixListId: "pl-82a045eb", Description: "CloudFront" },
  ]);
  expect(r.Machine.Properties.SubnetId).toEqual({ Ref: "PrivateSubnet" });
  // The gate's code is the us-east-1 stack's: this stack has none of it, and takes each function's ARN as a parameter.
  expect(Object.values(r).filter((x) => x.Type == "AWS::CloudFront::Function" || x.Type == "AWS::CloudFront::KeyValueStore")).toEqual([]);
  expect(JSON.stringify(stackTemplate(gated))).not.toContain("E()");
  // The app's distribution: each part of the gate on its own paths; the Lambda only where the gate needs the network
  // (the callback) or a body (the token endpoint). The response function is on every behavior: it signs, and it
  // removes Erga's headers to the gate.
  expect(behaviorsOf(r.AppDistribution)).toEqual({
    "*": { request: "GateRequest", response: "GateResponse", lambda: null },
    "/_edge/*": { request: "GateEdge", response: "GateResponse", lambda: "origin-request" },
    "/oauth/token": { request: "GateAgents", response: "GateResponse", lambda: "origin-request with the body" },
    "/oauth/register": { request: "GateAgents", response: "GateResponse", lambda: "origin-request with the body" },
    "/.well-known/oauth-*": { request: "GateAgents", response: "GateResponse", lambda: null },
  });
  // The pages' distribution (each document's host, and the accept host): no callback and no token endpoint there.
  expect(behaviorsOf(r.PagesDistribution)).toEqual({
    "*": { request: "GateRequest", response: "GateResponse", lambda: null },
    "/_edge/*": { request: "GateEdge", response: "GateResponse", lambda: null },
  });
  // No cache keeps one of the gate's own answers; Erga's answers are the origin's to decide, as without the gate.
  const app = r.AppDistribution.Properties.DistributionConfig;
  expect(app.CacheBehaviors.map((b: Behavior) => b.CachePolicyId)).toEqual(Array(4).fill("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"));
  expect(app.DefaultCacheBehavior.CachePolicyId).toEqual({ Ref: "CachePolicy" });
  expect(app.CacheBehaviors[0].LambdaFunctionAssociations[0].LambdaFunctionARN).toEqual({ Ref: "EdgeVersion" });
  // The key that proves the gate to Erga: AWS makes it; both distributions send it with each request to the machine,
  // read by CloudFormation from the secret (a reference: no value in the template); the machine's role reads it.
  expect(r.GateKey).toMatchObject({ Type: "AWS::SecretsManager::Secret", Properties: { GenerateSecretString: { PasswordLength: 64 } } });
  expect(r.GateKey.Properties.Name).toBeUndefined();
  for (const d of [r.AppDistribution, r.PagesDistribution]) {
    const origin = d.Properties.DistributionConfig.Origins[0];
    expect(origin.VpcOriginConfig).toMatchObject({ VpcOriginId: { "Fn::GetAtt": ["Origin", "Id"] } });
    expect(origin.OriginCustomHeaders).toEqual([
      { HeaderName: "x-erga-front", HeaderValue: { "Fn::Sub": "{{resolve:secretsmanager:${GateKey}:SecretString}}" } },
    ]);
  }
  const role = r.Role.Properties.Policies[0].PolicyDocument.Statement;
  expect(role).toContainEqual({ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: "GateKey" } });
  // Without the gate: no such header, no such permission, no secret.
  const plain = resources({ ...gated, edge: { kind: "cloudfront", prefixList: "pl-82a045eb" } });
  expect(plain.AppDistribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders).toBeUndefined();
  expect(JSON.stringify(plain)).not.toContain("secretsmanager");
  expect(plain.GateKey).toBeUndefined();
  // The stack takes the Lambda's version and the functions from the us-east-1 stack, and says where the machine finds the key.
  const t = stackTemplate(gated) as { Parameters: Record<string, unknown>; Outputs: Record<string, unknown> };
  expect(Object.keys(t.Parameters)).toEqual(
    expect.arrayContaining(["AppCertificate", "PagesCertificate", "EdgeVersion", "GateEdge", "GateAgents", "GateRequest", "GateResponse"])
  );
  expect(t.Outputs).toMatchObject({ GateKey: { Value: { Ref: "GateKey" } } });
  expect(t.Outputs.Store).toBeUndefined();
  // The gate's functions hold the app's host: no gate on CloudFront's own names.
  expect(() => stackTemplate({ ...gated, domains: null })).toThrow("needs domains");
});

test("the gate's code is in us-east-1's stack, with the certificates: the four functions and their key store, and the Lambda", () => {
  const t = certificatesTemplate("erga-example-com", domains, code) as {
    Resources: Record<string, { Type: string; Properties: Record<string, any> }>;
    Outputs: Record<string, { Value: { Ref: string } }>;
  };
  expect(t.Resources.AppCertificate.Type).toBe("AWS::CertificateManager::Certificate");
  // The four functions, as built, each with the key store (the edge key is in it, never in a template).
  const functions = Object.entries(t.Resources).filter(([, x]) => x.Type == "AWS::CloudFront::Function");
  expect(functions.map(([name, x]) => [name, x.Properties.Name, x.Properties.FunctionCode]).sort()).toEqual([
    ["GateAgents", "erga-example-com-agents", "A()"],
    ["GateEdge", "erga-example-com-edge", "E()"],
    ["GateRequest", "erga-example-com-request", "R()"],
    ["GateResponse", "erga-example-com-response", "S()"],
  ]);
  for (const [name, x] of functions) {
    expect(x.Properties.FunctionConfig).toMatchObject({
      Runtime: "cloudfront-js-2.0",
      KeyValueStoreAssociations: [{ KeyValueStoreARN: { "Fn::GetAtt": ["Store", "Arn"] } }],
    });
    // The main stack takes each one's ARN, by the same name.
    expect(t.Outputs[name]).toEqual({ Value: { "Fn::GetAtt": [name, "FunctionMetadata.FunctionARN"] } } as never);
  }
  expect(t.Resources.Store.Type).toBe("AWS::CloudFront::KeyValueStore");
  expect(t.Outputs.Store).toEqual({ Value: { "Fn::GetAtt": ["Store", "Arn"] } } as never);
  expect(t.Resources.Edge.Properties).toMatchObject({ Runtime: "nodejs22.x", Handler: "index.handler", Code: { ZipFile: code.lambda } });
  // Lambda@Edge has no environment: its settings are in its code.
  expect(t.Resources.Edge.Properties.Environment).toBeUndefined();
  expect(t.Resources.EdgeRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toEqual([
    "lambda.amazonaws.com",
    "edgelambda.amazonaws.com",
  ]);
  // It reads the sign-in's client secret, and nothing else. That parameter is not in the machine's folder.
  expect(t.Resources.EdgeRole.Properties.Policies[0].PolicyDocument.Statement).toEqual([
    {
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: {
        "Fn::Sub": "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/erga-gate/erga-example-com/idp-secret",
      },
    },
  ]);
  expect(idpSecretParam("erga-example-com").startsWith(paramPath("erga-example-com"))).toBe(false);
  // A distribution names a version. Another build is another resource, so CloudFormation makes its version.
  const version = t.Outputs.EdgeVersion.Value.Ref;
  expect(t.Resources[version]).toEqual({
    Type: "AWS::Lambda::Version",
    DeletionPolicy: "Retain",
    Properties: { FunctionName: { Ref: "Edge" } },
  } as never);
  const next = certificatesTemplate("erga-example-com", domains, { ...code, lambda: "exports.handler=other;" }) as typeof t;
  expect(next.Outputs.EdgeVersion.Value.Ref).not.toBe(version);
  // Without the gate: the certificates only.
  expect(Object.keys((certificatesTemplate("erga", domains) as typeof t).Resources)).toEqual(["AppCertificate", "PagesCertificate"]);
});

test("the gate's code is built for the instance: its hosts and its issuer in the functions, the secret's name in the Lambda, no secret's value", async () => {
  const built = await gateCode("erga-example-com", domains, oidc, "us-east-1");
  for (const part of GATE_PARTS) {
    // Each one under CloudFront's 10 KB (gate/build.ts refuses a larger one), and a script: CloudFront calls `handler`.
    expect(built.functions[part].length).toBeLessThan(10 * 1024);
    expect(built.functions[part]).toContain("function handler(");
    expect(built.functions[part]).toContain('shell:"erga.example.com"');
    expect(built.functions[part]).toContain('content:"example-pages.com"');
  }
  // Only people with a proof come in, and the organization's issuer signs them in, with this server's client there.
  expect(gateSettings(domains, oidc)).toEqual({
    shell: "erga.example.com",
    content: "example-pages.com",
    https: true,
    open: false,
    idp: { sso: { authorize: oidc.authorize, client: "client-1", scope: "openid email profile" } },
    oauth: true,
    hours: 30 * 24,
  });
  // A sign-in lasts 30 days, or the days that the deploy says (--sign-in-days): in the code of the function that signs.
  expect(built.functions.response).toContain("hours:720");
  expect(gateSettings(domains, oidc, 7).hours).toBe(7 * 24);
  expect((await gateCode("erga-example-com", domains, oidc, "us-east-1", 7)).functions.response).toContain("hours:168");
  // The Lambda: a script that CloudFormation takes inline, with where the client's secret is, and the token endpoint.
  expect(built.lambda.length).toBeLessThanOrEqual(INLINE_MAX);
  expect(built.lambda).toMatch(/exports\.handler=[\w$]+;$/);
  expect(built.lambda).toContain("/erga-gate/erga-example-com/idp-secret");
  expect(built.lambda).toContain(oidc.token);
  // The us-east-1 stack written to disk carries the code, within the size that CloudFormation takes from a command.
  const dir = mkdtempSync(join(tmpdir(), "erga-gate-"));
  try {
    const shape: AwsShape = { ...gated, edge: { kind: "gate", prefixList: "pl-1", code: built } };
    const [certs, main] = writeTemplates(dir, shape);
    const edge = JSON.parse(readFileSync(certs, "utf8"));
    expect(edge.Resources.Edge.Properties.Code.ZipFile).toBe(built.lambda);
    expect(edge.Resources.GateRequest.Properties.FunctionCode).toBe(built.functions.request);
    for (const file of [certs, main]) expect(readFileSync(file).length).toBeLessThan(TEMPLATE_MAX);
    // Four functions at CloudFront's own limit (10 KB each) still fit (here with no character that JSON escapes).
    const full = "x".repeat(10 * 1024);
    const most = { functions: { edge: full, agents: full, request: full, response: full }, lambda: "y".repeat(INLINE_MAX) };
    expect(readFileSync(writeTemplates(dir, { ...shape, edge: { kind: "gate", prefixList: "pl-1", code: most } })[0]).length).toBeLessThan(
      TEMPLATE_MAX
    );
    // A template over the limit fails here, with its size: not at AWS.
    const over = { ...most, lambda: "y".repeat(8000) };
    expect(() => writeTemplates(dir, { ...shape, edge: { kind: "gate", prefixList: "pl-1", code: over } })).toThrow(
      "CloudFormation takes 51200"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate's edge key goes into its store one time: a store that has one keeps it", async () => {
  const calls: string[][] = [];
  const store = "arn:aws:cloudfront::1:key-value-store/abc";
  let key = "";
  const aws = (has: boolean) =>
    (async (...args: string[]) => {
      calls.push(args);
      // (The key's file is there only while the command runs.)
      if (args[1] == "put-key") key = readFileSync(args[7].replace("file://", ""), "utf8");
      if (args[1] == "get-key") {
        if (!has)
          throw new Error("aws cloudfront-keyvaluestore get-key failed: An error occurred (ResourceNotFoundException): Key not found");
        return { Key: "key" };
      }
      return args[1] == "describe-key-value-store" ? { ETag: "E1" } : null;
    }) as Aws;
  expect(await putEdgeKey(aws(false), store)).toBe(true);
  const put = calls.find((c) => c[1] == "put-key")!;
  expect(put.slice(0, 6)).toEqual(["cloudfront-keyvaluestore", "put-key", "--kvs-arn", store, "--key", "key"]);
  expect(put.slice(8)).toEqual(["--if-match", "E1"]);
  // A random key of 48 bytes: the gate signs with it. It goes through a file of this user's, which is gone after: a
  // command's words show in the process list, and the CLI takes a value that starts with "-" for an option.
  expect(key).toMatch(/^[\w-]{64}$/);
  expect(put[7]).toMatch(/^file:\/\//);
  expect(JSON.stringify(calls)).not.toContain(key);
  expect(existsSync(put[7].replace("file://", ""))).toBe(false);
  calls.length = 0;
  expect(await putEdgeKey(aws(true), store)).toBe(false);
  expect(calls.map((c) => c[1])).toEqual(["get-key"]);
  // Any other failure stops the deploy: no key is written over a store that could not be read.
  const broken = (async () => {
    throw new Error("aws cloudfront-keyvaluestore get-key failed: AccessDenied");
  }) as Aws;
  await expect(putEdgeKey(broken, store)).rejects.toThrow("AccessDenied");
});

const viaGate = {
  ...aws,
  host: "erga.example.com",
  region: "us-west-2",
  signIn: "sso" as const,
  organization: "",
  issuer: "https://idp.example.com/pool",
  client: "client-1",
};

test("the organization's sign-in on AWS: the entry says where the gate's key is, and anyone who passes the gate may write", () => {
  // The machine's deploy reads the key that the gate sends from the stack's secret: the entry names it.
  const secret = "arn:aws:secretsmanager:us-west-2:123456789012:secret:GateKey-AbCdEf";
  const entry = awsEntry(viaGate, "123456789012", { AppHost: "erga.example.com", GateKey: secret }, undefined);
  expect(entry.aws.gate).toBe(secret);
  expect(entry.vars.GITHUB_CLIENT_ID).toBe("");
  expect(entry.aws.pages).toEqual({ kind: "domain", domain: "pages.erga.example.com" });
  // With no gate in front, the entry names no key.
  expect("gate" in awsEntry(aws, "1", { AppHost: "erga.example.com" }, undefined).aws).toBe(false);
  const sql = firstSql(viaGate);
  expect(sql).toContain("INSERT INTO server_config (key, value, updated) SELECT 'anyone_access', '\"write\"',");
  expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')");
  expect(sql).not.toContain("INSERT INTO people");
});

test("the sign-in's endpoints come from its issuer; setup's check of the sign-in reads the deployed settings, not the server", async () => {
  const document = {
    issuer: oidc.issuer,
    authorization_endpoint: oidc.authorize,
    token_endpoint: oidc.token,
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

  // The settings that the release runs with must be the answers' sign-in. (The proxy's setting is from before the
  // gate: the server reads it no more, and setup still compares it.)
  const signer = "arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/x/1";
  const deployed = varsOf(viaGate, undefined, signer);
  expect(signInOf(viaGate, undefined, deployed, signer)).toBe("ok");
  expect(signInOf({ ...viaGate, client: "client-2" }, undefined, deployed, signer)).toMatchObject({
    bad: expect.stringContaining("PROXY_SIGN_IN"),
  });
  // A release from before the stack had its proxy runs with no proxy at all.
  expect(signInOf(viaGate, undefined, { PROXY_SIGN_IN: "{}" }, signer)).toMatchObject({ bad: expect.stringContaining("deploy again") });
  // With a GitHub App: its client id.
  const github = { ...aws, pages: "example-pages.com" };
  expect(signInOf(github, "Iv1.ada", { GITHUB_CLIENT_ID: "Iv1.ada" })).toBe("ok");
  expect(signInOf(github, "Iv1.ada", { GITHUB_CLIENT_ID: "Iv1.other" })).toEqual({
    bad: "it signs in with the app Iv1.other, not yours (Iv1.ada): deploy again",
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

test("the NAT machine has room for dnf, its script runs at each start, and adds its rule one time", () => {
  // On a t4g.nano the kernel stopped dnf, also with the swap file: the default is a t4g.micro.
  expect((stackTemplate(shape).Parameters as any).NatType.Default).toBe("t4g.micro");
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

test("a deploy again of the same release runs this deploy's settings, not those of the release the machine ran before", () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-machine-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The machine's commands, faked: the bucket gives release.tgz, celld keeps the settings it loaded.
  const tool = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  tool(
    "aws",
    `case "$1 $2" in
  "s3 cp") cat "$FAKE/release.tgz" ;;
  "s3 ls") echo node ;;
  "ssm get-parameters-by-path") echo '{"Parameters":[{"Name":"/erga/erga/SESSION_SECRET","Value":"s"}]}' ;;
  "secretsmanager get-secret-value") [ "$4" = "$FAKE_SECRET" ] && echo the-gate-key || { echo "AccessDenied" >&2; exit 254; } ;;
esac`
  );
  tool("celld", `[ "$1" = deploy ] && cp wrangler.json "$FAKE/loaded.json"; true`);
  // The release answers its own health check on the loopback: healthy, as release v1. (As curl does, it reads the
  // header that comes on its input: else the script's printf may write to a pipe that nothing reads, and fail.)
  tool("curl", `case "$*" in *"-H @-"*) cat >/dev/null ;; esac; echo '{"ok":true,"version":"v1","checks":{}}'`);
  // (macOS's sed needs a suffix after -i.)
  tool(
    "sed",
    `if [ "$1" = -i ] && [ "$(uname)" = Darwin ]; then shift; exec ${Bun.which("sed")} -i '' "$@"; fi; exec ${Bun.which("sed")} "$@"`
  );
  const SECRET = "arn:aws:secretsmanager:us-west-2:1:secret:GateKey-AbCdEf";
  const scriptOf = (gateKey?: string) =>
    deployScript({ bucket: "bucket", region: "us-west-2", stack: "erga", version: "v1", gateKey }).replaceAll(
      "/var/lib/erga",
      join(dir, "state")
    );
  const run = (proxy: string, script: string, more: Record<string, string> = {}) => {
    const release = join(dir, "release");
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "wrangler.json"), JSON.stringify({ vars: { PROXY_SIGN_IN: proxy } }));
    Bun.spawnSync(["tar", "-czf", join(dir, "release.tgz"), "-C", release, "."]);
    rmSync(join(dir, "loaded.json"), { force: true });
    return Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: dir, FAKE_SECRET: SECRET, ...more },
    });
  };
  const deploy = (proxy: string, script = scriptOf(), more: Record<string, string> = {}) => {
    const r = run(proxy, script, more);
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    return JSON.parse(readFileSync(join(dir, "loaded.json"), "utf8")).vars;
  };
  try {
    expect(deploy("old")).toEqual({ PROXY_SIGN_IN: "old", SESSION_SECRET: "s" });
    expect(deploy("new")).toEqual({ PROXY_SIGN_IN: "new", SESSION_SECRET: "s" });
    // With the gate in front: the machine reads the key that the gate sends from the stack's secret, as Erga's GATE_KEY.
    expect(deploy("new", scriptOf(SECRET))).toEqual({ PROXY_SIGN_IN: "new", SESSION_SECRET: "s", GATE_KEY: "the-gate-key" });
    // A machine that can't read the key loads nothing: without it Erga would take itself for a server with no gate.
    const refused = run("new", scriptOf("arn:another"));
    expect([refused.exitCode == 0, existsSync(join(dir, "loaded.json"))]).toEqual([false, false]);
    // The machine's own health check carries the key: Erga behind a gate answers no request without it.
    // (From curl's input: the key is in no command's words.)
    expect(scriptOf(SECRET)).toContain(
      `health() { printf 'x-erga-front: %s\\n' "$GATE_KEY" | curl -sS -m 10 -H @- localhost:8080/api/health 2>/dev/null; }`
    );
    expect(scriptOf()).toContain("health() { curl -sS -m 10 localhost:8080/api/health 2>/dev/null; }");
    expect(healthScript({ key: SECRET, region: "us-west-2" })).toBe(
      `export AWS_REGION=us-west-2\nGATE_KEY=$(aws secretsmanager get-secret-value --secret-id '${SECRET}' --query SecretString --output text) || true\nprintf 'x-erga-front: %s\\n' "$GATE_KEY" | curl -sS -m 10 -H @- localhost:8080/api/health 2>/dev/null || true`
    );
    // With no gate, a GATE_KEY of the machine's own environment is not the release's.
    expect(deploy("new", scriptOf(), { GATE_KEY: "stray" })).toEqual({ PROXY_SIGN_IN: "new", SESSION_SECRET: "s" });
    expect(readFileSync(join(dir, "state", "deployed"), "utf8")).toBe("v1\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what an instance on AWS runs, and its health: the parameter that each deploy and rollback writes, and the machine's own check", async () => {
  // Not in the stack's folder: the machine loads every parameter of that folder into the Worker's settings.
  expect(liveParam("erga")).toBe("/erga-live/erga");
  expect(liveParam("erga").startsWith(paramPath("erga"))).toBe(false);
  const calls: string[] = [];
  let live: string | null = null;
  // What the server answers the machine on the loopback (GET /api/health), or nothing.
  let report = JSON.stringify({ ok: true, version: "abc123def456", checks: { db: { ok: true } } });
  const fake: Aws = async (...args) => {
    calls.push(args.slice(0, 2).join(" "));
    const op = args[1];
    if (op == "send-command") {
      // The machine's command is the health check, and nothing else.
      expect(JSON.parse(args[args.indexOf("--parameters") + 1]).commands).toEqual([healthScript()]);
      return { Command: { CommandId: "c-1" } } as never;
    }
    if (op == "get-command-invocation") return { Status: "Success", StandardOutputContent: report, StandardErrorContent: "" } as never;
    if (op != "get-parameter") throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: not faked`);
    expect(args.slice(2)).toEqual(["--name", "/erga-live/erga-example-com"]);
    if (!live)
      throw new Error("aws ssm get-parameter failed: An error occurred (ParameterNotFound) when calling the GetParameter operation: ");
    return { Parameter: { Value: live } } as never;
  };
  expect(await liveOnAws(fake, "erga-example-com")).toBeNull();
  const entry = awsEntry(
    { ...aws, pages: "example-pages.com" },
    "123456789012",
    { AppHost: "erga.example.com", Bucket: "b", Machine: "i-1" },
    "Iv1.ada"
  );
  expect(entry.aws.stack).toBe("erga-example-com");
  const places: string[] = [];
  const ask = instanceReader({ aws: (where) => (places.push(`${where.profile} in ${where.region}`), fake) });
  // Before the first deploy with this code: no record, and the answer says what makes one.
  expect(await ask(entry)).toEqual({ version: null, error: "no release on record yet: bun erga deploy erga.example.com", healthy: true });
  live = "abc123def456";
  expect(await ask(entry)).toEqual({ version: "abc123def456", healthy: true });
  expect(places.at(-1)).toBe("work in eu-west-1");
  // Only AWS's API was asked: the parameter, and one command on the machine.
  expect([...new Set(calls)].sort()).toEqual(["ssm get-command-invocation", "ssm get-parameter", "ssm send-command"]);
  // The server's own report says a check fails; it runs another release; it gives no report.
  report = JSON.stringify({ ok: false, version: "abc123def456", checks: { documents: { ok: false, error: "no host" } } });
  expect(await ask(entry)).toEqual({ version: "abc123def456", healthy: false, health: "documents: no host" });
  report = JSON.stringify({ ok: true, version: "000000000000", checks: {} });
  expect(await ask(entry)).toEqual({ version: "abc123def456", healthy: false, health: "it runs 000000000000" });
  report = "";
  expect(await ask(entry)).toEqual({ version: "abc123def456", healthy: null, health: "the machine's server gave no health report" });
  // An AWS error is the answer's error.
  const broken = instanceReader({ aws: () => async () => Promise.reject(new Error("aws ssm get-parameter failed: ExpiredToken")) });
  expect((await broken(entry)).error).toBe("aws ssm get-parameter failed: ExpiredToken");
});

test("on the machine: a release's deploy facts for bun erga register, and setup's look for an admin in the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-machine-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tool = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // The bucket gives the release that the machine's list names last; celld prints its command's rows as a table.
  tool("aws", `[ "$1 $2" = "s3 cp" ] && { echo "$3" > "$FAKE/asked"; cat "$FAKE/release.tgz"; }`);
  tool("celld", `echo "$@" > "$FAKE/celld"; printf '| who |\\n| admin:ada@example.com |\\n'`);
  const facts = { aws: { stack: "erga" }, vars: { PROXY_SIGN_IN: "p" } };
  const release = join(dir, "release");
  mkdirSync(release);
  writeFileSync(join(release, "wrangler.json"), JSON.stringify({ vars: { ERGA_DEPLOY: JSON.stringify(facts), SESSION_SECRET: "never" } }));
  Bun.spawnSync(["tar", "-czf", join(dir, "release.tgz"), "-C", release, "."]);
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "state", "deployed"), "v0\nv1\n");
  const run = (script: string) => {
    const r = Bun.spawnSync(["bash", "-c", script.replaceAll("/var/lib/erga", join(dir, "state"))], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: dir },
    });
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    return r.stdout.toString();
  };
  try {
    // The facts: one line of JSON, the release's ERGA_DEPLOY and nothing else of its settings.
    expect(JSON.parse(run(factsScript({ bucket: "bucket", region: "us-west-2", version: "v1" })))).toEqual(facts);
    expect(readFileSync(join(dir, "asked"), "utf8").trim()).toBe("s3://bucket/releases/v1.tgz");
    // The admin: the statement reaches celld whole, in the release that runs (the list's last), and its mark is read.
    const out = run(sqlScript({ bucket: "bucket", region: "us-west-2", sql: ADMIN_SQL }));
    expect(readFileSync(join(dir, "asked"), "utf8").trim()).toBe("s3://bucket/releases/v1.tgz");
    expect(readFileSync(join(dir, "celld"), "utf8").trim()).toBe(`d1 execute erga . --bucket s3://bucket/fleet --command ${ADMIN_SQL}`);
    expect(adminIn(out)).toBe("ada@example.com");
    // No admin: no row. celld's echo of the statement is not a row.
    expect(adminIn("| who |\n")).toBeNull();
    expect(adminIn(`Executing: ${ADMIN_SQL}`)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate in front: no behavior with the Lambda goes to the VPC origin, which CloudFront refuses", () => {
  const r = resources(gated);
  for (const d of [r.AppDistribution, r.PagesDistribution]) {
    const c = d.Properties.DistributionConfig;
    const vpc = new Set(c.Origins.filter((o: any) => o.VpcOriginConfig).map((o: any) => o.Id));
    for (const b of [c.DefaultCacheBehavior, ...(c.CacheBehaviors ?? [])])
      if (b.LambdaFunctionAssociations?.some((l: any) => l.EventType.startsWith("origin-"))) expect(vpc.has(b.TargetOriginId)).toBe(false);
    // The other origin gets no key of the machine's.
    for (const o of c.Origins.filter((o: any) => !o.VpcOriginConfig)) expect(o.OriginCustomHeaders).toBeUndefined();
  }
  expect(r.GateOrigin.Type).toBe("AWS::S3::Bucket");
});

test("the gate in front: a behavior with the Lambda passes it only the header it reads, never the all-viewer policy", () => {
  const r = resources(gated);
  const c = r.AppDistribution.Properties.DistributionConfig;
  for (const b of c.CacheBehaviors.filter((b: any) => b.LambdaFunctionAssociations))
    expect(b.OriginRequestPolicyId).toEqual({ Ref: "GateOriginPolicy" });
  expect(r.GateOriginPolicy.Properties.OriginRequestPolicyConfig.HeadersConfig.Headers).toEqual(["x-erga-exchange"]);
});
