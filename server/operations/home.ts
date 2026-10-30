// The homepage's operations: whether a document is the homepage and how its deploy goes (the editor's settings show
// it on the homepage), and its deploy again now (Redeploy there; admins only). The homepage itself is chosen on
// /admin (the landing_document setting), never from the document.

import * as Schema from "effect/Schema";
import { forgetHome, IDLE } from "../home/index.ts";
import { byLine } from "../../shared/attribution.ts";
import { DOCUMENT, findDocument, type Operation, OperationError, platformOf } from "./operation.ts";

export const HOME_OPERATIONS: Operation[] = [
  {
    name: "homepage_status",
    label: "Read the homepage's status",
    activity: "checking the homepage",
    ui: "The editor's settings: Homepage (on the homepage)",
    description:
      "Whether a document is the server's homepage (isHome), and if it is, how its deploy goes (deploy: idle, scheduled, deploying, deployed or failed, with when and any error); whether you may redeploy it (canDeploy: an admin, with admin power); and locked: an admin acting without admin power (a token without the admin scope).",
    parameters: Schema.Struct({ document: DOCUMENT }),
    run: async (args, caller) => {
      const doc = await findDocument(caller, args.document, "open");
      if (doc.test) throw new OperationError({ message: "There's no such document.", status: 404 });
      const { dir, who } = caller;
      const [isHome, admin, unlocked] = await Promise.all([
        dir.homeId().then((id) => id == doc.id),
        dir.users.isAdmin(who),
        dir.users.actsAsAdmin(who),
      ]);
      return {
        isHome,
        canDeploy: isHome && unlocked,
        locked: admin && !unlocked,
        deploy: isHome ? await platformOf(caller).home.status() : IDLE,
      };
    },
  },
  {
    name: "deploy_homepage",
    label: "Redeploy the homepage",
    activity: "deploying the homepage",
    admin: true,
    ui: "The editor's settings: Homepage, Redeploy now (on the homepage)",
    description:
      "Admins only. Deploys the homepage (the document the landing_document setting names, which set_setting changes) again now, as Redeploy in its settings does. Answers how the deploy goes. Only when the person asks.",
    parameters: Schema.Struct({}),
    run: async (_args, caller) => {
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
    },
  },
];
