// "Share with an agent" on every admin page (server/admin/layout.ts: the icon in the header bar, upper right, as in the
// editor): the same menu as on every page (client/common/agent-menu.ts), with Admin picked for the token. Built by
// client/build.ts to admin-share.js.

import { mountAgentMenu } from "../common/agent-menu";

const button = document.getElementById("btn-share");
if (button) mountAgentMenu({ button, root: document, address: () => location.pathname, tokens: true, scope: "admin" });
