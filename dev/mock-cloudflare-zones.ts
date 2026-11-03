// The pretend Cloudflare's zones (dev/mock-cloudflare.ts): the account's zones (a pending one has the name servers
// Cloudflare gave it, and the ones it had before), their DNS records, routes and certificates; Workers' custom domains;
// and Registrar. As Cloudflare does: a custom domain on a name with a DNS record of its own is refused unless the
// request says override_existing_dns_record; a new custom domain answers only once its certificate is there (`certMs`
// after it was added).
//
// Registrar: a name with "taken" in it is taken, ".xyz" can't be registered through the API, ".dev" costs 12.18 USD
// and anything else 10.44.

import { createHash } from "node:crypto";
import type { MockState } from "./mock-cloudflare";

/** A custom domain's id: fixed by its hostname, here. */
export const domainId = (hostname: string) => createHash("md5").update(`domain:${hostname}`).digest("hex");

interface Answers {
  ok: (result: unknown, status?: number) => Response;
  fail: (status: number, code: number, message: string) => Response;
  randomHex: (n: number) => string;
  /** How long a new custom domain waits for its certificate. */
  certMs: number;
}

/** A custom domain whose certificate isn't there yet: a browser (or fetch) can't reach it. */
export const waitsForCertificate = (state: MockState, host: string) =>
  (state.domains.find((d) => d.hostname == host)?.readyAt ?? 0) > Date.now();

/** An account's custom domains and Registrar (`rest`: the path after /accounts/<id>): an answer, or null. */
export async function accountZones(state: MockState, a: Answers, m: string, rest: string, req: Request): Promise<Response | null> {
  const { ok, fail } = a;
  const body = async () => (req.headers.get("content-type")?.includes("json") ? ((await req.json()) as any) : null);
  let r: RegExpExecArray | null;
  if (m == "GET" && rest.startsWith("/workers/domains")) {
    const q = new URLSearchParams(rest.split("?")[1] ?? ""),
      hostname = q.get("hostname"),
      service = q.get("service");
    return ok(
      state.domains
        .filter((d) => (!hostname || d.hostname == hostname) && (!service || d.service == service))
        .map(({ readyAt: _, ...d }) => ({ id: domainId(d.hostname), zone_name: state.zones.find((z) => z.id == d.zone_id)?.name, ...d }))
    );
  }
  if (m == "DELETE" && (r = /^\/workers\/domains\/([0-9a-f]+)$/.exec(rest))) {
    const d = state.domains.find((x) => domainId(x.hostname) == r![1]);
    if (!d) return fail(404, 100114, "Domain not found");
    state.domains = state.domains.filter((x) => x != d);
    return ok(null);
  }
  if (m == "PUT" && rest == "/workers/domains") {
    const d = await body();
    if (!d.hostname || !d.service) return fail(400, 100101, "hostname and service are required");
    if (!state.scripts[d.service]) return fail(400, 100103, `Worker ${d.service} not found`);
    const zone = state.zones.find((z) => z.id == d.zone_id && (d.hostname == z.name || d.hostname.endsWith(`.${z.name}`)));
    if (!zone) return fail(400, 100117, "Hostname is not in the zone");
    if (zone.status != "active") return fail(400, 100117, `The zone ${zone.name} is not active yet`);
    if (state.domains.some((x) => x.hostname == d.hostname && x.service != d.service))
      return fail(409, 100116, "Hostname is already in use by another Worker");
    const records = state.dns[d.zone_id] ?? [];
    if (records.some((x) => x.name == d.hostname)) {
      if (!d.override_existing_dns_record)
        return fail(
          409,
          100117,
          "Hostname already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override."
        );
      state.dns[d.zone_id] = records.filter((x) => x.name != d.hostname);
    }
    const was = state.domains.find((x) => x.hostname == d.hostname);
    state.domains = state.domains.filter((x) => x.hostname != d.hostname);
    const readyAt = was ? was.readyAt : a.certMs ? Date.now() + a.certMs : undefined;
    state.domains.push({ hostname: d.hostname, service: d.service, zone_id: d.zone_id, ...(readyAt ? { readyAt } : {}) });
    return ok({ id: domainId(d.hostname), hostname: d.hostname, service: d.service, zone_id: d.zone_id });
  }
  if (m == "GET" && rest.startsWith("/registrar/domain-search?")) {
    const q = (new URLSearchParams(rest.split("?")[1]).get("q") ?? "").replace(/\..*$/, "");
    return ok({ domains: [".com", ".dev", ".app", ".xyz"].map((tld) => ({ name: `${q}${tld}` })) });
  }
  if (m == "POST" && rest == "/registrar/domain-check") {
    const { domains } = (await body()) as { domains: string[] };
    return ok({ domains: domains.map(check) });
  }
  if (m == "POST" && rest == "/registrar/registrations") {
    const { domain_name } = await body();
    const c = check(domain_name);
    if (!c.registrable) return fail(400, 10500, `${domain_name} is not available`);
    state.registrations.push({ domain: domain_name, price: c.pricing?.registration_cost });
    state.zones.push({ id: `zone${a.randomHex(14)}`, name: domain_name, status: "active" });
    return ok({ domain_name, state: "succeeded", completed: true, context: { registration: { status: "active" } } }, 201);
  }
  if (m == "GET" && (r = /^\/registrar\/registrations\/([^/]+)\/registration-status$/.exec(rest))) {
    const done = state.registrations.some((x) => x.domain == decodeURIComponent(r![1]));
    return done ? ok({ domain_name: r[1], state: "succeeded", completed: true }) : fail(404, 10404, "no such registration");
  }
  return null;
}

