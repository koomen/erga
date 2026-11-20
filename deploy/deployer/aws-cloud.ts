// The deployer in the cloud on AWS: deploy()'s four calls (aws.ts) and the instance's database (instance.ts), with
// the keys of the deployer's own role (aws-api.ts). The role may do four things, for one instance: put an object
// under releases/ in the instance's bucket, send the instance's own document to its machine and read that command's
// end, write the parameter that says which release runs, and read the gate's hash that setup recorded
// (deploy/aws/deployer.ts has the role).
//
// The machine runs only the instance's document (a Systems Manager document that setup installs): a fixed script
// with three actions and checked parameters. So these keys run no other command on the machine, and read nothing of
// the bucket. Of the instance's database they read only the three tables of its deploys, and write only the jobs and
// the looks (DEPLOYER): no user, no token, no document, and not the spec.
//
// Trap: a release whose gate is not the installed one is refused before the bucket gets anything (plan decision D7).
// Only setup, with a person's own login, installs the gate's code: the role can change no function of the gate.

import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Schema from "effect/Schema";
import { type AwsApi, gateParam, liveParam } from "./aws";
import { type Aws, AwsRefusal } from "./aws-api";
import { celldTgz } from "./celld";
import { DeployError } from "./cloudflare-api";
import { NoTable, type Sql } from "./instance";
import type { Release } from "./release-format";
import type { Spec } from "./spec";

/** The one instance that a deployer is installed for, as setup gave it: the role's resources are these. */
export interface Own {
  stack: string;
  bucket: string;
  /** The machine's EC2 id. */
  machine: string;
  /** The name of the instance's document. */
  document: string;
  /** Whether the gate is in front of the instance (the organization's sign-in). */
  gate: boolean;
}

/** The actions of the instance's document, and each one's parameters (deploy/aws/machine.ts has the script). */
export type Action = { action: "load"; version: string } | { action: "deployed" } | { action: "sql"; sql: string };

/** What a release's name must be for the document: 12 hex characters. */
export const VERSION = /^[0-9a-f]{12}$/;
/** The three tables of an instance's record of its deploys: its spec, its jobs, and the row that the app and the deployer share. */
const TABLE = "deploy_(?:spec|jobs|control)";

/**
 * What a statement for the machine may be, as three patterns that JavaScript and Python read the same way (the
 * document's script checks a statement with them again, on the machine: deploy/aws/machine.ts):
 *
 *   shape   the whole statement: a read, or a write of the tables `writes`, of plain characters only (\x27 is the
 *           quote of SQL's own texts): no quote that ends a text in a script, nothing that a shell reads, no second
 *           statement, no comment
 *   read    the one form in which a statement names a table to read: FROM, one of the three tables, and then WHERE,
 *           ORDER BY, LIMIT, a closing bracket or the statement's end. So no second table comes after it
 *   other   what must not be in the statement but for those reads: another FROM (in any case, also inside a name or
 *           a text), a JOIN, and the word IN (SQLite reads a table that IN names)
 *
 * So a statement reads no table but the three, and writes no table but `writes`.
 */
export interface Rules {
  shape: string;
  read: string;
  other: string;
}
const rules = (writes: string): Rules => ({
  shape: `(?:SELECT |INSERT INTO ${writes} |UPDATE ${writes} SET )[A-Za-z0-9_ ,()=<>|\\x27*.:]*`,
  read: ` FROM ${TABLE}(?= WHERE | ORDER BY | LIMIT |\\)|$)`,
  other: "from|join|(?<![a-z0-9_])in(?![a-z0-9_])",
});
/** With a person's own login, on a machine: the three tables, the spec too (setup and `bun erga` write it). */
export const PERSON = rules(TABLE);
/** The deployer in the cloud: it reads the three tables, and writes its jobs and its looks. It never writes the spec. */
export const DEPLOYER = rules("deploy_(?:jobs|control)");

