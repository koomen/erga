// bun erga setup: the flow (deploy/own/flow.ts), the answers and what follows from them (plan.ts), and the Setup tab
// (view.ts). All pure: each test sends the flow its events (an answer, what was seen), as the command and the page do.
import { expect, test } from "bun:test";
import {
  type Effect,
  effectOf,
  type Event,
  type Flow,
  nothingSeen,
  partsAfter,
  progress,
  type Seen,
  step,
  stepsOf,
} from "../deploy/own/flow";
import { firstRows, githubManifest, namesOf, noAnswers, parseAnswer, proxySetting, setupEntry, varsOf } from "../deploy/own/plan";
import { newSetup, type Setup } from "../deploy/own/store";
import { setupHtml } from "../deploy/own/view";

const HOST = "erga.example.com";
const start = (): Flow => ({ answers: noAnswers(HOST), seen: nothingSeen, state: { at: "where" } });
/** Sends the events, in order: the flow after them, the last effect, and each refusal. */
function send(flow: Flow, ...events: Event[]) {
  let effect: Effect = effectOf(flow);
  const problems: string[] = [];
  for (const e of events) {
    const r = step(flow, e);
    flow = r.flow;
    effect = r.effect;
    if (r.problem) problems.push(r.problem);
  }
  return { flow, effect, problems };
}
const set = (key: keyof Flow["answers"], value: string): Event => ({ type: "set", key, value });
const seen = (s: Partial<Seen>): Event => ({ type: "seen", seen: { ...nothingSeen, ...s } });
/** A Cloudflare login with one account that holds example.com. */
const CF: Partial<Seen> = {
  login: { ok: true },
  choices: [{ id: "a".repeat(32), name: "Ada Lovelace" }],
  zones: ["example.com"],
  account: "a".repeat(32),
};
const AWS: Partial<Seen> = {
  login: { ok: true },
  choices: [{ id: "work", name: "444455556666" }],
  zones: ["example.com"],
  account: "444455556666",
  region: "us-west-2",
};
const LIVE: Partial<Seen> = { live: { version: "abc123", healthy: true, signIn: "ok" } };
const text = (e: Effect) => (e.do == "ask" ? e.text.join("\n") : "text" in e ? e.text : "");
const view = (flow: Flow, more: Partial<Setup> = {}) => setupHtml({ ...newSetup(HOST), flow, ...more });
const words = (html: string) => html.replace(/<[^>]+>/g, " ");

test("the answers are read as the person gives them, and a bad one says why", () => {
  expect(parseAnswer("where", "AWS")).toEqual({ value: "aws" });
  expect(parseAnswer("signIn", "sso")).toEqual({ value: "sso" });
  expect(parseAnswer("team", "Acme.cloudflareaccess.com")).toEqual({ value: "acme" });
  expect(parseAnswer("issuer", "https://idp.example.com/pool/")).toEqual({ value: "https://idp.example.com/pool" });
  expect(parseAnswer("company", "Acme.com")).toEqual({ value: "acme.com" });
  expect(parseAnswer("egress", "vpc-0a1/subnet-0b2")).toEqual({ value: "vpc-0a1/subnet-0b2" });
  for (const [key, bad] of [
    ["where", "azure"],
    ["signIn", "oauth"],
    ["issuer", "http://idp.example.com"],
    ["region", "west"],
    ["aud", "short"],
    ["confirm", "ok"],
    ["host", "erga"],
  ] as const)
    expect("problem" in parseAnswer(key, bad)).toBe(true);
});

test("an instance's names: its entry's when it has one, whatever they are; a new instance's from its address", () => {
  expect(namesOf(HOST)).toEqual({
    worker: "erga-example-com",
    database: "erga-example-com",
    bucket: "erga-example-com-files",
    pagesWorker: "erga-example-com-pages",
  });
  expect(namesOf("erga.dev", { worker: "erga", database: "erga" }).pagesWorker).toBe("erga-pages");
});

