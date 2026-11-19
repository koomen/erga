// The AWS infrastructure of one Erga instance, as CloudFormation templates: what `bun erga setup` writes into
// .erga/aws/ for the user to read and change, before it makes the stacks (deploy/aws/stack.ts). Pure: no network.
//
// The main stack, in the instance's region:
//   - the network: a new VPC with a private subnet for the machine and a public one for its way out (a NAT machine or a
//     NAT gateway), or a private subnet of a VPC the user names, which has its own way out;
//   - the machine (celld and Chrome, deploy/aws/machine.ts): no public address, and only CloudFront may reach its port;
//   - the bucket (celld's state, the releases, the programs), the KMS key (the bucket and the secrets), the role;
//   - the edge (what answers the internet): CloudFront, two distributions, the app's and the pages', each with the
//     machine as its VPC origin. With domains, a second stack in us-east-1 holds the ACM certificates, where CloudFront
//     needs them (certificatesTemplate). One of two:
//       cloudfront   nothing in front of Erga: the gate runs inside it (OAuth mode);
//       gate         the gate in front, with the organization's OIDC sign-in (SSO: gate/mounts/cloudfront.ts): its four
//                    CloudFront Functions on each distribution, and the key that only the distributions and the
//                    machine know (GATE_KEY: the origin's header). The gate's code is in the us-east-1 stack: the
//                    four functions, their KeyValueStore (the edge key), and the Lambda@Edge function, which
//                    CloudFront takes only from there. It needs domains: the functions hold the app's host;
//   - with domains: the Route 53 records of the app's name and the pages' wildcard name.
//
// The structure follows the answers (the way out, the domains); the sizes and the machine image are the template's
// parameters, with defaults, which the user may change in the file.

import { FRONT } from "../../gate/mounts/web.ts";

/** The answers that shape an instance's stacks. */
export interface AwsShape {
  /** The instance's own name: the stack's, and every name in it. */
  stack: string;
  /** How the machine reaches the internet (the model APIs, sign-in): a NAT machine, a NAT gateway, or the user's VPC. */
  egress: { kind: "nat-instance" } | { kind: "nat-gateway" } | { kind: "vpc"; vpcId: string; subnetId: string };
  /** The domains, each with its Route 53 hosted zone; none: CloudFront's own names (the pages on one shared name). */
  domains: { app: string; appZone: string; pages: string; pagesZone: string } | null;
  /**
   * What answers the internet: CloudFront, with the region's origin-facing prefix list
   * (com.amazonaws.global.cloudfront.origin-facing). `gate`: the gate in front, built for this instance; it needs
   * domains.
   */
  edge: { kind: "cloudfront"; prefixList: string } | { kind: "gate"; prefixList: string; code: GateCode };
}

/** The organization's OIDC sign-in, as its issuer publishes it (/.well-known/openid-configuration), and Erga's client there. */
export interface Oidc {
  issuer: string;
  authorize: string;
  token: string;
  clientId: string;
}

/** The gate's four CloudFront Functions, by the part of the gate each is (gate/build.ts). */
export const GATE_PARTS = ["edge", "agents", "request", "response"] as const;
/** Each one's name in the us-east-1 stack, and of the main stack's parameter that takes its ARN. */
export const GATE_FUNCTIONS = { edge: "GateEdge", agents: "GateAgents", request: "GateRequest", response: "GateResponse" } as const;
/**
 * CloudFormation's limit on a template that a command sends (--template-body). The gate's code is most of the
 * us-east-1 stack's template: four functions of 10 KB at most each. So that template is written with no indentation.
 */
export const TEMPLATE_MAX = 51_200;
/**
 * The gate's code for one instance (deploy/aws/gate.ts builds it: the settings are in the code, since nothing at the
 * edge has environment variables): each CloudFront Function, and the Lambda@Edge function as CloudFormation takes it
 * inline.
 */
export interface GateCode {
  functions: Record<(typeof GATE_PARTS)[number], string>;
  lambda: string;
}

/** The port celld answers on, on the machine. Only the edge reaches it. */
export const CELLD_PORT = 8080;
/** Where the instance's secrets are in Parameter Store: /erga/<stack>/<NAME>. */
export const paramPath = (stack: string) => `/erga/${stack}/`;
/**
 * The parameters' folder, as the machine asks for it and as its role allows it. Trap: IAM compares the path as it is
 * given: with a "/" at its end it is another resource, and AWS refuses the machine.
 */
