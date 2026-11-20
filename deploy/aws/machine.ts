// The instance's machine on AWS: what runs on it, and the commands `bun erga` runs there through Systems Manager (no
// SSH, no open port). The machine has no public address; it reads the programs, the releases and the secrets from its
// own bucket and Parameter Store, and reaches the internet only through the stack's way out (the model APIs, sign-in).
//
//   programs   celld and Chrome, fetched once by this machine, checked by their SHA-256, then kept in the bucket
//   provision  installs them from the bucket and starts their services (each step only when it isn't done)
//   release    one release's celld project, in the bucket as releases/<version>.tgz: the machine loads it (deployRelease)
//   rollback   loads the release before the one that runs (the machine keeps the list of the releases it ran)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONT } from "../../gate/mounts/web.ts";
import { CHROME_DEVTOOLS } from "../deployer/aws";
import { DEPLOYER } from "../deployer/aws-cloud";
import { type Aws, pause } from "./cli";
import { CELLD_PORT, paramFolder } from "./template";

/** celld (Deno, Apache-2.0) for Linux ARM64, at a fixed version. */
export const CELLD = {
  version: "v0.6.3",
  sha256: "6d617cdf9f049e43ca6a4e37c4cce5d8e35395c8e86b371c984d32ba7d803bf5",
  url: (v: string) => `https://github.com/denoland/celld/releases/download/${v}/celld-aarch64-unknown-linux-gnu.gz`,
};
/** Playwright's build of Chrome's headless shell for Linux ARM64 (Chrome for Testing has none), for view_page. */
export const CHROME = {
  revision: "1243",
  sha256: "3a2bc2c354fb66615ee329c2ab13cd1312b40294798bea04c5dc0053caa6b881",
  url: (r: string) => `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${r}/chromium-headless-shell-linux-arm64.zip`,
};

/**
 * celld's listener for its own commands (deploy, d1): on the loopback only, since it asks nobody who they are. Trap:
 * celld does not start with a public CELLD_ADDR unless this is set.
 */
const CELLD_INTERNAL = "127.0.0.1:8081";

const celldKey = `programs/celld-${CELLD.version}.gz`;
const chromeKey = `programs/chrome-${CHROME.revision}.zip`;
const fleet = (bucket: string) => `s3://${bucket}/fleet`;

/** A download, kept in this machine's cache (~/.cache/erga), checked by its SHA-256. The result: its path. */
async function fetched(url: string, sha256: string, log: (l: string) => void): Promise<string> {
  const dir = join(process.env.HOME ?? "/tmp", ".cache", "erga");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sha256);
  const ok = () => existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") == sha256;
  if (!ok()) {
    log(`download ${url}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    writeFileSync(path, new Uint8Array(await r.arrayBuffer()));
    if (!ok()) throw new Error(`${url} isn't the file we checked (its SHA-256 differs).`);
  }
  return path;
}

/**
 * Puts one file in the bucket, in one request. Trap: `aws s3 cp` sends a large file in parts, and S3 then asks the
 * sender for kms:Decrypt. The key lets the admins encrypt only (template.ts, Key), so S3 refuses a file in parts.
 */
