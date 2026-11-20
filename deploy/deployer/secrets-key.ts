// The key that encrypts the secrets that the server stores (API keys, sign-in secrets) is SECRETS_KEY. Its name was
// FACTORY_KEY before. An instance from before holds the key under the old name, and no machine has its value. So the
// deploy of a release that reads SECRETS_KEY gives the key its new name where the platform keeps it, with its value:
//
//   Cloudflare   the Worker's upload asks Cloudflare to rename the secret (cloudflare.ts, the worker step). The value
//                never leaves Cloudflare.
//   AWS          `bun erga deploy` copies the parameter in Parameter Store, and the deploy after that deletes the old
//                one (deploy/aws/deploy.ts, moveSecretsKey): a rollback between the two finds the old name.
//
// A release from before reads the old name, and its deploy moves nothing.
//
// Trap: this file and every use of OLD_SECRETS_KEY are temporary. Remove them when every instance has moved.

import type { Release } from "./release-format";

export const SECRETS_KEY = "SECRETS_KEY";
export const OLD_SECRETS_KEY = "FACTORY_KEY";

/** Whether the release's server reads SECRETS_KEY: its build declares the secret (cloudflare.config.ts). */
export const readsSecretsKey = (release: Release) => release.worker.env[SECRETS_KEY]?.type == "secret";

/** The secrets' names after the key has its new name. */
export const movedNames = (names: readonly string[]) => [...new Set(names.map((n) => (n == OLD_SECRETS_KEY ? SECRETS_KEY : n)))].sort();
