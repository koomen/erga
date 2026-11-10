// Clipboard payloads from the apps people paste from, as each writes text/html and text/plain.
//
// "web" is a real capture: a styled page copied with Cmd+C in headless Chrome, read back with
// navigator.clipboard.read(). The others are written to match each app's clipboard markup as it
// is documented and seen in the wild: Google Docs (the <b style="font-weight:normal"> wrapper,
// bold and italic as inline styles, lists nested by aria-level), Word (mso-list paragraphs with
// a marker to drop, <o:p>, conditional comments), Pages (Cocoa HTML Writer: formatting by class
// rules in <style>), Notion, and Slack (lists nested by data-indent).

export interface Payload {
  html?: string;
  text: string;
}

export const web: Payload = {
  html: '<h2 style="font-family: Helvetica; color: rgb(170, 0, 0); font-size: 28px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Release notes</h2><p class="note" style="background: rgb(255, 255, 221); padding: 4px; color: rgb(51, 51, 51); font-family: Georgia, serif; font-size: 19px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Version 2 is <strong>much</strong> faster and <em>quieter</em>. Read <a href="https://example.com/blog?a=1&amp;b=2" style="color: green;">the blog</a>.</p><ul style="color: rgb(51, 51, 51); font-family: Georgia, serif; font-size: 19px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li>Builds in <b>half</b> the time</li><li>Nested:<ul><li>one</li><li>two</li></ul></li></ul><ol style="color: rgb(51, 51, 51); font-family: Georgia, serif; font-size: 19px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li>First</li><li>Second</li></ol><p style="color: rgb(51, 51, 51); font-family: Georgia, serif; font-size: 19px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Line one<br>Line two</p>',
  text: "Release notes\nVersion 2 is much faster and quieter. Read the blog.\n\nBuilds in half the time\nNested:\none\ntwo\nFirst\nSecond\nLine one\nLine two",
};

const gs = (more: string) =>
  `font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;${more}`;
const gp = `dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"`;
export const googleDocs: Payload = {
  html:
    `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6c1a2f0e-7fff-3b5c-91d2-0a4e5f6b7c8d">` +
    `<h2 dir="ltr" style="line-height:1.38;margin-top:18pt;margin-bottom:6pt;"><span style="${gs("font-size:16pt;font-weight:400;font-style:normal;")}">Project plan</span></h2>` +
    `<p ${gp}><span style="${gs("font-weight:400;font-style:normal;")}">We ship </span><span style="${gs("font-weight:700;font-style:normal;")}">on Friday</span><span style="${gs("font-weight:400;font-style:italic;")}">, not before</span><span style="${gs("font-weight:400;font-style:normal;")}">. See </span><a href="https://docs.example.com/spec?id=7&amp;v=2" style="text-decoration:none;"><span style="${gs("color:#1155cc;font-weight:400;font-style:normal;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;")}">the spec</span></a><span style="${gs("font-weight:400;")}">.</span></p>` +
    `<br>` +
    `<p ${gp}><span style="${gs("font-weight:400;")}">First line</span><span style="${gs("font-weight:400;")}"><br></span><span style="${gs("font-weight:400;")}">second line</span></p>` +
    `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">` +
    `<li dir="ltr" style="list-style-type:disc;${gs("font-weight:400;font-style:normal;")}" aria-level="1"><p ${gp} role="presentation"><span style="${gs("font-weight:400;")}">Milk</span></p></li>` +
    `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:circle;${gs("font-weight:400;")}" aria-level="2"><p ${gp} role="presentation"><span style="${gs("font-weight:700;")}">Oat</span><span style="${gs("font-weight:400;")}"> milk</span></p></li></ul>` +
    `<li dir="ltr" style="list-style-type:disc;${gs("font-weight:400;")}" aria-level="1"><p ${gp} role="presentation"><span style="${gs("font-weight:400;")}">Eggs</span></p></li></ul>` +
    `<br>` +
    `<ol style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:decimal;${gs("font-weight:400;")}" aria-level="1"><p ${gp} role="presentation"><span style="${gs("font-weight:400;")}">Wake up</span></p></li>` +
    `<li dir="ltr" style="list-style-type:decimal;${gs("font-weight:400;")}" aria-level="1"><p ${gp} role="presentation"><span style="${gs("font-weight:400;")}">Code</span></p></li></ol></b>`,
  text: "Project plan\nWe ship on Friday, not before. See the spec.\n\nFirst line\nsecond line\nMilk\nOat milk\nEggs\n\nWake up\nCode",
};

const wordMarker = (m: string, font = "Symbol") =>
  `<![if !supportLists]><span style='font-family:${font};mso-fareast-font-family:${font};mso-bidi-font-family:${font}'><span style='mso-list:Ignore'>${m}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>`;
