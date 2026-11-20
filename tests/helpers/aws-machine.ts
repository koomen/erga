// The machine of an instance on AWS, for a test of its scripts (deploy/aws/machine.ts): the real script runs in bash,
// and the machine's commands are fakes in a folder of the test's own. The bucket has one release, bbbbbbbbbbbb; celld
// keeps what it got; the server's health report is the one of the Worker that celld loaded last.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A machine that runs `script` for each command. The script's /var/lib/erga is the folder `state` of the test's own. */
export function fakeMachine(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "erga-machine-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tool = (name: string, body: string) => (
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`), chmodSync(join(bin, name), 0o755)
  );
  // The bucket gives release.tgz, and says which object was asked.
  tool(
    "aws",
    `case "$1 $2" in
  "s3 cp") echo "$3" >> "$FAKE/asked"; cat "$FAKE/release.tgz" > "$4" ;;
  "s3 ls") echo node ;;
  "ssm get-parameters-by-path") echo '{"Parameters":[{"Name":"/erga/erga-example/SESSION_SECRET","Value":"s"}]}' ;;
esac`
  );
  tool("celld", `echo "$@" >> "$FAKE/celld"; [ "$1" = deploy ] && cp wrangler.json "$FAKE/loaded.json"; true`);
  // The server's health report: the Worker that celld loaded last says its load's name. $FAKE/stale: celld took no
  // new Worker, and the one before answers, healthy, with the same version.
  tool(
    "curl",
    `python3 -c 'import json, os, sys
d = os.environ["FAKE"]
stale = os.path.exists(d + "/stale")
upload = "before" if stale else json.load(open(d + "/loaded.json"))["vars"].get("ERGA_UPLOAD")
print(json.dumps({"ok": True, "version": "bbbbbbbbbbbb", "upload": upload, "checks": {}}))'`
  );
  // (The machine's wait for a healthy answer, without its time: two looks, and no pause.)
  tool("seq", "echo 1; echo 2");
  tool("sleep", "true");
  // (macOS's sed needs a suffix after -i.)
  tool(
    "sed",
    `if [ "$1" = -i ] && [ "$(uname)" = Darwin ]; then shift; exec ${Bun.which("sed")} -i '' "$@"; fi; exec ${Bun.which("sed")} "$@"`
  );
  const project = join(dir, "release");
  mkdirSync(project);
  /** Puts the release bbbbbbbbbbbb in the bucket, with `more` settings: it replaces the object that was there. */
  const inBucket = (more: Record<string, string> = {}) => {
    writeFileSync(join(project, "wrangler.json"), JSON.stringify({ vars: { ERGA_VERSION: "bbbbbbbbbbbb", ...more } }));
    Bun.spawnSync(["tar", "-czf", join(dir, "release.tgz"), "-C", project, "."]);
  };
  inBucket();
  const state = join(dir, "state");
  const here = script.replaceAll("/var/lib/erga", state);
  return {
    /** The script as this machine runs it. */
    script: here,
    /** The machine's own folder (the script's /var/lib/erga). */
    state,
    inBucket,
    /** One command: the script with `env` (the agent's variables), and how it ended. */
    command(env: Record<string, string>) {
      const { PATH, HOME } = process.env;
      const r = Bun.spawnSync(["bash", "-c", here], { env: { HOME, PATH: `${bin}:${PATH}`, FAKE: dir, ...env } });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    },
    /** The lines of what a fake wrote: "asked" (the bucket's objects), "celld" (its calls). */
    said: (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim().split("\n") : []),
    /** The settings of the Worker that celld loaded last. */
    loaded: () => JSON.parse(readFileSync(join(dir, "loaded.json"), "utf8")).vars as Record<string, string>,
    /** Whether celld takes no new Worker: the one before goes on to answer. */
    stale(on: boolean) {
      if (on) writeFileSync(join(dir, "stale"), "");
      else rmSync(join(dir, "stale"), { force: true });
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
