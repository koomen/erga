// Who may use the deploy page (/deploy): the deploy_page setting, and the deploy role.

import type { Directory } from "../directory/index.ts";
import { type Session, whoOf } from "../platform.ts";

/**
 * Who may use /deploy: the deploy_page setting (off, admins and those with
 * the deploy role, or users), and never a test person or an agent's token. It's a permission of its own: it
 * gives nothing of an admin's (settings, users, the factory).
 */
export async function mayDeploy(directory: Directory, session: Session | null): Promise<boolean> {
  if (!session || session.test || session.agent) return false;
  const mode = await directory.config.get("deploy_page");
  if (mode == "users") return true;
  return mode == "admins" && (await directory.users.hasDeploy(whoOf(session)));
}