export const paramFolder = (stack: string) => paramPath(stack).slice(0, -1);
/**
 * The parameter (Parameter Store, a SecureString, in us-east-1) that holds the secret of Erga's client at the
 * organization's sign-in: the user who has the secret stores it there (setup's page), and only the gate's
 * Lambda@Edge function reads it. It is never in a file, a template or a chat. Trap: it is not in the stack's folder
 * (paramFolder): the machine loads every parameter of that folder into the Worker's settings, and Erga never holds
 * this secret.
 */
export const idpSecretParam = (stack: string) => `/erga-gate/${stack}/idp-secret`;
/**
 * What the NAT machine runs at each start (cloud-init runs a plain script at the first start only: then a change to
 * this script would do nothing, and a script that failed would never run again). Each step is safe to do again.
 * Trap: on a t4g.nano (512 MB), the kernel stopped dnf even with the swap file. Amazon Linux gives a machine under
 * 800 MB a swap in RAM (zram), which the kernel fills first, and the agents of Systems Manager use RAM too. A t4g.micro
 * (1 GB) has no zram, and dnf fits: so NatType is a t4g.micro, never smaller.
 */
export const NAT_USER_DATA = [
  'Content-Type: multipart/mixed; boundary="//"',
  "MIME-Version: 1.0",
  "",
  "--//",
  "Content-Type: text/cloud-config",
  "",
  "#cloud-config",
  "cloud_final_modules:",
  "  - [scripts-user, always]",
  "",
  "--//",
  "Content-Type: text/x-shellscript",
  "",
  "#!/bin/bash",
  "set -euo pipefail",
  "if ! rpm -q iptables-services > /dev/null; then",
  "  swapoff /swap 2> /dev/null || true",
  "  dd if=/dev/zero of=/swap bs=1M count=1024 status=none && chmod 600 /swap && mkswap -q /swap && swapon /swap",
  "  dnf install -y -q iptables-services",
  "  swapoff /swap && rm /swap",
  "fi",
  "echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-nat.conf && sysctl -q -p /etc/sysctl.d/90-nat.conf",
  "dev=$(ip route show default | awk '{print $5; exit}')",
  'rule="POSTROUTING -o $dev -s 10.80.0.0/16 -j MASQUERADE"',
  "iptables -t nat -C $rule 2> /dev/null || iptables -t nat -A $rule",
  "iptables -F FORWARD && service iptables save && systemctl enable --now iptables",
  "--//--",
  "",
].join("\n");

/** CloudFront's managed origin request policy AllViewer: the viewer's Host, headers, cookies and query to the origin. */
const ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3";
/** CloudFront's managed cache policy CachingDisabled: the gate's own answers are never a cache's. */
const NO_CACHE = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
/** Route 53's hosted zone of every CloudFront distribution, for an alias record. */
const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2";

/**
 * The viewer-request function: X-Forwarded-Host is the Host the viewer asked for.
 * Trap: not X-Forwarded-Proto. CloudFront refuses a function that writes it, with a 502 for each request ("The
 * CloudFront function tried to add a disallowed header": seen on a real distribution, 2026-11-18), and it removes
 * that header from the viewer's request and from the origin's custom headers too. The server needs no header for the
 * scheme: a deployed server's address is https (shared/http.ts, overHttps).
 */
const FORWARDED = `function handler(event) {
  var r = event.request;
  r.headers["x-forwarded-host"] = { value: r.headers.host.value };
  return r;
}
`;

type Json = Record<string, unknown>;
const ref = (name: string) => ({ Ref: name });
const att = (name: string, a: string) => ({ "Fn::GetAtt": [name, a] });
const sub = (s: string) => ({ "Fn::Sub": s });
const tags = (stack: string, name: string) => [
  { Key: "erga", Value: stack },
  { Key: "Name", Value: `${stack}-${name}` },
];