test("the main path asks three questions, one at a time, and each step has one actor", () => {
  // Where it runs comes first: nothing is assumed, and no login is asked before it.
  let { flow, effect } = send(start());
  expect(flow.state).toEqual({ at: "where" });
  expect(text(effect)).toBe(
    "Where should Erga run?\n1. Cloudflare (recommended): the Workers Paid plan, $5 a month.\n2. AWS: in your own AWS account."
  );
  expect(effect).toMatchObject({
    do: "ask",
    answer: [`bun erga setup ${HOST} set where=cloudflare    (1)`, `bun erga setup ${HOST} set where=aws    (2)`],
  });
  expect(stepsOf(flow).map((s) => [s.title, s.who, s.state])).toEqual([
    ["Where it runs", "answer", "now"],
    ["Connect your account", "you", "blocked"],
    ["Who signs in", "answer", "blocked"],
    ["Review the plan", "answer", "blocked"],
    ["GitHub App", "you", "blocked"],
    ["Build", "agent", "blocked"],
    ["Become the admin", "you", "blocked"],
  ]);
  // The answer changes what there is to see: the owner looks.
  ({ flow, effect } = send(flow, set("where", "cloudflare")));
  expect(effect).toEqual({ do: "look" });
  // Not logged in: the command runs the login, and the person finishes it in the browser.
  ({ flow, effect } = send(flow, seen({ login: { ok: false, why: "Not logged in to Cloudflare." } })));
  expect([flow.state, effect]).toEqual([
    { at: "connect", need: "login", why: "Not logged in to Cloudflare." },
    { do: "login", where: "cloudflare" },
  ]);
  // One account holds the domain: no question; the flow takes it, and looks at that account.
  ({ flow, effect } = send(flow, seen({ ...CF, zones: [], account: "" })));
  expect([flow.answers.account, effect]).toEqual(["a".repeat(32), { do: "look" }]);
  ({ flow, effect } = send(flow, seen(CF)));
  expect(flow.state).toEqual({ at: "who", need: "signIn" });
  expect(text(effect)).toStartWith(`Who may sign in to ${HOST}?\n1. Only people you invite (recommended)\n2. Anyone in your company`);
  ({ flow, effect } = send(flow, set("signIn", "invite")));
  expect(flow.state).toEqual({ at: "review" });
  expect(text(effect)).toContain(`I will make Erga at ${HOST}, in the Cloudflare account Ada Lovelace:`);
  expect(text(effect)).toEndWith("Shall I make it?");
  // Nothing is made before the yes: no build, no wait for the page.
  expect(effect.do).toBe("ask");
  ({ flow, effect } = send(flow, set("confirm", "yes")));
  expect([flow.state, effect.do]).toEqual([{ at: "app", kind: "github" }, "wait"]);
  expect(text(effect)).toContain("click Create the GitHub App on GitHub");
  // The page made the app: the command, which waited, builds by itself. The person never says "done".
  ({ flow, effect } = send(flow, seen({ ...CF, app: true })));
  expect([flow.state, effect]).toEqual([{ at: "build" }, { do: "build" }]);
  ({ flow, effect } = send(flow, seen({ ...CF, app: true, ...LIVE })));
  expect([flow.state, effect.do]).toEqual([{ at: "admin" }, "wait"]);
  expect(text(effect)).toContain("That sign-in makes you the admin");
  ({ flow, effect } = send(flow, seen({ ...CF, app: true, ...LIVE, admin: "ada" })));
  expect([flow.state, effect]).toEqual([{ at: "done" }, { do: "done" }]);
  expect(progress(stepsOf(flow, "erga-app"))).toBe("Every step is done.");
  expect(stepsOf(flow, "erga-app").map((s) => s.detail)).toEqual([
    "Cloudflare",
    "Account Ada Lovelace",
    "People you invite",
    "You said yes",
    "The app erga-app",
    `Live at https://${HOST}, release abc123`,
    "ada is the admin",
  ]);
});

