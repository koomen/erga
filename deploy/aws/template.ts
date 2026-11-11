// The AWS infrastructure of one Erga instance, as CloudFormation templates: what `bun erga setup` writes into
// .erga/aws/ for the person to read and change, before it makes the stacks (deploy/aws/stack.ts). Pure: no network.
//
// The main stack, in the instance's region:
//   - the network: a new VPC with a private subnet for the machine and a public one for its way out (a NAT machine or a
//     NAT gateway), or a private subnet of a VPC the person names, which has its own way out;
//   - the machine (celld and Chrome, deploy/aws/machine.ts): no public address, and only CloudFront may reach its port;
//   - the bucket (celld's state, the releases, the programs), the KMS key (the bucket and the secrets), the role;
//   - the front, one of two:
//       CloudFront: two distributions, the app's and the pages', each with the machine as its VPC origin; with domains,
//       a second stack in us-east-1 holds the ACM certificates, where CloudFront needs them (certificatesTemplate);
//       a load balancer (an ALB, public): it signs each person in with the company's OIDC sign-in before Erga, and
//       lets pass without it only what Erga's own tokens guard (balancer, below). Its certificate is in this stack;
//   - with domains: the Route 53 records of the app's name and the pages' wildcard name.
//
// The structure follows the answers (the way out, the domains); the sizes and the machine image are the template's
// parameters, with defaults, which the person may change in the file.

/** The answers that shape an instance's stacks. */
export interface AwsShape {
  /** The instance's own name: the stack's, and every name in it. */
  stack: string;
  /** How the machine reaches the internet (the model APIs, sign-in): a NAT machine, a NAT gateway, or the person's VPC. */
  egress: { kind: "nat-instance" } | { kind: "nat-gateway" } | { kind: "vpc"; vpcId: string; subnetId: string };
  /** The domains, each with its Route 53 hosted zone; none: CloudFront's own names (the pages on one shared name). */
  domains: { app: string; appZone: string; pages: string; pagesZone: string } | null;
  /**
   * What answers the internet. CloudFront, with the region's origin-facing prefix list
   * (com.amazonaws.global.cloudfront.origin-facing); or a load balancer with a sign-in in front of Erga: it needs
   * domains, and the stack's own network.
   */
  front: { kind: "cloudfront"; prefixList: string } | { kind: "balancer"; oidc: Oidc };
}

/** The company's OIDC sign-in, as its issuer publishes it (/.well-known/openid-configuration), and Erga's client there. */
export interface Oidc {
  issuer: string;
  authorize: string;
  token: string;
  userInfo: string;
  clientId: string;
}

/** The port celld answers on, on the machine. Only the front reaches it. */
export const CELLD_PORT = 8080;
/** Where the instance's secrets are in Parameter Store: /erga/<stack>/<NAME>. */
export const paramPath = (stack: string) => `/erga/${stack}/`;
/**
 * The Secrets Manager secret that holds the OIDC client's secret, as plain text: the person who has the secret stores
 * it there, and the stack reads it by this name (a dynamic reference). It is never in a file, a command or a chat.
 */
export const oidcSecretName = (stack: string) => `erga/${stack}/oidc-client-secret`;

/**
 * What passes the load balancer without the sign-in, on the app's address: only what Erga's own tokens guard, or what
 * holds nothing private. An agent or the CLI can't sign in with a browser: MCP and its OAuth (the person approves the
 * agent on /tokens/approve, which stays behind the sign-in), the operations, the CLI's token request, the deploy's
 * checks. And the editor's code, which a document's page loads from its own address, with no cookie.
 * Three paths a rule: a rule takes five values, and the host is one.
 */
export const TOKEN_PATHS: readonly (readonly string[])[] = [
  ["/mcp", "/llms.txt", "/api/publish"],
  ["/.well-known/oauth-*", "/oauth/register", "/oauth/token"],
  ["/api/auth/request", "/api/auth/poll", "/api/ops"],
  ["/api/tools", "/api/tools/*", "/api/health"],
  ["/api/deploys/version", "/_erga/*", "/erga/*"],
];
/** What a document's own address answers (server/documents/pages-origin.ts): its files by their token, and the offline worker. */
export const PAGES_PATHS = ["/t/*", "/erga-sw.js", "/erga-clear"] as const;

/** CloudFront's managed origin request policy AllViewer: the viewer's Host, headers, cookies and query to the origin. */
const ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3";
/** Route 53's hosted zone of every CloudFront distribution, for an alias record. */
const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2";

