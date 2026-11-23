// bun erga setup on an instance that runs (deploy/own/flow.ts, stateOf): with an admin, a left-out option changes
// nothing, and each given option applies or stops the command. The move to single sign-on and to a pages domain keeps
// each account for its person. The flow is pure: each test gives it the answers and what the command saw.
// (tests/erga-setup.test.ts runs the command itself against the mock Cloudflare.)
import { expect, test } from "bun:test";
import type { CloudflareEntry } from "../deploy/cli/config";
import { readOptions } from "../deploy/own/cli";
import { type Account, keepsOf, moveText, nothingSeen, type Seen, step } from "../deploy/own/flow";
import { type Answers, movedEntry, noAnswers, setupEntry, varsOf } from "../deploy/own/plan";

const HOST = "erga.example.com";
const ADA = "a".repeat(32);
/** A Cloudflare login with one account that holds example.com. */
const CF: Partial<Seen> = { login: { ok: true }, choices: [{ id: ADA, name: "Ada Lovelace" }], zones: ["example.com"], account: ADA };
const LIVE: Partial<Seen> = { live: { version: "abc123", healthy: true, signIn: "ok" } };
const seen = (s: Partial<Seen>): Seen => ({ ...nothingSeen, ...s });
const options = (...args: string[]) => readOptions(HOST, args);
/** The answers of the options, and the state after each look, as the command folds them in. */
function run(a: Answers, ...looks: Partial<Seen>[]) {
  let r = { answers: a, state: step(a, seen({})).state, look: false };
  for (const s of looks) r = step(r.answers, seen(s));
  return r;
}

