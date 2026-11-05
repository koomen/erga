// Who may use the server: the specific people are users, each with one role (server/directory/users.ts, people.ts:
// Admin, write, read; added by their GitHub or Google account before their first sign-in too), and the group rules
// (server/directory/access.ts: everybody, a Google Workspace organization by the hd claim, a GitHub organization; each
// none, read or write). A person gets the highest of their role and the rules that match them; none: they can't sign
// in. Admins always have write. On an in-memory database with D1's migrations, 0240's and 0250's translations included.

import { expect, test } from "bun:test";
import { Directory, type Vouched } from "../server/directory/index.ts";
import { resolve } from "../server/identity/accounts.ts";
import { memory } from "./helpers/memory-sql.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const ADMIN = { login: "koomen", admin: true };
const google = (sub: string, email: string, hd: string | null = null, verified = true): Vouched => ({ provider: "google", subject: sub, handle: email, name: null, emails: [{ email, verified }], hd });
const github = (id: number, login: string, orgs: string[] | null = null): Vouched => ({ provider: "github", subject: String(id), handle: login, name: null, emails: [], orgs });
/** The pretend GitHub's public users API: every login is an account (its id from its length and first letter), but no-such-*. */
const lookup = async (login: string) =>
  login.startsWith("no-such-") ? null : { id: String(1000 + login.length * 100 + login.charCodeAt(0)), login };
const fresh = () => new Directory(memory(), { admins: ["koomen"], github: lookup });
/** An account someone made at their first sign-in (no rule of its own). */
const joined = (dir: Directory, name: string, v: Vouched) => dir.identities.createAccount(name, v);
const everybody = async (dir: Directory, access: string) => dir.rules.change(ADMIN, (await dir.rules.list(ADMIN)).find((r) => r.kind == "everybody")!.id, access);
const accessOf = async (dir: Directory, login: string) => dir.accessOf((await dir.users.get(login))!);

test("0240 and 0250 translate the invite list: everybody none; each account on it a user with write; an invited email waits", async () => {
  const dir = new Directory(memory({ at: "0240", run: (db) => {
    db.exec("INSERT INTO users (login, name, role, created, added_by) VALUES ('ada', 'Ada', 'user', 1, 'koomen'), ('bo', 'Bo', 'admin', 2, NULL)");
    db.exec("INSERT INTO invites (email, role, created) VALUES ('cy@example.com', 'user', 3)");
  } }), { admins: ["koomen"] });
  const rules = (await dir.rules.list(ADMIN)).map((r) => `${r.kind}:${r.value}:${r.access}`);
  expect(rules).toEqual(["everybody::none"]);
  expect((await dir.users.get("ada"))?.access).toBe("write");
  expect(await dir.users.allowed("ada")).toBe(true);
  expect((await dir.people.list(ADMIN)).map((p) => `${p.provider}:${p.handle}:${p.role}`)).toEqual(["google:cy@example.com:write"]);
});

test("the highest access of the rules that match; none signs in nowhere; admins always write", async () => {
  const dir = fresh();
  await joined(dir, "dee", github(1, "dee", ["acme"]));
  expect(await accessOf(dir, "dee")).toBe("none");
  expect(await dir.users.allowed("dee")).toBe(false);
  await dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "read" });
  expect(await accessOf(dir, "dee")).toBe("read");
  expect(await dir.users.allowed("dee")).toBe(true);
  expect(await dir.mayWrite("dee")).toBe(false);
  await everybody(dir, "write");
  expect(await accessOf(dir, "dee")).toBe("write");
  await everybody(dir, "none");
  await dir.users.setUserRole(ADMIN, "dee", "write");
  expect(await accessOf(dir, "dee")).toBe("write");
  // Their role, and the groups: the higher of the two.
  await dir.users.setUserRole(ADMIN, "dee", "read");
  await dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "write" });
  expect(await accessOf(dir, "dee")).toBe("write");
  await dir.users.setUserRole(ADMIN, "dee", "none");
  await dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "none" });
  expect(await dir.users.allowed("dee")).toBe(false);
  expect(await accessOf(dir, "koomen")).toBe("write");
});

test("Google Workspace: the hd claim, never the email's domain; a personal account never matches", async () => {
  const dir = fresh();
  await dir.rules.add(ADMIN, { kind: "workspace", value: "Example.com", access: "write" });
  expect((await dir.rules.list(ADMIN)).some((r) => r.kind == "workspace" && r.value == "example.com")).toBe(true);
  expect(await dir.mayJoin(google("g1", "a@example.com", "example.com"))).toBe(true);
  // The email says example.com, but no hd: a personal account (or another Workspace's alias). No.
  expect(await dir.mayJoin(google("g2", "a@example.com"))).toBe(false);
  expect(await dir.mayJoin(google("g3", "a@gmail.com"))).toBe(false);
  expect(await dir.mayJoin({ ...github(4, "gh"), hd: "example.com" })).toBe(false);
  await joined(dir, "eve", google("g1", "eve@example.com", "example.com"));
  expect(await accessOf(dir, "eve")).toBe("write");
  // Her account leaves the Workspace (Google gives no hd now): her next sign-in records it, and she's refused.
  expect((await resolve(dir, google("g1", "eve@example.com"), { join: false })).kind).toBe("refused");
});

