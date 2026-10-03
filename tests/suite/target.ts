// What the suite runs against. A target hands out documents; a document is
// reached only through the deployment's public surface (the contract in
// tests/suite/README.md): its shell, the room's WebSocket, the agent's HTTP
// endpoints, what's served and what's stored. Nothing here peeks inside the
// server, so the same tests run against a local dev server and a deployment.
//
//   local    a dev server (tests/host.ts: the Worker under Vite, as `bun
//            start` runs it) with the scripted agent model, and each
//            document a scratch copy of a fixture linked from disk, so a
//            test can edit its files there too. Tests share one server,
//            except those that restart or kill it, which get their own.
//   remote   a deployed document at ERGA_TARGET_DOC (its URL must
//            contain "test": the suite rewrites it), with optional auth
//            (ERGA_TARGET_COOKIE, ERGA_TARGET_HEADERS as JSON,
//            and per person ERGA_TARGET_USERS: {"Ada": {"Cookie": ...}})
//            and capabilities (ERGA_TARGET_CAPS, comma-separated).
//            With ERGA_TARGET_NEW_DOC (a URL that makes a document and
//            redirects to it; "{id}" becomes a fresh test id), each test
//            gets its own document instead, as locally, and they run in
//            parallel.

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { startHost, type Host } from "../host";

/**
 * What a target can do beyond the contract:
 *   restart        stop the server gracefully and start it again
 *   kill           stop it abruptly (SIGKILL) and start it again
 *   disk           edit the stored files directly, behind the server's back
 *   scriptedAgent  the agent runs the scripted test model (agent.ts)
 *   liveAgent      the agent runs a real model (costs money)
 *   browser        a headless Chrome is available here to open the shell
 *   roles          people can have view-only access (Doc.share)
 */
export type Capability = "restart" | "kill" | "disk" | "scriptedAgent" | "liveAgent" | "browser" | "roles";

export interface Doc {
  /** Where the document is served: its shell is `base + "/"`, its API under it. */
  base: string;
  /** The document's own file, as the room names it (e.g. "index.html"). */
  path: string;
  /** How long after an edit the server writes it to storage (from /api/doc; 400 if it doesn't say). */
  writeDelay: number;
  /** The fixture's files, as they were when the document was created. */
  fixture: Record<string, string>;
  /** Headers every request (and WebSocket) needs: auth, on a deployment. */
  headers: Record<string, string>;
  /** The headers that make a request come from one person (their session, on a deployment). */
  headersFor(user: string): Record<string, string>;
  /** The room's WebSocket endpoint (y-websocket's server URL and room name). */
  roomUrl: string;
  roomName: string;
  /** The shell's URL as a given person. */
  pageUrl(user: string): string;
  /** An HTTP request to the document's API, with auth (as `user`, if given). */
  fetch(path: string, init?: RequestInit, user?: string): Promise<Response>;
  /** What storage holds for a file, and its etag (null if it doesn't exist). */
  stored(path: string): Promise<{ text: string; etag: string } | null>;
  /** An edit that arrives as a whole file (a publish). */
  push(path: string, text: string, ifMatch?: string | null): Promise<Response>;
  /** What the server serves for a file to the page (the room's latest). */
  served(path: string): Promise<string | null>;
  /** Behind the server's back (capability "disk"). */
  writeDisk?(path: string, data: string | Uint8Array): void;
  /**
   * Capability "roles": gives a person ("*": anyone signed in with the link)
   * a role on the document, or takes theirs away (null), as its owner.
   */
  share?(user: string, role: "editor" | "viewer" | null): Promise<void>;
  /**
   * Capability "restart" / "kill". "lose-state" kills the server and
   * deletes the room's saved Yjs state, as if storage for it was lost.
   */
  restart?(how: "graceful" | "kill" | "lose-state", whileDown?: () => Promise<void>): Promise<void>;
  dispose(): Promise<void>;
}

export interface Target {
  name: string;
  caps: Set<Capability>;
  /** Whether tests may run at once (each gets its own document). */
  parallel: boolean;
  /** A fresh document from a fixture; `needs` are the test's (a local target gives one that restarts a server of its own). */
  newDoc(fixture: string, needs?: Capability[]): Promise<Doc>;
  close(): Promise<void>;
}