/** The viewer-request function: X-Forwarded-Host is the Host the viewer asked for, X-Forwarded-Proto is https. */
const FORWARDED = `function handler(event) {
  var r = event.request;
  r.headers["x-forwarded-host"] = { value: r.headers.host.value };
  r.headers["x-forwarded-proto"] = { value: "https" };
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
  // A load balancer needs two zones. Its rule for the server's own browser names the NAT's address: a fixed one.
  if (s.front.kind == "balancer") {
    r.PublicSubnetB = {
      Type: "AWS::EC2::Subnet",
      Properties: {
        VpcId: ref("Vpc"),
        CidrBlock: "10.80.2.0/24",
        AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] },
        Tags: tags(s.stack, "public-b"),
      },
    };
    r.PublicRoutesOfB = {
      Type: "AWS::EC2::SubnetRouteTableAssociation",
      Properties: { SubnetId: ref("PublicSubnetB"), RouteTableId: ref("PublicRoutes") },
    };
    if (s.egress.kind == "nat-instance")
      r.NatAddress = {
        Type: "AWS::EC2::EIP",
        DependsOn: "GatewayAttachment",
        Properties: { Domain: "vpc", InstanceId: ref("Nat"), Tags: tags(s.stack, "nat") },
      };
  }
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
        UserData: {
          "Fn::Base64": [
            "#!/bin/bash",
            "set -euo pipefail",
            "dnf install -y -q iptables-services",
            "echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-nat.conf && sysctl -p /etc/sysctl.d/90-nat.conf",
            "dev=$(ip route show default | awk '{print $5; exit}')",
            'iptables -t nat -A POSTROUTING -o "$dev" -s 10.80.0.0/16 -j MASQUERADE',
            "iptables -F FORWARD && service iptables save && systemctl enable --now iptables",
            "",
          ].join("\n"),
        },
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

/** A distribution for the machine: the app's (its name, or CloudFront's own), or the pages' (a wildcard, or one shared name). */
function distribution(s: AwsShape, which: "App" | "Pages"): Json {
  const alias = s.domains ? (which == "App" ? s.domains.app : `*.${s.domains.pages}`) : null;
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
          },
        ],
        DefaultCacheBehavior: {
          TargetOriginId: "machine",
          ViewerProtocolPolicy: "redirect-to-https",
          AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          CachedMethods: ["GET", "HEAD"],
          Compress: true,
          CachePolicyId: ref("CachePolicy"),
          OriginRequestPolicyId: ALL_VIEWER,
          FunctionAssociations: [{ EventType: "viewer-request", FunctionARN: att("Forwarded", "FunctionMetadata.FunctionARN") }],
        },
      },
      Tags: [{ Key: "erga", Value: s.stack }],
    },
  };
}

/** The main stack's template. */
export function stackTemplate(s: AwsShape): Json {
  const net = network(s);
  const front = s.front.kind == "balancer" ? balancer(s, s.front.oidc, net.vpc) : cloudFront(s, s.front.prefixList);
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
                  Resource: sub(
                    `arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${paramPath(s.stack).slice(0, -1)}`
                  ),
                },
              ],
            },
          },
        ],
        Tags: [{ Key: "erga", Value: s.stack }],
      },
    },
    Profile: { Type: "AWS::IAM::InstanceProfile", Properties: { Roles: [ref("Role")] } },
    // Only the front reaches celld's port; nothing else comes in.
    Firewall: {
      Type: "AWS::EC2::SecurityGroup",
      Properties: {
        GroupDescription: `Erga ${s.stack}: celld, from ${s.front.kind == "balancer" ? "the load balancer" : "CloudFront"} only`,
        VpcId: net.vpc,
        SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: CELLD_PORT, ToPort: CELLD_PORT, ...front.ingress }],
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
    ...front.resources,
  };
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Erga ${s.stack}: one celld machine, its bucket, and ${s.front.kind == "balancer" ? "a load balancer with the sign-in" : "CloudFront"} in front (written by bun erga setup)`,
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
        ? { NatType: { Type: "String", Default: "t4g.nano", Description: "The NAT machine: the Erga machine's way out" } }
        : {}),
      ...front.parameters,
    },
    Resources: resources,
    Outputs: { Bucket: { Value: ref("Bucket") }, Machine: { Value: ref("Machine") }, Key: { Value: att("Key", "Arn") }, ...front.outputs },
  };
}

/** A front's part of the stack: who may reach the machine's port, and its own resources, parameters and outputs. */
interface Front {
  ingress: Json;
  resources: Json;
  parameters: Json;
  outputs: Json;
}

