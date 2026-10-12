// The document agent's and the admin agent's settings, as they are now: the
// Anthropic key an admin stored on /admin/api-keys, else the
// Worker secret. Read at each turn (one row of D1), so a key an admin stores,
// replaces or clears reaches every agent at its next turn, with no reload.

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { agentConfigFrom, type AgentConfig } from "../editor-agent/session";
import { CREDENTIALS, type Credentials } from "../server/directory/index.ts";
import { directoryOf } from "./d1";
import type { Env } from "./env";

/** What the agent pane says when the stored key doesn't open on this server. */
export const UNREADABLE_KEY = "the Anthropic API key stored on /admin/api-keys doesn't open on this server: it was encrypted with another server's FACTORY_KEY. An admin must paste the key again on /admin/api-keys";

export const agentSettings = (env: Env) => agentSettingsFrom(env, env.DB ? directoryOf(env).credentials : null);

/** The same, from the Worker's bindings and the stored keys (none: the Worker secret only). */
export async function agentSettingsFrom(env: object, credentials: Pick<Credentials, "opened"> | null): Promise<AgentConfig | { missing: string }> {
  const name = CREDENTIALS.anthropic.env;
  const stored = credentials
    ? await credentials.opened("anthropic").catch((e: unknown) => {
      console.log(`couldn't read the stored ${CREDENTIALS.anthropic.label}, so the Worker secret stands: ${e instanceof Error ? e.message : e}`);
      return { key: null, unreadable: false };
    })
    : { key: null, unreadable: false };
  const cfg = await Effect.runPromise(agentConfigFrom(ConfigProvider.fromUnknown(stored.key ? { ...env, [name]: stored.key } : env)));
  // No key to use, but one is stored: say why it can't be used, not only that there's none.
  return "missing" in cfg && stored.unreadable && cfg.missing.startsWith(name) ? { missing: UNREADABLE_KEY } : cfg;
}
