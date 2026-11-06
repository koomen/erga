// Erga on celld on AWS: one EC2 machine runs celld (the Worker and its Durable Objects) behind Caddy (HTTPS), and one
// S3 bucket holds celld's state and the releases. No CloudFormation: these AWS CLI calls make what's missing, and
// `down` removes it all. Everything has the tag erga=aws-provider. deploy/celld/README.md has the why and the costs.
//
//   bun deploy/celld/aws.ts up      makes what's missing, then builds and deploys this checkout
//   bun deploy/celld/aws.ts down    removes it all, then lists what still has the tag
//
// The machine's names are <ip>.sslip.io names (sslip.io answers a name with the IP in it): no DNS change. People use
// the two CloudFront names in front of them (cdn.ts).
// Settings the Worker keeps as secrets come from Parameter Store, /erga-celld/<NAME>: SESSION_SECRET and FACTORY_KEY are
// made the first time; set others (GITHUB_CLIENT_SECRET) with `aws ssm put-parameter --type SecureString --key-id
// alias/erga-celld`. Only the machine reads them, at each deploy. celld has no secret store: it keeps them as plain vars
// in its deployment, so the bucket is encrypted with a KMS key that only the machine's role may use, and its policy
// denies a read to anyone else.

import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeRelease } from "../release.ts";
import { celldProject } from "./project.ts";
import { caddyfile, cdnDown, cdnLeft, cdnUp } from "./cdn.ts";

const PROFILE = process.env.AWS_PROFILE ?? "labs";
const REGION = process.env.AWS_REGION ?? "us-west-2";
const NAME = "erga-celld";
const TAG = { key: "erga", value: "aws-provider" } as const;
const PARAMS = `/${NAME}/`;
const KEY = `alias/${NAME}`;
/** Who becomes the first admin, while there's none. */
const ADMIN = process.env.ERGA_ADMIN ?? "koomen";
const CELLD = { version: "v0.6.3", sha256: "6d617cdf9f049e43ca6a4e37c4cce5d8e35395c8e86b371c984d32ba7d803bf5" };
const CADDY = {
  version: "2.11.9",
  sha512:
    "9e5e76d7888542924de2c25353ae87c5f77e2a22c5b1198633cae13688922282e05383d142599205c88d8d80eee5e967d291214d7abce4835329a191b20dd6e0",
};
const ROOT = resolve(import.meta.dir, "../..");
const print = (line: string) => console.log(`- ${line}`);

/** The AWS CLI's answer: its JSON, else its text; throws if it fails. */
async function aws<T = any>(...args: string[]): Promise<T> {
  const out = (await $`aws ${args} --profile ${PROFILE} --region ${REGION} --output json`.quiet().text()).trim();
  if (!out) return null as T;
  try {
    return JSON.parse(out) as T;
  } catch {
    return out as T;
  }
}
const maybe = <T>(p: Promise<T>) => p.catch(() => null);
const tags = (kind: string) => `ResourceType=${kind},Tags=[{Key=${TAG.key},Value=${TAG.value}},{Key=Name,Value=${NAME}}]`;

const account: string = (await aws("sts", "get-caller-identity")).Account;
const BUCKET = `${NAME}-${account}`;
const ROLE = `arn:aws:iam::${account}:role/${NAME}`;
const FLEET = `s3://${BUCKET}/fleet`;

/** The machine (pending or running), or null. */
async function machine(): Promise<{ InstanceId: string; PublicIpAddress?: string; State: { Name: string } } | null> {
  const r = await aws(
    "ec2",
    "describe-instances",
    "--filters",
    `Name=tag:Name,Values=${NAME}`,
    "Name=instance-state-name,Values=pending,running,stopping,stopped"
  );
  return r.Reservations.flatMap((x: any) => x.Instances)[0] ?? null;
}