/** Whether `statement` is one that `rules` allow. */
export const allowed = (statement: string, r: Rules) =>
  new RegExp(`^${r.shape}$`).test(statement) && !new RegExp(r.other, "i").test(statement.replace(new RegExp(r.read, "g"), " "));

/** Systems Manager gives back the first 24,000 characters of a command's output. */
const OUTPUT = 24_000;

/** A value in a statement that the machine runs: text as hex, so that no value can end the statement or the script. */
const literal = (v: string | number | null) =>
  v == null ? "NULL" : typeof v == "number" ? String(Math.trunc(v)) : `CAST(X'${Hex.encode(new TextEncoder().encode(v))}' AS TEXT)`;

/** One statement with its values in it, as the machine may run it, or null: `rules` do not allow it. */
export function statementOf(sql: string, params: readonly (string | number | null)[], r: Rules = PERSON): string | null {
  const parts = sql.split("?");
  const statement = parts.map((part, i) => (i ? literal(params[i - 1] ?? null) : "") + part).join("");
  return parts.length == params.length + 1 && allowed(statement, r) ? statement : null;
}

/** The rows in the machine's answer to a statement: the marked texts in celld's output (instance.ts). */
export function rowsIn(out: string): Effect.Effect<readonly string[], DeployError> {
  // More than Systems Manager gives back is a row that is cut.
  if (out.length >= OUTPUT)
    return Effect.fail(new DeployError({ message: "The machine's answer is longer than Systems Manager gives back." }));
  return Effect.succeed(out.match(/erga:(?:[0-9A-F]{2})+/g) ?? []);
}

/**
 * The instance's database through `run`, which runs one statement on the machine: its output, as celld prints it. A
 * statement that `rules` do not allow never leaves.
 */
export const machineSql =
  (run: (statement: string) => Effect.Effect<string, DeployError>, r: Rules = PERSON): Sql =>
  (sql, params) => {
    const statement = statementOf(sql, params, r);
    if (statement == null)
      return Effect.fail(new DeployError({ message: "A statement of the deploys' record is not one that the machine may run." }));
    return run(statement).pipe(
      Effect.flatMap(rowsIn),
      // A machine that runs no release yet, or one from before the tables, says so in SQLite's words.
      Effect.mapError((e) => (/no such table/.test(e.message) ? new NoTable() : e))
    );
  };

/**
 * Why the deployer in the cloud does not deploy `release` to an instance with the gate in front, or null. `installed`:
 * the hash that setup recorded (null: none).
 */
export function gateProblem(release: Pick<Release, "version" | "gate">, installed: string | null): string | null {
  if (installed && release.gate == installed) return null;
  const why = !installed
    ? "setup has not recorded which gate is in front of the instance"
    : !release.gate
      ? "the release does not say which gate it has"
      : "the release has another gate than the one in front of the instance";
  return `Release ${release.version} is not deployed: ${why}. Only setup installs the gate's code (its sign-in function at CloudFront, and its four functions), with a person's own login. Nothing changed. Run bun erga setup for the instance on a machine, at the release's commit; then deploy again.`;
}

const Sent = Schema.Struct({ Command: Schema.Struct({ CommandId: Schema.String }) });
const Invocation = Schema.Struct({
  Status: Schema.String,
  StandardOutputContent: Schema.optionalKey(Schema.String),
  StandardErrorContent: Schema.optionalKey(Schema.String),
});
const Parameter = Schema.Struct({ Parameter: Schema.Struct({ Value: Schema.String }) });
const Nothing = Schema.Struct({});
/** A command that did not end yet. */
const WAITS = ["Pending", "InProgress", "Delayed", "Cancelling"];

/** What the look and deploy() act through, for the deployer's one instance. */
export interface CloudAws {
  api: AwsApi;
  sql: Sql;
  /** Whether a spec's target is the deployer's instance. */
  mine: (target: Spec["target"]) => boolean;
}