/** /zones and /zones/<id>/...: an answer, or null. */
export async function zones(state: MockState, a: Answers, m: string, path: string, req: Request): Promise<Response | null> {
  const { ok, fail } = a;
  const shown = (z: MockState["zones"][number]) => ({ ...z, account: { id: state.account.id, name: state.account.name } });
  if (m == "GET" && path.startsWith("/zones?")) {
    const q = new URLSearchParams(path.split("?")[1]),
      name = q.get("name");
    return ok(state.zones.filter((z) => !name || z.name == name).map(shown));
  }
  const r = /^\/zones\/([^/?]+)(\/[^?]*)?(?:\?(.*))?$/.exec(path);
  if (!r) return null;
  const [, zone, rest = "", query] = r;
  const z = state.zones.find((x) => x.id == zone);
  if (!z) return fail(404, 1001, "Invalid zone identifier");
  const body = async () => (await req.json()) as any;
  if (rest == "" && m == "GET") return ok(shown(z));
  if (rest == "/dns_records") {
    const list = (state.dns[zone] ??= []);
    if (m == "GET") {
      const p = new URLSearchParams(query);
      return ok(list.filter((x) => (!p.get("type") || x.type == p.get("type")) && (!p.get("name") || x.name == p.get("name"))));
    }
    if (m == "POST") {
      const d = await body();
      list.push({ type: d.type, name: d.name, content: d.content, proxied: d.proxied });
      return ok(d);
    }
  }
  if (rest == "/workers/routes") {
    const list = (state.routes[zone] ??= []);
    if (m == "GET") return ok(list);
    if (m == "POST") {
      const d = await body();
      list.push({ pattern: d.pattern, script: d.script });
      return ok({ id: a.randomHex(16), ...d });
    }
  }
  return null;
}

function check(name: string) {
  if (name.includes("taken")) return { name, registrable: false, reason: "domain_unavailable" };
  if (name.endsWith(".xyz")) return { name, registrable: false, reason: "extension_not_supported_via_api" };
  const cost = name.endsWith(".dev") ? "12.18" : "10.44";
  return { name, registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: cost, renewal_cost: cost } };
}
