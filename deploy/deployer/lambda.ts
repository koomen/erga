// The deployer on AWS: a Lambda function in the person's own account, with no URL: nothing calls it but its schedule,
// which runs one look each minute (look.ts). The look reads the instance's spec, looks at GitHub, and with
// auto-deploy on deploys the head of the spec's branch with the core (deploy.ts) and AWS's calls (aws-cloud.ts).
//
// What it has (deploy/aws/deployer.ts installs it):
//   its role's keys           from Lambda's runtime (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN): AWS
//                             changes them, and no person ever holds them
//   AWS_REGION                the instance's region
//   ERGA_STACK, ERGA_BUCKET,  the one instance that it deploys to: its stack, its bucket, its machine and its
//   ERGA_MACHINE,             document, and whether the gate is in front ("1")
//   ERGA_DOCUMENT, ERGA_GATE
//
// It reads the spec on the instance, through the machine. A spec that names another stack, bucket or machine is
// refused: the person who installed this deployer said which instance it is for, and its role reaches no other.

import * as Effect from "effect/Effect";
import { Aws } from "./aws-api";
import { cloudAws } from "./aws-cloud";
import type { Fetch } from "./cloudflare-api";
import { look } from "./look";

/** The function, with `fetch` as its way out and `env` as its environment (a test gives its own). */
export const lambda = (fetch: Fetch, env: Record<string, string | undefined>) => async (): Promise<string> => {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`The deployer has no ${name}: install it again (bun erga setup).`);
    return value;
  };
  const aws = new Aws(
    { id: need("AWS_ACCESS_KEY_ID"), secret: need("AWS_SECRET_ACCESS_KEY"), token: env.AWS_SESSION_TOKEN },
    need("AWS_REGION"),
    fetch
  );
  const cloud = cloudAws(aws, {
    stack: need("ERGA_STACK"),
    bucket: need("ERGA_BUCKET"),
    machine: need("ERGA_MACHINE"),
    document: need("ERGA_DOCUMENT"),
    gate: env.ERGA_GATE == "1",
  });
  const line = await Effect.runPromise(look({ sql: cloud.sql, fetch, cloud: { aws: cloud.api }, mine: cloud.mine }));
  console.log(line);
  return line;
};