export const putObject = (aws: Aws, bucket: string, key: string, file: string) =>
  aws("s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file);

/** Puts celld and Chrome in the bucket, unless they are there. */
export async function putPrograms(aws: Aws, bucket: string, log: (l: string) => void) {
  for (const [key, url, sha] of [
    [celldKey, CELLD.url(CELLD.version), CELLD.sha256],
    [chromeKey, CHROME.url(CHROME.revision), CHROME.sha256],
  ] as const) {
    const there = await aws("s3api", "head-object", "--bucket", bucket, "--key", key).catch(() => null);
    if (there) continue;
    await putObject(aws, bucket, key, await fetched(url, sha, log));
    log(`put ${key} in the bucket`);
  }
}

/**
 * Runs a shell script on the machine (Systems Manager's Run Command), and waits: its output. Throws with its error
 * output. It asks for the end after a quarter of a second, then less often (3 seconds at most): a short command, as a
 * health check, ends in about a second.
 */
export async function onMachine(aws: Aws, machine: string, script: string, timeoutS = 900): Promise<string> {
  const { Command } = await aws<{ Command: { CommandId: string } }>(
    "ssm",
    "send-command",
    "--instance-ids",
    machine,
    "--document-name",
    "AWS-RunShellScript",
    "--timeout-seconds",
    String(timeoutS),
    "--parameters",
    JSON.stringify({ commands: [script], executionTimeout: [String(timeoutS)] })
  );
  for (let wait = 250; ; wait = Math.min(3000, wait * 2)) {
    await pause(wait);
    const r = await aws<{ Status: string; StandardOutputContent: string; StandardErrorContent: string }>(
      "ssm",
      "get-command-invocation",
      "--command-id",
      Command.CommandId,
      "--instance-id",
      machine
    ).catch((e: Error) => {
      if (/InvocationDoesNotExist/.test(e.message)) return null;
      throw e;
    });
    if (!r || ["Pending", "InProgress", "Delayed"].includes(r.Status)) continue;
    if (r.Status == "Success") return r.StandardOutputContent;
    throw new Error(
      `on the machine (${r.Status}): ${`${r.StandardOutputContent}\n${r.StandardErrorContent}`.trim().split("\n").slice(-6).join("\n")}`
    );
  }
}

/** Waits until Systems Manager reaches the machine (a new machine takes a minute or two). */
export async function untilReachable(aws: Aws, machine: string, log: (l: string) => void) {
  for (let i = 0; ; i++) {
    const r = await aws<{ InstanceInformationList: { PingStatus: string }[] }>(
      "ssm",
      "describe-instance-information",
      "--filters",
      `Key=InstanceIds,Values=${machine}`
    );
    if (r.InstanceInformationList[0]?.PingStatus == "Online") return;
    if (i == 0) log(`wait for the machine ${machine} to answer Systems Manager...`);
    if (i > 90) throw new Error(`The machine ${machine} doesn't answer Systems Manager: does its subnet have a way out?`);
    await pause(5000);
  }
}

/** The machine's setup: celld and Chrome from the bucket, and their services. Each part only when it isn't done. */
export function provisionScript(o: { bucket: string; region: string }): string {
  const chromeDir = `/opt/chrome-${CHROME.revision}`;
  const [host, port] = CHROME_DEVTOOLS.split(":");
  return `set -euo pipefail
export AWS_REGION=${o.region}
cloud-init status --wait >/dev/null || true
if ! /usr/local/bin/celld --version 2>/dev/null | grep -q '${CELLD.version.slice(1)}'; then
  aws s3 cp s3://${o.bucket}/${celldKey} /tmp/celld.gz --quiet
  echo "${CELLD.sha256}  /tmp/celld.gz" | sha256sum -c --quiet
  gunzip -c /tmp/celld.gz > /usr/local/bin/celld.new && chmod 755 /usr/local/bin/celld.new && mv /usr/local/bin/celld.new /usr/local/bin/celld
  rm /tmp/celld.gz
fi
useradd --system --home /var/lib/celld --create-home celld 2>/dev/null || true
cat > /etc/systemd/system/celld.service <<EOF
[Unit]
Description=celld (Erga)
After=network-online.target
[Service]
User=celld
Environment=AWS_REGION=${o.region} CELLD_BUCKET=${fleet(o.bucket)} CELLD_ADDR=0.0.0.0:${CELLD_PORT} CELLD_TRUST_FORWARDED_HEADERS=1
Environment=CELLD_INTERNAL_ADDR=${CELLD_INTERNAL}
Environment=CELLD_WATCH=/var/lib/celld/state CELLD_ASSET_CACHE_DIR=/var/lib/celld/assets
ExecStart=/usr/local/bin/celld
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
if [ ! -x ${chromeDir}/chrome-linux/headless_shell ]; then
  dnf install -y -q unzip atk at-spi2-atk libX11 libXcomposite libXdamage libXext libXfixes libXrandr mesa-libgbm libxcb \\
    libxkbcommon alsa-lib pango cairo nss nspr cups-libs libdrm dbus-libs google-noto-sans-fonts google-noto-serif-fonts \\
    google-noto-sans-mono-fonts google-noto-emoji-color-fonts >/dev/null
  aws s3 cp s3://${o.bucket}/${chromeKey} /tmp/chrome.zip --quiet
  echo "${CHROME.sha256}  /tmp/chrome.zip" | sha256sum -c --quiet
  rm -rf ${chromeDir}.new && mkdir -p ${chromeDir}.new && unzip -q /tmp/chrome.zip -d ${chromeDir}.new && rm /tmp/chrome.zip && mv ${chromeDir}.new ${chromeDir}
fi
useradd --system --home /var/lib/chrome --create-home chrome 2>/dev/null || true
cat > /etc/systemd/system/chrome.service <<EOF
[Unit]
Description=Headless Chrome for view_page (Erga)
After=network-online.target
[Service]
User=chrome
ExecStart=${chromeDir}/chrome-linux/headless_shell --remote-debugging-address=${host} --remote-debugging-port=${port} --user-data-dir=/var/lib/chrome/profile --site-per-process --no-first-run --disable-gpu about:blank
MemoryMax=900M
OOMScoreAdjust=500
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable celld chrome >/dev/null 2>&1
systemctl restart celld chrome
listens() { ss -ltn | grep -q ':${CELLD_PORT} '; }
for i in $(seq 1 30); do listens && break; sleep 1; done
listens || { echo "celld doesn't start: $(journalctl -u celld -n 20 --no-pager -o cat | grep -m1 Error)" >&2; exit 1; }
for i in $(seq 1 30); do curl -fsS http://${CHROME_DEVTOOLS}/json/version >/dev/null 2>&1 && break; sleep 1; done
echo "celld $(/usr/local/bin/celld --version | head -1); $(curl -fsS http://${CHROME_DEVTOOLS}/json/version | grep -o '"Browser": "[^"]*"')"
`;
}

/** The stack's secret that holds the gate's key (GATE_KEY), into the shell's GATE_KEY: the machine's role may read it. */
const gateKeyOf = (secret: string) =>
  `GATE_KEY=$(aws secretsmanager get-secret-value --secret-id '${secret}' --query SecretString --output text)`;

/**
 * The machine's own request to its server's health check, on the loopback. With the gate in front (`gate`), Erga
 * answers only a request with the gate's key (server/identity/mount.ts): the shell's GATE_KEY. curl reads that header
 * from its input (printf is the shell's own): the key is in no command's words, which the machine's other users see.
 */
const healthCurl = (gate: boolean) =>
  `${gate ? `printf '${FRONT}: %s\\n' "$GATE_KEY" | ` : ""}curl -sS -m 10 ${gate ? "-H @- " : ""}localhost:${CELLD_PORT}/api/health 2>/dev/null`;

/**
 * Loads a release that is in the bucket: the database's migrations first (they only add: the release that runs now
 * still works on the new schema), then the Worker, then it waits until the new version answers. Trap: celld's node
 * takes its lease (nodes/ in the fleet's folder) only when it has a deployment, and celld d1 needs that node: the
 * first release goes the other way, the Worker and then the migrations. The secrets go into
 * the settings on the machine only, never into the bucket's release. The machine adds the version to its list of
 * releases (rollback reads it). Trap: the machine reads the release from the bucket on every deploy and keeps no copy:
 * a deploy again of the same version carries other settings (the entry's vars, in its wrangler.json). The script waits, for
 * three minutes at most, until the release answers its own health check, healthy, on the loopback (GET /api/health: its
 * version, the database, a document): a release that does not is an error, and the caller loads the release before.
 * Trap: the answer must be this load's own. The Worker that ran before answers too until celld has the new one, and
 * after a load that celld refused; with the same release it says the same version. So the machine gives each load a
 * name of its own (ERGA_UPLOAD, in the settings on the machine: the server says it in its health report, as
 * `upload`), and takes only a healthy answer that has it.
 * The release makes the default homepage itself, in its scheduled run (its Cron Trigger, in the project's
 * wrangler.json: server/health.ts). `first`: SQL to run after it answers (setup's first admin). `gateKey`: with the
 * gate in front (deploy/aws/template.ts), the stack's secret that holds the key the distributions send with each
 * request: the machine reads it, and it is Erga's GATE_KEY (server/identity/mode.ts). A deploy whose machine can't
 * read it stops here: without the key Erga would take itself for a server with no gate in front. `version`: the
 * release's name, or the shell's own word for it ("$SSM_version", in the deployer's document): the script reads it
 * only as its variable `version`.
 */
export function deployScript(o: {
  bucket: string;
  region: string;
  stack: string;
  version: string;
  first?: string;
  gateKey?: string;
}): string {
  return `set -euo pipefail
export AWS_REGION=${o.region}
export version="${o.version}"
upload=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
export upload
live=$(mktemp -d) && trap 'rm -rf "$live"' EXIT && cd "$live"
aws s3 cp "s3://${o.bucket}/releases/$version.tgz" - --quiet | tar -xz
${
  // (Each on a line of its own: `set -e` does not stop at a command that fails before an `&&`.)
  o.gateKey
    ? `${gateKeyOf(o.gateKey)}
test -n "$GATE_KEY"
export GATE_KEY`
    : "unset GATE_KEY"
}
aws ssm get-parameters-by-path --path ${paramFolder(o.stack)} --with-decryption --output json | python3 -c 'import json, os, sys
c = json.load(open("wrangler.json"))
c["vars"].update({p["Name"].rsplit("/", 1)[1]: p["Value"] for p in json.load(sys.stdin)["Parameters"]})
if "GATE_KEY" in os.environ: c["vars"]["GATE_KEY"] = os.environ["GATE_KEY"]
c["vars"]["ERGA_UPLOAD"] = os.environ["upload"]
json.dump(c, open("wrangler.json", "w"))'
quiet() { grep -v 'jemalloc\\|allocator' || true; }
migrate() { celld d1 migrations apply erga . --bucket ${fleet(o.bucket)} 2>&1 | quiet | tail -3; }
load() { celld deploy . --bucket ${fleet(o.bucket)} 2>&1 | quiet | tail -2; }
if aws s3 ls ${fleet(o.bucket)}/nodes/ 2>/dev/null | grep -q .; then
  migrate
  load
else
  load
  for i in $(seq 1 60); do aws s3 ls ${fleet(o.bucket)}/nodes/ 2>/dev/null | grep -q . && break; sleep 2; done
  migrate
fi
health() { ${healthCurl(!!o.gateKey)}; }
healthy() { health | python3 -c 'import json, os, sys
h = json.load(sys.stdin)
sys.exit(0 if h.get("ok") is True and h.get("version") == os.environ["version"] and h.get("upload") == os.environ["upload"] else 1)' 2>/dev/null; }
for i in $(seq 1 90); do healthy && break; sleep 2; done
healthy || { echo "release $version is not healthy: its load $upload gives no healthy answer. The last answer: $(health | head -c 400)" >&2; exit 1; }
${o.first ? `celld d1 execute erga . --bucket ${fleet(o.bucket)} --command "${o.first.replace(/"/g, '\\"')}" 2>&1 | quiet | tail -1` : ""}
mkdir -p /var/lib/erga && touch /var/lib/erga/deployed && sed -i "/^$version\\$/d" /var/lib/erga/deployed
echo "$version" >> /var/lib/erga/deployed
echo "runs $version"
`;
}

/**
 * The server's own health report, as it answers the machine on the loopback (GET /api/health), in 10 seconds: one line
 * of JSON, or nothing. `gate`: with the gate in front, the stack's secret that holds the gate's key, and its region.
 */
export const healthScript = (gate?: { key: string; region: string }) =>
  `${gate ? `export AWS_REGION=${gate.region}\n${gateKeyOf(gate.key)} || true\n` : ""}${healthCurl(!!gate)} || true`;

/** One release's deploy facts (ERGA_DEPLOY in its settings, as the bucket has them), as one line of JSON. */
export const factsScript = (o: { bucket: string; region: string; version: string }) =>
  `set -euo pipefail
