// The signed part of a new server's claim link (server/identity/claim.ts). Apart from the route, which makes pages,
// because `bun erga setup` seals one (deploy/own/cli.ts) and must run in a new clone, before any build (Trap: a
// page's import reaches .build/, which git ignores; tests/imports.test.ts holds it).

import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";

/** How long a claim link works. */
export const CLAIM_SECONDS = 30 * 60;

/** A claim: nothing but this server's signature and its end. Setup seals one with the server's SESSION_SECRET. */
export const Claim = signed("claim", Schema.Struct({}), CLAIM_SECONDS);
