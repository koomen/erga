// bun erga snapshot-secret <host>: a new SNAPSHOT_TOKEN, the secret that an instance shares with each instance on a
// copy of its data (document/store/snapshot.ts). With it a copy reads every document of its source, so when it may have
// leaked, this command replaces it everywhere at once: on the source's Worker, on each copy's Worker,
// and in .erga/secrets.json under the source's host (where a --fresh deploy reads it). The old secret opens nothing
// from then on. It prints the servers' names, never the secret.

import { randomBytes } from "node:crypto";
import { putSecret } from "../own/store";
import { Cloudflare, type Fetch } from "../pipeline/cloudflare-api";
import { type CloudflareEntry, entryOf, isAws, readConfig } from "./config";
import { netOf } from "./deploy";

/** Replaces the secret on `host` and on each instance on a copy of its data. The result: the hosts that have the new one. */
export async function replaceSnapshotSecret(o: {
  dir: string;
  host: string;
  net?: Fetch;
  token?: string;
  print?: (line: string) => void;
}): Promise<string[]> {
  const print = o.print ?? console.log;
  const config = readConfig(o.dir);
  const entry = entryOf(config, o.host);
  if (!entry) throw new Error(`${o.host} has no entry in .erga/config.json. Register it first: bun erga register ${o.host}`);
  if (entry.copyOf)
    throw new Error(`${o.host} runs on a copy of ${entry.copyOf}'s data: name the source (bun erga snapshot-secret ${entry.copyOf}).`);
  const all = [entry, ...config.instances.filter((e) => e.copyOf == o.host)];
  const aws = all.find(isAws);
  if (aws) throw new Error(`${aws.host} runs on AWS: its secrets are in Parameter Store, and this command does not change them.`);
  const { net, token } = await netOf(o);
  const cf = new Cloudflare(token, net);
  const secret = randomBytes(32).toString("hex");
  const done: string[] = [];
  for (const e of all as CloudflareEntry[]) {
    await cf
      .call("PUT", `/accounts/${e.account}/workers/scripts/${e.worker}/secrets`, `set ${e.worker}'s SNAPSHOT_TOKEN`, {
        name: "SNAPSHOT_TOKEN",
        text: secret,
        type: "secret_text",
      })
      .catch((err: Error) => {
        throw new Error(
          `${err.message}\n${done.length ? `${done.join(", ")} ${done.length == 1 ? "has" : "have"} the new secret and ${e.host} does not: ` : ""}Run the command again: it makes a new secret for all of them.`
        );
      });
    done.push(e.host);
    print(`${e.host} (Worker ${e.worker}) has the new SNAPSHOT_TOKEN.`);
  }
  putSecret(o.host, "SNAPSHOT_TOKEN", secret, o.dir);
  print(`.erga/secrets.json has it under ${o.host}. The old secret opens nothing now.`);
  if (process.env.SNAPSHOT_TOKEN?.trim())
    print("NOTE  SNAPSHOT_TOKEN is set in this shell's environment, and a deploy reads it first: unset it.");
  return done;
}