export AWS_REGION=${o.region}
aws s3 cp s3://${o.bucket}/releases/${o.version}.tgz - --quiet | tar -xzO ./wrangler.json | python3 -c 'import json, sys
print(json.load(sys.stdin)["vars"]["ERGA_DEPLOY"])'
`;

/**
 * One SQL statement on the instance's database (celld d1 execute, in the release that runs, as deployScript's `first`
 * does): its output, as celld prints it.
 */
export const sqlScript = (o: { bucket: string; region: string; sql: string }) =>
  `set -euo pipefail
export AWS_REGION=${o.region}
version=$(tail -1 /var/lib/erga/deployed)
dir=$(mktemp -d) && trap 'rm -rf "$dir"' EXIT && cd "$dir"
aws s3 cp s3://${o.bucket}/releases/$version.tgz - --quiet | tar -xz
celld d1 execute erga . --bucket ${fleet(o.bucket)} --command "${o.sql.replace(/"/g, '\\"')}" 2>&1
`;

/**
 * One statement of the instance's record of its deploys (deploy/deployer/instance.ts) on its database: celld's rows,
 * one JSON object for each (its table has lines around each row, as wide as the row: Systems Manager gives back
 * 24,000 characters of the output at most). A machine that runs no release yet has no database: it says so in SQLite's words for a table
 * that is not there. Trap: `sql` goes into the script as it is: its caller (deploy.ts, awsSql) gives only a statement
 * of plain characters, with each value as hex.
 */
export const recordScript = (o: { bucket: string; region: string; sql: string }) =>
  `set -euo pipefail
