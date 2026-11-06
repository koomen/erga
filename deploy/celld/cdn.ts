// CloudFront in front of Caddy, for what HTTP caching can do: one distribution for the app's address and one for the
// pages' (PAGES_HOST). It keeps a response only when its Cache-Control lets a shared cache keep it (the editor's hashed
// files, the homepage's /_home-files/): no cookie or header is in the key, and a response with no max-age is never
// kept. Everything else, WebSockets too, goes through to Caddy. deploy/celld/README.md has the why.
//
// CloudFront sends Caddy the machine's own name as Host (its certificate), and the distribution's name as X-Erga-Host.
// Caddy passes that on as X-Forwarded-Host, which celld trusts (CELLD_TRUST_FORWARDED_HEADERS), so the Worker sees
// the address the browser asked for.

/** The AWS CLI's answer (aws.ts). */
type Aws = <T = any>(...args: string[]) => Promise<T>;

const NAME = "erga-celld";
const TAG = { Key: "erga", Value: "aws-provider" };
/** CloudFront's managed origin request policy AllViewerExceptHostHeader: cookies, headers and query to the origin. */
const ALL_BUT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
const POLICY = `${NAME}-origin-cache-control`;
const ORIGIN = "caddy";

export interface Names {
  app: string;
  pages: string;
}

/** The cache policy: the origin's Cache-Control decides (0 s without one), and only the URL is the key. */
async function cachePolicy(aws: Aws): Promise<string> {
  const mine = (await aws("cloudfront", "list-cache-policies", "--type", "custom")).CachePolicyList.Items?.find(
    (p: any) => p.CachePolicy.CachePolicyConfig.Name == POLICY
  );
  if (mine) return mine.CachePolicy.Id;
  const config = {
    Name: POLICY,
    Comment: "Erga on celld: the origin's Cache-Control decides",
    MinTTL: 0,
    DefaultTTL: 0,
    MaxTTL: 31536000,
    ParametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: true,
      EnableAcceptEncodingBrotli: true,
      HeadersConfig: { HeaderBehavior: "none" },
      CookiesConfig: { CookieBehavior: "none" },
      QueryStringsConfig: { QueryStringBehavior: "all" },
    },
  };
  return (await aws("cloudfront", "create-cache-policy", "--cache-policy-config", JSON.stringify(config))).CachePolicy.Id;
}

/** Each distribution of this deploy, by its comment (`erga-celld app`, `erga-celld pages`). */
async function distributions(aws: Aws): Promise<{ Id: string; DomainName: string; Comment: string }[]> {
  return ((await aws("cloudfront", "list-distributions")).DistributionList.Items ?? []).filter((d: any) =>
    d.Comment.startsWith(`${NAME} `)
  );
}

/** A distribution's config, for the machine's name `origin`, and `host` (its own name) in X-Erga-Host. */
function configOf(comment: string, origin: string, host: string, policy: string, reference: string) {
  return {
    CallerReference: reference,
    Comment: comment,
    Enabled: true,
    PriceClass: "PriceClass_100",
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: ORIGIN,
          DomainName: origin,
          CustomHeaders: { Quantity: 1, Items: [{ HeaderName: "X-Erga-Host", HeaderValue: host }] },
          CustomOriginConfig: {
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginProtocolPolicy: "https-only",
            OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
            OriginReadTimeout: 60,
            OriginKeepaliveTimeout: 5,
          },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: ORIGIN,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: true,
      CachePolicyId: policy,
      OriginRequestPolicyId: ALL_BUT_HOST,
    },
  };
}