/** CloudFront in front: two distributions with the machine as their VPC origin, and with domains their names in Route 53. */
function cloudFront(s: AwsShape, prefixList: string): Front {
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
    // The address the viewer asked for, as celld reads it (CELLD_TRUST_FORWARDED_HEADERS): set here on each request,
    // over any value the viewer sent, since celld takes the last one.
    Forwarded: {
      Type: "AWS::CloudFront::Function",
      Properties: {
        Name: `${s.stack}-forwarded`,
        AutoPublish: true,
        FunctionConfig: { Comment: "Erga: the viewer's host and https, for celld", Runtime: "cloudfront-js-2.0" },
        FunctionCode: FORWARDED,
      },
    },
    AppDistribution: distribution(s, "App"),
    PagesDistribution: distribution(s, "Pages"),
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
    resources,
    parameters: s.domains
      ? {
          AppCertificate: { Type: "String", Description: `The ACM certificate of ${s.domains.app}, in us-east-1` },
          PagesCertificate: { Type: "String", Description: `The ACM certificate of *.${s.domains.pages}, in us-east-1` },
        }
      : {},
    outputs: {
      AppHost: { Value: s.domains ? s.domains.app : att("AppDistribution", "DomainName") },
      PagesHost: { Value: s.domains ? s.domains.pages : att("PagesDistribution", "DomainName") },
    },
  };
}

/**
 * A load balancer in front (an ALB, public), with the company's sign-in. Its listener's rules, first match wins:
 *
 *    1  a request that brings X-Forwarded-Host: refused. celld trusts that header (CELLD_TRUST_FORWARDED_HEADERS) for
 *       https (the balancer's X-Forwarded-Proto), and the balancer passes a caller's own; without it celld reads Host.
 *    2  a document's own address (*.<pages>), its files and its worker only: no sign-in. The page's token is the pass
 *       (a frame can't follow a sign-in, and that address has no cookie).
 *   10+ the app's address, what Erga's tokens guard (TOKEN_PATHS): no sign-in.
 *   20  the app's address, a request with a key (?key=): what a document's page asks of its room, from its own address.
 *   30  the app's address, from the NAT's address: the server's own browser (view_page), which holds Erga's view cookie.
 *  100  the app's address, anything else: the sign-in (OIDC) first. The balancer then adds x-amzn-oidc-data, which says
 *       who signed in, signed by AWS (server/identity/front.ts reads it).
 * Any other host: 404. The machine lets in only the balancer.
 */
