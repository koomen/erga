// The admin agent's own tool, beside the operations every agent has (agents/tools.ts; the Ops page's are operations
// too: control/operations.ts): the homepage's deploy. agents/admin/sessions.ts gives it to the agent with
// agents/tools.ts `agentTools`, which checks the admin first (`guard`).

import * as Schema from "effect/Schema";
import type { Tool } from "../tools";

/** The homepage (the landing_document setting) deployed again, as Redeploy in the editor's settings does. */
export function homeTools(deployHome: () => Promise<object>): Tool[] {
  return [
    {
      name: "deploy_homepage",
      label: "Redeploy the homepage",
      description:
        "Deploys the homepage (the document the landing_document setting names, which set_setting changes) again now, as Redeploy in that document's settings does in the editor.",
      parameters: Schema.Struct({}),
      run: () => deployHome(),
    },
  ];
}
