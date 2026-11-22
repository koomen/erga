// A server as `bun erga setup` leaves it with single sign-on (deploy/own/plan.ts, firstRows): no admin and no user,
// and everybody whom the organization's sign-in lets through may join. With its deployer as the binding answers
// (deploy/deployer/token.ts): it holds no token, and takes only TOKEN. For the tests of the setup page behind the
// gate, wherever the gate runs (tests/gate-erga.test.ts, tests/gate-front.test.ts).

import { firstRows, noAnswers } from "../../deploy/own/plan";
import { Directory } from "../../server/directory/index.ts";
import { Grants, sessionOf } from "../../server/identity/index.ts";
import type { Platform } from "../../server/platform";
import type { server } from "./app";
import { memory } from "./memory-sql.ts";

export const TOKEN = "t".repeat(40);

/** Makes `s` such a server. `deployer`: what its deployer was asked, and whether it holds the token now. */
export async function asNewServer(s: ReturnType<typeof server>, host: string) {
  const sql = memory();
  const directory = new Directory(sql, { admins: [], providers: ["github", "google"] });
  for (const { table, row } of firstRows({ ...noAnswers(host), signIn: "sso" }))
    await sql.run(`INSERT INTO ${table} (${Object.keys(row)}) VALUES (${Object.keys(row).map(() => "?")})`, ...Object.values(row));
  const deployer = { held: false, asked: [] as string[] };
  const says = () => ({ ok: true as const, ready: deployer.held, head: deployer.held ? "a".repeat(40) : null });
  const deploy: Platform["deploy"] = {
    ...s.platform.deploy,
    deployer: {
      account: "acc-1",
      worker: "erga-example",
      ask: async (token) => {
        if (token == null) return says();
        deployer.asked.push(token);
        if (token != TOKEN) return { ok: false, why: "The token can read another Worker (other)." };
        deployer.held = true;
        return says();
      },
    },
  };
  Object.assign(s.platform as unknown as Record<string, unknown>, {
    directory,
    grants: new Grants(sql, directory),
    dev: () => false,
    deploy,
    sessionOf: (r: Request) => sessionOf(s.platform, r),
  });
  return { directory, deployer };
}

/** Each row of the setup page, with its state, and whether it is open. */
export const rowsOf = (html: string) =>
  [...html.matchAll(/data-step="(\w+)" data-state="(\w+)"( open)?/g)].map((m) => `${m[1]} ${m[2]}${m[3] ?? ""}`);
