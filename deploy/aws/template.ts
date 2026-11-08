// The AWS infrastructure of one Erga instance, as CloudFormation templates: what `bun erga setup` writes into
// .erga/aws/ for the person to read and change, before it makes the stacks (deploy/aws/stack.ts). Pure: no network.
//
// The main stack, in the instance's region:
//   - the network: a new VPC with a private subnet for the machine and a public one for its way out (a NAT machine or a
//     NAT gateway), or a private subnet of a VPC the person names, which has its own way out;
//   - the machine (celld and Chrome, deploy/aws/machine.ts): no public address, and only CloudFront may reach its port;
//   - the bucket (celld's state, the releases, the programs), the KMS key (the bucket and the secrets), the role;
//   - two CloudFront distributions, the app's and the pages', each with the machine as its VPC origin;
//   - with domains: the Route 53 records of the app's name and the pages' wildcard name.
// With domains, a second stack in us-east-1 holds the ACM certificates, where CloudFront needs them (certificatesTemplate).
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
  /** The CloudFront origin-facing prefix list of the region (com.amazonaws.global.cloudfront.origin-facing). */
  cloudFrontPrefixList: string;
}

/** The port celld answers on, on the machine. Only CloudFront reaches it. */
export const CELLD_PORT = 8080;
/** Where the instance's secrets are in Parameter Store: /erga/<stack>/<NAME>. */
export const paramPath = (stack: string) => `/erga/${stack}/`;

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
  const machineArn = sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Machine}");
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
    // Only CloudFront reaches celld's port; nothing else comes in.
    Firewall: {
      Type: "AWS::EC2::SecurityGroup",
      Properties: {
        GroupDescription: `Erga ${s.stack}: celld, from CloudFront only`,
        VpcId: net.vpc,
        SecurityGroupIngress: [
          {
            IpProtocol: "tcp",
            FromPort: CELLD_PORT,
            ToPort: CELLD_PORT,
            SourcePrefixListId: s.cloudFrontPrefixList,
            Description: "CloudFront",
          },
        ],
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
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Erga ${s.stack}: one celld machine, its bucket, and CloudFront in front (written by bun erga setup)`,
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
      ...(s.domains
        ? {
            AppCertificate: { Type: "String", Description: `The ACM certificate of ${s.domains.app}, in us-east-1` },
            PagesCertificate: { Type: "String", Description: `The ACM certificate of *.${s.domains.pages}, in us-east-1` },
          }
        : {}),
    },
    Resources: resources,
    Outputs: {
      Bucket: { Value: ref("Bucket") },
      Machine: { Value: ref("Machine") },
      Key: { Value: att("Key", "Arn") },
      AppHost: { Value: s.domains ? s.domains.app : att("AppDistribution", "DomainName") },
      PagesHost: { Value: s.domains ? s.domains.pages : att("PagesDistribution", "DomainName") },
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
