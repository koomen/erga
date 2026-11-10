// Which addresses are private: the machine itself, a private network, a cloud's metadata service. The server's own
// browser (cloudflare/render.ts: the Chrome on the AWS host, or local development's) refuses each request to one, so a
// page can't make it look at a service that the public can't reach. It reads only the address as written: a public
// name that the DNS sends to a private address passes.

/** Whether `a.b.c.d` is not a public address: this machine, a private or link-local network, or a reserved range. */
function privateV4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a == 0 ||
    a == 10 ||
    a == 127 ||
    (a == 100 && b >= 64 && b <= 127) ||
    (a == 169 && b == 254) ||
    (a == 172 && b >= 16 && b <= 31) ||
    (a == 192 && b == 168) ||
    (a == 192 && b == 0 && parts[2] == 0) ||
    (a == 198 && (b == 18 || b == 19)) ||
    a >= 224
  );
}

/** Whether an IPv6 address (as a URL writes it, without the brackets) is not a public one. */
function privateV6(host: string): boolean {
  // An IPv4 address inside one (::ffff:7f00:1, ::7f00:1, 64:ff9b::7f00:1): by its last 32 bits.
  const mapped = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16),
      lo = parseInt(mapped[2], 16);
    return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (host == "::" || host == "::1") return true;
  const first = parseInt(host.split(":")[0] || "0", 16);
  // fc00::/7 (private), fe80::/10 (link-local), ff00::/8 (multicast).
  return (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || (first & 0xff00) == 0xff00;
}

/** Whether a host, as a URL has it, is private: an address in a private range, or a name that only a private network knows. */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return privateV6(host.slice(1, -1));
  // (A URL writes every form of an IPv4 address, 2130706433 or 0x7f.1, as four numbers.)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateV4(host.split(".").map(Number));
  return !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host);
}

/**
 * Whether the server's own browser may ask for `url`: one of `own` (Erga's own origins, wherever they are), or an
 * http(s) or WebSocket address that isn't private. An address of no network (data:, blob:, about:) always.
 */
export function reachable(url: string, own: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return /^(data|blob|about):$/.test(u.protocol);
  const origin = `${u.protocol.replace("ws", "http")}//${u.host}`;
  return own.includes(origin) || !privateHost(u.hostname);
}