/** The network: the subnet the machine is in, and the resources that make it. */
function network(s: AwsShape): { subnet: unknown; vpc: unknown; resources: Json } {
  if (s.egress.kind == "vpc") return { subnet: s.egress.subnetId, vpc: s.egress.vpcId, resources: {} };
  const az = { "Fn::Select": [0, { "Fn::GetAZs": "" }] };
  const r: Json = {
    Vpc: {
      Type: "AWS::EC2::VPC",
      Properties: { CidrBlock: "10.80.0.0/16", EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags(s.stack, "vpc") },
    },
    // CloudFront's VPC origins need an internet gateway in the VPC; the NAT's way out uses it too.
    Gateway: { Type: "AWS::EC2::InternetGateway", Properties: { Tags: tags(s.stack, "gateway") } },
    GatewayAttachment: { Type: "AWS::EC2::VPCGatewayAttachment", Properties: { VpcId: ref("Vpc"), InternetGatewayId: ref("Gateway") } },
    PublicSubnet: {
      Type: "AWS::EC2::Subnet",
      Properties: { VpcId: ref("Vpc"), CidrBlock: "10.80.0.0/24", AvailabilityZone: az, Tags: tags(s.stack, "public") },
    },
    PrivateSubnet: {
      Type: "AWS::EC2::Subnet",
      Properties: { VpcId: ref("Vpc"), CidrBlock: "10.80.1.0/24", AvailabilityZone: az, Tags: tags(s.stack, "private") },
    },
    PublicRoutes: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: ref("Vpc"), Tags: tags(s.stack, "public") } },
    PublicDefault: {
      Type: "AWS::EC2::Route",
      DependsOn: "GatewayAttachment",
      Properties: { RouteTableId: ref("PublicRoutes"), DestinationCidrBlock: "0.0.0.0/0", GatewayId: ref("Gateway") },
    },
    PublicRoutesOf: {
      Type: "AWS::EC2::SubnetRouteTableAssociation",
      Properties: { SubnetId: ref("PublicSubnet"), RouteTableId: ref("PublicRoutes") },
    },
    PrivateRoutes: { Type: "AWS::EC2::RouteTable", Properties: { VpcId: ref("Vpc"), Tags: tags(s.stack, "private") } },
    PrivateRoutesOf: {
      Type: "AWS::EC2::SubnetRouteTableAssociation",
      Properties: { SubnetId: ref("PrivateSubnet"), RouteTableId: ref("PrivateRoutes") },
    },
    // The bucket without the NAT: S3's gateway endpoint costs nothing.
    S3Endpoint: {
      Type: "AWS::EC2::VPCEndpoint",
      Properties: {
        VpcId: ref("Vpc"),
        ServiceName: sub("com.amazonaws.${AWS::Region}.s3"),
        VpcEndpointType: "Gateway",
        RouteTableIds: [ref("PrivateRoutes")],
      },
    },
  };
  if (s.egress.kind == "nat-gateway") {
    r.NatAddress = { Type: "AWS::EC2::EIP", DependsOn: "GatewayAttachment", Properties: { Domain: "vpc", Tags: tags(s.stack, "nat") } };
    r.Nat = {
      Type: "AWS::EC2::NatGateway",
      Properties: { AllocationId: att("NatAddress", "AllocationId"), SubnetId: ref("PublicSubnet"), Tags: tags(s.stack, "nat") },
    };
    r.PrivateDefault = {
      Type: "AWS::EC2::Route",
      Properties: { RouteTableId: ref("PrivateRoutes"), DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: ref("Nat") },
    };
  } else {
    // A small machine that forwards the private subnet's traffic out (Amazon Linux, iptables), in the public subnet.
    r.NatFirewall = {
      Type: "AWS::EC2::SecurityGroup",
      Properties: {
        GroupDescription: "Erga NAT: traffic from the VPC only",
        VpcId: ref("Vpc"),
        SecurityGroupIngress: [{ IpProtocol: "-1", CidrIp: "10.80.0.0/16" }],
        Tags: tags(s.stack, "nat"),
      },
    };
    r.Nat = {
      Type: "AWS::EC2::Instance",
      DependsOn: "PublicDefault",
      Properties: {
        ImageId: ref("MachineImage"),
        InstanceType: ref("NatType"),
        SourceDestCheck: false,
        MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
        NetworkInterfaces: [
          { DeviceIndex: "0", SubnetId: ref("PublicSubnet"), AssociatePublicIpAddress: true, GroupSet: [ref("NatFirewall")] },
        ],
        UserData: { "Fn::Base64": NAT_USER_DATA },
        Tags: tags(s.stack, "nat"),
      },
    };
    r.PrivateDefault = {
      Type: "AWS::EC2::Route",
      Properties: { RouteTableId: ref("PrivateRoutes"), DestinationCidrBlock: "0.0.0.0/0", InstanceId: ref("Nat") },
    };
  }
  return { subnet: ref("PrivateSubnet"), vpc: ref("Vpc"), resources: r };
}

