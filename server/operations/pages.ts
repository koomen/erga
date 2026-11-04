// The pages of Erga itself that a person may open (whoami's `pages`), for the quick search (⌘K,
// client/common/quick-search.ts): Documents, Settings and Source for everyone signed in, and the admin sections for a
// caller with admin power. The same checks as the pages themselves, so nobody is shown one they can't open.

import { ADMIN_PAGES } from "../admin/index.ts";
import type { Caller } from "./operation.ts";

export async function sitePages({ dir, who }: Caller): Promise<{ group: string; label: string; path: string }[]> {
  const admin = await dir.users.actsAsAdmin(who);
  return [
    { group: "Pages", label: "Documents", path: "/docs" },
    { group: "Pages", label: "Settings", path: "#settings" },
    { group: "Pages", label: "Source", path: "/git" },
    ...(admin ? ADMIN_PAGES.map((p) => ({ group: "Admin", label: p.label, path: p.path })) : []),
  ];
}
