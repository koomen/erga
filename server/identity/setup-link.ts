// What a new server's setup page (server/identity/setup.ts) and `bun erga setup` (deploy/own/) both read: the link
// that opens the page, and the deployer's step, which the page and the command tell each other through the instance's
// database (server/migrations/0530_setup.sql). Apart from the route, which makes pages, because `bun erga setup` must
// run in a new clone, before any build (Trap: a page's import reaches .build/, which git ignores;
// tests/imports.test.ts holds it).
//
// The deployer's step (Cloudflare, cloud deploys): the person makes a token for the instance's Worker only and pastes
// it on the page. The server can't install a Worker, and the deployer has no address. So the page seals the token with
// the server's secret and keeps it in the row; the command, which waits with the person's own login and the same
// secret (.erga/secrets.json), opens it, checks it, installs the deployer with it, and writes how that ended.
//
//   open ----pasted----> waiting ----installed----> installed (the end)
//   open ----skipped---> skipped                \---refused----> refused
//   refused, skipped ----pasted----> waiting;   waiting, refused ----skipped----> skipped
//
// No state but `waiting` holds the token, and nothing prints it.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { KeyBox } from "../directory/index.ts";
import { signed } from "../signed.ts";

/** How long the link opens the page, and how long the browser that opened it keeps the page. */
export const LINK_SECONDS = 30 * 60;
export const PASS_SECONDS = 12 * 60 * 60;

/**
 * What the command tells the page. `deployer`: the account and the Worker that the person makes the deployer's token
 * for; null: the page has no such step (deploys from a machine, a deployer that is there, or AWS).
 */
export const SetupFacts = Schema.Struct({
  deployer: Schema.NullOr(Schema.Struct({ account: Schema.String, worker: Schema.String })),
});
export type SetupFacts = typeof SetupFacts.Type;

/** The link: the facts, and `n`, which the server keeps when the link is used: it opens the page one time. */
export const SetupLink = signed("setup-link", Schema.Struct({ ...SetupFacts.fields, n: Schema.String }), LINK_SECONDS);

/** The link's address on `host`, sealed with the server's SESSION_SECRET. */
export const setupUrl = async (host: string, secret: string, facts: SetupFacts) =>
  `https://${host}/setup?t=${encodeURIComponent(await SetupLink.seal(secret, { ...facts, n: crypto.randomUUID() }))}`;

const Step = Schema.Union([
  Schema.Struct({ at: Schema.Literal("open") }),
  /** The token as the person pasted it, sealed (sealToken). */
  Schema.Struct({ at: Schema.Literal("waiting"), iv: Schema.String, data: Schema.String }),
  /** `unconfirmed`: what the check could not confirm about the token, for the person to read. */
  Schema.Struct({ at: Schema.Literal("installed"), unconfirmed: Schema.Array(Schema.String) }),
  Schema.Struct({ at: Schema.Literal("refused"), why: Schema.String }),
  Schema.Struct({ at: Schema.Literal("skipped") }),
]);
export type DeployerStep = typeof Step.Type;

export type DeployerEvent =
  | { kind: "pasted"; iv: string; data: string }
  | { kind: "skipped" }
  | { kind: "installed"; unconfirmed: readonly string[] }
  | { kind: "refused"; why: string };

/** The step after `e`. An event that does not fit the state changes nothing. */
export function deployerStep(s: DeployerStep, e: DeployerEvent): DeployerStep {
  if (s.at == "installed") return s;
  if (e.kind == "pasted") return { at: "waiting", iv: e.iv, data: e.data };
  if (e.kind == "skipped") return { at: "skipped" };
  if (s.at != "waiting") return s;
  return e.kind == "installed" ? { at: "installed", unconfirmed: [...e.unconfirmed] } : { at: "refused", why: e.why };
}

/** The row's text as a step: no row, or one that this code can't read, is `open`. */
export const readStep = (text: string | null | undefined): DeployerStep =>
  (text == null ? null : Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Step))(text))) ?? { at: "open" };

const LABEL = "deployer-token";
const box = (secret: string) => new KeyBox(secret, "erga-setup");

/** The token, sealed under the server's SESSION_SECRET: it opens only with that secret. */
export const sealToken = (secret: string, token: string) => box(secret).seal(LABEL, token);
/** The token of a step that waits; null: it does not open with this secret. */
export const openToken = (secret: string, s: { iv: string; data: string }) => box(secret).open(LABEL, s);
