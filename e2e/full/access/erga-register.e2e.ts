// `bun erga register` and `bun erga login` (deploy/cli/main.ts) as a person runs them, in a clone, against a dev server
// that plays a deployed instance (ERGA_DEPLOY): an admin approves in the browser's place, and the command writes the
// instance's entry, with its deploy facts and vars, into the clone's .erga/config.json.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, servers, test } from "../../helpers/fixtures";
import { postForm } from "../../helpers/form-post";
import { signIn } from "./access";

const CLI = new URL("../../../deploy/cli/main.ts", import.meta.url).pathname;
const FACTS = {
  account: "acc123",
  worker: "erga-example",
  database: "erga-example",
  app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
  pages: { kind: "zone", zoneName: "example-pages.com", domain: "example-pages.com" },
  vars: { GITHUB_CLIENT_ID: "Ov23example", SERVER_DEFAULTS: "{}", DEPLOY_TARGET: "" },
};
const deployed = () => servers.of("deployed", { env: { ERGA_DEPLOY: JSON.stringify(FACTS) } });
await deployed();

/** A new clone with no .erga/ yet. */
function clone() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-register-")));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

/** Runs `bun erga <args>` in `cwd`; an admin approves each link it prints. Its exit and output. */
async function erga(cwd: string, root: string, ...args: string[]) {
  const p = spawn("bun", [CLI, ...args], { cwd });
  const exited = new Promise<number | null>((done) => p.on("close", done));
  let out = "";
  p.stderr.on("data", (chunk) => (out += chunk));
  for await (const chunk of p.stdout) {
    out += chunk;
    const link = /https?:\/\/\S+\/tokens\/approve\?code=\S+/.exec(out)?.[0];
    if (link && !out.includes("APPROVED")) {
      out += "APPROVED\n";
      const code = new URL(link).searchParams.get("code")!;
      expect((await postForm(root, "/tokens/approve", { code, answer: "approve" }, await signIn(root, null))).page).toContain("Approved");
    }
  }
  return { code: await exited, out };
}

const config = (dir: string) => JSON.parse(readFileSync(join(dir, ".erga/config.json"), "utf8"));

test("register writes the instance's entry with its facts, vars and token; login gives it a new token; a staging instance needs its primary", async () => {
  const root = (await deployed()).root,
    host = new URL(root).host,
    dir = clone();
  try {
    const refused = await erga(dir, root, "register", root, "--staging-of", "nothere.example.com");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("nothere.example.com has no entry in .erga/config.json");

    const r = await erga(dir, root, "register", root);
    expect(r.out).toContain(`PASS  ${host} is registered`);
    expect(r.code).toBe(0);
    const [entry] = config(dir).instances;
    expect(entry).toEqual({ host, ...FACTS, token: expect.stringMatching(/^erga_/) });

    const l = await erga(dir, root, "login", host);
    expect(l.out).toContain(`PASS  ${host} has a new ops token`);
    const after = config(dir).instances;
    expect(after).toHaveLength(1);
    expect(after[0].token).toMatch(/^erga_/);
    expect(after[0].token).not.toBe(entry.token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
