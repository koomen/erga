// The repository's folder, for every deploy tool; and what a command prints.

export const ROOT = new URL("..", import.meta.url).pathname;

export const say = (s = "") => console.log(s);
export const pass = (s: string) => say(`PASS  ${s}`);
/** Says what failed and what to do next, and ends the command. */
export const fail = (s: string, next?: string): never => {
  say(`FAIL  ${s}`);
  if (next) say(`NEXT  ${next}`);
  process.exit(1);
};