/** What the machine runs at its first boot: celld and Caddy at fixed versions (checked), and their services. */
const setup = () => `#!/bin/bash
set -euxo pipefail
dnf install -y tar gzip
curl -fsSL -o /tmp/celld.gz https://github.com/denoland/celld/releases/download/${CELLD.version}/celld-aarch64-unknown-linux-gnu.gz
echo "${CELLD.sha256}  /tmp/celld.gz" | sha256sum -c
gunzip -c /tmp/celld.gz > /usr/local/bin/celld && chmod 755 /usr/local/bin/celld
curl -fsSL -o /tmp/caddy.tgz https://github.com/caddyserver/caddy/releases/download/v${CADDY.version}/caddy_${CADDY.version}_linux_arm64.tar.gz
echo "${CADDY.sha512}  /tmp/caddy.tgz" | sha512sum -c
tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
useradd --system --home /var/lib/celld --create-home celld || true
cat > /etc/systemd/system/celld.service <<EOF
[Unit]
Description=celld (Erga)
After=network-online.target
[Service]
User=celld
Environment=AWS_REGION=${REGION} CELLD_BUCKET=${FLEET} CELLD_ADDR=127.0.0.1:8080 CELLD_TRUST_FORWARDED_HEADERS=1
Environment=CELLD_WATCH=/var/lib/celld/state CELLD_ASSET_CACHE_DIR=/var/lib/celld/assets
ExecStart=/usr/local/bin/celld
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
T=$(curl -fsS -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/public-ipv4)
mkdir -p /etc/caddy /var/lib/caddy
cat > /etc/caddy/Caddyfile <<EOF
erga-\${IP//./-}.sslip.io, pages-\${IP//./-}.sslip.io {
  reverse_proxy 127.0.0.1:8080
}
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
Environment=HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now celld caddy
`;

/** Runs a shell script on the machine (SSM Run Command): its output; throws if it fails. */
async function onMachine(instance: string, script: string, timeoutS = 600): Promise<string> {
  const params = JSON.stringify({ commands: [script], executionTimeout: [String(timeoutS)] });
  const id = (await aws("ssm", "send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript", "--parameters", params))
    .Command.CommandId;
  for (;;) {
    await Bun.sleep(3000);
    const r = await maybe(aws("ssm", "get-command-invocation", "--command-id", id, "--instance-id", instance));
    if (!r || ["Pending", "InProgress", "Delayed"].includes(r.Status)) continue;
    if (r.Status != "Success") throw new Error(`on the machine: ${r.Status}\n${r.StandardOutputContent}\n${r.StandardErrorContent}`);
    return r.StandardOutputContent;
  }
}

