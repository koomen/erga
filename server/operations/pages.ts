// The pages of Erga itself that a person may open, for the quick search (⌘K, client/common/quick-search.ts): Documents,
// Settings and Source for everyone signed in, Deploy your own for those the deploy_page setting lets in, and the admin
// sections for a caller with admin power. The same checks as the pages themselves, so nobody is shown one they can't open.

import * as Schema from "effect/Schema";
import { ADMIN_PAGES } from "../admin/index.ts";
import type { Operation } from "./operation.ts";

export const PAGE_OPERATIONS: Operation[] = [
  {
    name: "site_pages",
    label: "List Erga's pages",
    activity: "listing Erga's pages",
    wide: true,
    ui: "The quick search (⌘K): its pages",
    description:
      "The pages of this Erga server (not documents) that the person may open: each one's group (Pages, or Admin), label and address. Admin pages only for a caller with admin power.",
    parameters: Schema.Struct({}),
    run: async (_args, { dir, who }) => {
      const [admin, mode, deployer] = await Promise.all([
        dir.users.actsAsAdmin(who),
        dir.config.get("deploy_page"),
        dir.users.hasDeploy(who),
      ]);
      const deploy = mode == "users" || (mode == "admins" && deployer);
      return [
        { group: "Pages", label: "Documents", path: "/docs" },
        { group: "Pages", label: "Settings", path: "/settings" },
        ...(deploy ? [{ group: "Pages", label: "Deploy your own", path: "/deploy" }] : []),
        { group: "Pages", label: "Source", path: "/git" },
        ...(admin ? ADMIN_PAGES.map((p) => ({ group: "Admin", label: p.label, path: p.path })) : []),
      ];
    },
  },
];