/** Makes or updates the two distributions for the machine's names, waits until CloudFront serves them: their names. */
export async function cdnUp(aws: Aws, origins: Names, print: (line: string) => void): Promise<Names> {
  const policy = await cachePolicy(aws);
  const names: Partial<Names> = {};
  for (const part of ["app", "pages"] as const) {
    const comment = `${NAME} ${part}`;
    let d = (await distributions(aws)).find((x) => x.Comment == comment);
    if (!d) {
      const config = configOf(comment, origins[part], "pending", policy, `${comment} ${Date.now()}`);
      d = (
        await aws(
          "cloudfront",
          "create-distribution-with-tags",
          "--distribution-config-with-tags",
          JSON.stringify({ DistributionConfig: config, Tags: { Items: [TAG] } })
        )
      ).Distribution;
      print(`made the CloudFront distribution ${d!.Id} (${part})`);
    }
    // Its own name is known only once it's made: X-Erga-Host gets it now, and the origin follows a new machine.
    const { ETag, DistributionConfig: now } = await aws("cloudfront", "get-distribution-config", "--id", d!.Id);
    const origin = now.Origins.Items[0];
    if (origin.DomainName != origins[part] || origin.CustomHeaders.Items[0]?.HeaderValue != d!.DomainName || !now.Enabled) {
      // (The config as CloudFront has it, with every field it filled in: an update must give them all.)
      origin.DomainName = origins[part];
      origin.CustomHeaders = { Quantity: 1, Items: [{ HeaderName: "X-Erga-Host", HeaderValue: d!.DomainName }] };
      now.Enabled = true;
      await aws("cloudfront", "update-distribution", "--id", d!.Id, "--if-match", ETag, "--distribution-config", JSON.stringify(now));
      print(`set the CloudFront distribution ${d!.Id} to ${origins[part]}`);
    }
    names[part] = d!.DomainName;
  }
  for (const d of await distributions(aws)) await aws("cloudfront", "wait", "distribution-deployed", "--id", d.Id);
  return names as Names;
}

/** The Caddyfile: the machine's names, and X-Erga-Host as X-Forwarded-Host when it names one of the distributions. */
export function caddyfile(origins: Names, cdn: Names): string {
  const re = [cdn.app, cdn.pages].map((n) => n.replaceAll(".", "\\.")).join("|");
  return `${origins.app}, ${origins.pages} {
  @cloudfront header_regexp X-Erga-Host ^(${re})$
  handle @cloudfront {
    reverse_proxy 127.0.0.1:8080 {
      header_up X-Forwarded-Host {header.X-Erga-Host}
    }
  }
  handle {
    reverse_proxy 127.0.0.1:8080
  }
}
`;
}

/** Turns the distributions off, deletes them when CloudFront has (minutes each), then the cache policy. */
export async function cdnDown(aws: Aws, print: (line: string) => void): Promise<void> {
  for (const d of await distributions(aws)) {
    let { ETag, DistributionConfig: config } = await aws("cloudfront", "get-distribution-config", "--id", d.Id);
    if (config.Enabled) {
      ETag = (
        await aws(
          "cloudfront",
          "update-distribution",
          "--id",
          d.Id,
          "--if-match",
          ETag,
          "--distribution-config",
          JSON.stringify({ ...config, Enabled: false })
        )
      ).ETag;
    }
    await aws("cloudfront", "wait", "distribution-deployed", "--id", d.Id);
    await aws("cloudfront", "delete-distribution", "--id", d.Id, "--if-match", ETag);
    print(`deleted the CloudFront distribution ${d.Id}`);
  }
  const policy = (await aws("cloudfront", "list-cache-policies", "--type", "custom")).CachePolicyList.Items?.find(
    (p: any) => p.CachePolicy.CachePolicyConfig.Name == POLICY
  );
  if (policy) {
    const { ETag } = await aws("cloudfront", "get-cache-policy", "--id", policy.CachePolicy.Id);
    await aws("cloudfront", "delete-cache-policy", "--id", policy.CachePolicy.Id, "--if-match", ETag);
    print(`deleted the cache policy ${POLICY}`);
  }
}

/** What's left of it, for down's last line. */
export async function cdnLeft(aws: Aws): Promise<string[]> {
  return (await distributions(aws)).map((d) => `the CloudFront distribution ${d.Id}`);
}
