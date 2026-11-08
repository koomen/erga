// The instance's machine on AWS: what runs on it, and the commands `bun erga` runs there through Systems Manager (no
// SSH, no open port). The machine has no public address; it reads the programs, the releases and the secrets from its
// own bucket and Parameter Store, and reaches the internet only through the stack's way out (the model APIs, sign-in).
//
//   programs   celld and Chrome, fetched once by this machine, checked by their SHA-256, then kept in the bucket
//   provision  installs them from the bucket and starts their services (each step only when it isn't done)
//   release    one release's celld project, in the bucket as releases/<version>.tgz: the machine loads it (deployRelease)
//   rollback   loads the release before the one that runs (the machine keeps the list of the releases it ran)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Aws } from "./cli";
import { CELLD_PORT, paramPath } from "./template";

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
/** Where the Worker finds the machine's Chrome (ERGA_CHROME, cloudflare/browser.ts): on the loopback only. */
export const CHROME_DEVTOOLS = "127.0.0.1:9222";

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

/** Puts celld and Chrome in the bucket, unless they are there. */
export async function putPrograms(aws: Aws, bucket: string, log: (l: string) => void) {
  for (const [key, url, sha] of [
    [celldKey, CELLD.url(CELLD.version), CELLD.sha256],
    [chromeKey, CHROME.url(CHROME.revision), CHROME.sha256],
  ] as const) {
    const there = await aws("s3api", "head-object", "--bucket", bucket, "--key", key).catch(() => null);
    if (there) continue;
    await aws("s3", "cp", await fetched(url, sha, log), `s3://${bucket}/${key}`);
    log(`put ${key} in the bucket`);
  }
}

/** Runs a shell script on the machine (Systems Manager's Run Command), and waits: its output. Throws with its error output. */
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
  for (;;) {
    await Bun.sleep(3000);
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
      `on the machine (${r.Status}): ${(r.StandardErrorContent || r.StandardOutputContent).trim().split("\n").slice(-6).join("\n")}`
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
    await Bun.sleep(5000);
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
for i in $(seq 1 30); do curl -fsS http://${CHROME_DEVTOOLS}/json/version >/dev/null 2>&1 && break; sleep 1; done
echo "celld $(/usr/local/bin/celld --version | head -1); $(curl -fsS http://${CHROME_DEVTOOLS}/json/version | grep -o '"Browser": "[^"]*"')"
`;
}

/**
 * Loads a release that is in the bucket: the database's migrations first (they only add: the release that runs now
 * still works on the new schema), then the Worker, then it waits until the new version answers. The secrets go into
 * the settings on the machine only, never into the bucket's release. The machine adds the version to its list of
 * releases (rollback reads it). `first`: SQL to run after it answers (setup's first admin).
 */
export function deployScript(o: { bucket: string; region: string; stack: string; version: string; first?: string }): string {
  return `set -euo pipefail
export AWS_REGION=${o.region}
dir=/var/lib/erga/releases/${o.version}
if [ ! -f "$dir/wrangler.json" ]; then
  rm -rf "$dir.new" && mkdir -p "$dir.new" && aws s3 cp s3://${o.bucket}/releases/${o.version}.tgz - --quiet | tar -xz -C "$dir.new"
  rm -rf "$dir" && mv "$dir.new" "$dir"
fi
live=$(mktemp -d) && trap 'rm -rf "$live"' EXIT && cp -r "$dir/." "$live" && cd "$live"
aws ssm get-parameters-by-path --path ${paramPath(o.stack)} --with-decryption --output json | python3 -c 'import json, sys
c = json.load(open("wrangler.json"))
c["vars"].update({p["Name"].rsplit("/", 1)[1]: p["Value"] for p in json.load(sys.stdin)["Parameters"]})
json.dump(c, open("wrangler.json", "w"))'
quiet() { grep -v 'jemalloc\\|allocator' || true; }
celld d1 migrations apply erga . --bucket ${fleet(o.bucket)} 2>&1 | quiet | tail -3
celld deploy . --bucket ${fleet(o.bucket)} 2>&1 | quiet | tail -2
for i in $(seq 1 90); do curl -sS localhost:${CELLD_PORT}/api/deploys/version 2>/dev/null | grep -q '"version":"${o.version}"' && break; sleep 2; done
curl -fsS localhost:${CELLD_PORT}/api/deploys/version | grep -q '"version":"${o.version}"' || { echo "release ${o.version} doesn't answer" >&2; exit 1; }
${o.first ? `celld d1 execute erga . --bucket ${fleet(o.bucket)} --command "${o.first.replace(/"/g, '\\"')}" 2>&1 | quiet | tail -1` : ""}
mkdir -p /var/lib/erga && touch /var/lib/erga/deployed && sed -i '/^${o.version}$/d' /var/lib/erga/deployed
echo '${o.version}' >> /var/lib/erga/deployed
echo "runs ${o.version}"
`;
}

/** The releases the machine ran, oldest first (the last one runs now). */
export const deployedScript = () => "cat /var/lib/erga/deployed 2>/dev/null || true";

/** Puts a release's celld project in the bucket (deploy/aws/project.ts made it in `dir`). */
export async function putRelease(aws: Aws, bucket: string, dir: string, version: string): Promise<number> {
  const tgz = `${dir}.tgz`;
  // (No macOS extended attributes: GNU tar on the machine warns of each.)
  const tar = Bun.spawnSync(["tar", "--no-xattrs", "--no-mac-metadata", "-czf", tgz, "-C", dir, "."]);
  if (tar.exitCode != 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  await aws("s3", "cp", tgz, `s3://${bucket}/releases/${version}.tgz`, "--quiet");
  return Bun.file(tgz).size;
}