test("an instance with an admin: a left-out option changes nothing, a given one applies or stops, and the move to single sign-on keeps each account for its person", () => {
  const CF2 = { ...CF, zones: ["example.com", "example-pages.com", "other-pages.com"] };
  const base = ["--host", "cloudflare", "--deploys", "local"];
  const TAG = "f".repeat(64);
  const sso = ["--sign-in", "sso", "--team", "acme", "--aud", TAG];
  const to = [...base, ...sso, "--pages", "example-pages.com"];
  const account = (login: string, more: Partial<Account> = {}): Account => ({
    login,
    admin: false,
    sso: false,
    emails: [],
    keeps: null,
    ...more,
  });
  // The instance, as setup made it: GitHub or Google sign-in, the pages on the shared address, an admin and two more accounts.
  const was = {
    ...CF2,
    ...LIVE,
    admin: true,
    vars: varsOf(options(...base).answers, undefined),
    pages: "shared",
    entryAccount: ADA,
    tracks: { repo: "github.com/koomen/erga", branch: "main" },
    pagesWorker: true,
    keepable: true,
    accounts: [account("koomen", { admin: true }), account("ada", { emails: ["ada@example.com"] }), account("bo")],
  };
  /** The state after the command's looks: one look, and one more when the flow filled an answer. */
  const at = (args: string[], s: Partial<Seen>) => run(options(...args).answers, s, s);

  // No option that changes it: it is done, as before.
  expect(at(base, was).state).toEqual({ at: "done" });

  // To single sign-on. GitHub's sign-in gave no address: without one for an admin, nobody is the admin after it.
  expect(at(to, was).state).toEqual({
    at: "stop",
    why: `With single sign-on, a person takes their account by their email address at the organization's sign-in, and Erga has no address for an admin of ${HOST} (GitHub's sign-in gives none). Without one, nobody is its admin after the move. Add --keep <username>=<address> for an admin (koomen), and for each other account that its person keeps.`,
  });
  // With the admin's address: the rows first (the release that runs knows them). Ada's sign-in before verified one address.
  const keep = [...to, "--keep", "koomen=pete@example.com"];
  const rows = [
    { login: "koomen", email: "pete@example.com" },
    { login: "ada", email: "ada@example.com" },
  ];
  expect(at(keep, was).state).toEqual({ at: "keep", rows });
  expect(keepsOf(options(...keep).answers, was).by).toEqual({ koomen: "given", ada: "verified", bo: "none" });
  // Then the move: the sign-in's settings, the defaults, and the pages.
  const kept = {
    ...was,
    accounts: [
      account("koomen", { admin: true, keeps: "pete@example.com" }),
      account("ada", { emails: ["ada@example.com"], keeps: "ada@example.com" }),
      account("bo"),
    ],
  };
  expect(at(keep, kept).state).toEqual({ at: "move", vars: ["SSO", "SERVER_DEFAULTS"], pages: "example-pages.com" });
  // A release from before such rows: the move first, then the rows.
  expect(at(keep, { ...was, keepable: false }).state).toEqual({ at: "move", vars: ["SSO", "SERVER_DEFAULTS"], pages: "example-pages.com" });
  const onDomain = {
    version: "abc123",
    healthy: true,
    signIn: "ok" as const,
    sso: varsOf(options(...to).answers, undefined).SSO,
    pages: "example-pages.com",
  };
  const moved = { ...kept, vars: varsOf(options(...to).answers, undefined), pages: "example-pages.com", live: onDomain };
  expect(at(keep, { ...moved, accounts: was.accounts }).state).toEqual({ at: "keep", rows });
  // Then the Worker of the shared address goes (only when the server is healthy on the domain), and the run is done.
  expect(at(keep, moved).state).toEqual({ at: "old-pages" });
  expect(at(keep, { ...moved, live: { ...onDomain, healthy: false } }).state).toEqual({ at: "done" });
  expect(at(keep, { ...moved, pagesWorker: false }).state).toEqual({ at: "done" });

  // After the move, a run that leaves the sign-in out changes nothing: its answers are the instance's own.
  const after = at(base, { ...moved, pagesWorker: false });
  expect([after.state, after.answers.signIn, after.answers.team, after.answers.aud, after.answers.pages]).toEqual([
    { at: "done" },
    "sso",
    "acme",
    TAG,
    "example-pages.com",
  ]);
  // A later run gives another account its person: only that row is new.
  expect(at([...base, "--keep", "bo=bo@example.com"], { ...moved, pagesWorker: false }).state).toEqual({
    at: "keep",
    rows: [{ login: "bo", email: "bo@example.com" }],
  });
  // An account whose person signed in at the organization's sign-in is theirs: it needs no row.
  const signedIn = {
    ...moved,
    pagesWorker: false,
    accounts: [account("koomen", { admin: true, sso: true }), account("ada", { sso: true, emails: ["ada@example.com"] }), account("bo")],
  };
  expect(at(base, signedIn).state).toEqual({ at: "done" });
  expect(at([...base, "--keep", "koomen=pete@example.com"], signedIn).state).toEqual({
    at: "stop",
    why: "koomen signs in with the organization's sign-in already: leave its --keep out.",
  });
  // Another Access application (a new tag): the setting changes, and nothing else.
  expect(at([...base, "--sign-in", "sso", "--team", "acme", "--aud", "e".repeat(64)], signedIn).state).toEqual({
    at: "move",
    vars: ["SSO"],
    pages: null,
  });

  // Only the pages: from the shared address to a domain, with the sign-in as it is.
  expect(at([...base, "--pages", "example-pages.com"], was).state).toEqual({ at: "move", vars: [], pages: "example-pages.com" });
  // The pages move one way only.
  expect(at([...base, "--pages", "other-pages.com"], moved).state).toEqual({
    at: "stop",
    why: `The documents' pages of ${HOST} are on example-pages.com. Setup moves the pages only from the shared workers.dev address to a domain: give --pages example-pages.com, as it is.`,
  });
  // A domain that the account does not have, as for a new instance.
  expect(at([...base, ...sso, "--pages", "nowhere.example", "--keep", "koomen=pete@example.com"], was).state).toEqual({
    at: "stop",
    why: "nowhere.example isn't a domain of this Cloudflare account: the pages need a whole domain of their own. Give another --pages.",
  });

  // What it tracks is bun erga track's, and its account is its entry's: an option that names another stops the run.
  expect(at([...base, "--branch", "main"], was).state).toEqual({ at: "done" });
  expect(at([...base, "--branch", "staging"], was).state).toEqual({
    at: "stop",
    why: `${HOST} tracks main of github.com/koomen/erga, and it has an admin: setup does not change what it tracks. Leave --repo and --branch out; bun erga track ${HOST} changes them.`,
  });
  expect(at([...base, "--account", "b".repeat(32)], was).state).toEqual({
    at: "stop",
    why: `${HOST} is in the Cloudflare account ${ADA}, as its entry says: leave --account out.`,
  });

  // --keep: an account of the instance, one time, one address for one person; and only with single sign-on.
  const stops = (...more: string[]) => (at([...to, ...more], was).state as { why?: string }).why;
  expect(stops("--keep", "cy=cy@example.com")).toBe(
    `${HOST} has no account cy: its accounts are koomen, ada, bo. Give --keep an account's username.`
  );
  expect(stops("--keep", "koomen=a@example.com", "--keep", "koomen=b@example.com")).toBe(
    "--keep names koomen 2 times: an account keeps one person."
  );
  expect(stops("--keep", "koomen=a@example.com", "--keep", "bo=a@example.com")).toBe(
    "--keep gives a@example.com to koomen and to bo: one address is one person's."
  );
  expect(at([...base, "--keep", "koomen=pete@example.com"], was).state).toEqual({
    at: "stop",
    why: `--keep goes with single sign-on, where an account keeps its person by their address, and ${HOST} signs people in with GitHub or Google: leave --keep out, or give --sign-in sso with its options.`,
  });
  // An address that two accounts verified is no one account's; --keep says whose it is.
  const twins = {
    ...was,
    accounts: [
      account("koomen", { admin: true }),
      account("ada", { emails: ["a@example.com"] }),
      account("ada2", { emails: ["a@example.com"] }),
    ],
  };
  expect(keepsOf(options(...keep).answers, twins).by).toEqual({ koomen: "given", ada: "none", ada2: "none" });
  expect(keepsOf(options(...keep, "--keep", "ada2=a@example.com").answers, twins).by).toEqual({
    koomen: "given",
    ada: "none",
    ada2: "given",
  });
  // A release that can't keep an account yet, on an instance with single sign-on: a newer release first.
  expect(at([...base, "--keep", "bo=bo@example.com"], { ...moved, pagesWorker: false, keepable: false }).state).toEqual({
    at: "stop",
    why: `The release that ${HOST} runs can't keep an account for its person yet (its database has no place for it). Deploy a newer release first (bun erga deploy ${HOST}), then run this again.`,
  });

  // The dry run's plan: each change, the person's steps at Cloudflare in their order, and each account, by username only.
  const again = `bun erga setup ${HOST} ${keep.join(" ")}`;
  const plan = moveText(at(keep, was).answers, seen(was), { worker: "erga-example-com", again });
  expect(plan).toEqual([
    `${HOST} runs, with an admin. I will change it as you chose. Its accounts and its documents stay:`,
    `• sign-in: from GitHub or Google sign-in to your organization's sign-in, with Cloudflare Access in front of ${HOST} (the team acme). After the deploy, Erga takes only a request with Access's proof for the application with your Audience tag. GitHub and Google sign-in stop`,
    `• before I deploy, the Access application must be in front of ${HOST}: with none, or with a wrong Audience tag, nobody comes in until a run again with the right one. The steps, in Cloudflare Zero Trust, in this order: 1. Add a self-hosted Access application for ${HOST}, with the policy that lets your people in. It may go in front of a server that runs: people pass Access first, then sign in as before. 2. Add a second Access application for these paths of ${HOST}, with one policy (Bypass, Everyone): /_edge/vouch, /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server, /oauth/token, /oauth/register, /mcp. They carry no Access sign-in (agents use them), and Erga checks its own tokens there. 3. Copy the Audience tag (AUD) of the first application: it is --aud. The team's name, the part before .cloudflareaccess.com, is --team.`,
    `• the documents' pages: from the shared workers.dev address to example-pages.com, each document on a subdomain of its own. A document keeps its address on ${HOST}. I delete the Worker of the old address (erga-example-com-pages): that address answers no more, and a page that is open there must be loaded again`,
    `• the settings' defaults: Anyone's level becomes "none", and sharing with anyone with the link is off. A setting that an admin set on the server stays as it is`,
    "• its 3 accounts: with single sign-on a person is known by their email address there. Each person takes their account at their first sign-in:",
    "  - by the address that you gave (--keep): koomen (an admin)",
    "  - by the address that Google verified at their sign-in before: ada",
    `  - with no address: bo. Erga has none for them (GitHub's sign-in gives none). Each stays, with its documents, and nobody signs in to it until a run gives its person's address: ${again} --keep <username>=<address>`,
    "• who may come in stays as the server's Access page says (/admin/access): a person of your organization who has no account comes in only when an admin adds them there, or sets Anyone's level",
    `• I write the change into this clone's entry of ${HOST}, and deploy the newest commit of the branch that it tracks`,
  ]);
  // An address that the database holds, and the user did not type, is not in the output.
  expect(plan.join("\n")).not.toContain("ada@example.com");
});