const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];
const functionArn = (name: string) => att(name, "FunctionMetadata.FunctionARN");

/**
 * A behavior of a distribution with the gate in front: `request` is the gate's function on its viewer request (the
 * main stack's parameter with its ARN), and the gate's response function is on every viewer response (it signs, and
 * it removes Erga's own headers to the gate).
 * `own`: one of the gate's own paths, whose answers no cache keeps. `lambda`: the Lambda@Edge function is its origin
 * request (the callback's code exchange; with `body`, the token endpoint's form).
 * Trap: CloudFront refuses an origin-request Lambda@Edge on a behavior whose origin is a VPC origin ("VPC origin with an
 * origin Lambda@Edge association is not supported"). A behavior with the Lambda goes to the "gate" origin instead: an
 * empty, private bucket that no request reaches, since the Lambda and the gate's functions answer each one. It never
 * gets the machine's key (the origin's header).
 */
const gated = (part: "edge" | "agents" | "request", o: { own?: boolean; lambda?: boolean; body?: boolean } = {}): Json => ({
  TargetOriginId: o.lambda ? "gate" : "machine",
  ViewerProtocolPolicy: "redirect-to-https",
  AllowedMethods: ALL_METHODS,
  CachedMethods: ["GET", "HEAD"],
  Compress: !o.own,
  CachePolicyId: o.own ? NO_CACHE : ref("CachePolicy"),
  // (CloudFront refuses the all-viewer policy for a bucket origin: the Lambda gets only the header it reads.)
  OriginRequestPolicyId: o.lambda ? ref("GateOriginPolicy") : ALL_VIEWER,
  FunctionAssociations: [
    { EventType: "viewer-request", FunctionARN: ref(GATE_FUNCTIONS[part]) },
    { EventType: "viewer-response", FunctionARN: ref(GATE_FUNCTIONS.response) },
  ],
  ...(o.lambda
    ? { LambdaFunctionAssociations: [{ EventType: "origin-request", LambdaFunctionARN: ref("EdgeVersion"), IncludeBody: !!o.body }] }
    : {}),
});

/**
 * A distribution for the machine: the app's (its name, or CloudFront's own), or the pages' (a wildcard, or one shared
 * name). `gate`: with the gate in front. Each of its parts has its own paths (gate/mounts/cloudfront.ts); the token
 * endpoint and the callback are the app's only, and so is the Lambda. Each request that goes on to the machine
 * carries the key that only the distributions and the machine know (the origin's header, which replaces any header
 * of that name from a viewer): CloudFormation reads it from the stack's secret, and it is in no file.
 */
function distribution(s: AwsShape, which: "App" | "Pages", gate: boolean): Json {
  const alias = s.domains ? (which == "App" ? s.domains.app : `*.${s.domains.pages}`) : null;
  const app = which == "App";
  return {
    Type: "AWS::CloudFront::Distribution",
    Properties: {
      DistributionConfig: {
        Comment: `${s.stack} ${which.toLowerCase()}`,
        Enabled: true,
        PriceClass: "PriceClass_100",
        HttpVersion: "http2and3",
        IPV6Enabled: true,
        ...(alias
          ? {
              Aliases: [alias],
              ViewerCertificate: {
                AcmCertificateArn: ref(`${which}Certificate`),
                SslSupportMethod: "sni-only",
                MinimumProtocolVersion: "TLSv1.2_2021",
              },
            }
          : { ViewerCertificate: { CloudFrontDefaultCertificate: true } }),
        Origins: [
          {
            Id: "machine",
            DomainName: att("Machine", "PrivateDnsName"),
            VpcOriginConfig: { VpcOriginId: att("Origin", "Id"), OriginReadTimeout: 60, OriginKeepaliveTimeout: 5 },
            ...(gate
              ? { OriginCustomHeaders: [{ HeaderName: FRONT, HeaderValue: sub("{{resolve:secretsmanager:${GateKey}:SecretString}}") }] }
              : {}),
          },
          ...(gate && app
            ? [{ Id: "gate", DomainName: att("GateOrigin", "RegionalDomainName"), S3OriginConfig: { OriginAccessIdentity: "" } }]
            : []),
        ],
        ...(gate
          ? {
              DefaultCacheBehavior: gated("request"),
              CacheBehaviors: [
                { PathPattern: "/_edge/*", ...gated("edge", { own: true, lambda: app }) },
                ...(app
                  ? [
                      { PathPattern: "/oauth/token", ...gated("agents", { own: true, lambda: true, body: true }) },
                      { PathPattern: "/.well-known/oauth-*", ...gated("agents", { own: true }) },
                    ]
                  : []),
              ],
            }
          : {
              DefaultCacheBehavior: {
                TargetOriginId: "machine",
                ViewerProtocolPolicy: "redirect-to-https",
                AllowedMethods: ALL_METHODS,
                CachedMethods: ["GET", "HEAD"],
                Compress: true,
                CachePolicyId: ref("CachePolicy"),
                OriginRequestPolicyId: ALL_VIEWER,
                FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: functionArn("Forwarded") }],
              },
            }),
      },
      Tags: [{ Key: "erga", Value: s.stack }],
    },
  };
}

