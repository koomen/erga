// The instance's database through a Worker's D1 binding: the deployer on Cloudflare's way to it (worker.ts). Its token
// holds no permission for D1, because Cloudflare has none for one database: the binding is for that one database only.
//
// The binding runs one statement for each call, and a batch of statements as one transaction. A migration is a file of
// statements, so this file cuts it into its statements (statementsOf).
//
// Trap: the binding's exec() takes a file, but it reads each line as a statement and is no transaction: never use it.

import * as Effect from "effect/Effect";
import type { Database } from "./cloudflare";
import { DeployError } from "./cloudflare-api";
import { NoTable, type Sql } from "./instance";

/** What this file uses of Cloudflare's D1 binding (D1Database). */
export interface D1 {
  prepare(sql: string): D1Statement;
  /** The statements in one transaction: all, or none. */
  batch(statements: D1Statement[]): Promise<unknown>;
}
interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  all(): Promise<{ results?: Record<string, unknown>[] }>;
}

/**
 * The statements of a SQL file, in order, with no comment. A `;` ends a statement, but not inside a text, a quoted
 * name or a comment, and not inside a trigger's body (BEGIN ... END).
 */
export function statementsOf(file: string): string[] {
  const out: string[] = [];
  let now = "";
  const end = () => {
    if (now.trim()) out.push(now.trim());
    now = "";
  };
  for (let i = 0; i < file.length; i++) {
    const c = file[i];
    if (c == "-" && file[i + 1] == "-") {
      // A comment to the end of its line.
      const stop = file.indexOf("\n", i);
      i = stop < 0 ? file.length : stop - 1;
    } else if (c == "/" && file[i + 1] == "*") {
      const stop = file.indexOf("*/", i + 2);
      i = stop < 0 ? file.length : stop + 1;
      now += " ";
    } else if (c == "'" || c == '"' || c == "`") {
      // A text or a quoted name, to its closing quote (a doubled quote is the quote itself).
      let j = i + 1;
      while (j < file.length && (file[j] != c || file[j + 1] == c)) j += file[j] == c ? 2 : 1;
      now += file.slice(i, j + 1);
      i = j;
    } else if (c == ";") {
      // A trigger's body has statements of its own: the trigger ends at the `;` after its END.
      if (/^\s*CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(now) && !/\bEND\s*$/i.test(now)) now += c;
      else end();
    } else now += c;
  }
  end();
  return out;
}

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The deploy's way to the instance's database (cloudflare.ts, Database), through the binding. */
export const bindingDatabase = (d1: D1): Database => ({
  query: (sql, params, what) =>
    d1
      .prepare(sql)
      .bind(...params)
      .all()
      .then(
        (r) => r.results ?? [],
        (e) => Promise.reject(new DeployError({ message: `The instance's database refused to ${what}: ${said(e)}` }))
      ),
  apply: (file, record, what) =>
    d1.batch([...statementsOf(file), record].map((s) => d1.prepare(s))).then(
      () => undefined,
      (e) => Promise.reject(new DeployError({ message: `The instance's database refused to ${what}: ${said(e)}` }))
    ),
  // A binding gives no Time Travel bookmark. The log has the deploy's time: Time Travel takes a time too.
  bookmark: () => Promise.resolve(null),
});

/** The instance's record of its deploys (instance.ts, Sql), through the binding. */
export const bindingSql =
  (d1: D1): Sql =>
  (sql, params) =>
    Effect.tryPromise({
      try: async () =>
        (
          (
            await d1
              .prepare(sql)
              .bind(...params)
              .all()
          ).results ?? []
        ).map((r) => String(Object.values(r)[0])),
      catch: (e) =>
        /no such table/.test(said(e))
          ? new NoTable()
          : new DeployError({ message: `The instance's database refused to read or write the record of its deploys: ${said(e)}` }),
    });
