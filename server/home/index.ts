// The homepage: the homepage's document served directly at /, from a
// snapshot its deploys make. The rest of the app imports the homepage through
// this file.

export { HomeDeploys, type HomeObject } from "./deploys.ts";
export { HOME_FILES, homeHeader, IDLE, renderHome } from "./render.ts";
export { forgetHome, homePageOf, HOME_PAGES, serveHome, serveHomeFile, serveHomePage, serveHomeRoot } from "./serve.ts";