test("the connect step asks only what the code cannot find, and stops where only the person can go on", () => {
  const at = (s: Partial<Seen>) => send(start(), set("where", "cloudflare"), seen(s));
  // Two accounts hold the domain: one question, with each account.
  const two = at({
    login: { ok: true },
    choices: [
      { id: "a".repeat(32), name: "Acme Inc" },
      { id: "b".repeat(32), name: "Ada Lovelace" },
    ],
  });
  expect(two.flow.state).toEqual({ at: "connect", need: "choose" });
  expect(text(two.effect)).toBe(
    "example.com is on 2 of your Cloudflare accounts. Which one should hold Erga?\n1. Acme Inc\n2. Ada Lovelace"
  );
  expect(two.effect).toMatchObject({
    answer: [expect.stringContaining(`set account=${"a".repeat(32)}`), expect.stringContaining(`set account=${"b".repeat(32)}`)],
  });
  // No account has the domain, or the address is in use: the person decides.
  const none = at({ login: { ok: true } });
  expect(none.effect).toMatchObject({ do: "stop", text: expect.stringContaining("None of your Cloudflare accounts has the domain") });
  const taken = send(start(), set("where", "cloudflare"), seen(CF), seen({ ...CF, taken: "DNS has A 192.0.2.1 for it" }));
  expect(taken.effect).toEqual({
    do: "stop",
    text: `${HOST} is in use: DNS has A 192.0.2.1 for it. Free it, or set up another address: bun erga setup <address>.`,
  });
  expect(stepsOf(taken.flow)[1]).toMatchObject({ state: "now", who: "you" });
});

test("a new answer opens what it decides again, and a yes holds only for the plan it was said to", () => {
  let { flow } = send(start(), set("where", "cloudflare"), seen(CF), seen(CF), set("signIn", "company"));
  expect(flow.state).toEqual({ at: "who", need: "company" });
  ({ flow } = send(flow, set("company", "acme-inc"), set("confirm", "yes")));
  expect(flow.state).toEqual({ at: "app", kind: "github" });
  // Another answer after the yes: the plan is another one, so the review asks again.
  ({ flow } = send(flow, set("company", "acme.com")));
  expect(flow.state).toEqual({ at: "review" });
  // Another sign-in forgets the company; another host forgets the account and the sign-in.
  ({ flow } = send(flow, set("signIn", "sso")));
  expect([flow.answers.company, flow.state]).toEqual(["", { at: "who", need: "team" }]);
  const moved = send(flow, set("where", "aws"));
  expect([moved.flow.answers.account, moved.flow.answers.signIn, moved.effect]).toEqual(["", "", { do: "look" }]);
  // A yes before there is a plan, the host, and a bad value are refused, and change nothing.
  const refused = send(start(), set("confirm", "yes"), set("host", "other.example.com"), set("where", "moon"));
  expect(refused.problems).toEqual([
    "There is no plan to say yes to yet.",
    "The address is the command's: bun erga setup <address>.",
    "where is cloudflare or aws.",
  ]);
  expect(refused.flow).toEqual(start());
});

