// A problem the page editor reported about a page (a file that didn't load, a
// script error), for an alert's "Fix with agent" (client/shell/alerts.ts). The page
// editor runs on the page's origin, so the page's own script can write the
// report: the agent gets it as data in a block of its own, never as what the
// person asked (the agent's system prompt says so).

/** What the person asks, in the shell's words. */
export const FIX_REPORTED = "Fix the problem with this page that the editor reported (the page-report in the editor block).";

/** The same for several problems at once ("Fix all with agent"): a report for each. */
export const FIX_ALL_REPORTED = "Fix the problems with this page that the editor reported (the page-reports in the editor block).";

/** Text from a page, with no character that can open or close a block the agent reads (‹ › for < >). */
export const noMarks = (text: string) => text.replace(/[<>]/g, (c) => (c == "<" ? "‹" : "›"));

/** The report, as a block the agent reads as data: nothing in it can close the block. */
export const pageReport = (report: string) => `<page-report>\n${noMarks(report.slice(0, 2000))}\n</page-report>`;
