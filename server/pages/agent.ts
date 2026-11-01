// Each person's agent, on every page for someone signed in (agents/person/): the round "e" in the lower left, which
// grows into the panel and shrinks back into it (client/style.css, .agent). The same element on every page, the
// editor's too; client/inline/agent-toggle.ts opens and closes it, and client/agent/person-agent.ts runs it.

import type { Session } from "../platform.ts";
import { inlineScript } from "./inline.ts";
import { scriptTag } from "./assets.ts";

const MARK = `<svg class="erga-mark" viewBox="-66 -1107 1240 1240" aria-hidden="true"><path fill="currentColor" d="M1026 -209Q1026 -182 1018 -163Q1009 -144 996 -129Q982 -114 965 -101Q947 -88 929 -73Q915 -61 904 -55Q893 -49 883 -45Q872 -41 861 -37Q849 -33 834 -26Q814 -16 801 -7Q787 1 774 8Q760 15 744 20Q728 24 704 27Q664 32 624 39Q583 46 543 46Q535 46 527 43Q518 39 507 36Q496 32 483 29Q469 25 450 25Q430 25 418 19Q406 13 397 5Q387 -3 377 -12Q367 -22 351 -29Q291 -56 249 -94Q207 -132 177 -179Q147 -226 127 -281Q107 -336 93 -396Q82 -438 82 -480Q82 -535 108 -582Q98 -610 98 -636Q98 -655 109 -692Q120 -730 138 -768Q155 -806 176 -836Q196 -867 214 -874Q228 -879 234 -882Q239 -886 239 -902Q239 -914 249 -922Q258 -930 272 -935Q285 -940 299 -944Q312 -948 321 -952Q358 -970 392 -982Q425 -995 459 -1003Q492 -1012 528 -1016Q564 -1020 605 -1020Q627 -1020 648 -1014Q669 -1008 689 -998Q708 -989 727 -977Q746 -966 764 -955L763 -955Q778 -953 792 -946Q805 -940 820 -938Q834 -921 857 -905Q879 -890 901 -873Q922 -856 938 -836Q953 -817 953 -792Q953 -788 953 -784Q952 -780 951 -775L955 -780Q959 -777 963 -770Q966 -763 969 -754Q972 -746 974 -737Q976 -729 977 -724Q985 -711 999 -703Q1012 -695 1020 -681Q1010 -671 1010 -655Q1010 -638 1017 -621Q1024 -605 1024 -588Q1024 -568 1022 -549Q1020 -531 1020 -511Q1020 -496 1009 -488Q997 -480 984 -474Q970 -468 959 -462Q948 -456 948 -445Q948 -437 939 -437Q929 -438 923 -438Q879 -438 836 -449Q792 -460 749 -460Q702 -460 656 -453Q610 -447 563 -447Q528 -447 494 -449Q459 -451 424 -451Q415 -451 390 -447Q365 -444 338 -438Q310 -433 285 -425Q260 -418 250 -411Q249 -406 249 -397Q249 -350 277 -300Q304 -250 349 -209Q394 -168 450 -141Q506 -114 563 -114Q596 -114 629 -111Q661 -109 692 -97Q719 -110 742 -127Q764 -144 785 -163Q806 -182 826 -202Q846 -222 867 -242Q871 -246 887 -249Q902 -253 920 -255Q938 -258 955 -259Q971 -261 977 -261Q1000 -261 1020 -254Q1026 -231 1026 -209ZM876 -615Q876 -630 871 -644Q866 -658 863 -673Q858 -701 858 -727Q858 -754 850 -781L849 -781Q849 -775 845 -769Q841 -764 834 -764Q822 -764 811 -770Q800 -776 792 -785Q754 -802 724 -817Q693 -832 663 -843Q632 -855 598 -861Q563 -868 518 -868Q514 -868 511 -867Q507 -867 504 -864L509 -853L501 -851Q474 -846 457 -841Q439 -837 425 -829Q411 -821 398 -809Q384 -798 363 -780Q353 -771 342 -766Q330 -762 319 -758Q307 -755 297 -751Q286 -747 279 -738Q272 -713 259 -689Q245 -666 245 -640Q245 -625 258 -613Q270 -602 290 -594Q309 -586 333 -580Q356 -574 379 -571Q402 -568 422 -566Q441 -565 452 -565Q490 -565 527 -572Q564 -580 602 -580Q641 -580 680 -576Q719 -573 758 -573Q768 -573 788 -574Q808 -575 828 -579Q847 -584 862 -592Q876 -601 876 -615Z"/></svg>`;

/** The panel's markup: the circle, and the panel inside its glass. */
const PANEL = `<aside id="agent" class="agent" aria-label="Agent"><div class="agent-glass">
<button type="button" class="agent-fab" id="agent-fab" aria-label="Open the agent (⌘J)" title="Agent  ⌘J" aria-expanded="false" aria-controls="agent">${MARK}</button>
<div class="agent-card" inert>
<div class="agent-head">
<span class="title">Agent</span><span class="model" id="agent-model"></span>
<button type="button" class="icon-btn" id="agent-reset" aria-label="New conversation" data-tip="New conversation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
<button type="button" class="icon-btn" id="agent-close" aria-label="Collapse (Esc)" data-tip="Collapse  Esc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5 10 14M10 14H5.5M10 14v4.5M19.5 4.5 14 10M14 10h4.5M14 10V5.5"/></svg></button>
</div>
<div class="agent-log" id="agent-log" data-empty="Ask for anything you can do in Erga: make or change a document, share it, find one. It sees the page you have open." aria-live="polite" tabindex="-1"></div>
<button type="button" class="agent-jump" id="agent-jump" hidden>↓ Jump to latest</button>
<p class="agent-hint" id="agent-hint" role="status" hidden></p>
<form class="agent-compose" id="agent-form">
<div class="agent-field" id="agent-field"><textarea id="agent-input" rows="1" placeholder="Ask the agent…" aria-label="Message the agent"></textarea></div>
<button type="submit" class="agent-send" id="agent-send">Send</button>
</form>
</div></div></aside>`;

/** Who has an agent: someone signed in, in person (not a test person, nor an agent's token). */
export const hasAgent = (session: Session | null) => !!session && !session.agent && !session.test;

/** The agent for `session`'s person, or nothing: its markup, opened or closed as they left it before it paints, and its script. */
export const agentPanel = (session: Session | null) =>
  hasAgent(session) ? `${PANEL}${inlineScript("agent-toggle")}${scriptTag("agent.js")}` : "";
