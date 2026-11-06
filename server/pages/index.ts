// The HTML the server renders, and nothing of the routing: the viewer's scripts and styles,
// the documents list, the start page, the page's own script (reader.ts), the account corner, the
// templates, and what every page shares (pages/chrome.ts). The rest of the app imports
// pages through this file.

export {
  appPage,
  crumbsFont,
  fromElsewhere,
  homeGoesToDocs,
  ICON,
  link,
  safeNext,
  signInFirst,
  TIMES_SCRIPT,
  withEdit,
} from "./chrome.ts";
export { docsPage, docsRows } from "./docs.ts";
export { readerPage, readerVersion } from "./reader.ts";
export { frontPage, startPage } from "./start.ts";
export { scratchMakeTip, scratchSave } from "./scratch.ts";
export { hasAgent } from "./agent.ts";
export { editButton, RESTORE_KEY, VIEW_STYLE, viewerPage } from "./viewer.ts";
export { AGENT_ICON, barsHtml, confirmAction, page, pageBars } from "./bars.ts";
export {
  type Account,
  ACCOUNT_STYLE,
  accountHtml,
  accountMarkup,
  accountOf,
  OWN_ACCOUNT,
  withAccount,
} from "./account-menu.ts";
export { NEW_DOC_STYLE, newDocMenu, type Template, templateById, TEMPLATES } from "./templates.ts";
export { inlineCall, inlineScript, inlineStyle } from "./inline.ts";
export {
  asset,
  assetManifest,
  assetScripts,
  fontTags,
  isAssetPath,
  libraryOf,
  serveLibrary,
  loadAssets,
  scriptTag,
  serveAsset,
  useAssets,
} from "./assets.ts";
