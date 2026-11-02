// The pages of Erga itself that a person may open (whoami's `pages`), for the quick search (⌘K,
// client/common/quick-search.ts): Documents, Settings and Source for everyone signed in, Deploy your own for those the
// deploy_page setting lets in, and the admin sections for a caller with admin power. The same checks as the pages
// themselves, so nobody is shown one they can't open.

import { ADMIN_PAGES } from "../admin/index.ts";
import type { Caller } from "./operation.ts";

export async function sitePages({ dir, who }: Caller): Promise<{ group: string; label: string; path: string }[]> {
  const [admin, mode, deployer] = await Promise.all([
    dir.users.actsAsAdmin(who),
    dir.config.get("deploy_page"),
    dir.users.hasDeploy(who),
  ]);
  const deploy = mode == "users" || (mode == "admins" && deployer);
  return [
    { group: "Pages", label: "Documents", path: "/docs" },
    { group: "Pages", label: "Settings", path: "#settings" },
    ...(deploy ? [{ group: "Pages", label: "Deploy your own", path: "/deploy" }] : []),
    { group: "Pages", label: "Source", path: "/git" },
    ...(admin ? ADMIN_PAGES.map((p) => ({ group: "Admin", label: p.label, path: p.path })) : []),
  ];
}