test("GitHub organizations: as GitHub answered at each sign-in, recorded on the identity", async () => {
  const dir = fresh();
  await dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "write" });
  expect(await dir.mayJoin(github(1, "fay", ["acme", "other"]))).toBe(true);
  expect(await dir.mayJoin(github(2, "gus", ["other"]))).toBe(false);
  expect(await dir.mayJoin(github(3, "hal", null))).toBe(false);
  await joined(dir, "fay", github(1, "fay", ["acme"]));
  expect(await resolve(dir, github(1, "fay", ["acme"]), { join: false })).toEqual({ kind: "in", login: "fay" });
  expect((await resolve(dir, github(1, "fay", []), { join: false })).kind).toBe("refused");
  expect((await dir.identities.find("github", "1"))?.orgs).toEqual([]);
});

test("users added before their first sign-in: a GitHub account by its id, a Google account by its verified email, then its sub", async () => {
  const dir = fresh();
  const join = async (name: string, v: Vouched) => {
    const { may, person } = await dir.joining(v);
    expect(may).toBe(true);
    return dir.identities.createAccount(name, v, person ? { role: person.role, waited: person.id } : {});
  };
  // GitHub: the login resolved to GitHub's id now; a login GitHub doesn't know is refused.
  const { person: jo } = await dir.addUser(ADMIN, { provider: "github", handle: "Jo" }, "read");
  expect(jo).toMatchObject({ provider: "github", handle: "jo", subject: String((await lookup("jo"))!.id), role: "read" });
  await expect(dir.addUser(ADMIN, { provider: "github", handle: "no-such-person" }, "read")).rejects.toThrow("GitHub has no account");
  // The id matches, whatever the login is now; the login on another account (it changed hands) doesn't.
  expect(await dir.mayJoin(github(9999, "jo"))).toBe(false);
  await join("joanna", github(Number(jo!.subject), "jo-renamed"));
  expect(await accessOf(dir, "joanna")).toBe("read");
  expect(await dir.people.list(ADMIN)).toEqual([]);
  // Google: the verified email, at the first sign-in; then only that sub.
  await dir.addUser(ADMIN, { provider: "google", handle: "ida@example.com" }, "write");
  expect(await dir.mayJoin(google("g-ida", "ida@example.com", null, false))).toBe(false);
  expect(await dir.mayJoin({ ...github(5, "ida"), emails: [{ email: "ida@example.com", verified: true }] })).toBe(false);
  expect(await dir.mayJoin(google("g-ida", "ida@example.com"))).toBe(true);
  expect(await dir.mayJoin(google("g-other", "ida@example.com"))).toBe(false);
  await join("ida", google("g-ida", "ida@example.com"));
  expect(await accessOf(dir, "ida")).toBe("write");
  // Adding the account of someone who's a user already gives them the role.
  expect((await dir.addUser(ADMIN, { provider: "google", handle: "ida@example.com" }, "admin")).user?.role).toBe("admin");
  expect((await dir.addUser(ADMIN, { provider: "github", handle: "jo-renamed" }, "write")).person?.handle).toBe("jo-renamed");
  // A bootstrap admin (DEV_LOGIN) is one already: said, not refused.
  expect((await dir.addUser(ADMIN, { provider: "github", handle: "koomen" }, "read")).note).toBe("koomen is already an admin.");
  // A role for someone waiting changes; removed, they can't join.
  const { person: kai } = await dir.addUser(ADMIN, { provider: "github", handle: "kai" }, "read");
  expect((await dir.people.setRole(ADMIN, kai!.id, "write")).role).toBe("write");
  await dir.people.remove(ADMIN, kai!.id);
  expect(await dir.mayJoin(github(Number(kai!.subject), "kai"))).toBe(false);
  await expect(dir.addUser({ login: "joanna" }, { provider: "github", handle: "lee" }, "read")).rejects.toThrow("Only an admin");
});

test("write: someone with read opens their documents and those shared with them as a viewer, and makes none", async () => {
  const dir = fresh();
  await everybody(dir, "read");
  await joined(dir, "kit", google("g-kit", "kit@example.com"));
  await dir.add({ id: "aaaaaaaa", owner: "kit", title: "Plan", created: 1, expires: null });
  expect(await dir.access({ login: "kit" }, (await dir.get("aaaaaaaa"))!)).toBe("viewer");
  expect(await dir.mayWrite("kit")).toBe(false);
  await dir.users.setUserRole(ADMIN, "kit", "write");
  expect(await dir.access({ login: "kit" }, (await dir.get("aaaaaaaa"))!)).toBe("owner");
});

