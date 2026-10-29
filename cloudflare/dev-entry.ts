// The app Worker's entry in local development (cloudflare.config.ts picks
// it in development): the Worker as it is (index.ts), plus the control
// Worker's two Durable Objects, which the app hosts only here, over the mock
// Cloudflare, so the Ops page, the deploys and their tests run with
// `bun start`. On erga.dev and staging those classes are deleted tombstones,
// and Cloudflare refuses an upload whose code still exports a deleted class:
// so index.ts, the built entry, never exports them.
import type { HostEnv } from "../control/env";
import type { Env } from "./env";

export * from "./index.ts";
export { default } from "./index.ts";
export { Pipeline } from "../control/deploys/pipeline-object";
export { SourceHost } from "../control/source/source-host";

/** Those objects run here on the app's bindings: they must be a HostEnv (control/env.ts). */
type Hosts<E extends HostEnv> = E;
export type AppHostsControl = Hosts<Env>;