function balancer(s: AwsShape, oidc: Oidc, vpc: unknown): Front {
  if (!s.domains || s.egress.kind == "vpc") throw new Error("A load balancer in front needs domains, and the stack's own network.");
  const d = s.domains;
  const forward = { Type: "forward", TargetGroupArn: ref("Targets") };
  const host = (name: string) => ({ Field: "host-header", HostHeaderConfig: { Values: [name] } });
  const paths = (values: readonly string[]) => ({ Field: "path-pattern", PathPatternConfig: { Values: [...values] } });
  const rule = (priority: number, conditions: Json[], actions: Json[]): Json => ({
    Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
    Properties: { ListenerArn: ref("Listener"), Priority: priority, Conditions: conditions, Actions: actions },
  });
  const alias = (zone: string, name: string) => ({
    Type: "AWS::Route53::RecordSet",
    Properties: {
      HostedZoneId: zone,
      Name: name,
      Type: "A",
      AliasTarget: { DNSName: att("Balancer", "DNSName"), HostedZoneId: att("Balancer", "CanonicalHostedZoneID") },
    },
  });
  const resources: Json = {
    Certificate: {
      Type: "AWS::CertificateManager::Certificate",
      Properties: {
        DomainName: d.app,
        SubjectAlternativeNames: [`*.${d.pages}`],
        ValidationMethod: "DNS",
        DomainValidationOptions: [
          { DomainName: d.app, HostedZoneId: d.appZone },
          { DomainName: `*.${d.pages}`, HostedZoneId: d.pagesZone },
        ],
        Tags: [{ Key: "erga", Value: s.stack }],
      },
    },
    BalancerFirewall: {
      Type: "AWS::EC2::SecurityGroup",
      Properties: {
        GroupDescription: `Erga ${s.stack}: the load balancer, from the internet`,
        VpcId: vpc,
        SecurityGroupIngress: [443, 80].map((port) => ({ IpProtocol: "tcp", FromPort: port, ToPort: port, CidrIp: "0.0.0.0/0" })),
        Tags: tags(s.stack, "balancer"),
      },
    },
    Balancer: {
      Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      DependsOn: "PublicDefault",
      Properties: {
        Type: "application",
        Scheme: "internet-facing",
        Subnets: [ref("PublicSubnet"), ref("PublicSubnetB")],
        SecurityGroups: [ref("BalancerFirewall")],
        LoadBalancerAttributes: [
          // A quiet socket of the editor stays open.
          { Key: "idle_timeout.timeout_seconds", Value: "3600" },
          { Key: "routing.http.preserve_host_header.enabled", Value: "true" },
          { Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" },
        ],
        Tags: tags(s.stack, "balancer"),
      },
    },
    // The health check goes to the machine itself: no rule, so no sign-in.
    Targets: {
      Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
      Properties: {
        VpcId: vpc,
        Protocol: "HTTP",
        Port: CELLD_PORT,
        TargetType: "instance",
        Targets: [{ Id: ref("Machine") }],
        HealthCheckPath: "/api/deploys/version",
        HealthCheckIntervalSeconds: 15,
        HealthyThresholdCount: 2,
        Matcher: { HttpCode: "200" },
        TargetGroupAttributes: [{ Key: "deregistration_delay.timeout_seconds", Value: "30" }],
        Tags: tags(s.stack, "machine"),
      },
    },
    Listener: {
      Type: "AWS::ElasticLoadBalancingV2::Listener",
      Properties: {
        LoadBalancerArn: ref("Balancer"),
        Port: 443,
        Protocol: "HTTPS",
        SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
        Certificates: [{ CertificateArn: ref("Certificate") }],
        DefaultActions: [
          { Type: "fixed-response", FixedResponseConfig: { StatusCode: "404", ContentType: "text/plain", MessageBody: "Not found" } },
        ],
      },
    },
    PlainListener: {
      Type: "AWS::ElasticLoadBalancingV2::Listener",
      Properties: {
        LoadBalancerArn: ref("Balancer"),
        Port: 80,
        Protocol: "HTTP",
        DefaultActions: [{ Type: "redirect", RedirectConfig: { Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301" } }],
      },
    },
    RefuseForwardedHost: rule(
      1,
      [{ Field: "http-header", HttpHeaderConfig: { HttpHeaderName: "X-Forwarded-Host", Values: ["?*"] } }],
      [{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "400", ContentType: "text/plain", MessageBody: "Bad request" } }]
    ),
    PagesRule: rule(2, [host(`*.${d.pages}`), paths(PAGES_PATHS)], [forward]),
    ...Object.fromEntries(TOKEN_PATHS.map((group, i) => [`TokenRule${i + 1}`, rule(10 + i, [host(d.app), paths(group)], [forward])])),
    KeyRule: rule(
      20,
      [host(d.app), paths(["/d/*/api/*"]), { Field: "query-string", QueryStringConfig: { Values: [{ Key: "key", Value: "*" }] } }],
      [forward]
    ),
    OwnBrowserRule: rule(
      30,
      [host(d.app), { Field: "source-ip", SourceIpConfig: { Values: [sub("${NatAddress.PublicIp}/32")] } }],
      [forward]
    ),
    SignInRule: rule(
      100,
      [host(d.app)],
      [
        {
          Type: "authenticate-oidc",
          Order: 1,
          AuthenticateOidcConfig: {
            Issuer: oidc.issuer,
            AuthorizationEndpoint: oidc.authorize,
            TokenEndpoint: oidc.token,
            UserInfoEndpoint: oidc.userInfo,
            ClientId: oidc.clientId,
            // Read from Secrets Manager when the stack is made: the secret is in no file.
            ClientSecret: sub("{{resolve:secretsmanager:${OidcSecret}:SecretString}}"),
            Scope: "openid email",
            OnUnauthenticatedRequest: "authenticate",
          },
        },
        { ...forward, Order: 2 },
      ]
    ),
    AppRecord: alias(d.appZone, d.app),
    PagesRecord: alias(d.pagesZone, `*.${d.pages}`),
  };
  return {
    ingress: { SourceSecurityGroupId: ref("BalancerFirewall"), Description: "The load balancer" },
    resources,
    parameters: {
      OidcSecret: {
        Type: "String",
        Default: oidcSecretName(s.stack),
        Description: "The Secrets Manager secret (its name) that holds the OIDC client's secret, as plain text",
      },
    },
    outputs: {
      AppHost: { Value: d.app },
      PagesHost: { Value: d.pages },
      // Who signs x-amzn-oidc-data: Erga takes the header only from this balancer.
      Balancer: { Value: ref("Balancer") },
    },
  };
}

/** The certificates' stack, in us-east-1 (CloudFront's): the app's name and the pages' wildcard, checked in Route 53. */
export function certificatesTemplate(stack: string, d: NonNullable<AwsShape["domains"]>): Json {
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
    Description: `Erga ${stack}: the certificates CloudFront serves (written by bun erga setup)`,
    Resources: { AppCertificate: cert(d.app, d.appZone), PagesCertificate: cert(`*.${d.pages}`, d.pagesZone) },
    Outputs: { AppCertificate: { Value: ref("AppCertificate") }, PagesCertificate: { Value: ref("PagesCertificate") } },
  };
}
