// Runs the multiplayer suite against erga.dev (or ERGA_PROD_URL) with a test
// token from /tokens:
//
//   ERGA_TEST_TOKEN=erga_test_... bun run test:prod [run.ts arguments]
//
// The token signs in test people (Tester, Ada, Bo, ...), each with their own
// session cookie, and one of them makes (or reuses) the test document
// /<you>/testsuit, whose agent is the scripted one. Each test then makes its
// own fresh test document, so leftovers (agent sessions, people who left)
// can't spill from one test into the next; it's the remote target
// (target.ts), as for any deployment.

const base = (process.env.ERGA_PROD_URL || "https://erga.dev").replace(/\/+$/, "");
const token = process.env.ERGA_TEST_TOKEN;
const docId = process.env.ERGA_TEST_DOC || "testsuit";
if (!token) {
  console.error(`set ERGA_TEST_TOKEN to a token from ${base}/tokens`);
  process.exit(2);
}

/** A test person's session cookie. */
async function cookieFor(name: string): Promise<string> {
  const r = await fetch(`${base}/auth/test?token=${encodeURIComponent(token!)}&as=${encodeURIComponent(name)}`, { redirect: "manual" });
  const cookie = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
  if (!cookie) throw new Error(`signing in ${name}: ${r.status} ${await r.text()}`);
  return cookie;
}

const tester = await cookieFor("Tester");
const users: Record<string, { Cookie: string }> = {};
for (const name of ["Ada", "Bo", "Cy", "Dee"]) users[name] = { Cookie: await cookieFor(name) };

const made = await fetch(`${base}/new?id=${docId}`, { headers: { Cookie: tester }, redirect: "manual" });
const location = made.headers.get("location");
if (made.status != 302 || !location) throw new Error(`making the test document: ${made.status} ${await made.text()}`);
const doc = new URL(location, base).toString();
console.log(`suite against ${doc}`);

const run = Bun.spawn(["bun", new URL("./run.ts", import.meta.url).pathname, "--remote", ...process.argv.slice(2)], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    ERGA_TARGET_DOC: doc,
    ERGA_TARGET_COOKIE: tester,
    ERGA_TARGET_USERS: JSON.stringify(users),
    ERGA_TARGET_CAPS: process.env.ERGA_TARGET_CAPS || "browser,scriptedAgent",
    ERGA_TARGET_NEW_DOC: `${base}/new?id={id}`,
  },
});
process.exit(await run.exited);