/** The main stack's template. */
export function stackTemplate(s: AwsShape): Json {
  const net = network(s);
  const edge = cloudFront(s, s.edge.prefixList, s.edge.kind == "gate");
  const role = att("Role", "Arn");
  const resources: Json = {
    ...net.resources,
    Key: {
      Type: "AWS::KMS::Key",
      Properties: {
        Description: `Erga ${s.stack}: the bucket and the secrets`,
        EnableKeyRotation: true,
        KeyPolicy: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "The account's admins manage it",
              Effect: "Allow",
              Principal: { AWS: sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:root") },
              Action: [
                "kms:Create*",
                "kms:Describe*",
                "kms:Enable*",
                "kms:List*",
                "kms:Put*",
                "kms:Update*",
                "kms:Revoke*",
                "kms:Disable*",
                "kms:Get*",
                "kms:Delete*",
                "kms:TagResource",
                "kms:UntagResource",
                "kms:ScheduleKeyDeletion",
                "kms:CancelKeyDeletion",
              ],
              Resource: "*",
            },
            {
              Sid: "The machine uses it",
              Effect: "Allow",
              Principal: { AWS: role },
              Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"],
              Resource: "*",
            },
            {
              Sid: "The admins use it only in Parameter Store (the secrets) and S3 (the uploads)",
              Effect: "Allow",
              Principal: { AWS: sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:root") },
              Action: ["kms:Encrypt", "kms:GenerateDataKey*"],
              Resource: "*",
              Condition: {
                StringEquals: { "kms:ViaService": [sub("ssm.${AWS::Region}.amazonaws.com"), sub("s3.${AWS::Region}.amazonaws.com")] },
              },
            },
          ],
        },
        Tags: [{ Key: "erga", Value: s.stack }],
      },
    },
    KeyAlias: { Type: "AWS::KMS::Alias", Properties: { AliasName: `alias/erga-${s.stack}`, TargetKeyId: ref("Key") } },
    Bucket: {
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: att("Key", "Arn") }, BucketKeyEnabled: true },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        Tags: [{ Key: "erga", Value: s.stack }],
      },
    },
    ...(s.edge.kind == "gate"
      ? {
          // What the behaviors with the Lambda pass it: only what the request function wrote for it (the callback's
          // code, gate/mounts/cloudfront.ts EXCHANGE); the token endpoint's form is the request's body.
          GateOriginPolicy: {
            Type: "AWS::CloudFront::OriginRequestPolicy",
            Properties: {
              OriginRequestPolicyConfig: {
                Name: `${s.stack}-gate`,
                HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["x-erga-exchange"] },
                CookiesConfig: { CookieBehavior: "none" },
                QueryStringsConfig: { QueryStringBehavior: "none" },
              },
            },
          },
          // The origin of the behaviors with the Lambda (gated): empty, private, and reached by no request.
          GateOrigin: {
            Type: "AWS::S3::Bucket",
            Properties: {
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                IgnorePublicAcls: true,
                BlockPublicPolicy: true,
                RestrictPublicBuckets: true,
              },
              OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
              Tags: [{ Key: "erga", Value: s.stack }],
            },
          },
        }
      : {}),
    // Only the machine reads what is in it: the documents, the database, the secrets in a release's settings.
    BucketPolicy: {
      Type: "AWS::S3::BucketPolicy",
      Properties: {
        Bucket: ref("Bucket"),
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "Only the machine reads",
              Effect: "Deny",
              Principal: "*",
              Action: ["s3:GetObject", "s3:GetObjectVersion"],
              Resource: sub("${Bucket.Arn}/*"),
              Condition: { ArnNotEquals: { "aws:PrincipalArn": role } },
            },
            {
              Sid: "TLS only",
              Effect: "Deny",
              Principal: "*",
              Action: "s3:*",
              Resource: [att("Bucket", "Arn"), sub("${Bucket.Arn}/*")],
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            },
          ],
        },
      },
    },
    // The machine's role: its bucket, its secrets, and Systems Manager (each deploy's commands; a shell with no SSH).
    Role: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
        },
        ManagedPolicyArns: [sub("arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore")],
        Policies: [
          {
            PolicyName: "erga",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                // The bucket by its name's start, as CloudFormation names it (<stack>-bucket-<random>): a reference to
                // the bucket itself would make a loop (the bucket's key names this role).
                {
                  Effect: "Allow",
                  Action: "s3:*",
                  Resource: [
                    sub("arn:${AWS::Partition}:s3:::${AWS::StackName}-bucket-*"),
                    sub("arn:${AWS::Partition}:s3:::${AWS::StackName}-bucket-*/*"),
                  ],
                },
                {
                  Effect: "Allow",
                  Action: "ssm:GetParametersByPath",
                  Resource: sub(`arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${paramFolder(s.stack)}`),
                },
                ...edge.role,
              ],
            },
          },
        ],
        Tags: [{ Key: "erga", Value: s.stack }],
      },
    },
    Profile: { Type: "AWS::IAM::InstanceProfile", Properties: { Roles: [ref("Role")] } },
    // Only the edge reaches celld's port; nothing else comes in.
    Firewall: {
      Type: "AWS::EC2::SecurityGroup",
      Properties: {
        GroupDescription: `Erga ${s.stack}: celld, from CloudFront only`,
        VpcId: net.vpc,
        SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: CELLD_PORT, ToPort: CELLD_PORT, ...edge.ingress }],
        Tags: tags(s.stack, "machine"),
      },
    },
    Machine: {
      Type: "AWS::EC2::Instance",
      ...(s.egress.kind == "vpc" ? {} : { DependsOn: "PrivateDefault" }),
      Properties: {
        ImageId: ref("MachineImage"),
        InstanceType: ref("MachineType"),
        IamInstanceProfile: ref("Profile"),
        SubnetId: net.subnet,
        SecurityGroupIds: [ref("Firewall")],
        MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
        BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: ref("DiskGb"), VolumeType: "gp3", Encrypted: true } }],
        Tags: tags(s.stack, "machine"),
      },
    },
    ...edge.resources,
  };
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Erga ${s.stack}: one celld machine, its bucket, and CloudFront in front${s.edge.kind == "gate" ? ", with the gate and the organization's sign-in" : ""} (written by bun erga setup)`,
    Parameters: {
      MachineType: {
        Type: "String",
        Default: "t4g.small",
        Description: "The machine that runs Erga (ARM: a t4g or another Graviton type)",
      },
      DiskGb: { Type: "Number", Default: 16, Description: "The machine's disk: celld's local copies (the bucket holds the state)" },
      MachineImage: {
        Type: "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>",
        Default: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
        Description: "Amazon Linux 2023 for ARM, AWS's newest",
      },
      ...(s.egress.kind == "nat-instance"
        ? { NatType: { Type: "String", Default: "t4g.micro", Description: "The NAT machine: the Erga machine's way out" } }
        : {}),
      ...edge.parameters,
    },
    Resources: resources,
    Outputs: { Bucket: { Value: ref("Bucket") }, Machine: { Value: ref("Machine") }, Key: { Value: att("Key", "Arn") }, ...edge.outputs },
  };
}

/**
 * The edge's part of the stack: who may reach the machine's port, what more the machine's role may do, and its own
 * resources, parameters and outputs.
 */
interface Edge {
  ingress: Json;
  role: Json[];
  resources: Json;
  parameters: Json;
  outputs: Json;
}

/**
 * CloudFront in front: two distributions with the machine as their VPC origin, and with domains their names in
 * Route 53. `gate`: with the gate in front (its functions are the us-east-1 stack's, and their ARNs this stack's
 * parameters), else with the function that says the viewer's host.
 */
function cloudFront(s: AwsShape, prefixList: string, gate: boolean): Edge {
  if (gate && !s.domains) throw new Error("The gate in front needs domains: its functions hold the app's host.");
  const machineArn = sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Machine}");
  const resources: Json = {
    Origin: {
      Type: "AWS::CloudFront::VpcOrigin",
      Properties: {
        VpcOriginEndpointConfig: { Name: `${s.stack}-machine`, Arn: machineArn, HTTPPort: CELLD_PORT, OriginProtocolPolicy: "http-only" },
        Tags: [{ Key: "erga", Value: s.stack }],
      },
    },
    // The origin's Cache-Control decides (nothing without it). The key: the host (each document's pages origin has its
    // own files at the same paths), the path and the query.
    CachePolicy: {
      Type: "AWS::CloudFront::CachePolicy",
      Properties: {
        CachePolicyConfig: {
          Name: `${s.stack}-origin-decides`,
          MinTTL: 0,
          DefaultTTL: 0,
          MaxTTL: 31536000,
          ParametersInCacheKeyAndForwardedToOrigin: {
            EnableAcceptEncodingGzip: true,
            EnableAcceptEncodingBrotli: true,
            HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["Host"] },
            CookiesConfig: { CookieBehavior: "none" },
            QueryStringsConfig: { QueryStringBehavior: "all" },
          },
        },
      },
    },
    // The host the viewer asked for, as celld reads it (CELLD_TRUST_FORWARDED_HEADERS): set on each request that goes
    // on, over any value the viewer sent, since celld takes the last one. With the gate in front, its request
    // function writes it (gate/mounts/cloudfront-request.ts: a behavior has one viewer-request function).
    ...(gate
      ? {
          // The key that the distributions send the machine with each request, and that the machine's deploy gives
          // Erga (GATE_KEY): AWS makes it, and it is in no file and no command. CloudFormation names the secret (a
          // new name for each stack: a deleted secret's name stays taken for a time).
          GateKey: {
            Type: "AWS::SecretsManager::Secret",
            Properties: {
              Description: `Erga ${s.stack}: the key that the gate in front proves itself to Erga with (GATE_KEY)`,
              GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
              Tags: [{ Key: "erga", Value: s.stack }],
            },
          },
        }
      : {
          Forwarded: {
            Type: "AWS::CloudFront::Function",
            Properties: {
              Name: `${s.stack}-forwarded`,
              AutoPublish: true,
              FunctionConfig: { Comment: "Erga: the viewer's host, for celld", Runtime: "cloudfront-js-2.0" },
              FunctionCode: FORWARDED,
            },
          },
        }),
    AppDistribution: distribution(s, "App", gate),
    PagesDistribution: distribution(s, "Pages", gate),
  };
  if (s.domains) {
    for (const [name, zone, distro, record] of [
      ["App", s.domains.appZone, "AppDistribution", s.domains.app],
      ["Pages", s.domains.pagesZone, "PagesDistribution", `*.${s.domains.pages}`],
    ] as const)
      for (const type of ["A", "AAAA"])
        resources[`${name}Record${type}`] = {
          Type: "AWS::Route53::RecordSet",
          Properties: {
            HostedZoneId: zone,
            Name: record,
            Type: type,
            AliasTarget: { DNSName: att(distro, "DomainName"), HostedZoneId: CLOUDFRONT_ZONE },
          },
        };
  }
  return {
    ingress: { SourcePrefixListId: prefixList, Description: "CloudFront" },
    // The machine reads the gate's key at each deploy (deploy/aws/machine.ts, deployScript), for Erga's GATE_KEY.
    role: gate ? [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: ref("GateKey") }] : [],
    resources,
    parameters: {
      ...(s.domains
        ? {
            AppCertificate: { Type: "String", Description: `The ACM certificate of ${s.domains.app}, in us-east-1` },
            PagesCertificate: { Type: "String", Description: `The ACM certificate of *.${s.domains.pages}, in us-east-1` },
          }
        : {}),
      ...(gate
        ? {
            EdgeVersion: { Type: "String", Description: "The gate's Lambda@Edge function, in us-east-1: its version's ARN" },
            ...Object.fromEntries(
              GATE_PARTS.map((part) => [
                GATE_FUNCTIONS[part],
                { Type: "String", Description: `The gate's ${part} function (CloudFront Functions), of the us-east-1 stack: its ARN` },
              ])
            ),
          }
        : {}),
    },
    outputs: {
      AppHost: { Value: s.domains ? s.domains.app : att("AppDistribution", "DomainName") },
      PagesHost: { Value: s.domains ? s.domains.pages : att("PagesDistribution", "DomainName") },
      // The secret of the gate's key: the machine reads it at each deploy.
      ...(gate ? { GateKey: { Value: ref("GateKey") } } : {}),
    },
  };
}