export AWS_REGION=${o.region}
version=$(tail -1 /var/lib/erga/deployed 2>/dev/null || true)
if [ -z "$version" ]; then echo "no such table: the machine runs no release yet"; exit 1; fi
dir=$(mktemp -d) && trap 'rm -rf "$dir"' EXIT && cd "$dir"
aws s3 cp s3://${o.bucket}/releases/$version.tgz - --quiet | tar -xz
celld d1 execute erga . --bucket ${fleet(o.bucket)} --json --command "${o.sql}"
`;

/** The releases the machine ran, oldest first (the last one runs now). */
export const deployedScript = () => "cat /var/lib/erga/deployed 2>/dev/null || true";

/**
 * The script of the instance's own document (Systems Manager), which the deployer in the cloud sends to the machine
 * (deploy/deployer/aws-cloud.ts): the only thing that its role may run there. It is fixed when setup installs it: the
 * bucket, the stack and the gate's secret are in it. A command gives three parameters, which the document checks and
 * which the agent gives the script as environment variables (SSM_action, SSM_version, SSM_sql: never as text of the
 * script), and the script checks the release's name again:
 *
 *   load      loads the release `version` from the bucket (deployScript, with no first SQL): a deploy, or the way back
 *   deployed  the releases that the machine ran (deployedScript)
 *   sql       one statement of the instance's record of its deploys (recordScript), checked here again: it reads no
 *             table but the three of the deploys, and writes only the jobs and the looks (deploy/deployer/aws-cloud.ts,
 *             DEPLOYER). The document's own pattern checks only the statement's shape
 *
 * Trap: an agent older than 3.3.2746.0 gives no such variable: the script stops at its second line, and runs nothing.
 */
export function documentScript(o: { bucket: string; region: string; stack: string; gateKey?: string }): string {
  const body = (script: string) => script.trim().replace(/^set -euo pipefail\n/, "");
  return `set -euo pipefail
