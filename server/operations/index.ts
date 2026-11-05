// The operations: each thing a person can do on the server, defined once (operation.ts). The front end calls them
// over POST /api/tools/<name> (server/api.ts); every agent has them as tools, as its person (agents/tools.ts). The
// rest of the app imports operations through this file. documents/ and admin/ never do: documents/ imports admin/,
// and operations/ imports documents/.

import { ADMIN_OPERATIONS } from "./admin.ts";
import { DOCUMENT_OPERATIONS } from "./documents.ts";
import { EDITOR_OPERATIONS } from "./editor.ts";
import { FEEDBACK_OPERATIONS } from "./feedback.ts";
import { HOME_OPERATIONS } from "./home.ts";
import type { Operation } from "./operation.ts";

export {
  callDocument,
  type Caller,
  described,
  DOCUMENT,
  findDocument,
  offered,
  type Operation,
  OperationError,
  platformOf,
  runInDocument,
  runOperation,
} from "./operation.ts";
export { addFile, cleanFilePath, PAGE_RULES } from "./documents.ts";

/** Every operation. Add one here and the front end's API, every agent, REST and MCP have it. */
export const OPERATIONS: Operation[] = [
  ...DOCUMENT_OPERATIONS,
  ...EDITOR_OPERATIONS,
  ...ADMIN_OPERATIONS,
  ...HOME_OPERATIONS,
  ...FEEDBACK_OPERATIONS,
];
