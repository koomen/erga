// The dev server's log, without what a person can't act on: Vite's banner (dev/start.ts prints the
// address itself, once the server answers) and Vite's warnings about dynamic imports inside other
// packages (the agent's model libraries load their Node-only parts by name, which no Worker reaches).

import { createLogger, type Logger } from "vite";

const banner = (msg: string) => /\bVITE\b.*\bv\d|➜/.test(msg);
const dependencyImport = (msg: string) => msg.includes("dynamic import cannot be analyzed by Vite") && /[\\/](deps(_ssr)?|node_modules)[\\/]/.test(msg);

export function quietLogger(): Logger {
  const logger = createLogger();
  const { info, warn } = logger;
  logger.info = (msg, options) => { if (!banner(msg)) info(msg, options); };
  logger.warn = (msg, options) => { if (!dependencyImport(msg)) warn(msg, options); };
  return logger;
}
