// erga/steps (steps.js, at /erga/steps/editor.js on each server): a presentation's page imports it itself, and defines
// window.ergaSteps (the contract: ../api/steps.ts). It draws the bar and the list of the steps (steps.ts), in Erga's
// viewer and in a page served as it is (the homepage's site). The page's text is erga/text's to edit, as on any page: Erga adds it.

import { mountSteps } from "./steps";

mountSteps();
