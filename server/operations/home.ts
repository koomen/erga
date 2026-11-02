// The homepage: whether a document is the homepage and how its deploy goes (ls answers it, and the editor's settings
// show it on the homepage), and its deploy again now (Redeploy there; admins only: the redeploy operation, with the
// target homepage, control/deploys/operations.ts). The homepage itself is chosen on
// /admin (the landing_document setting), never from the document.

import type { DocRow } from "../directory/index.ts";
import { forgetHome } from "../home/index.ts";
import { byLine } from "../../shared/attribution.ts";
import { type Caller, OperationError, platformOf } from "./operation.ts";

/**
 * The homepage's state, for ls, if `doc` is the homepage (else null): how its deploy goes, whether the caller may
 * redeploy it (canDeploy: admin power), and locked: an admin acting without admin power (a token without the admin scope).
 */
export async function homepageOf(caller: Caller, doc: DocRow) {
  const { dir, who } = caller;
  if (doc.test || (await dir.homeId()) != doc.id) return null;
  const [admin, unlocked] = await Promise.all([dir.users.isAdmin(who), dir.users.actsAsAdmin(who)]);
  return { isHome: true, canDeploy: unlocked, locked: admin && !unlocked, deploy: await platformOf(caller).home.status() };
}

/** Deploys the homepage again now, as `caller` (an admin: the redeploy operation checks), as Redeploy in its settings does. */
export async function redeployHome(caller: Caller) {
  const { dir, who } = caller;
  if (!(await dir.homeId()))
    throw new OperationError({
      message: "No document is the homepage (the landing_document setting): there's nothing to deploy.",
      status: 409,
    });
  const platform = platformOf(caller);
  const deploy = await platform.home.deploy(byLine(who.login, who.via));
  // This isolate forgets the snapshot it serves; the others ask the home object again.
  if (caller.origin) await forgetHome(platform, new URL(caller.origin)).catch(() => {});
  return { isHome: true, canDeploy: true, locked: false, deploy };
}
