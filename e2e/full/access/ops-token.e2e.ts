// The CLI's ops token (deploy/cli/ops.ts), against the dev server: it asks, an admin approves, and it reads GET /api/ops.
// The token reads nothing else: no API, MCP, documents or admin pages. On staging (admins only) it works the same.
import { expect, servers, test } from "../../helpers/fixtures";
import { postForm } from "../../helpers/form-post";
import { askOpsToken, readOps } from "../../../deploy/cli/ops";
import { getter, mint, signIn, tool } from "./access";

const staging = () => servers.of("staging-tokens", { env: { ERGA_DEPLOY_TARGET: "staging" } });
await servers.main();
await staging();

/** The CLI's sign-in, with the admin's approval in the browser's place: the token. */
async function signInCli(root: string) {
  let link = "";
  const asked = askOpsToken(root, { say: (line) => (link = /https?:\/\/\S+/.exec(line)![0]) });
  while (!link) await new Promise((r) => setTimeout(r, 20));
  const code = new URL(link).searchParams.get("code")!;
  const cookie = await signIn(root, null);
  // The admin's card says what the token reads, and when it ends.
  const card = await (await getter(root)(`/tokens/approve?code=${code}`, { headers: { Cookie: cookie } })).text();
  for (const part of ["bun erga", ">Ops<", "deploy facts", "no admin power", "Expires", ">Approve<"]) expect(card).toContain(part);
  expect(card).not.toContain("Never (until you revoke it)");
  const approved = await postForm(root, "/tokens/approve", { code, answer: "approve" }, cookie);
  expect(approved.page).toContain("Approved");
  return (await asked).token;
}

for (const [name, server] of [
  ["main", servers.main],
  ["staging", staging],
] as const)
  test(`${name}: the CLI gets an ops token and reads the server's facts with it; the token reads nothing else`, async () => {
    const root = (await server()).root,
      get = getter(root);
    const token = await signInCli(root);
    const facts = await readOps(root, token);
    expect(facts.host).toBe(new URL(root).host);
    expect(facts.target).toBe(name == "staging" ? "staging" : null);
    // Locally no deploy set the deploy facts.
    expect(facts.deploy).toBeNull();

    const auth = { Authorization: `Bearer ${token}` };
    // Refused: 401 on production (no session), 403 from staging's guard.
    for (const name of ["whoami", "list_documents"]) expect([401, 403]).toContain((await tool(root, token, name)).status);
    const refused = [
      ["POST", "/mcp"],
      ["GET", "/api/tools"],
      ["GET", "/api/admin/agent"],
      ["GET", "/admin"],
      ["GET", "/docs"],
      ["POST", "/api/publish"],
    ] as const;
    for (const [method, path] of refused) {
      const r = await get(path, { method, headers: { ...auth, Accept: "application/json" } });
      // Refused, or sent to sign in.
      const no = r.status >= 400 || (r.headers.get("location") ?? "").includes("/auth/sign-in");
      expect(`${method} ${path}: ${r.status} ${no}`).toMatch(/ true$/);
    }

    // No token, a wrong one, or an admin token: no facts.
    expect((await get("/api/ops")).status).toBe(401);
    const admin = (await mint(root, null, { label: "Admin", scope: "admin" })).token;
    for (const t of ["erga_nope", admin])
      expect(
        await readOps(root, t).then(
          () => "read",
          (e: Error) => e.message
        )
      ).toContain("refused the ops token");
  });