test("a document's access asks the database a few things at once, so a stall counts once, not once per read", async () => {
  const sql = memory(),
    dir = new Directory(sql, { admins: ["koomen"] });
  await everybody(dir, "read");
  await joined(dir, "kit", google("g-kit", "kit@example.com"));
  await dir.users.setUserRole(ADMIN, "kit", "write");
  await dir.add({ id: "aaaaaaaa", owner: "kit", title: "Plan", created: 1, expires: null });
  // A second server on the same database, so nothing is remembered yet; each read waits a moment, as D1's do.
  let open = 0,
    most = 0;
  const slow = {
    ...sql,
    all: async <T>(q: string, ...p: Parameters<typeof sql.all>[1][]) => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return sql.all<T>(q, ...p);
    },
  };
  const cold = new Directory(slow, { admins: ["koomen"] });
  expect(await cold.decide({ login: "kit" }, { id: "aaaaaaaa", owner: "kit", test: false }, [{ login: "kit", role: "owner" }])).toBe(
    "owner"
  );
  expect(most).toBeGreaterThanOrEqual(2);
});

test("the rules' own rules: admins only; groups only; everybody's stays; values checked; a removed user's role goes", async () => {
  const dir = fresh();
  await expect(dir.rules.add({ login: "bo" }, { kind: "workspace", value: "example.com", access: "read" })).rejects.toThrow("Only an admin");
  const all = await dir.rules.list(ADMIN), every = all.find((r) => r.kind == "everybody")!;
  await expect(dir.rules.remove(ADMIN, every.id)).rejects.toThrow("always there");
  await expect(dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "some" })).rejects.toThrow();
  await expect(dir.rules.add(ADMIN, { kind: "account", value: "ada", access: "read" })).rejects.toThrow("isn't a kind of rule");
  await expect(dir.rules.add(ADMIN, { kind: "workspace", value: "not a domain", access: "read" })).rejects.toThrow("isn't a domain");
  await expect(dir.addUser(ADMIN, { provider: "google", handle: "1+x@users.noreply.github.com" }, "read")).rejects.toThrow(
    "isn't a Google account"
  );
  const org = await dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "read" });
  expect((await dir.rules.change(ADMIN, org.id, "write")).access).toBe("write");
  await dir.rules.remove(ADMIN, org.id);
  expect((await dir.rules.list(ADMIN)).some((r) => r.kind == "github_org")).toBe(false);
  await dir.users.add(ADMIN, "lu");
  expect(await accessOf(dir, "lu")).toBe("write");
  await dir.users.remove(ADMIN, "lu");
  expect(await dir.users.allowed("lu")).toBe(false);
  await expect(dir.users.setUserRole(ADMIN, "koomen", "read")).rejects.toThrow("DEV_LOGIN");
});

test("suggestions: the Workspace domains and GitHub organizations of people who signed in here", async () => {
  const dir = fresh();
  await joined(dir, "mo", google("g-mo", "mo@example.com", "example.com"));
  await joined(dir, "ned", github(7, "ned", ["acme", "zeta"]));
  expect(await dir.rules.suggestions(ADMIN)).toEqual({ workspaces: ["example.com"], orgs: ["acme", "zeta"] });
});

test("a GitHub sign-in's organizations: active memberships only, as the pretend GitHub answers the person's token; none when it can't", async () => {
  const { mockGithub } = await import("../dev/github-mock");
  const { memberships } = await import("../server/identity/sign-in");
  const gh = mockGithub({ app: { slug: "erga-editor", clientId: "Iv1.x", clientSecret: "s" }, origin: "https://gh.test", callback: "https://erga.test/auth/github/callback", orgs: ["Acme", "other"] });
  gh.state.tokens.push({ token: "ghu_ada", kind: "user", login: "ada" });
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => gh.fetch(new Request(new URL(String(input instanceof Request ? input.url : input).replace("https://gh.test/api", "https://gh.test/__github/api")), init)).then((r) => r ?? new Response("", { status: 404 }))) as typeof fetch;
  try {
    expect(await memberships("https://gh.test/api", "ghu_ada")).toEqual(["acme", "other"]);
    expect(await memberships("https://gh.test/api", "ghu_unknown")).toEqual([]);
  } finally { globalThis.fetch = real; }
});