test("who may sign in is one question: the settings, the access rule and the app step follow from it", () => {
  const a = (signIn: string, more = {}) => ({ ...noAnswers(HOST), where: "cloudflare" as const, signIn: signIn as "invite", ...more });
  // People you invite: public sharing as a website has it, no rule.
  expect(JSON.parse(varsOf(a("invite"), "Iv1.x").SERVER_DEFAULTS)).toEqual({ public_sharing: true, delete_docs_after_hours: null });
  expect(firstRows(a("invite"))).toEqual([]);
  // A company: nothing opens for people who are not signed in; its organization (or Workspace domain) may write.
  expect(JSON.parse(varsOf(a("company"), "Iv1.x").SERVER_DEFAULTS).public_sharing).toBe(false);
  expect(firstRows(a("company", { company: "acme-inc" }), 5)).toEqual([
    {
      table: "access_rules",
      row: { kind: "github_org", value: "acme-inc", access: "write", created: 5 },
      onConflict: "(kind, value) DO UPDATE SET access = 'write'",
    },
  ]);
  expect(firstRows(a("company", { company: "acme.com" }))[0].row).toMatchObject({ kind: "workspace", value: "acme.com" });
  // No row names an admin: the person who opens the setup page's link becomes it.
  expect(JSON.stringify([firstRows(a("company", { company: "acme-inc" })), firstRows(a("sso"))])).not.toContain("admin");
  // Single sign-on on Cloudflare: the team is asked, the Audience tag is the page's; no GitHub App anywhere.
  let { flow, effect } = send(start(), set("where", "cloudflare"), seen(CF), seen(CF), set("signIn", "sso"));
  expect(text(effect)).toBe("What is your Cloudflare Zero Trust team name? It is the part before .cloudflareaccess.com.");
  ({ flow, effect } = send(flow, set("team", "acme"), set("confirm", "yes")));
  expect([flow.state, effect.do]).toEqual([{ at: "app", kind: "access" }, "wait"]);
  expect(stepsOf(flow).map((s) => s.title)).toEqual([
    "Where it runs",
    "Connect Cloudflare",
    "Who signs in",
    "Review the plan",
    "Single sign-on",
    "Build",
    "Become the admin",
  ]);
  const page = view(flow);
  expect(page).toContain('<form method="post" action="/setup/aud">');
  expect(page).toContain("Bypass policy");
  expect(page).not.toContain("GitHub");
  ({ flow, effect } = send(flow, set("aud", "f".repeat(64))));
  expect([flow.state, effect]).toEqual([{ at: "build" }, { do: "build" }]);
  expect(varsOf(flow.answers, "Iv1.unused")).toMatchObject({
    GITHUB_CLIENT_ID: "",
    PROXY_SIGN_IN: JSON.stringify({ kind: "cloudflare-access", team: "acme", aud: "f".repeat(64) }),
  });
  expect(firstRows(flow.answers)[0].row).toMatchObject({ kind: "everybody", value: "", access: "write" });
  expect(proxySetting(a("invite"))).toBeNull();
});

test("AWS is a lane of its own: the profile, the stack as the plan, and the company's sign-in", () => {
  // One profile: no question. Its region comes from the profile.
  let { flow, effect } = send(start(), set("where", "aws"), seen({ choices: AWS.choices }));
  expect([flow.answers.profile, effect]).toEqual(["work", { do: "look" }]);
  ({ flow, effect } = send(flow, seen({ ...AWS, login: { ok: false, why: "Not logged in to AWS with the profile work" } })));
  expect([flow.answers.region, effect]).toEqual(["us-west-2", { do: "look" }]);
  ({ flow, effect } = send(flow, seen({ ...AWS, login: { ok: false, why: "Not logged in to AWS with the profile work" } })));
  expect(effect).toEqual({ do: "login", where: "aws" });
  ({ flow, effect } = send(flow, seen(AWS)));
  expect(flow.state).toEqual({ at: "who", need: "signIn" });
  // More than one profile: one question.
  const two = send(
    start(),
    set("where", "aws"),
    seen({
      choices: [
        { id: "default", name: "111122223333" },
        { id: "work", name: "" },
      ],
    })
  );
  expect(text(two.effect)).toBe("Which AWS profile should hold Erga?\n1. default (account 111122223333)\n2. work");
  // Single sign-on: the issuer and the client ID are asked; the client's secret is the page's alone.
  ({ flow, effect } = send(flow, set("signIn", "sso")));
  expect(text(effect)).toStartWith("What is the issuer URL of your company's sign-in");
  ({ flow, effect } = send(flow, set("issuer", "https://idp.example.com/pool")));
  expect(text(effect)).toContain(`https://${HOST}/oauth2/idpresponse`);
  ({ flow, effect } = send(flow, set("client", "client-1")));
  expect(flow.state).toEqual({ at: "review" });
  expect(text(effect)).toContain(`in your AWS account 444455556666 (profile work, region us-west-2), as one CloudFormation stack:`);
  expect(text(effect)).toContain(`• the documents' pages on pages.${HOST}`);
  expect(
    view({
      ...flow,
      seen: { ...flow.seen, stack: { status: null, outputs: {}, resources: ["Machine (AWS::EC2::Instance)"], applied: false } },
    })
  ).toContain("<li>Machine (AWS::EC2::Instance)</li>");
  ({ flow, effect } = send(flow, set("confirm", "yes")));
  expect([flow.state, effect.do]).toEqual([{ at: "app", kind: "oidc" }, "wait"]);
  expect(text(effect)).toContain("It goes to AWS Secrets Manager, never to me.");
  expect(view(flow)).toContain('<input id="s-secret" name="secret" type="password"');
  expect(stepsOf({ ...flow, state: { at: "build" } })[1].detail).toBe("Profile work, region us-west-2");
  // Without single sign-on, the pages need a whole zone of their own: one more question, and the app's own zone is refused.
  const cdn = send(start(), set("where", "aws"), seen({ choices: AWS.choices }), seen(AWS), seen(AWS), set("signIn", "invite"));
  expect(cdn.flow.state).toEqual({ at: "who", need: "pages" });
  const same = send(cdn.flow, set("pages", "example.com"));
  expect(same.flow.state).toMatchObject({ at: "who", need: "pages", why: expect.stringContaining("another domain than the app's") });
  const other = send(cdn.flow, seen({ ...AWS, zones: ["example.com", "example-pages.com"] }), set("pages", "example-pages.com"));
  expect(other.flow.state).toEqual({ at: "review" });
});

