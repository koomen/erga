// The server's admin pages (/admin: settings, their change log, users, API
// keys, sign-in) and the layout they share. The rest of the app imports admin
// through this file. Each admin's agent is agents/admin/.

export {
  adminGate,
  adminResponse,
  adminSidebar,
  adminStyleTag,
  isAdminPath,
  SIDEBAR_EARLY_SCRIPT,
  SIDEBAR_SCRIPT,
  VIEW_SCRIPT,
  type AdminLayout,
} from "./layout.ts";
export { adminRoutes } from "./routes.ts";
