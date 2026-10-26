// The HTML the server renders, and nothing of the routing: the viewer's scripts and styles,
// the documents list, the start page, the page's own script (reader.ts), the account corner, the
// templates, and what every page shares (pages/chrome.ts). The rest of the app imports
// pages through this file.

export { appPage, confirmAction, crumbs, crumbsFont, esc, fromElsewhere, ICON, link, page, safeNext, signInFirst, TIMES_SCRIPT, viewCrumbs, withEdit } from "./chrome.ts";
export { docsPage } from "./docs.ts";
export { EDITOR_ALLOW, PAGE_ALLOW, PAGE_SANDBOX, readerPage, readerScript, readerVersion } from "./reader.ts";
export { startPage } from "./start.ts";
export { cloneButton, editButton, FADE, filesButton, RESTORE_KEY, VIEW_STYLE, viewerPage } from "./viewer.ts";
export { filesPage } from "./files.ts";
export { type Account, ACCOUNT_STYLE, accountHtml, accountMarkup, accountOf, OWN_ACCOUNT, signInUrl, withAccount } from "./account-menu.ts";
export { imgFallbackScript } from "./account-menu.ts";
export { NEW_DOC_SCRIPT, NEW_DOC_STYLE, newDocButton, newDocMenu, type Template, templateById, TEMPLATES } from "./templates.ts";
export { inlineCall, inlineScript } from "./inline.ts";
export { asset, assetManifest, assetScripts, fontTags, isAssetPath, loadAssets, remoteAssets, scriptTag, serveAsset, styleTag, useAssets } from "./assets.ts";