const EDITOR = new URL("../../", import.meta.url).pathname;
export const FIXTURES = join(EDITOR, "tests/fixtures");

/** A fixture folder's text files, keyed by path. */
export function readFixture(name: string): Record<string, string> {
  const root = join(FIXTURES, name), out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split("\\").join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

const indexOf = (files: Record<string, string>) => ["index.html", "index.htm", "index.md"].find((n) => n in files) ?? Object.keys(files)[0];

function makeDoc(base: string, headers: Record<string, string>, fixture: Record<string, string>, extra: Partial<Doc> & { dispose(): Promise<void> }, perUser: Record<string, Record<string, string>> = {}): Doc {
  const doc: Doc = {
    base,
    path: indexOf(fixture),
    fixture,
    headers,
    headersFor: (user) => ({ ...headers, ...(perUser[user] ?? {}) }),
    writeDelay: 400,
    roomUrl: base.replace(/^http/, "ws") + "/api/room",
    roomName: "doc",
    pageUrl: (user) => `${base}/?user=${encodeURIComponent(user)}`,
    fetch: (p, init = {}, user) => fetch(base + p, { ...init, headers: { ...(user ? doc.headersFor(user) : headers), ...(init.headers as Record<string, string> | undefined) } }),
    async stored(p) {
      const r = await doc.fetch(`/api/stored/${p.split("/").map(encodeURIComponent).join("/")}`);
      if (r.status == 404) return null;
      if (!r.ok) throw new Error(`stored ${p}: ${r.status}`);
      return { text: await r.text(), etag: (r.headers.get("etag") ?? "").replace(/"/g, "") };
    },
    push: (p, text, ifMatch = null) => doc.fetch(`/api/stored/${p.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", body: text, headers: ifMatch ? { "If-Match": `"${ifMatch}"` } : {} }),
    async served(p) {
      const r = await doc.fetch(`/doc/${p.split("/").map(encodeURIComponent).join("/")}`);
      return r.ok ? r.text() : null;
    },
    ...extra,
  };
  return doc;
}

// ------------------------------------------------------------ local

export class LocalTarget implements Target {
  name = "local";
  parallel = true;
  caps: Set<Capability>;
  private shared: Promise<Host> | null = null;
  constructor(private opts: { liveAgent?: boolean; browser?: boolean } = {}) {
    this.caps = new Set<Capability>(["restart", "kill", "disk", "roles", opts.liveAgent ? "liveAgent" : "scriptedAgent", ...(opts.browser === false ? [] : ["browser" as const])]);
  }

  /**
   * A short write delay: the suite waits on storage a lot, and aims at the
   * delay where it matters. Not too short: tests share a server, and one
   * that makes an edit "not yet stored" needs the next request in first.
   */
  private env(): Record<string, string> {
    const env: Record<string, string> = { ERGA_WRITE_DELAY_MS: "200" };
    if (this.opts.liveAgent) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
    else env.ERGA_AGENT_MODEL = "script";
    return env;
  }

  async newDoc(fixture: string, needs: Capability[] = []): Promise<Doc> {
    const dir = mkdtempSync(join(tmpdir(), "erga-suite-"));
    cpSync(join(FIXTURES, fixture), dir, { recursive: true });
    const writeDisk = (p: string, data: string | Uint8Array) => { const full = join(dir, p); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, data); };
    const own = needs.includes("restart") || needs.includes("kill");
    // The folder opens as a document of its own, edited in place, at an address that stays the same across restarts.
    const host = own ? await startHost(dir, { env: this.env() }) : await (this.shared ??= startHost(null, { env: this.env() }));
    const base = own ? host.base : await host.open(dir);
    const info = (await (await fetch(`${base}/api/doc`)).json()) as { writeDelay?: number; docName?: { id: string } };
    const writeDelay = info.writeDelay ?? 400;
    return makeDoc(base, {}, readFixture(fixture), {
      writeDelay,
      writeDisk,
      // As the dev server's own person (DEV_LOGIN), who opened it from disk and owns it.
      async share(user: string, role: "editor" | "viewer" | null) {
        const r = await fetch(`${host.root}/docs/share`, { method: "POST", headers: { Origin: host.root }, body: new URLSearchParams({ id: info.docName!.id, login: user, role: role ?? "none" }) });
        if (!r.ok) throw new Error(`sharing with ${user}: ${r.status} ${await r.text()}`);
      },
      ...(own ? {
        async restart(how: "graceful" | "kill" | "lose-state", whileDown?: () => Promise<void>) {
          await host.stop(how == "graceful" ? "SIGTERM" : "SIGKILL");
          // The documents' storage goes, the room's saved state with it; the folder is linked afresh on start.
          if (how == "lose-state") rmSync(join(host.state, "v3"), { recursive: true, force: true });
          await whileDown?.();
          await host.start();
        },
      } : {}),
      async dispose() {
        if (own) await host.dispose();
        else await host.forget(base);
        rmSync(dir, { recursive: true, force: true });
      },
    });
  }

  async close() {
    await (await this.shared)?.dispose();
  }
}

// ------------------------------------------------------------ remote

export class RemoteTarget implements Target {
  name: string;
  /** One scratch document for every test: one at a time. */
  parallel = false;
  caps: Set<Capability>;
  private base: string;
  private headers: Record<string, string>;
  private users: Record<string, Record<string, string>>;
  private newDocUrl = process.env.ERGA_TARGET_NEW_DOC;

  constructor() {
    const url = process.env.ERGA_TARGET_DOC;
    if (!url) throw new Error("set ERGA_TARGET_DOC to a scratch document's URL");
    if (!/test/i.test(url)) throw new Error(`refusing ${url}: the suite rewrites the document, so its URL must contain "test"`);
    this.base = url.replace(/\/+$/, "");
    this.name = `remote ${this.base}`;
    this.headers = { ...JSON.parse(process.env.ERGA_TARGET_HEADERS || "{}") };
    if (process.env.ERGA_TARGET_COOKIE) this.headers.Cookie = process.env.ERGA_TARGET_COOKIE;
    // Each test person signed in as their own account, so the server sees different people.
    this.users = JSON.parse(process.env.ERGA_TARGET_USERS || "{}");
    this.caps = new Set((process.env.ERGA_TARGET_CAPS || "browser").split(",").map((s) => s.trim()).filter(Boolean) as Capability[]);
    this.parallel = !!this.newDocUrl;
  }

  /** A fresh document from ERGA_TARGET_NEW_DOC, or else the one scratch document. */
  private async docBase(): Promise<string> {
    if (!this.newDocUrl) return this.base;
    const id = "test" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    const r = await fetch(this.newDocUrl.replace("{id}", id), { headers: this.headers, redirect: "manual" });
    const location = r.headers.get("location");
    if (r.status != 302 || !location) throw new Error(`making a test document: ${r.status} ${await r.text()}`);
    return new URL(location, this.newDocUrl).toString().replace(/\/+$/, "");
  }

  /**
   * One scratch document, reset to the fixture for each test: every fixture
   * file is pushed as a publish would. Tests that make new files give them
   * unique names; tests run one at a time, so they don't see each other.
   */
  async newDoc(fixture: string): Promise<Doc> {
    const files = readFixture(fixture);
    const base = await this.docBase();
    const doc = makeDoc(base, this.headers, files, { async dispose() {} }, this.users);
    const info = await doc.fetch("/api/doc");
    if (!info.ok) throw new Error(`${base}/api/doc answered ${info.status}`);
    doc.writeDelay = ((await info.json()) as { writeDelay?: number }).writeDelay ?? 400;
    for (const [p, text] of Object.entries(files)) {
      const r = await doc.push(p, text);
      if (!r.ok) throw new Error(`resetting ${p}: ${r.status} ${await r.text()}`);
    }
    // Agent sessions from earlier tests start over (a fresh document has none,
    // and asking would start them, as extra participants).
    if (!this.newDocUrl) for (const user of ["Ada", "Bo", "Cy"]) await doc.fetch(`/api/agent/reset?user=${user}`, { method: "POST" }, user).catch(() => {});
    return doc;
  }

  async close() {}
}
