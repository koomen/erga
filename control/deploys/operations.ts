// The Ops page's operations on the deploys (server/operations/operation.ts: one each, for the page over
// POST /api/tools/<name> and for every agent with admin power as a tool): every target's deploys and their logs,
// Redeploy (Retry), Roll back, the Cloudflare credential, the release store's channels and each environment's
// domains. They run on the pipeline's object wherever the page is: on the control Worker its own, on erga.dev and
// staging over the CONTROL binding (Platform.deploys). Connect Cloudflare stays a consent in a popup (control/routes.ts).

import * as Schema from "effect/Schema";
import { type Caller, type Operation, OperationError, platformOf } from "../../server/operations/index.ts";
import { byLine } from "../../shared/attribution.ts";
import type { Offer } from "../../shared/agent-log.ts";
import type { CredentialStatus } from "./credential.ts";
import type { OpsDeploys } from "./api.ts";

const str = (description: string) => Schema.String.annotate({ description });
const TARGET = str("The deploy target: staging or production (list_deploys lists them)");
const ENVIRONMENT = str("The environment: production, staging or control");

const deploys = (caller: Caller): OpsDeploys => platformOf(caller).deploys;
/** Who asked, as a deploy's trigger and the change log name them: the person, and their agent if one. */
const byOf = ({ who }: Caller) => byLine(who.login, who.via);
/** The pipeline's answer: its result, or its error as the operation's failure. */
function ok<T>(r: T): T {
  const e = r as { error?: string; status?: unknown; ok?: boolean };
  if (e.error || e.ok === false)
    throw new OperationError({ message: e.error ?? "refused", status: typeof e.status == "number" ? e.status : 400 });
  return r;
}

/**
 * Not connected: Connect Cloudflare, a button under the call in the admin's panel (a consent in a popup, on the control
 * Worker's origin). The consent is the admin's own: the agent only offers it.
 */
function withOffer<T extends { credential?: CredentialStatus }>(o: T, caller: Caller): T | (T & { offer: Offer; connect: string }) {
  if (!o.credential || o.credential.connected) return o;
  const at = platformOf(caller).control?.url ?? caller.origin ?? "";
  return {
    ...o,
    offer: {
      kind: "connect-cloudflare",
      label: o.credential.by ? "Connect Cloudflare again" : "Connect Cloudflare",
      url: `${at}/install/start?popup=1`,
    },
    connect:
      "Nothing deploys until the admin connects Cloudflare. A Connect Cloudflare button shows under this call in their panel: it opens Cloudflare's consent in a popup, on this page. Tell them so, with Cloudflare's own words (credential.error, else credential.problem). You can't consent for them.",
  };
}