test("public sharing: off by default; then anyone with the link is refused, saying why, kept shares open to no one signed out; on restores them", async () => {
  const dir = fresh();
  await dir.users.add(ADMIN, "ada");
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1, expires: null });
  expect(await dir.config.get("public_sharing")).toBe(false);
  await expect(dir.share({ login: "ada" }, "aaaaaaaa", "*", "viewer")).rejects.toThrow("doesn't let users share content publicly");
  // Sharing with people by name is unaffected (Bo may sign in).
  await dir.users.add(ADMIN, "bo");
  await dir.share({ login: "ada" }, "aaaaaaaa", "bo", "viewer");
  await dir.config.set(ADMIN, "public_sharing", true);
  await dir.share({ login: "ada" }, "aaaaaaaa", "*", "viewer");
  expect(await dir.isPublic("aaaaaaaa")).toBe(true);
  // A signed-in person without a share of their own opens it through anyone with the link.
  await dir.users.add(ADMIN, "cy");
  expect(await dir.access({ login: "cy" }, (await dir.get("aaaaaaaa"))!)).toBe("viewer");
  // Off: kept, and still for people who sign in, but not public; stopping it is allowed.
  await dir.config.set(ADMIN, "public_sharing", false);
  expect((await dir.permissions("aaaaaaaa")).some((p) => p.login == "*")).toBe(true);
  expect(await dir.isPublic("aaaaaaaa")).toBe(false);
  expect(await dir.access({ login: "cy" }, (await dir.get("aaaaaaaa"))!)).toBe("viewer");
  await dir.config.set(ADMIN, "public_sharing", true);
  expect(await dir.isPublic("aaaaaaaa")).toBe(true);
  await dir.config.set(ADMIN, "public_sharing", false);
  await dir.share({ login: "ada" }, "aaaaaaaa", "*", null);
  expect((await dir.permissions("aaaaaaaa")).some((p) => p.login == "*")).toBe(false);
  // Only admins turn it on or off.
  await expect(dir.config.set({ login: "ada" }, "public_sharing", true)).rejects.toThrow();
});

test("public sharing: anyone with the link as an editor gives a signed-in person with 'Can authenticate' only viewing", async () => {
  const dir = fresh();
  await dir.config.set(ADMIN, "public_sharing", true);
  await dir.users.add(ADMIN, "ada");
  await dir.add({ id: "bbbbbbbb", owner: "ada", title: "Notes", created: 1, expires: null });
  await dir.share({ login: "ada" }, "bbbbbbbb", "*", "editor");
  await dir.identities.createAccount("dee", google("g-dee", "dee@example.com"));
  await everybody(dir, "read");
  expect(await dir.access({ login: "dee" }, (await dir.get("bbbbbbbb"))!)).toBe("viewer");
  await everybody(dir, "write");
  expect(await dir.access({ login: "dee" }, (await dir.get("bbbbbbbb"))!)).toBe("editor");
});

test("a share goes only to someone who may sign in, and the page says why not; one made before stays", async () => {
  const dir = fresh();
  await dir.users.add(ADMIN, "ada");
  await dir.add({ id: "cccccccc", owner: "ada", title: "Brief", created: 1, expires: null });
  const shareTo = (login: string) => dir.share({ login: "ada" }, "cccccccc", login, "viewer");
  // Nobody lets them in: refused, saying so.
  await expect(shareTo("nobody")).rejects.toThrow("isn't allowed to sign in");
  // A user with a role: yes.
  await dir.identities.createAccount("cal", google("g-cal", "cal@example.com"), { role: "read" });
  await shareTo("cal");
  // A user without one, whom no group lets in: no.
  await dir.identities.createAccount("bea", google("g-bea", "bea@example.com"));
  await expect(shareTo("bea")).rejects.toThrow("isn't allowed to sign in");
  // An organization's rule: someone whose last sign-in recorded it, yes; someone else, no.
  await dir.rules.add(ADMIN, { kind: "github_org", value: "acme", access: "read" });
  await dir.identities.createAccount("dan", github(10, "dan", ["acme"]));
  await shareTo("dan");
  await dir.identities.createAccount("eli", github(11, "eli", ["other"]));
  await expect(shareTo("eli")).rejects.toThrow("isn't allowed to sign in");
  // Never signed in: no username yet, so they sign in once first.
  await expect(shareTo("fox")).rejects.toThrow("There's no user fox on this server yet");
  await dir.rules.add(ADMIN, { kind: "workspace", value: "example.org", access: "read" });
  await expect(shareTo("gil")).rejects.toThrow("sign in once first");
  // Everybody may sign in: anyone may get a share.
  await everybody(dir, "read");
  await shareTo("fox");
  // Shares made before stay when the rules change (sign-in still checks them).
  await everybody(dir, "none");
  expect((await dir.permissions("cccccccc")).map((p) => p.login)).toContain("fox");
  // Stopping a share is always allowed; so is an admin, and anyone with the link is the public switch's.
  await dir.share({ login: "ada" }, "cccccccc", "fox", null);
  await shareTo("koomen");
});
