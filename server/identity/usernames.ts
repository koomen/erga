// How a new account gets its username: the setting `usernames` (server/directory/settings.ts), a radio on /admin/auth.
//
//   github   the GitHub username. Only while GitHub is the only sign-in provider that is on: then each login is one
//            person's.
//   email    the part of the email address before the @. With a gate in front (single sign-on), always: the
//            organization's own sign-in is the one way in. Else only while Google is the only provider that is on, one
//            Google Workspace rule is the only group rule, and Anyone's level lets no account in (none or public): then
//            that Workspace's addresses are the one way in, and each prefix is one person's. A person outside that
//            Workspace (one an admin added), or whose address has another domain, chooses.
//   choose   each new person chooses (/auth/username).
//
// The condition is asked when the rule is set (set_setting refuses a rule that can't apply) and again at each first
// sign-in. An admin's change that would stop the rule that is set (a second provider on, a second group rule) asks
// first: after it, the rule is choose (server/operations/admin.ts, keepsUsernames; RULE_ENDS has the question). A rule
// whose condition stopped another way (the deploy's sign-in changed) has no effect, and the page shows choose.
//
// A rule never makes a second account of one name: a name that is not free (an older account's, a reserved one, two
// addresses that give the same name) goes to the username step, where its person chooses another (accounts.ts).
// `whyNot` and `assigned` decide, with no IO; `usernameFacts` reads what they decide with.

import { type Anyone, anyoneAccess, groupOf, type RuleKind, usernameFrom, type UsernameRule, type Vouched } from "../directory/index.ts";
import type { Platform } from "../platform.ts";
import { providerName, SSO } from "../../shared/sign-in.ts";
import { signInChoices } from "./settings.ts";

/** What the rules' conditions read of the server. */
export interface UsernameFacts {
  /** The ways to sign in that are on: the providers' ids; with a gate in front, the gate alone (SSO). */
  ways: string[];
  /** The group rules (the Access page). */
  rules: { kind: RuleKind; value: string }[];
  /** Anyone's level. */
  anyone: Anyone;
}

/** Each rule, as the page names it, and the line under its name: what it does, and what it requires. */
export const RULE_LABEL: Record<UsernameRule, string> = {
  github: "GitHub username",
  email: 'Email prefix, e.g. "pete" for pete@example.com',
  choose: "Users choose their own usernames",
};
export const RULE_ABOUT: Record<UsernameRule, string> = {
  github: "New users get their GitHub username. Requires GitHub to be the only provider.",
  email: "Requires either SSO, or OAuth with Google as the only provider, and access limited to a single Google Workspace.",
  choose: "Each new user chooses a username when they first sign in.",
};

/** What an admin reads before a change that stops the rule that is set: to proceed makes the rule choose. */
export const RULE_ENDS: Record<Exclude<UsernameRule, "choose">, string> = {
  github:
    "Usernames are assigned based on GitHub username, which requires GitHub to be the only provider. If you proceed, each new user will choose their own username.",
  email:
    "Usernames are assigned based on email prefix, which requires access limited to a single Google Workspace. If you proceed, each new user will choose their own username.",
};

/** What stops a rule now, for an admin ("Google is off; GitHub is on"); null: it can apply. */
export function whyNot(rule: UsernameRule, f: UsernameFacts): string | null {
  if (rule == "choose") return null;
  const sso = f.ways.includes(SSO);
  if (rule == "email" && sso) return null;
  const provider = rule == "github" ? "github" : "google";
  const now = sso
    ? ["this server uses single sign-on"]
    : [
        ...(f.ways.includes(provider) ? [] : [`${providerName(provider)} is off`]),
        ...f.ways.filter((w) => w != provider).map((w) => `${providerName(w)} is on`),
      ];
  if (rule == "email") {
    if (f.rules.length != 1) now.push(f.rules.length ? `${f.rules.length} group rules give access` : "no group rule gives access");
    else if (f.rules[0].kind != "workspace") now.push("the one group rule is a GitHub organization");
    if (anyoneAccess(f.anyone) != "none") now.push("Anyone can sign in");
  }
  return now.length ? now.join("; ") : null;
}

/** The rule that names a new account now: the one that is set, or choose while it can't apply. */
export const ruleNow = (rule: UsernameRule, f: UsernameFacts): UsernameRule => (whyNot(rule, f) ? "choose" : rule);

/**
 * The username the rule gives this person, as their sign-in names them; null: they choose (the rule is choose, its
 * condition does not hold now, or it does not cover them).
 */
export function assigned(rule: UsernameRule, f: UsernameFacts, v: Vouched): string | null {
  if (rule == "choose" || whyNot(rule, f) || v.provider != f.ways[0]) return null;
  if (rule == "github") return usernameFrom(v.handle) || null;
  // The address the provider calls them by, which it verified.
  const email = v.handle.toLowerCase();
  if (!v.emails.some((e) => e.verified && e.email.toLowerCase() == email)) return null;
  // (A gate in front has no group rule to ask: whyNot.)
  const domain = v.provider == SSO ? null : f.rules[0].value;
  if (domain != null && !(v.groups?.includes(groupOf("workspace", domain)) && email.endsWith(`@${domain}`))) return null;
  return usernameFrom(email) || null;
}

/** What the rules' conditions read, as the server is now. */
export async function usernameFacts(platform: Pick<Platform, "own" | "signIn" | "directory">): Promise<UsernameFacts> {
  const [ways, rules, anyone] = await Promise.all([signInChoices(platform), platform.directory.rules.all(), platform.directory.anyone()]);
  return { ways: ways.map((w) => w.id), rules, anyone };
}
