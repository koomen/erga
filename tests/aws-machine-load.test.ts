// A load on the machine of an instance on AWS, and the way back after one that did not get healthy
// (deploy/aws/machine.ts: deployScript and backScript, as the deployer's document runs them). The real script runs in
// bash, with the machine's commands faked (tests/helpers/aws-machine.ts). The document's checks of a command:
// tests/aws-deployer.test.ts.

import { expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { documentScript } from "../deploy/aws/machine";
import { fakeMachine } from "./helpers/aws-machine.ts";

const SLOW = 30_000;
const UPLOAD = expect.stringMatching(/^[0-9a-f]{32}$/);
const load = { SSM_action: "load", SSM_version: "bbbbbbbbbbbb", SSM_sql: "" };
const deployed = { SSM_action: "deployed", SSM_version: "", SSM_sql: "" };

test(
  "a load is healthy only with its own answer; the way back loads what the last healthy load ran, with its settings",
  () => {
    const machine = fakeMachine(documentScript({ bucket: "bucket", region: "us-west-2", stack: "erga-example" }));
    const { command, said, loaded, inBucket, stale } = machine;
    try {
      // No release yet: nothing to go back to.
      const nothing = command({ SSM_action: "back", SSM_version: "", SSM_sql: "" });
      expect([nothing.code, nothing.err]).toEqual([1, "the machine ran no release yet: it has none to go back to\n"]);
      // A load: the release with the machine's secrets and a name of this load's own, which the server's health says.
      expect(command(load).code).toBe(0);
      const first = loaded().ERGA_UPLOAD;
      expect(loaded()).toEqual({ ERGA_VERSION: "bbbbbbbbbbbb", SESSION_SECRET: "s", ERGA_UPLOAD: UPLOAD });

      // The same release again: a load with a new name. While the Worker of the load before answers (healthy, with
      // the same version), the load is not healthy: the script fails, and the machine's list stays.
      stale(true);
      const failed = command(load);
      const second = loaded().ERGA_UPLOAD;
      expect(second).not.toBe(first);
      expect([failed.code, failed.err]).toEqual([
        1,
        `release bbbbbbbbbbbb is not healthy: its load ${second} gives no healthy answer. The last answer: {"ok": true, "version": "bbbbbbbbbbbb", "upload": "before", "checks": {}}\n`,
      ]);
      stale(false);
      expect(command(load).code).toBe(0);
      expect(command(deployed).out).toBe("bbbbbbbbbbbb\n");

      // The way back. The same release comes again with a setting that stops it, and its object replaces the bucket's.
      // Its load fails. `back` loads what the last healthy load ran, with that load's settings, from the machine's own
      // copy: it asks the bucket for nothing, and the release's name is the machine's, whatever the command says.
      inBucket({ SERVER_CONFIG: "{" });
      stale(true);
      expect(command(load).code).toBe(1);
      expect(loaded().SERVER_CONFIG).toBe("{");
      stale(false);
      const asked = said("asked").length;
      const back = command({ SSM_action: "back", SSM_version: "cccccccccccc", SSM_sql: "" });
      expect([back.code, back.err, back.out.trim().split("\n").at(-1)]).toEqual([0, "", "runs bbbbbbbbbbbb"]);
      expect(loaded()).toEqual({ ERGA_VERSION: "bbbbbbbbbbbb", SESSION_SECRET: "s", ERGA_UPLOAD: UPLOAD });
      expect(loaded().ERGA_UPLOAD).not.toBe(second);
      expect(said("asked").length).toBe(asked);
      expect(command(deployed).out).toBe("bbbbbbbbbbbb\n");
      // A way back that does not get healthy fails as a load does.
      stale(true);
      expect(command({ SSM_action: "back", SSM_version: "", SSM_sql: "" }).code).toBe(1);
      stale(false);

      // Only this user reads the copy. A machine with no copy (its last healthy load was before it kept one) takes
      // the bucket's object of the release that it ran last.
      const kept = join(machine.state, "healthy.tgz");
      expect(statSync(kept).mode & 0o077).toBe(0);
      rmSync(kept);
      expect(command({ SSM_action: "back", SSM_version: "", SSM_sql: "" }).code).toBe(0);
      expect(said("asked")).toHaveLength(asked + 1);
      expect(said("asked").at(-1)).toBe("s3://bucket/releases/bbbbbbbbbbbb.tgz");
      expect(loaded().SERVER_CONFIG).toBe("{");
    } finally {
      machine.remove();
    }
  },
  SLOW
);