test("a staging instance takes the same steps: its primary's host and sign-in, an app of its own, and an approval at the end", () => {
  const answers = {
    ...noAnswers("staging.example.com"),
    stagingOf: HOST,
    where: "cloudflare" as const,
    account: "a".repeat(32),
    signIn: "invite" as const,
  };
  let { flow, effect } = send({ answers, seen: nothingSeen, state: { at: "where" } }, seen(CF));
  expect(flow.state).toEqual({ at: "review" });
  expect(text(effect)).toContain(`as a staging instance of ${HOST} (a copy of its data, for admins only)`);
  ({ flow, effect } = send(flow, set("confirm", "yes"), seen({ ...CF, app: true, ...LIVE })));
  expect(text(effect)).toContain("approve there as an admin");
  expect(stepsOf(flow).at(-1)).toMatchObject({ title: "Connect this page", who: "you", state: "now" });
  const entry = setupEntry(answers, {
    zones: ["example.com"],
    subdomain: "ada",
    github: "Iv1.staging",
    base: { SERVER_DEFAULTS: '{"public_sharing":false}' },
  });
  expect(entry).toMatchObject({ host: "staging.example.com", stagingOf: HOST, worker: "staging-example-com", token: "" });
  expect(entry.vars).toMatchObject({ GITHUB_CLIENT_ID: "Iv1.staging", SERVER_DEFAULTS: '{"public_sharing":false}' });
});

test("the entry comes from the answers alone, and the GitHub App's manifest has the callback and no permissions", () => {
  const answers = { ...noAnswers(HOST), where: "cloudflare" as const, account: "a".repeat(32), signIn: "invite" as const };
  expect(setupEntry(answers, { zones: ["example.com"], subdomain: null, github: "Iv1.ada" })).toEqual({
    host: HOST,
    account: "a".repeat(32),
    worker: "erga-example-com",
    database: "erga-example-com",
    subdomain: "erga-example-com",
    app: { kind: "domain", zoneName: "example.com", hostname: HOST },
    pages: { kind: "shared" },
    vars: { GITHUB_CLIENT_ID: "Iv1.ada", SERVER_DEFAULTS: '{"public_sharing":true,"delete_docs_after_hours":null}' },
    token: "",
  });
  expect(githubManifest(answers, "http://127.0.0.1:4801/setup/github/created")).toMatchObject({
    name: `Erga ${HOST}`,
    redirect_url: "http://127.0.0.1:4801/setup/github/created",
    callback_urls: [`https://${HOST}/auth/github/callback`],
    default_permissions: {},
    public: false,
  });
});

