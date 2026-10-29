// The control Worker's settings, from its bindings (control/env.ts says what each is), read with Effect's Config at
// each request: control/index.ts. APP_URL is the one it can't do without.

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

/** A text setting, trimmed: null when it's unset or blank. */
const setting = (name: string) =>
  Config.String(name).pipe(
    Config.map((s) => s.trim() || null),
    Config.withDefault(null)
  );
/** A secret, as it was set: "" when it isn't. */
const secret = (name: string) => Config.String(name).pipe(Config.withDefault(""));

/** The control Worker's settings, from its bindings (control/env.ts says what each is). */
const Settings = Config.all({
  app: Config.String("APP_URL"),
  // Unset, the deploys say so where they need it (control-worker.ts, branches.ts): the pages still answer.
  accountId: secret("CLOUDFLARE_ACCOUNT_ID"),
  upstream: setting("UPSTREAM").pipe(Config.map((s) => s?.replace(/\/+$/, "") || null)),
  forkSecret: secret("FORK_SECRET"),
  googleId: setting("GOOGLE_APP_CLIENT_ID"),
  googleSecret: setting("GOOGLE_APP_CLIENT_SECRET"),
  version: setting("ERGA_VERSION"),
  oauthClientId: setting("CLOUDFLARE_OAUTH_CLIENT_ID"),
  oauthSecret: secret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
});

export type ControlSettings = Config.Success<typeof Settings>;

/** The settings in `env` (the Worker's bindings). Throws only without APP_URL. */
export const controlSettings = (env: object): ControlSettings => Effect.runSync(Settings.parse(ConfigProvider.fromUnknown(env)));