/** The deployer's calls for its instance `own`, with the role's keys in `aws`. */
export function cloudAws(aws: Aws, own: Own): CloudAws {
  /**
   * Runs one action of the instance's document on its machine, and waits: its output. It asks for the end at once,
   * after a quarter of a second, then less often (3 seconds at most). A command that fails is an error with its last
   * lines.
   */
  const run = (a: Action): Effect.Effect<string, DeployError> =>
    Effect.gen(function* () {
      const { action, ...params } = a;
      const sent = yield* aws.ssm(
        "SendCommand",
        {
          DocumentName: own.document,
          InstanceIds: [own.machine],
          // How long Systems Manager tries to reach the machine: one that it can't reach is an error in a minute.
          TimeoutSeconds: 60,
          Parameters: Object.fromEntries(Object.entries({ action, ...params }).map(([k, v]) => [k, [v]])),
        },
        Sent,
        `run "${action}" on the machine ${own.machine}`
      );
      const ask = aws
        .ssm("GetCommandInvocation", { CommandId: sent.Command.CommandId, InstanceId: own.machine }, Invocation, "read the command's end")
        // (For a moment after it is sent, Systems Manager does not know the command on the machine.)
        .pipe(
          Effect.catchIf(
            (e) => e instanceof AwsRefusal && e.code == "InvocationDoesNotExist",
            () => Effect.succeed(null)
          )
        );
      for (let wait = 250; ; wait = Math.min(3000, wait * 2)) {
        const r = yield* ask;
        if (r && !WAITS.includes(r.Status)) {
          const out = r.StandardOutputContent ?? "";
          if (r.Status == "Success") return out;
          const last = `${out}\n${r.StandardErrorContent ?? ""}`.trim().split("\n").slice(-6).join("\n");
          return yield* new DeployError({ message: `on the machine (${r.Status}): ${last}` });
        }
        yield* Effect.sleep(wait);
      }
    });

  const installed = aws.ssm("GetParameter", { Name: gateParam(own.stack) }, Parameter, "read which gate setup installed").pipe(
    Effect.map((p) => p.Parameter.Value as string | null),
    Effect.catchIf(
      (e) => e instanceof AwsRefusal && e.code == "ParameterNotFound",
      () => Effect.succeed(null)
    )
  );

  const api: AwsApi = {
    putRelease: (release, vars) =>
      Effect.gen(function* () {
        if (!VERSION.test(release.version))
          return yield* new DeployError({ message: `"${release.version}" is not a release's name (12 hex characters).` });
        const problem = own.gate ? gateProblem(release, yield* installed) : null;
        if (problem) return yield* new DeployError({ message: problem });
        const tgz = yield* celldTgz(release, vars);
        yield* aws.putObject(
          own.bucket,
          `releases/${release.version}.tgz`,
          tgz,
          `put release ${release.version} in the bucket ${own.bucket}`
        );
        return tgz.length;
      }),
    deployed: Effect.map(run({ action: "deployed" }), (out) => out.split("\n").filter(Boolean)),
    load: (version) =>
      VERSION.test(version)
        ? run({ action: "load", version })
        : Effect.fail(new DeployError({ message: `"${version}" is not a release's name (12 hex characters).` })),
    setLive: (version) =>
      Effect.asVoid(
        aws.ssm(
          "PutParameter",
          { Name: liveParam(own.stack), Value: version, Type: "String", Overwrite: true },
          Nothing,
          `write which release runs (${liveParam(own.stack)})`
        )
      ),
  };
  return {
    api,
    sql: machineSql((sql) => run({ action: "sql", sql }), DEPLOYER),
    mine: (t) =>
      t.kind == "aws" &&
      t.region == aws.region &&
      t.stack == own.stack &&
      t.bucket == own.bucket &&
      t.machine == own.machine &&
      !!t.gate == own.gate,
  };
}