test("an instance with no admin yet: --pages and --branch are answers too, and --keep has no account to keep", () => {
  const CF2 = { ...CF, zones: ["example.com", "example-pages.com"] };
  const a = options("--host", "cloudflare", "--deploys", "local").answers;
  const built = {
    ...CF2,
    ...LIVE,
    vars: varsOf(a, undefined),
    pages: "shared",
    tracks: { repo: a.repo, branch: a.branch },
    pagesWorker: true,
  };
  expect(run(a, CF2, built).state).toEqual({ at: "page" });
  // The pages to a domain: the entry and a deploy, then the Worker of the shared address goes, then the setup page.
  const pages = options("--host", "cloudflare", "--deploys", "local", "--pages", "example-pages.com").answers;
  expect(run(pages, CF2, built).state).toEqual({ at: "update", vars: [], pages: "example-pages.com" });
  const onDomain = {
    ...built,
    pages: "example-pages.com",
    live: { version: "abc123", healthy: true, signIn: "ok" as const, sso: "", pages: "example-pages.com" },
  };
  expect(run(pages, CF2, onDomain).state).toEqual({ at: "old-pages" });
  expect(run(pages, CF2, { ...onDomain, pagesWorker: false }).state).toEqual({ at: "page" });
  // Back to the shared address is no move that setup makes.
  expect(run(a, CF2, { ...built, pages: "example-pages.com" }).state).toMatchObject({ at: "stop" });
  // A branch that the run names, and the entry does not track.
  const staging = options("--host", "cloudflare", "--deploys", "local", "--branch", "staging").answers;
  expect(run(staging, CF2, built).state).toEqual({ at: "update", vars: [], tracks: true });
  expect(run(options("--host", "cloudflare", "--deploys", "local", "--keep", "ada=ada@example.com").answers, CF2, built).state).toEqual({
    at: "stop",
    why: `${HOST} has no admin yet, so it has no account that keeps its person: leave --keep out.`,
  });
});

