// What the tests of the gate's core share (tests/gate-core.test.ts, tests/gate-agents.test.ts): the four settings, a
// request as the core reads it, and its values made and forged.

import {
  after as afterAs,
  type Answer,
  type Caller,
  callerOf,
  type Config,
  FORM,
  gate,
  parseForm,
  type Req,
  seal,
} from "../../gate/core.ts";
import { webPort as port } from "../../gate/port.ts";

export { gate, port };
export const KEY = "edge-key-1";
export const NOW = 1_800_000_000_000;
export const now = NOW / 1000;
export const IDP = { authorize: "https://idp.example.com/authorize", client: "client-1", scope: "openid email profile" };

/** SSO, content on another site. */
export const sso: Config = {
  key: KEY,
  shell: "erga.example.com",
  content: "pages.example.net",
  https: true,
  open: false,
  idp: { sso: IDP },
  oauth: true,
};
/** SSO, content under the shell's host. */
export const near: Config = { ...sso, content: "pages.erga.example.com" };
/** OAuth: anyone may come in. */
export const oauth: Config = { ...sso, open: true, idp: { github: IDP, google: IDP }, chooser: "/auth/sign-in" };
/** SSO behind Cloudflare Access. */
export const access: Config = { ...sso, idp: "access" };

export const ADA = { p: "sso", sub: "sub-ada", email: "ada@example.com", name: "Ada" };

export function req(
  url: string,
  o: Partial<Req> & { cookie?: Record<string, string | string[]>; dest?: string; bearer?: string; form?: string } = {}
): Req {
  const u = new URL(url);
  const cookies: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o.cookie ?? {})) cookies[k] = Array.isArray(v) ? v : [v];
  return {
    method: "GET",
    host: u.host,
    path: u.pathname,
    query: parseForm(u.search.slice(1)),
    headers: {
      ...(o.dest ? { "sec-fetch-dest": o.dest } : {}),
      ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
      ...(o.form != null ? { [FORM]: o.form } : {}),
    },
    cookies,
    id: "req-1",
    now: NOW,
    ...o,
  };
}


/** What Erga's answer asks, for the caller the gate finds on the request (as a mount calls it). */
export const after = async (q: Req, c: Config, p: typeof port, ask: string | null) => {
  const who = await callerOf(q, c, p);
  return afterAs(q, c, p, ask, who == "bad" ? { kind: "none" } : who);
};

export type Respond = Extract<Answer, { do: "respond" }>;
export const responded = (a: Answer): Respond => {
  if (a.do != "respond") throw new Error(`expected an answer, got ${a.do}`);
  return a;
};
export const forwarded = (a: Answer): Caller => {
  if (a.do != "forward") throw new Error(`expected a forward, got ${JSON.stringify(a)}`);
  return a.caller;
};
/** The cookies an answer sets, by name: value and attributes. */
export const set = (cookies: string[]) =>
  Object.fromEntries(
    cookies.map((c) => {
      const [pair, ...attrs] = c.split("; ");
      const at = pair.indexOf("=");
      return [pair.slice(0, at), { value: pair.slice(at + 1), attrs }];
    })
  );
export const shellCookie = (c: Config, who = ADA, e = now + 3600, i = NOW) => seal(port, c.key, "s", { ...who, i }, e);
export const memberCookie = (c: Config, e = now + 3600) => seal(port, c.key, "m", {}, e);
/** A value with one character of its claims changed, under the old signature. */
export const forged = (v: string) => v.replace(/\.(.)/, (_m, ch) => `.${ch == "A" ? "B" : "A"}`);

/** Where a hand-off's page goes on to (core.ts, hop): the address in its meta refresh. */
export const hopOf = (html: string) =>
  (/^<!doctype html><meta http-equiv="refresh" content="0;url=([^"]*)">$/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");
