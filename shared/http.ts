// Where a request came from, and whether its host is this machine. Here, not in server/, so that every layer has them.

/** Whether `url` is on this machine: localhost, a name under it (a document's pages in local development), or a loopback address. */
export const isLocal = (url: URL) =>
  url.hostname == "localhost" || url.hostname.endsWith(".localhost") || url.hostname == "127.0.0.1" || url.hostname == "[::1]";

/**
 * The address a request came from, as the edge in front of the server saw it: Cloudflare's header (which can't be
 * sent from outside), else the last address of X-Forwarded-For, which the edge adds itself (AWS's proxy,
 * CloudFront: the server's port is open to them only). Null with neither (local development).
 */
export const callerAddress = (headers: Headers): string | null =>
  headers.get("cf-connecting-ip") ?? (headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null);
