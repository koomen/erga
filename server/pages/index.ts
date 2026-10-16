// The HTML the server renders, and nothing of the routing: the viewer's scripts and styles,
// the documents list, the start page, the frame's host page, the account corner, the
// templates, and what every page shares (pages/chrome.ts). The rest of the app imports
// pages through this file.

export { appPage, confirmAction, crumbs, crumbsFont, esc, fromElsewhere, ICON, link, page, safeNext, signInFirst, TIMES_SCRIPT, viewCrumbs } from "./chrome.ts";
export { docsPage } from "./docs.ts";
export { HOST_SCRIPT, HOST_STYLE, HOST_VERSION, PAGE_ALLOW, PAGE_SANDBOX, VIEW_FILES } from "./frame-host.ts";
export { startPage } from "./start.ts";
export { cloneButton, editButton, FADE, RESTORE_KEY, VIEW_STYLE, viewerPage } from "./viewer.ts";
export { type Account, ACCOUNT_STYLE, accountHtml, accountMarkup, accountOf, avatarsOf, avatarUrl, OWN_ACCOUNT, signInUrl, withAccount } from "./account-menu.ts";
export { NEW_DOC_SCRIPT, NEW_DOC_STYLE, newDocButton, newDocMenu, pickerRows, type Template, TEMPLATE_GROUPS, templateById, type TemplateGroup, TEMPLATES } from "./templates.ts";