/**
 * The gate's code, in the us-east-1 stack:
 *   - its four CloudFront Functions, as built, each with the KeyValueStore. The edge key is not here: CloudFormation
 *     can't write a store's key, so the deploy puts it there after this stack, before a distribution exists
 *     (deploy/aws/gate.ts, putEdgeKey);
 *   - its Lambda@Edge function (gate/mounts/lambda.ts), which CloudFront takes only from us-east-1: its role, the
 *     function, and one version of it (a distribution names a version). The version's name in the template has the
 *     code's hash: CloudFormation makes a new version only for a new resource. The role reads the one secret
 *     (idpSecretParam).
 */
function gateCodeResources(stack: string, code: GateCode): { resources: Json; version: string } {
  const version = `EdgeVersion${new Bun.CryptoHasher("sha256").update(code.lambda).digest("hex").slice(0, 12)}`;
  return {
    version,
    resources: {
      Store: {
        Type: "AWS::CloudFront::KeyValueStore",
        Properties: { Name: stack, Comment: "Erga: the gate's edge key, and its deny list" },
      },
      ...Object.fromEntries(
        GATE_PARTS.map((part) => [
          GATE_FUNCTIONS[part],
          {
            Type: "AWS::CloudFront::Function",
            Properties: {
              Name: `${stack}-${part}`,
              AutoPublish: true,
              FunctionCode: code.functions[part],
              FunctionConfig: {
                Comment: `Erga: the gate's ${part} function`,
                Runtime: "cloudfront-js-2.0",
                KeyValueStoreAssociations: [{ KeyValueStoreARN: att("Store", "Arn") }],
              },
            },
          },
        ])
      ),
      EdgeRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] }, Action: "sts:AssumeRole" },
            ],
          },
          ManagedPolicyArns: [sub("arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole")],
          Policies: [
            {
              PolicyName: "secret",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: "ssm:GetParameter",
                    Resource: sub(`arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${idpSecretParam(stack)}`),
                  },
                ],
              },
            },
          ],
          Tags: [{ Key: "erga", Value: stack }],
        },
      },
      Edge: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Description: `Erga ${stack}: the gate's Lambda@Edge function (the sign-in's code exchange, the token endpoint's form)`,
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          Timeout: 10,
          MemorySize: 128,
          Role: att("EdgeRole", "Arn"),
          Code: { ZipFile: code.lambda },
          Tags: [{ Key: "erga", Value: stack }],
        },
      },
      // (Kept when a new build replaces it: the distributions still name it until the main stack has the new one,
      // and Lambda refuses to delete a version that CloudFront uses. It goes with the function.)
      [version]: { Type: "AWS::Lambda::Version", DeletionPolicy: "Retain", Properties: { FunctionName: ref("Edge") } },
    },
  };
}