test("the entry of an instance that moves keeps all that the answers do not change", () => {
  const a = options(
    "--host",
    "cloudflare",
    "--deploys",
    "local",
    "--sign-in",
    "sso",
    "--team",
    "acme",
    "--aud",
    "f".repeat(64),
    "--pages",
    "example-pages.com"
  ).answers;
  const made = setupEntry(
    { ...noAnswers(HOST), where: "cloudflare", account: ADA, repo: "github.com/ada/erga", branch: "live" },
    { zones: ["example.com"], subdomain: "ada" }
  );
  const had: CloudflareEntry = {
    ...made,
    upstream: { repo: "github.com/koomen/erga", branch: "main" },
    domains: ["docs.example.org"],
    vars: { ...made.vars, OTHER: "x" },
  };
  const ALL = { vars: ["GITHUB_CLIENT_ID", "SSO", "SERVER_DEFAULTS"], pages: "example-pages.com" };
  expect(movedEntry(had, a, ALL)).toEqual({
    host: HOST,
    repo: "github.com/ada/erga",
    branch: "live",
    upstream: { repo: "github.com/koomen/erga", branch: "main" },
    account: ADA,
    worker: "erga-example-com",
    database: "erga-example-com",
    app: { kind: "domain", zoneName: "example.com", hostname: HOST },
    pages: { kind: "zone", zoneName: "example-pages.com" },
    domains: ["docs.example.org"],
    vars: {
      GITHUB_CLIENT_ID: "",
      OTHER: "x",
      SSO: `{"access":{"team":"acme","aud":"${"f".repeat(64)}"}}`,
      SERVER_DEFAULTS: '{"anyone_access":"none","public_sharing":false,"delete_docs_after_hours":null}',
    },
  });
  // Only the sign-in changes: the pages, and the subdomain that their shared address needs, stay.
  const signIn = movedEntry(had, a, { ...ALL, pages: null });
  expect([signIn.pages, signIn.subdomain]).toEqual([{ kind: "shared" }, "ada"]);
  // Only the pages change: no setting changes, whatever the answers would give a new instance. Pages that stay keep
  // each value of their own (a zone's id, a domain under the zone).
  const closed = { ...had, vars: { ...had.vars, SERVER_DEFAULTS: '{"anyone_access":"none","public_sharing":false,"max_project_gb":9}' } };
  const pages = movedEntry(closed, { ...a, signIn: "" }, { vars: [], pages: "example-pages.com" });
  expect([pages.vars, pages.pages]).toEqual([closed.vars, { kind: "zone", zoneName: "example-pages.com" }]);
  const own = { ...closed, pages: { kind: "zone" as const, zoneId: "z1", zoneName: "example-pages.com", domain: "p.example-pages.com" } };
  expect(movedEntry(own, a, { vars: ["SSO"], pages: null }).pages).toEqual(own.pages);
  // The sign-in decides two of the defaults: a default that a person put in the entry stays.
  expect(JSON.parse(movedEntry(closed, a, { ...ALL, pages: null }).vars.SERVER_DEFAULTS)).toEqual({
    anyone_access: "none",
    public_sharing: false,
    delete_docs_after_hours: null,
    max_project_gb: 9,
  });
});