test("the Setup tab shows the open step alone: its question, its field, the build's parts, the admin's link", () => {
  const cf = send(start(), set("where", "cloudflare"), seen(CF), seen(CF)).flow;
  // The first page has its steps drawn, and one question: no field for an answer (the answer goes to the agent).
  const first = view(start());
  expect(words(first)).toContain("0 of 7 steps done. Next: Where it runs (you, to your agent).");
  expect(first).toContain('<ol class="s-opts"><li><b>Cloudflare</b> <span class="s-rec">Recommended</span>');
  expect(first).not.toContain("<input");
  expect(first.match(/class="s-n"/g)?.length).toBe(1);
  // The login is the person's step, with the person's words; the build is the agent's.
  const login = view(send(start(), set("where", "cloudflare"), seen({ login: { ok: false, why: "no" } })).flow);
  expect(login).toContain('<span class="s-t">Connect Cloudflare</span><span class="s-who person">You</span>');
  expect(words(login)).toContain("A Cloudflare tab is open. Sign in there, then click Allow.");
  expect(login).toContain('<span class="s-t">Build</span><span class="s-who ">Agent</span>');
  // The GitHub App: a button, and a field for an organization (no browser prompt).
  const app = send(cf, set("signIn", "invite"), set("confirm", "yes")).flow;
  expect(view(app)).toContain(
    '<form method="get" action="/setup/github/new"><p class="s-acts"><button class="s-btn">Create the GitHub App on GitHub</button>'
  );
  expect(view(app)).toContain('<input id="s-org" name="org" placeholder="Organization login"');
  expect(view(app, { problem: "GitHub didn't give the app's values: 404." })).toContain(
    '<p class="s-bad" role="alert">GitHub didn&#39;t give the app&#39;s values: 404.</p>'
  );
  // The build: each part as the log tells it, and why it stopped.
  const build = { ...app, state: { at: "build" as const } };
  const parts = [
    { title: "Build the code", at: 0, ms: 14_000 },
    { title: "Upload the Worker", at: 14_000, ms: null },
  ];
  expect(view(build, { build: { parts, failed: "" } })).toContain(
    '<li class="ok">Build the code<small>14 s</small></li><li class="run">Upload the Worker<small>working</small></li>'
  );
  expect(view(build, { build: { parts, failed: "The account has no Workers Paid plan." } })).toContain(
    '<li class="bad">Upload the Worker<small>stopped</small></li></ol><p class="s-bad" role="alert">The account has no Workers Paid plan.</p>'
  );
  // The admin's link is a button of the page, which goes through the page's own route: no address of the server in it.
  const admin = { ...app, state: { at: "admin" as const } };
  expect(view(admin)).toContain("Your agent&#39;s command makes the link.");
  expect(view(admin, { approve: "ABCD-EFGH" })).toContain(
    `<a class="s-btn" href="/setup/claim" target="_blank" rel="noopener">Open ${HOST} and sign in</a>`
  );
  expect(view(admin, { approve: "ABCD-EFGH" })).not.toContain("ABCD-EFGH");
  // Done: the card, and no step open.
  const done = view({ ...app, seen: { ...app.seen, admin: "ada" }, state: { at: "done" } });
  expect(done).toContain(`<h3>${HOST} is live</h3>`);
  expect(done).not.toContain('class="s-n"');
  // No text of any state shows a backtick, or the old flow's words.
  for (const html of [first, login, view(app), view(build), view(admin), done]) {
    expect(words(html)).not.toContain("`");
    expect(words(html)).not.toMatch(/bun erga setup \S+ (ask|start|status|token|preset)/);
  }
});

test("the build's parts come from its log: a line that ends in ... starts one, and its done line ends it", () => {
  let parts = partsAfter([], "Build the code...", 1000);
  parts = partsAfter(parts, "build: built 9cc056f30333: 100 bytes", 1500);
  parts = partsAfter(parts, "Build the code: done", 3000);
  parts = partsAfter(parts, "Make the database (D1)...", 3000);
  parts = partsAfter(parts, 'Make the database (D1): done, "erga" (85a6)', 5500);
  parts = partsAfter(parts, "erga-example-com: AWS makes the changes (CloudFront takes 5 to 15 minutes)...", 6000);
  parts = partsAfter(parts, "Wait for it to answer...", 6000);
  expect(parts).toEqual([
    { title: "Build the code", at: 1000, ms: 2000 },
    { title: "Make the database (D1)", at: 3000, ms: 2500 },
    { title: "Wait for it to answer", at: 6000, ms: null },
  ]);
  // A line that changes nothing gives the same list back: the owner writes only a change.
  expect(partsAfter(parts, "some other line", 7000)).toBe(parts);
});