export const DEPLOY_OPERATIONS: Operation[] = [
  {
    name: "list_deploys",
    ui: "Ops (/admin/ops): every target's deploys, and the Cloudflare credential",
    label: "Read the deploys",
    admin: true,
    description:
      "Every deploy target (staging, production, control): what it runs, its deploy now (state, commit, steps) and its last deploys, newest first, each with its state, commit, trigger and error (why it failed) (history: how many, default 5, at most 100), and the Cloudflare credential every deploy uses (credential).",
    parameters: Schema.Struct({
      history: Schema.optionalKey(Schema.Int.annotate({ description: "How many past deploys of each target (default 5)" })),
    }),
    run: async (a, caller) => {
      const history = Math.max(0, Math.min(100, a.history == null ? 5 : Number(a.history) || 0));
      return withOffer((await deploys(caller).status(history)) as { credential?: CredentialStatus }, caller);
    },
  },
  {
    name: "deploy_log",
    ui: "Ops (/admin/ops): a deploy's log",
    label: "Read a deploy's log",
    admin: true,
    description:
      "A deploy's log, as the Ops page shows it: the target's latest deploy, or the one named. The last 200 lines unless you ask for more (lines; 0: the whole log).",
    parameters: Schema.Struct({
      target: TARGET,
      deploy: Schema.optionalKey(str("The deploy's id (list_deploys); default: the latest")),
      lines: Schema.optionalKey(Schema.Int.annotate({ description: "How many lines, the last (default 200; 0: all of them)" })),
    }),
    run: async (a, caller) => {
      const target = String(a.target),
        deploy = typeof a.deploy == "string" && a.deploy ? a.deploy : undefined;
      const log = (await deploys(caller).logOf(target, deploy)) as { lines?: unknown[] } | null;
      if (!log)
        throw new OperationError({
          message: deploy
            ? `${target} has no deploy ${deploy} in its history. list_deploys lists them.`
            : `There's no deploy target called ${target}.`,
          status: 404,
        });
      const lines = log.lines ?? [],
        n = a.lines === 0 ? lines.length : Math.max(1, Number(a.lines) || 200);
      return { ...log, lines: lines.slice(-n), ...(lines.length > n ? { cut: `the last ${n} of ${lines.length} lines` } : {}) };
    },
  },
  {
    name: "redeploy",
    ui: "Ops (/admin/ops): Retry, a target's branch head deployed again (fresh_data: staging with a fresh copy of production's data)",
    label: "Redeploy a target",
    admin: true,
    description:
      "Deploys a target's branch head again now (staging: staging; production: main), as the Ops page's Retry does. The deploy says who asked for it. Staging's copy of production's data is frozen: a deploy keeps it (new migrations run on it in place); fresh_data: true makes this redeploy of staging copy production's data afresh, the only way to refresh it.",
    parameters: Schema.Struct({
      target: TARGET,
      fresh_data: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "Staging only: copy production's database and documents afresh, in place of staging's frozen copy",
        })
      ),
    }),
    run: async (a, caller) => {
      const target = String(a.target),
        trigger = `redeploy by ${byOf(caller)}`,
        fresh = a.fresh_data === true;
      const r = ok(
        fresh ? await deploys(caller).redeployWith(target, trigger, { fresh }) : await deploys(caller).redeploy(target, trigger)
      );
      return { ok: true, target: r.status, done: `${target} redeploys now${fresh ? ", with a fresh copy of production's data" : ""}` };
    },
  },
  {
    name: "rollback",
    ui: "Ops (/admin/ops), a deploy's log: Roll back to the version before the live deploy",
    label: "Roll a target back",
    admin: true,
    description:
      "Puts back the version a target ran before its live deploy, as the Ops page's Roll back does: one deployment of that Worker version, in seconds, with no build. The database keeps its schema (migrations only add). Only when the admin asks in this conversation to roll back; list_deploys shows which deploy is live and what it would go back to (restore).",
    parameters: Schema.Struct({ target: TARGET }),
    run: async (a, caller) => {
      const target = String(a.target);
      const r = ok(await deploys(caller).rollback(target, `rollback by ${byOf(caller)}`));
      return { ok: true, target: r.status, done: `${target} is rolled back` };
    },
  },
  {
    name: "deploy_credential",
    ui: "Ops (/admin/ops), the Cloudflare card: whether the deploy credential is connected",
    label: "Read the deploy credential",
    admin: true,
    description:
      "The control Worker's Cloudflare credential, which every deploy uses: connected or not, who connected it, and when it doesn't work, Cloudflare's own words (error: its answer to the last refresh). An expired access token refreshes by itself; only a refused or missing grant stops the deploys, and then the deploys that wait go by themselves once it's connected again. When it isn't connected, a Connect Cloudflare button shows under this call in the admin's panel: Cloudflare's consent, in a popup, on the page they're on. Tell them to click it. You can't consent for them, and there's no token to ask for.",
    parameters: Schema.Struct({}),
    run: async (_a, caller) => withOffer({ credential: await deploys(caller).credentialStatus() }, caller),
  },
  {
    name: "disconnect_deploy_credential",
    ui: "Ops (/admin/ops), the Cloudflare card: Disconnect, the grant revoked and forgotten",
    label: "Disconnect the deploy credential",
    admin: true,
    description:
      "Revokes the control Worker's Cloudflare grant on Cloudflare and forgets it, as Disconnect on the Ops page's Cloudflare card does: nothing deploys until the admin connects Cloudflare again (a consent of their own). Only when the admin asks in this conversation to disconnect or revoke it.",
    parameters: Schema.Struct({}),
    run: async (_a, caller) => {
      await deploys(caller).disconnectCredential();
      return {
        ok: true,
        credential: await deploys(caller).credentialStatus(),
        done: "The control Worker's Cloudflare grant is revoked: nothing deploys until the admin connects Cloudflare again (a consent of their own)",
      };
    },
  },
  {
    name: "list_releases",
    ui: "Ops (/admin/ops): the release store's channels, marked on the log",
    label: "Read the release channels",
    admin: true,
    description:
      "The release store's channels: edge (every commit of main production deployed and found healthy, newest first) and stable (the newest release tag; what other installs of Erga follow). Each entry: its version (the commit's first 12 digits), the tag on stable, when it was built and when it went on the channel. list_branches lists the release tags themselves (tags, release).",
    parameters: Schema.Struct({}),
    run: async (_a, caller) => {
      const r = await deploys(caller).releases();
      if (!r) throw new OperationError({ message: "This server has no release store.", status: 404 });
      return r;
    },
  },
  {
    name: "list_domains",
    ui: "Ops (/admin/ops): each environment's domains",
    label: "Read the environments' domains",
    admin: true,
    description:
      "Each environment's domains (production, staging, control): its own address first (primary: the one deploys put it on), then the domains added to it, with the Cloudflare zone each is on.",
    parameters: Schema.Struct({}),
    run: async (_a, caller) => ok(await deploys(caller).domains()),
  },
  {
    name: "add_domain",
    ui: "Ops (/admin/ops): + Add domain to an environment",
    label: "Add a domain to an environment",
    admin: true,
    description:
      "Attaches a hostname on one of this account's Cloudflare zones to an environment's Worker (a Workers custom domain: Cloudflare makes the DNS record and certificate), as Add domain on the Ops page does. Only when the admin asks in this conversation.",
    parameters: Schema.Struct({ target: ENVIRONMENT, hostname: str("The hostname, like docs.example.com") }),
    run: async (a, caller) => {
      const target = String(a.target),
        hostname = String(a.hostname).trim().toLowerCase();
      const r = ok(await deploys(caller).addDomain(target, hostname, byOf(caller)));
      return { ...r, done: `${hostname} added to ${target}: Cloudflare makes its DNS record and certificate in a minute or two` };
    },
  },
  {
    name: "remove_domain",
    ui: "Ops (/admin/ops): × on a domain, removed from its environment",
    label: "Remove a domain from an environment",
    admin: true,
    description:
      "Takes a hostname off an environment's Worker (never its own address), as the × on the Ops page does. Only when the admin asks in this conversation.",
    parameters: Schema.Struct({ target: ENVIRONMENT, hostname: str("The hostname to remove") }),
    run: async (a, caller) => {
      const target = String(a.target),
        hostname = String(a.hostname).trim().toLowerCase();
      const r = ok(await deploys(caller).removeDomain(target, hostname, byOf(caller)));
      return { ...r, done: `${hostname} removed from ${target}` };
    },
  },
];
