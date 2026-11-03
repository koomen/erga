// erga/steps (steps.js, at https://erga.dev/erga/steps/editor.js): a presentation's page imports it itself, and defines
// window.ergaSteps (the contract: ../api/steps.ts). It draws the bar and the list of the steps (steps.ts), in Erga's
// viewer and in a page opened outside Erga. The page's text is erga/text's to edit, as on any page: Erga adds it.

import { mountSteps } from "./steps";

mountSteps();