test("a move that did not end, and an entry that differs from the release: the run ends the move, or stops; it never deletes the pages' Worker from the entry alone", () => {
  const CF2 = { ...CF, zones: ["example.com", "example-pages.com"] };
  const base = ["--host", "cloudflare", "--deploys", "local"];
  const TAG = "f".repeat(64);
  const to = [...base, "--sign-in", "sso", "--team", "acme", "--aud", TAG, "--pages", "example-pages.com"];
  const SSO = `{"access":{"team":"acme","aud":"${TAG}"}}`;
  const at = (args: string[], s: Partial<Seen>) => run(options(...args).answers, s, s).state;
  // The entry says that the move is done (a run wrote it, and its deploy did not end): the release still has the
  // sign-in from before, and the pages on the shared address, whose Worker is in the account.
  const entry = {
    ...CF2,
    admin: true,
    vars: varsOf(options(...to).answers, undefined),
    pages: "example-pages.com",
    entryAccount: ADA,
    tracks: { repo: "github.com/koomen/erga", branch: "main" },
    pagesWorker: true,
    keepable: true,
    accounts: [{ login: "koomen", admin: true, sso: false, emails: [], keeps: "pete@example.com" }],
  };
  const stale = { ...entry, live: { version: "abc123", healthy: true, signIn: "ok" as const, sso: "", pages: "shared" } };
  // The same options again end the move: a deploy of the entry. The pages' Worker stays until the release has the domain.
  expect(at(to, stale)).toEqual({ at: "move", vars: ["SSO"], pages: "example-pages.com" });
  // A run with none of those options deploys nothing, and says why.
  expect(at(base, stale)).toEqual({
    at: "stop",
    why: `This clone's entry of ${HOST} has the single sign-on setting and the documents' pages (example-pages.com), and the release that runs does not: a run of setup did not end, or the entry changed by hand. Run setup again with the options of that change (it deploys the entry), or deploy the entry as it is: bun erga deploy ${HOST} --write-spec.`,
  });
  // The release has them: now the Worker of the old address goes.
  expect(at(to, { ...entry, live: { version: "abc123", healthy: true, signIn: "ok", sso: SSO, pages: "example-pages.com" } })).toEqual({
    at: "old-pages",
  });
  // With no admin yet: an update of the pages that did not end deploys again, before the Worker goes.
  const a = options(...base, "--pages", "example-pages.com").answers;
  const fresh = { ...CF2, vars: varsOf(a, undefined), pages: "example-pages.com", pagesWorker: true };
  expect(run(a, CF2, { ...fresh, live: { version: "abc123", healthy: true, signIn: "ok", sso: "", pages: "shared" } }).state).toEqual({
    at: "build",
  });
  expect(
    run(a, CF2, { ...fresh, live: { version: "abc123", healthy: true, signIn: "ok", sso: "", pages: "example-pages.com" } }).state
  ).toEqual({
    at: "old-pages",
  });
});

