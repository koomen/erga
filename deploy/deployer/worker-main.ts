// The module that Cloudflare runs as the deployer (worker.ts has all of it): the Worker, with the platform's own ways
// out, and its store's class. Cloudflare refuses a module that exports anything else (a number, a plain function).

import { DeployerState, deployer } from "./worker";

/** The release that this code is of: the build writes it in (deploy/pipeline/deployer.ts, deployerModule). */
declare const ERGA_DEPLOYER_VERSION: string;

export { DeployerState };
// The platform's fetch, called as a function of its own: a Worker refuses it as a method of another object.
export default deployer({
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  version: ERGA_DEPLOYER_VERSION,
});
