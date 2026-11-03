// The Ops page's operations on the deploys (server/operations/operation.ts: one each, for the page over
// POST /api/tools/<name> and for every agent with admin power as a tool): every target's deploys, their logs, the
// Cloudflare credential and each environment's domains (one read), Redeploy (Retry; and the homepage's), Roll back,
// Disconnect, and a domain added or removed. They run on the pipeline's object wherever the page is: on the control Worker its own, on erga.dev and
// staging over the CONTROL binding (Platform.deploys). Connect Cloudflare stays a consent in a popup (control/routes.ts).

import type { DomainNeed } from "./domains.ts";
import * as Schema from "effect/Schema";
import { type Caller, type Operation, OperationError, platformOf, redeployHome } from "../../server/operations/index.ts";
import { byLine } from "../../shared/attribution.ts";
import type { Offer } from "../../shared/agent-log.ts";
import type { CredentialStatus } from "./credential.ts";
import type { OpsDeploys } from "./api.ts";

const str = (description: string) => Schema.String.annotate({ description });
const TARGET = str("The deploy target: staging or production");
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
    name: "deploys",
    ui: "Ops (/admin/ops): every target's deploys, a deploy's log, the Cloudflare credential, and each environment's domains",
    label: "Read the deploys",
    admin: true,
    description: "Each target's deploys and the Cloudflare credential, one deploy's log, or the domains.",
    parameters: Schema.Struct({
      view: Schema.optionalKey(
        Schema.Literals(["deploys", "log", "domains"]).annotate({
          description:
            "deploys (default): each target's deploy now and its last ones, and the credential. log: one deploy's log (target, deploy, lines). domains: each environment's addresses",
        })
      ),
      history: Schema.optionalKey(
        Schema.Int.annotate({ description: "deploys: how many past deploys of each target (default 5, at most 100)" })
      ),
      target: Schema.optionalKey(str("log: the deploy target, staging or production")),
      deploy: Schema.optionalKey(str("log: the deploy's id (default: the target's latest)")),
      lines: Schema.optionalKey(Schema.Int.annotate({ description: "log: how many lines, the last (default 200; 0: all of them)" })),
    }),
    run: async (a, caller) => {
      if (a.view == "domains") return ok(await deploys(caller).domains());
      if (a.view == "log") {
        if (typeof a.target != "string" || !a.target)
          throw new OperationError({ message: "The log needs target: staging or production.", status: 400 });
        const target = a.target,
          deploy = typeof a.deploy == "string" && a.deploy ? a.deploy : undefined;
        const log = (await deploys(caller).logOf(target, deploy)) as { lines?: unknown[] } | null;
        if (!log)
          throw new OperationError({
            message: deploy
              ? `${target} has no deploy ${deploy} in its history: deploys lists them.`
              : `There's no deploy target called ${target}.`,
            status: 404,
          });
        const lines = log.lines ?? [],
          n = a.lines === 0 ? lines.length : Math.max(1, Number(a.lines) || 200);
        return { ...log, lines: lines.slice(-n), ...(lines.length > n ? { cut: `the last ${n} of ${lines.length} lines` } : {}) };
      }
      const history = Math.max(0, Math.min(100, a.history == null ? 5 : Number(a.history) || 0));
      return withOffer((await deploys(caller).status(history)) as { credential?: CredentialStatus }, caller);
    },
  },
  {
    name: "redeploy",
    ui: "Ops (/admin/ops): Retry, a target's branch head deployed again (fresh_data: staging with a fresh copy of production's data); the editor's settings: Homepage, Deploy",
    label: "Redeploy",
    activity: "deploying again",
    admin: true,
    description: "Deploys a target's branch head again now, or the homepage.",
    parameters: Schema.Struct({
      target: str(
        "staging, production (main): the build starts and runs on (deploys shows it). homepage (landing_document): answers when it is live, with each file's live address (live.files)"
      ),
      fresh_data: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "staging only: copy production's database and documents afresh (a deploy keeps staging's frozen copy)",
        })
      ),
    }),
    run: async (a, caller) => {
      const target = String(a.target);
      if (target == "homepage") return redeployHome(caller);
      const trigger = `redeploy by ${byOf(caller)}`,
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
    description: "Puts back the Worker version a target ran before its live deploy, with no build.",
    parameters: Schema.Struct({ target: TARGET }),
    run: async (a, caller) => {
      const target = String(a.target);
      const r = ok(await deploys(caller).rollback(target, `rollback by ${byOf(caller)}`));
      return { ok: true, target: r.status, done: `${target} is rolled back` };
    },
  },
  {
    name: "disconnect_deploy_credential",
    ui: "Ops (/admin/ops), the Cloudflare card: Disconnect, the grant revoked and forgotten",
    label: "Disconnect the deploy credential",
    admin: true,
    description: "Revokes the Cloudflare grant that every deploy uses.",
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
    name: "set_domain",
    ui: "Ops (/admin/ops): + Add domain to an environment, and × on a domain",
    label: "Change an environment's domains",
    admin: true,
    description: "Attaches a hostname to an environment's Worker, or takes one off.",
    parameters: Schema.Struct({
      action: Schema.Literals(["add", "remove"]).annotate({
        description:
          "add: a hostname on one of this account's Cloudflare zones (Cloudflare makes its DNS record and certificate); remove: never the environment's own address",
      }),
      target: ENVIRONMENT,
      hostname: str("The hostname, like docs.example.com"),
      replace: Schema.optionalKey(Schema.Boolean).annotate({
        description: "add: replace the name's own DNS records (only after the person said yes to an answer with need.kind replace)",
      }),
    }),
    run: async (a, caller) => {
      const target = String(a.target),
        hostname = String(a.hostname).trim().toLowerCase();
      if (a.action == "add") {
        const r = ok(await deploys(caller).addDomain(target, hostname, byOf(caller), { replace: a.replace === true }));
        if ("need" in r) return { ...r, done: needWords((r as { need: DomainNeed }).need) };
        return {
          ...r,
          done: `${hostname} added to ${target}: it answers once Cloudflare has made its certificate, in a minute or two (live in the view)`,
        };
      }
      if (a.action == "remove") {
        const r = ok(await deploys(caller).removeDomain(target, hostname, byOf(caller)));
        return { ...r, done: `${hostname} removed from ${target}` };
      }
      throw new OperationError({ message: "action: add or remove.", status: 400 });
    },
  },
];

/** What a domain still needs, in words for an agent to tell its person (the Ops page shows the same as steps). */
function needWords(n: DomainNeed): string {
  if (n.kind == "zone")
    return `Not added: ${n.domain} isn't in this Cloudflare account. The person adds it at https://dash.cloudflare.com/${n.accountId}/add-site (the free plan is enough), moves its name servers as Cloudflare says, then adds ${n.hostname} again. No domain yet: Cloudflare Registrar sells one, and it is in the account at once`;
  if (n.kind == "nameservers")
    return `Not added yet: ${n.domain} is in the account, but its registrar still names other name servers${n.current.length ? ` (${n.current.join(", ")})` : ""}. The person sets ${n.nameservers.join(" and ") || "Cloudflare's name servers"} at the registrar, then adds ${n.hostname} again (Cloudflare sees the change in minutes, at most a day)`;
  return `Not added: ${n.hostname} already has DNS records (${n.records.map((r) => `${r.type} ${r.content}`).join(", ")}). Add it again with replace: true only if the person says yes: the old target stops answering at that name`;
}
