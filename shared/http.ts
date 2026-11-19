// Where a request came from, and whether its host is this machine. Here, not in server/, so that every layer has them.

/** Whether `url` is on this machine: localhost, a name under it (a document's pages in local development), or a loopback address. */
export const isLocal = (url: URL) =>
  url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1" || url.hostname == "[::1]";

/**
 * A request's address as its browser asked it: over HTTPS, unless the server is on this machine. A deployed server is
 * reached over HTTPS only (Cloudflare's edge, CloudFront), whatever its own listener hears: celld behind CloudFront
 * hears plain HTTP, and CloudFront lets no function and no origin header say the scheme (X-Forwarded-Proto). So the
 * scheme comes from where the server is, never from a header: nothing from outside can change it. Null: as it is.
 */
export function overHttps(address: string): string | null {
  const url = new URL(address);
  if (url.protocol != "http:" || isLocal(url)) return null;
  url.protocol = "https:";
  return url.href;
}

/**
 * The address a request came from, as the edge in front of the server saw it: Cloudflare's header (which can't be
 * sent from outside), else the last address of X-Forwarded-For, which the edge adds itself (AWS's proxy,
 * CloudFront: the server's port is open to them only). Null with neither (local development).
 */
export const callerAddress = (headers: Headers): string | null =>
  headers.get("cf-connecting-ip") ?? (headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null);