async function up() {
  // 1. The bucket: celld's state under fleet/, the releases under releases/.
  if (!(await maybe(aws("s3api", "head-bucket", "--bucket", BUCKET)))) {
    await aws("s3api", "create-bucket", "--bucket", BUCKET, "--create-bucket-configuration", `LocationConstraint=${REGION}`);
    print(`made the bucket ${BUCKET}`);
  }
  await aws(
    "s3api",
    "put-public-access-block",
    "--bucket",
    BUCKET,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  );
  await aws("s3api", "put-bucket-tagging", "--bucket", BUCKET, "--tagging", `TagSet=[{Key=${TAG.key},Value=${TAG.value}}]`);

  // 2. The machine's role: the bucket, and SSM (Run Command for deploys, Session Manager for a shell: no SSH).
  if (!(await maybe(aws("iam", "get-role", "--role-name", NAME)))) {
    const trust = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
    };
    await aws(
      "iam",
      "create-role",
      "--role-name",
      NAME,
      "--assume-role-policy-document",
      JSON.stringify(trust),
      "--tags",
      `Key=${TAG.key},Value=${TAG.value}`
    );
    await aws("iam", "attach-role-policy", "--role-name", NAME, "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore");
    const bucket = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:*", Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`] }],
    };
    await aws("iam", "put-role-policy", "--role-name", NAME, "--policy-name", "bucket", "--policy-document", JSON.stringify(bucket));
    await aws("iam", "create-instance-profile", "--instance-profile-name", NAME, "--tags", `Key=${TAG.key},Value=${TAG.value}`);
    await aws("iam", "add-role-to-instance-profile", "--instance-profile-name", NAME, "--role-name", NAME);
    print(`made the role ${NAME}`);
    await Bun.sleep(10_000); // (A new instance profile takes a moment before EC2 sees it.)
  }
  const reads = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "ssm:GetParametersByPath", Resource: `arn:aws:ssm:${REGION}:${account}:parameter${PARAMS}` }],
  };
  await aws("iam", "put-role-policy", "--role-name", NAME, "--policy-name", "params", "--policy-document", JSON.stringify(reads));

  // 2b. The key: only the machine's role may use it for the bucket. The account's admins manage it, and use it only
  // through Parameter Store, to set and read the secrets. The bucket's objects are encrypted with it.
  let key: string | undefined = (await maybe(aws("kms", "describe-key", "--key-id", KEY)))?.KeyMetadata.Arn;
  if (!key) {
    key = (
      await aws(
        "kms",
        "create-key",
        "--description",
        "Erga on celld: the bucket and the secrets",
        "--tags",
        `TagKey=${TAG.key},TagValue=${TAG.value}`
      )
    ).KeyMetadata.Arn as string;
    await aws("kms", "create-alias", "--alias-name", KEY, "--target-key-id", key);
    print(`made the key ${KEY}`);
  }
  const root = `arn:aws:iam::${account}:root`;
  const use = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*"];
  const keyPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Admins manage it",
        Effect: "Allow",
        Principal: { AWS: root },
        Action: ["Create*", "Describe*", "Enable*", "List*", "Put*", "Update*", "Revoke*", "Disable*", "Get*", "Delete*"]
          .map((a) => `kms:${a}`)
          .concat(["kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"]),
        Resource: "*",
      },
      { Sid: "The machine uses it", Effect: "Allow", Principal: { AWS: ROLE }, Action: [...use, "kms:DescribeKey"], Resource: "*" },
      {
        Sid: "Admins use it only in Parameter Store",
        Effect: "Allow",
        Principal: { AWS: root },
        Action: use,
        Resource: "*",
        Condition: { StringEquals: { "kms:ViaService": `ssm.${REGION}.amazonaws.com` } },
      },
    ],
  };
  await aws("kms", "put-key-policy", "--key-id", key, "--policy-name", "default", "--policy", JSON.stringify(keyPolicy));
  await aws(
    "s3api",
    "put-bucket-encryption",
    "--bucket",
    BUCKET,
    "--server-side-encryption-configuration",
    JSON.stringify({
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: key }, BucketKeyEnabled: true }],
    })
  );
  const guard = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Only the machine reads",
        Effect: "Deny",
        Principal: "*",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: `arn:aws:s3:::${BUCKET}/*`,
        Condition: { ArnNotEquals: { "aws:PrincipalArn": ROLE } },
      },
    ],
  };
  await aws("s3api", "put-bucket-policy", "--bucket", BUCKET, "--policy", JSON.stringify(guard));

  // 3. The firewall, in the default VPC: 80 and 443 only.
  const vpc = (await aws("ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true")).Vpcs[0].VpcId;
  let sg = (await aws("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${NAME}`, `Name=vpc-id,Values=${vpc}`))
    .SecurityGroups[0]?.GroupId;
  if (!sg) {
    sg = (
      await aws(
        "ec2",
        "create-security-group",
        "--group-name",
        NAME,
        "--description",
        "Erga on celld: HTTP and HTTPS (Caddy)",
        "--vpc-id",
        vpc,
        "--tag-specifications",
        tags("security-group")
      )
    ).GroupId;
    for (const port of ["80", "443"])
      await aws("ec2", "authorize-security-group-ingress", "--group-id", sg, "--protocol", "tcp", "--port", port, "--cidr", "0.0.0.0/0");
    print(`made the security group ${sg}`);
  }

  // 4. The machine: t4g.small (ARM, 2 GB), Amazon Linux 2023, a 16 GB disk for celld's local copies.
  let m = await machine();
  if (!m) {
    const ami = (await aws("ssm", "get-parameter", "--name", "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"))
      .Parameter.Value;
    const run = await aws(
      "ec2",
      "run-instances",
      "--image-id",
      ami,
      "--instance-type",
      "t4g.small",
      "--security-group-ids",
      sg,
      "--iam-instance-profile",
      `Name=${NAME}`,
      "--user-data",
      setup(),
      "--metadata-options",
      "HttpTokens=required,HttpEndpoint=enabled",
      "--block-device-mappings",
      JSON.stringify([{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 16, VolumeType: "gp3", Encrypted: true } }]),
      "--tag-specifications",
      tags("instance"),
      tags("volume")
    );
    m = run.Instances[0];
    print(`made the machine ${m!.InstanceId}`);
  }
  const instance = m!.InstanceId;
  await aws("ec2", "wait", "instance-running", "--instance-ids", instance);
  const ip: string = (await machine())!.PublicIpAddress!;
  const dashed = ip.replaceAll(".", "-");
  const origins = { app: `erga-${dashed}.sslip.io`, pages: `pages-${dashed}.sslip.io` };
  const cdn = await cdnUp(aws, origins, print);
  const app = `https://${cdn.app}`;

  // 5. The secrets, made once: SESSION_SECRET signs the sessions, FACTORY_KEY encrypts the API keys an admin enters.
  for (const name of ["SESSION_SECRET", "FACTORY_KEY"]) {
    if (await maybe(aws("ssm", "get-parameter", "--name", `${PARAMS}${name}`))) continue;
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
    await aws(
      "ssm",
      "put-parameter",
      "--name",
      `${PARAMS}${name}`,
      "--type",
      "SecureString",
      "--key-id",
      KEY,
      "--value",
      secret,
      "--tags",
      `Key=${TAG.key},Value=${TAG.value}`
    );
    print(`made ${PARAMS}${name}`);
  }

  // 6. The release, as a celld project, into the bucket.
  await $`bun run build`.cwd(ROOT).quiet();
  const index = await makeRelease();
  // (No secrets: the machine adds them at its deploy.)
  const project = await celldProject({ PAGES_HOST: cdn.pages, ERGA_VERSION: index.version });
  // (Outside .build/: the next release would serve it as a static asset, with the vars in it.)
  const tgz = join(mkdtempSync(join(tmpdir(), "erga-celld-")), "release.tgz");
  // (No macOS extended attributes: GNU tar on the machine warns of each.)
  await $`tar --no-xattrs --no-mac-metadata -czf ${tgz} -C ${project} .`;
  // (S3's own key: the release holds no secret, and the key is the machine's only.)
  await aws("s3", "cp", tgz, `s3://${BUCKET}/releases/${index.version}.tgz`, "--sse", "AES256");
  print(`release ${index.version}: ${(Bun.file(tgz).size / 1e6).toFixed(1)} MB`);

  // 7. On the machine: celld deploys it (the node takes it up at its next look), the database's migrations, the first admin.
  for (
    let i = 0;
    !(await aws("ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instance}`)).InstanceInformationList.length;
    i++
  ) {
    if (i > 60) throw new Error(`the machine ${instance} doesn't answer SSM`);
    await Bun.sleep(5000);
  }
  // Caddy passes on CloudFront's X-Erga-Host as X-Forwarded-Host (cdn.ts).
  await onMachine(
    instance,
    `cloud-init status --wait >/dev/null
cat > /etc/caddy/Caddyfile <<'EOF'
${caddyfile(origins, cdn)}EOF
HOME=/var/lib/caddy caddy reload --config /etc/caddy/Caddyfile`
  );
  const out = await onMachine(
    instance,
    `set -euo pipefail
cloud-init status --wait >/dev/null
export AWS_REGION=${REGION}
dir=$(mktemp -d) && cd "$dir" && trap 'rm -rf "$dir"' EXIT
aws s3 cp s3://${BUCKET}/releases/${index.version}.tgz - | tar -xz
aws ssm get-parameters-by-path --path ${PARAMS} --with-decryption --output json | python3 -c 'import json, sys
c = json.load(open("wrangler.json"))
c["vars"].update({p["Name"].rsplit("/", 1)[1]: p["Value"] for p in json.load(sys.stdin)["Parameters"]})
json.dump(c, open("wrangler.json", "w"))'
celld deploy . --bucket ${FLEET} 2>&1 | grep -v jemalloc | tail -2
for i in $(seq 1 60); do curl -sS localhost:8080/api/health 2>/dev/null | grep -q '"version":"${index.version}"' && break; sleep 2; done
celld d1 migrations apply erga . --bucket ${FLEET} 2>&1 | grep -v 'jemalloc\\|allocator' | tail -3
celld d1 execute erga . --bucket ${FLEET} --command "INSERT INTO users (login, name, role, created) SELECT '${ADMIN}', '${ADMIN}', 'admin', $(date +%s000) WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') ON CONFLICT (login) DO UPDATE SET role = 'admin'" 2>&1 | grep -v 'jemalloc\\|allocator' | tail -1
curl -fsS localhost:8080/api/health`
  );
  console.log(out.trim());
  print(`the app: ${app}`);
  print(
    `check it: SESSION_SECRET=$(aws ssm get-parameter --profile ${PROFILE} --region ${REGION} --name ${PARAMS}SESSION_SECRET --with-decryption --query Parameter.Value --output text) bun deploy/celld/check.ts ${app}`
  );
}

async function down() {
  await cdnDown(aws, print);
  const m = await machine();
  if (m) {
    await aws("ec2", "terminate-instances", "--instance-ids", m.InstanceId);
    await aws("ec2", "wait", "instance-terminated", "--instance-ids", m.InstanceId);
    print(`terminated ${m.InstanceId}`);
  }
  for (const g of (await aws("ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${NAME}`)).SecurityGroups) {
    await aws("ec2", "delete-security-group", "--group-id", g.GroupId);
    print(`deleted the security group ${g.GroupId}`);
  }
  if (await maybe(aws("iam", "get-role", "--role-name", NAME))) {
    await maybe(aws("iam", "remove-role-from-instance-profile", "--instance-profile-name", NAME, "--role-name", NAME));
    await maybe(aws("iam", "delete-instance-profile", "--instance-profile-name", NAME));
    await maybe(
      aws("iam", "detach-role-policy", "--role-name", NAME, "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
    );
    for (const policy of ["bucket", "params"]) await maybe(aws("iam", "delete-role-policy", "--role-name", NAME, "--policy-name", policy));
    await aws("iam", "delete-role", "--role-name", NAME);
    print(`deleted the role ${NAME}`);
  }
  if (await maybe(aws("s3api", "head-bucket", "--bucket", BUCKET))) {
    await aws("s3", "rb", `s3://${BUCKET}`, "--force");
    print(`deleted the bucket ${BUCKET} and all in it`);
  }
  for (const p of (await aws("ssm", "get-parameters-by-path", "--path", PARAMS)).Parameters) {
    await aws("ssm", "delete-parameter", "--name", p.Name);
    print(`deleted ${p.Name}`);
  }
  const key = await maybe(aws("kms", "describe-key", "--key-id", KEY));
  if (key) {
    await aws("kms", "delete-alias", "--alias-name", KEY);
    await aws("kms", "schedule-key-deletion", "--key-id", key.KeyMetadata.KeyId, "--pending-window-in-days", "7");
    print(`the key ${KEY} goes in 7 days (AWS's shortest wait)`);
  }
  // The tag index lags: a terminated machine and a deleted disk stay in it a while, so each is asked for itself.
  const left = (await aws("resourcegroupstaggingapi", "get-resources", "--tag-filters", `Key=${TAG.key},Values=${TAG.value}`))
    .ResourceTagMappingList;
  const still: string[] = [];
  for (const { ResourceARN: arn } of left) {
    const [, kind, id] = /:(instance|volume|key)\/(.+)$/.exec(arn) ?? [];
    if (kind == "instance") {
      const r = await maybe(aws("ec2", "describe-instances", "--instance-ids", id));
      if (!r || r.Reservations.every((x: any) => x.Instances.every((i: any) => i.State.Name == "terminated"))) continue;
    } else if (kind == "volume" && !(await maybe(aws("ec2", "describe-volumes", "--volume-ids", id)))) continue;
    else if (kind == "key" && (await aws("kms", "describe-key", "--key-id", id)).KeyMetadata.KeyState == "PendingDeletion") continue;
    still.push(arn);
  }
  if (await maybe(aws("iam", "get-role", "--role-name", NAME))) still.push(`the role ${NAME}`);
  still.push(...(await cdnLeft(aws)));
  print(still.length ? `still tagged ${TAG.key}=${TAG.value}:\n  ${still.join("\n  ")}` : `nothing tagged ${TAG.key}=${TAG.value} is left`);
}

const command = process.argv[2];
if (command == "up") await up();
else if (command == "down") await down();
else {
  console.error("usage: bun deploy/celld/aws.ts up|down");
  process.exit(2);
}
