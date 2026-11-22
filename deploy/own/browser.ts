// The user's steps in the browser that `bun erga setup` opens on this machine: a page on the loopback, for one step,
// that stops when the step is done. No agent sees these pages or what goes through them. (A new server's own steps
// are on its setup page, server/identity/setup.ts: this is the one that comes before there is a server.)
//
//   oidcSecret    single sign-on on AWS: one field for the client secret of the organization's sign-in, into Parameter Store
//
// With --remote the user is at another computer, and a browser here shows nothing. Their steps go through their own
// terminal (/dev/tty), never through stdin, stdout or stderr, which the agent that runs the command has: a hidden
// prompt (askSecret), and the links that they open in their own browser (tellUser).
//
// Trap: a page here never shows a secret, and the command never prints one.

import { closeSync, openSync, writeSync } from "node:fs";
import { esc } from "../../shared/html";
import type { Answers } from "./plan";

/** Opens `url` in the user's browser. */
export const openBrowser = (url: string) =>
  void Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });

/** The user's terminal, open for writing: its file descriptor, or null when the command has none (an agent's shell). */
export function openTerminal(open: (path: string, flags: string) => number = openSync): number | null {
  try {
    return open("/dev/tty", "w");
  } catch {
    return null;
  }
}

/** Writes `text` on the user's terminal only. False: there is none. */
export function tellUser(text: string): boolean {
  const tty = openTerminal();
  if (tty == null) return false;
  try {
    writeSync(tty, `\n${text}\n\n`);
  } finally {
    closeSync(tty);
  }
  return true;
}

/**
 * Asks the user for a secret on their terminal, with no echo (bash's read -s, which turns the echo back on after a
 * Ctrl-C too). The value comes back through a pipe, and nothing shows it. "": they typed nothing; null: no terminal.
 */
export function askSecret(label: string): string | null {
  if (!tellUser(label)) return null;
  const r = Bun.spawnSync(["bash", "-c", 'IFS= read -rs v </dev/tty && printf %s "$v"; echo >/dev/tty'], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return r.success ? r.stdout.toString().trim() : null;
}

/** A page of a step: `body` in the steps' plain look. (The verify suite's own step, for the deployer's token, has the same look: dev/verify/deploys.ts.) */
export const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Erga setup</title><body style="font:15px/1.5 system-ui;max-width:560px;margin:48px auto;padding:0 16px">${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
const doneHtml = (what: string) =>
  html(`<h1 style="font-size:20px">Done</h1><p>${esc(what)} Go back to your terminal: setup goes on by itself.</p>`);

/**
 * One step's page on the loopback, opened in the browser. `route` answers each request; it ends the step with "" (done)
 * or a failure, or null to go on. The result: "" (done), a failure, or null when `ms` ends first.
 */
export async function step(
  route: (req: Request, url: URL) => Promise<{ res: Response; end?: string }>,
  ms: number,
  open: (url: string) => void
): Promise<string | null> {
  let end: (r: string) => void = () => {};
  const ended = new Promise<string>((r) => (end = r));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const r = await route(req, new URL(req.url));
      if (r.end != undefined) queueMicrotask(() => end(r.end!));
      return r.res;
    },
  });
  open(`http://127.0.0.1:${server.port}/`);
  try {
    return await Promise.race([ended, Bun.sleep(ms).then(() => null)]);
  } finally {
    // The last page has its answer before the server stops.
    setTimeout(() => server.stop(), 500);
  }
}

/** Single sign-on on AWS: the user types the client secret, and `put` stores it (Parameter Store). */
export function oidcSecret(a: Answers, put: (secret: string) => Promise<void>, ms: number): Promise<string | null> {
  const form = (problem = "") =>
    html(`<h1 style="font-size:20px">The client secret of your organization's sign-in</h1>
<p>Erga's client <code>${esc(a.client)}</code> at ${esc(a.issuer)}. The secret goes to AWS Parameter Store, never to your agent.</p>
${problem ? `<p style="color:#b42318">${esc(problem)}</p>` : ""}<form method="post" action="/"><input name="secret" type="password" autocomplete="off" style="width:100%;padding:6px 8px" autofocus>
<p><button>Save</button></p></form>`);
  return step(
    async (req) => {
      if (req.method != "POST") return { res: form() };
      const secret = String((await req.formData()).get("secret") ?? "").trim();
      if (!secret) return { res: form("Type the client secret.") };
      return put(secret).then(
        () => ({ res: doneHtml("AWS has the client secret."), end: "" }),
        (e: Error) => ({ res: form(`AWS did not take the secret: ${e.message}`) })
      );
    },
    ms,
    openBrowser
  );
}