/** A hand-off's step: a page that runs nothing and goes on by itself. Where to. */
export const hopped = (a: Answer): string => {
  const r = responded(a);
  if (
    r.status != 200 ||
    r.headers["content-type"] != "text/html; charset=utf-8" ||
    r.headers["content-security-policy"] != "default-src 'none'"
  )
    throw new Error(`expected a page that goes on, got ${r.status}`);
  return hopOf(r.body);
};

/**
 * A pretend browser: it keeps cookies by host, Domain and Path, sends each request the cookies that are its host's
 * and its path's, and follows redirects. (It keeps no partitions: one frame under one tab.)
 */
export function browser(fetcher: (request: Request) => Promise<Response>) {
  const jar: { name: string; value: string; host: string; domain: boolean; path: string; none: boolean }[] = [];
  /** A cookie's Path covers a request's path: the same, or a folder above it (RFC 6265, 5.1.4). */
  const under = (path: string, at: string) => at == path || (at.startsWith(path) && (path.endsWith("/") || at[path.length] == "/"));
  const cookiesFor = (host: string, at?: string) =>
    jar.filter((c) => (c.domain ? host == c.host || host.endsWith(`.${c.host}`) : host == c.host) && (at == null || under(c.path, at)));
  const keep = (host: string, from: string, line: string) => {
    const [pair, ...attrs] = line.split("; ");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at),
      value = pair.slice(at + 1);
    const domain = attrs.find((a) => a.startsWith("Domain="))?.slice(7);
    // __Host- cookies take no Domain; a Domain must be the host's own or a parent's.
    if (name.startsWith("__Host-") && (domain || !attrs.includes("Secure"))) return;
    if (domain && !(host == domain || host.endsWith(`.${domain}`))) return;
    // No Path: the folder of the request's path.
    const path = attrs.find((a) => a.startsWith("Path="))?.slice(5) ?? (from.slice(0, from.lastIndexOf("/")) || "/");
    const i = jar.findIndex((c) => c.name == name && c.host == (domain ?? host) && c.path == path);
    if (i >= 0) jar.splice(i, 1);
    if (!attrs.includes("Max-Age=0"))
      jar.push({ name, value, host: domain ?? host, domain: !!domain, path, none: attrs.includes("SameSite=None") });
  };
  const trail: string[] = [];
  /** `frame`: a frame's page under the shell's tab; a request that came through another site carries only SameSite=None cookies. */
  async function go(
    url: string,
    o: { method?: string; headers?: Record<string, string>; body?: string; dest?: string; frame?: boolean } = {}
  ): Promise<Response> {
    let at = new URL(url);
    let crossed = false;
    for (let hop = 0; hop < 12; hop++) {
      trail.push(`${at.host}${at.pathname}`);
      const cookies = cookiesFor(at.host, at.pathname).filter((c) => !(o.frame && crossed) || c.none);
      const headers = new Headers({ "sec-fetch-dest": o.dest ?? (o.frame ? "iframe" : "document"), ...o.headers });
      if (cookies.length) headers.set("cookie", cookies.map((c) => `${c.name}=${c.value}`).join("; "));
      const answer = await fetcher(
        new Request(at, { method: hop ? "GET" : (o.method ?? "GET"), headers, body: hop ? undefined : o.body, redirect: "manual" })
      );
      for (const line of answer.headers.getSetCookie()) keep(at.host, at.pathname, line);
      let to = answer.status >= 300 && answer.status < 400 ? answer.headers.get("location") : null;
      // A hand-off's page goes on by itself (a meta refresh).
      const page = !to && answer.headers.get("content-type")?.startsWith("text/html") ? await answer.clone().text() : "";
      if (page.includes('http-equiv="refresh"')) to = hopOf(page);
      if (!to) return answer;
      const next = new URL(to, at);
      if (next.host.split(".").slice(-2).join(".") != at.host.split(".").slice(-2).join(".")) crossed = true;
      at = next;
    }
    throw new Error("too many redirects");
  }
  return { go, jar, trail, cookie: (name: string, host: string) => cookiesFor(host).find((c) => c.name == name) };
}
