// A problem the page editor reported about a page (a file that didn't load, a
// script error), for the toast's "Fix with agent" (client/main.ts). The page
// editor runs on the page's origin, so the page's own script can write the
// report: the agent gets it as data in a block of its own, never as what the
// person asked (the editor agent's system prompt says so).

/** What the person asks, in the shell's words. */
export const FIX_REPORTED = "Fix the problem with this page that the editor reported (the page-report in the editor block).";

/** The report, as a block the agent reads as data: nothing in it can close the block. */
export const pageReport = (report: string) =>
  `<page-report>\n${report.slice(0, 2000).replace(/[<>]/g, (c) => (c == "<" ? "‹" : "›"))}\n</page-report>`;
