// The homepage: the front page's document served directly at /, from a
// snapshot its deploys make. The rest of the app imports the homepage through
// this file.

export { homeApi } from "./api.ts";
export { HomeDeploys, type HomeDeps, type HomeObject, type LivePage, type HomeFiles } from "./deploys.ts";
export { addressOf, BAND, homeHeader, renderHome, type DeployStatus, HOME_FILES, IDLE } from "./render.ts";
export { forgetHome, serveHome, serveHomeFile, serveHomeRoot } from "./serve.ts";
