// People for the factory's tests: admins made on the worker's factory server, each with a name of their own (a
// login can be added only once, and the server outlives a test), and who their commits are by.

import { expect } from "../fixtures";
import type { factory } from "./factory";

/** The factory's own committer (factory/author.ts). */
export const FACTORY = "Erga factory <factory@erga.dev>";

/** A GitHub name as a commit's author: the name and the login's noreply address. */
export const author = (name: string, login: string) => `${name} <${login}@users.noreply.github.com>`;

/** A new admin, named `first` and a word of its own ("Ada k3x9"): their name (for ?user=) and login. */
export async function admin(f: ReturnType<typeof factory>, first: string) {
  const name = `${first} ${crypto.randomUUID().slice(0, 6)}`;
  const login = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const r = await fetch(`${f.root}/admin/users`, { method: "POST", headers: { Origin: f.root }, body: new URLSearchParams({ do: "add", login, role: "admin" }) });
  expect(r.ok, await r.text()).toBe(true);
  return { name, login };
}

/** Each commit in `range` of the factory's repository: author, committer and subject. */
export const commits = (f: ReturnType<typeof factory>, ...range: string[]) =>
  f.git("log", "--format=%an <%ae>|%cn <%ce>|%s", ...range).split("\n").filter(Boolean).map((l) => { const [author, committer, subject] = l.split("|"); return { author, committer, subject }; });
