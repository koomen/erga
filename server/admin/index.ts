// The server's admin pages (/admin: settings, their change log, users, API
// keys, sign-in), the layout they share, and each admin's agent. The rest of
// the app imports admin through this file.

export { AdminAgents, adminAgentApi, adminGuideApi, isAdminAgentPath, type AdminAgentObject, type AdminAgentsDeps, type DashboardDeploys } from "./agent.ts";
export { adminGate, adminLayout, adminResponse, isAdminPath, LAYOUT_STYLE, type AdminLayout, type AdminSection } from "./layout.ts";
export { adminDoor, credentialRow, settingRow } from "./pages.ts";