export const word: Payload = {
  html:
    `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=ProgId content=Word.Document><meta name=Generator content="Microsoft Word 15">` +
    `<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><style><!-- p.MsoNormal, li.MsoNormal {margin:0cm; font-size:12.0pt; font-family:"Calibri",sans-serif;} p.MsoListParagraph {margin-left:36.0pt; font-family:"Calibri",sans-serif;} --></style></head>` +
    `<body lang=EN-US style='tab-interval:36.0pt;word-wrap:break-word'><!--StartFragment-->` +
    `<h1><span lang=EN-US>Quarterly review<o:p></o:p></span></h1>` +
    `<p class=MsoNormal><span lang=EN-US style='font-family:"Times New Roman",serif;color:#C00000'>Revenue grew <b>12%</b> and churn fell <i>slightly</i>. Details in <a href="https://example.com/q3">the report</a>.<o:p></o:p></span></p>` +
    `<p class=MsoNormal><span lang=EN-US><o:p>&nbsp;</o:p></span></p>` +
    `<p class=MsoListParagraphCxSpFirst style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'>${wordMarker("·")}<span lang=EN-US>Hire two engineers<o:p></o:p></span></p>` +
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:72.0pt;mso-add-space:auto;text-indent:-18.0pt;mso-list:l0 level2 lfo1'>${wordMarker("o", '"Courier New"')}<span lang=EN-US>Backend<o:p></o:p></span></p>` +
    `<p class=MsoListParagraphCxSpLast style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'>${wordMarker("·")}<span lang=EN-US>Open the <b>Berlin</b> office<o:p></o:p></span></p>` +
    `<p class=MsoListParagraphCxSpFirst style='text-indent:-18.0pt;mso-list:l1 level1 lfo2'>${wordMarker("1.", "Calibri")}<span lang=EN-US>Plan<o:p></o:p></span></p>` +
    `<p class=MsoListParagraphCxSpLast style='text-indent:-18.0pt;mso-list:l1 level1 lfo2'>${wordMarker("2.", "Calibri")}<span lang=EN-US>Build<o:p></o:p></span></p>` +
    `<p class=MsoNormal><span lang=EN-US>Kind regards,<br>Ann<o:p></o:p></span></p>` +
    `<!--EndFragment--></body></html>`,
  text: "Quarterly review\r\nRevenue grew 12% and churn fell slightly. Details in the report.\r\n \r\n·        Hire two engineers\r\no        Backend\r\n·        Open the Berlin office\r\n1.       Plan\r\n2.       Build\r\nKind regards,\r\nAnn\r\n",
};

export const pages: Payload = {
  html: `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n<html>\n<head>\n<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">\n<meta http-equiv="Content-Style-Type" content="text/css">\n<title></title>\n<meta name="Generator" content="Cocoa HTML Writer">\n<meta name="CocoaVersion" content="2487.5">\n<style type="text/css">\np.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 13.0px 'Helvetica Neue'}\np.p2 {margin: 0.0px 0.0px 0.0px 0.0px; font: 13.0px 'Helvetica Neue'; min-height: 15.0px}\nli.li1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 13.0px 'Helvetica Neue'}\nspan.s1 {font: 13.0px 'Helvetica Neue'; font-weight: bold}\nspan.s2 {font-family: 'Helvetica Neue'; font-weight: normal; font-style: italic; font-size: 13.00px}\nspan.s3 {font: 18.0px 'Avenir Next'; color: #ff2600}\nul.ul1 {list-style-type: disc}\n</style>\n</head>\n<body>\n<p class="p1">Notes from <span class="s1">Monday</span>, with <span class="s2">care</span> and <span class="s3">colour</span>.</p>\n<p class="p2"><br></p>\n<p class="p1">Second paragraph<br>\nwith a break</p>\n<ul class="ul1">\n<li class="li1">Apples</li>\n<li class="li1">Pears</li>\n</ul>\n</body>\n</html>\n`,
  text: "Notes from Monday, with care and colour.\n\nSecond paragraph with a break\n\t•\tApples\n\t•\tPears\n",
};

export const notion: Payload = {
  html: `<meta charset='utf-8'><h2>Meeting notes</h2><p>We agreed on <strong>three</strong> things and one <em>maybe</em>. <a href="https://www.notion.so/team/abc123">Link</a> and <code>npm test</code>.</p><ul><li>Ship it<ul><li>tonight</li></ul></li><li>Tell people</li></ul><ol><li>One</li><li>Two</li></ol><blockquote>Keep it simple.</blockquote>`,
  text: "## Meeting notes\n\nWe agreed on **three** things and one *maybe*. [Link](https://www.notion.so/team/abc123) and `npm test`.\n\n- Ship it\n    - tonight\n- Tell people\n1. One\n2. Two\n\n> Keep it simple.",
};

const slackList = (tag: string, indent: number, text: string) =>
  `<${tag} data-stringify-type="${tag == "ul" ? "unordered" : "ordered"}-list" data-list-tree="true" class="p-rich_text_list p-rich_text_list__${tag == "ul" ? "bullet" : "ordered"} p-rich_text_list--nested" data-indent="${indent}" data-border="0"><li data-stringify-indent="${indent}" data-stringify-border="0">${text}</li></${tag}>`;
export const slack: Payload = {
  html:
    `<meta charset='utf-8'><div class="p-rich_text_section">Hey <b data-stringify-type="bold">team</b>, the deploy is <i data-stringify-type="italic">done</i>. Logs: <a target="_blank" class="c-link" data-stringify-link="https://logs.example.com/x" delay="150" data-sk="tooltip_parent" href="https://logs.example.com/x" rel="noopener noreferrer">https://logs.example.com/x</a><br aria-hidden="true">Second line</div>` +
    slackList("ul", 0, "step one") +
    slackList("ul", 1, "sub step") +
    slackList("ul", 0, "step two") +
    slackList("ol", 0, "first") +
    `<pre class="c-mrkdwn__pre" data-stringify-type="pre"><div class="p-rich_text_block--no-overflow">npm run build\nnpm test</div></pre><blockquote type="cite" class="c-mrkdwn__quote" data-stringify-type="quote">quoted text</blockquote>`,
  text: "Hey team, the deploy is done. Logs: https://logs.example.com/x\nSecond line\n• step one\n    ◦ sub step\n• step two\n1. first\n```npm run build\nnpm test```\n> quoted text",
};

export const plain: Payload = {
  text: "Dear team,\nthe launch moved to May.\n\nWhat to do:\n- tell sales\n  - today\n- update the page\n\n1. one\n2. two\n\nThanks,\nAnn",
};