/**
 * The us-east-1 stack (CloudFront's region): the certificates of the app's name and the pages' wildcard, checked in
 * Route 53; and, with the gate in front, the gate's code (`gate`). The main stack takes its outputs as parameters;
 * `Store` is where the deploy writes the edge key.
 */
export function certificatesTemplate(stack: string, d: NonNullable<AwsShape["domains"]>, gate?: GateCode): Json {
  const edge = gate ? gateCodeResources(stack, gate) : null;
  const cert = (name: string, zone: string) => ({
    Type: "AWS::CertificateManager::Certificate",
    Properties: {
      DomainName: name,
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: name, HostedZoneId: zone }],
      Tags: [{ Key: "erga", Value: stack }],
    },
  });
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Erga ${stack}: the certificates CloudFront serves${edge ? ", and the gate's code" : ""} (written by bun erga setup)`,
    Resources: { AppCertificate: cert(d.app, d.appZone), PagesCertificate: cert(`*.${d.pages}`, d.pagesZone), ...edge?.resources },
    Outputs: {
      AppCertificate: { Value: ref("AppCertificate") },
      PagesCertificate: { Value: ref("PagesCertificate") },
      ...(edge
        ? {
            EdgeVersion: { Value: ref(edge.version) },
            Store: { Value: att("Store", "Arn") },
            ...Object.fromEntries(GATE_PARTS.map((part) => [GATE_FUNCTIONS[part], { Value: functionArn(GATE_FUNCTIONS[part]) }])),
          }
        : {}),
    },
  };
}