: "\${SSM_action:?The Systems Manager agent of the machine gave the script no parameter. It must be 3.3.2746.0 or newer.}"
if [ "$SSM_action" = load ]; then
[[ "\${SSM_version:-}" =~ ^[0-9a-f]{12}$ ]] || { echo "not a release's name" >&2; exit 2; }
${body(deployScript({ ...o, version: "$SSM_version" }))}
elif [ "$SSM_action" = deployed ]; then
${deployedScript()}
elif [ "$SSM_action" = sql ]; then
SQL="\${SSM_sql:-}" python3 -c 'import os, re, sys
s = os.environ["SQL"]
ok = re.fullmatch(r"${DEPLOYER.shape}", s) and not re.search(r"${DEPLOYER.other}", re.sub(r"${DEPLOYER.read}", " ", s), re.I)
sys.exit(0 if ok else 2)' || { echo "not a statement of the record of the deploys" >&2; exit 2; }
${body(recordScript({ bucket: o.bucket, region: o.region, sql: "$SSM_sql" }))}
else
echo "not an action of this document" >&2; exit 2
fi
`;
}

/** Puts a release's packed celld project (deploy/deployer/celld.ts) in the bucket: its size, in bytes. */
export async function putRelease(aws: Aws, bucket: string, tgz: Uint8Array, version: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), `erga-celld-${version}-`));
  try {
    const file = join(dir, "release.tgz");
    writeFileSync(file, tgz);
    await putObject(aws, bucket, `releases/${version}.tgz`, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return tgz.length;
}
