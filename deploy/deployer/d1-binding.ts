// A Worker's D1 binding, as the deployer on Cloudflare uses it (worker.ts): the instance's database. The deployer's
// token holds no permission for D1, because Cloudflare has none for one database: the binding is for that one database
// only.
//
// The binding runs one statement for each call, and a batch of statements as one transaction. A migration is a file of
// statements, so this file cuts it into its statements (statementsOf).
//
// Trap: the binding's exec() takes a file, but it reads each line as a statement and is no transaction: never use it.
// Nothing here imports Effect: the deployer's Worker holds this file.

/** What this file uses of Cloudflare's D1 binding (D1Database). */
export interface D1 {
  prepare(sql: string): D1Statement;
  /** The statements in one transaction: all, or none. */
  batch(statements: D1Statement[]): Promise<unknown>;
}
export interface D1Statement {
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