test("an instance with an admin and single sign-on: a run with no sign-in option deploys nothing, and another organization's sign-in is no move", () => {
  const CF2 = { ...CF, zones: ["example.com", "example-pages.com"] };
  const base = ["--host", "cloudflare", "--deploys", "local"];
  const TAG = "f".repeat(64);
  const at = (args: string[], s: Partial<Seen>) => run(options(...args).answers, s, s).state;
  const runs = {
    ...CF2,
    ...LIVE,
    admin: true,
    pages: "example-pages.com",
    entryAccount: ADA,
    tracks: { repo: "github.com/koomen/erga", branch: "main" },
    keepable: true,
    accounts: [{ login: "koomen", admin: true, sso: true, emails: [], keeps: null }],
  };
  // The entry's setting as another text (its keys in another order, a registered instance's): no change that the user chose.
  const access = { ...runs, vars: { SSO: `{"access":{"aud":"${TAG}","team":"acme"}}` } };
  expect(at(base, access)).toEqual({ at: "done" });
  // Another application of the same team: the setting changes. Another team: the accounts would have no person.
  expect(at([...base, "--sign-in", "sso", "--team", "acme", "--aud", "e".repeat(64)], access)).toEqual({
    at: "move",
    vars: ["SSO"],
    pages: null,
  });
  const other = `${HOST} signs people in at the Cloudflare Zero Trust team acme, and each account is known by its person's id there. Setup does not move it to another organization's sign-in: the accounts would have no person. It changes the Access application (--aud) of the same team, or the client (--client) of the same issuer.`;
  expect(at([...base, "--sign-in", "sso", "--team", "other", "--aud", TAG], access)).toEqual({ at: "stop", why: other });
  expect(at([...base, "--sign-in", "sso", "--issuer", "https://idp.example.com", "--client", "c"], { ...access, app: true })).toEqual({
    at: "stop",
    why: other,
  });
  // An issuer: its endpoints as it publishes them now, or an issuer that does not answer, are no answer of a run that names no sign-in.
  const oidc = {
    ...runs,
    app: true,
    vars: {
      SSO: '{"oidc":{"issuer":"https://idp.example.com","authorize":"https://idp.example.com/a","token":"https://idp.example.com/t","client":"c"}}',
    },
  };
  expect(at(base, { ...oidc, oidc: { authorize: "https://idp.example.com/authorize2", token: "https://idp.example.com/t" } })).toEqual({
    at: "done",
  });
  expect(at(base, { ...oidc, oidc: { why: "https://idp.example.com does not answer." } })).toEqual({ at: "done" });
  expect(at([...base, "--pages", "example-pages.com"], { ...oidc, oidc: { why: "https://idp.example.com does not answer." } })).toEqual({
    at: "done",
  });
});
