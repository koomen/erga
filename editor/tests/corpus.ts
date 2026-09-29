// Markdown samples shared by the parser, highlighting and command tests.

import { readFileSync } from "fs";

const editorJs = readFileSync(new URL("../../editor-cm/editor.js", import.meta.url), "utf8");
const welcome = /const WELCOME = `([^`]*(?:\\`[^`]*)*)`;/.exec(editorJs)![1].replace(/\\`/g, "`");

export const WELCOME = welcome;

export const corpus: string[] = [
  "",
  "\n",
  "hello",
  welcome,
  "# Heading\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven",
  "#not heading\n# closed #\n# closed ###   \n#\n# \n#  x  ##x",
  "Setext\n===\n\nTwo\n---\n\nnot\n- setext",
  "*em* **strong** ***both*** _u_ __uu__ ___uuu___ **a *b* c** *a **b** c*",
  "foo*bar* foo_bar_ *foo*bar **foo**bar __foo__bar",
  "***x** y* *x **y***",
  "~~strike~~ ~sub~ ^sup^ ~~~no~~~ a~~b~~c",
  "`code` ``co`de`` ` a ` ```x``` `unclosed",
  "[link](http://x.com) [ref][id] [short] [](empty) ![img](i.png) [a [b](c) d](e)",
  "[link](<http://x y> \"title\") [t](u 'single') [t](u (paren)) [bad](u\nnext)",
  "<http://auto.link> <me@x.com> <div class=\"x\"> </span> <!-- c --> <?pi?> <!DOCTYPE html>",
  "www.example.com https://x.com/path?q=1. mailto:a@b.co foo@bar.com xmpp:a@b.c/res (https://x.com)",
  "\\*escaped\\* \\\\ \\a &amp; &#123; &#x1F; &nope",
  "line with two spaces  \nnext\\\nthird",
  "- a\n- b\n  - c\n    - d\n- e",
  "1. one\n2. two\n10. ten\n3) paren",
  "* star\n+ plus\n- dash",
  "- [ ] task\n- [x] done\n- [X] Done\n- [ ]no",
  "> quote\n> more\nlazy\n\n> - list in quote\n> > nested",
  "```js\ncode\n```\n\n~~~\ntilde\n~~~\n\n```\nunclosed",
  "    indented\n    code\n\n\n    more",
  "- item\n\n      code in item\n- next",
  "***\n---\n___\n* * *\n- - -",
  "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |",
  "a | b\n-|-\nc | d",
  "[id]: http://x.com \"Title\"\n[id2]: <u>\n  't'\n\n[bad]: \n",
  "<div>\nhtml block\n</div>\n\npara",
  "<!--\ncomment\n-->\n<?php\n?>",
  "para\n# heading interrupts\n> quote\n- list\n1. ordered\n2. more",
  "para\n2. not list\n\n2. list\n- \n-",
  "  - indented bullet\n   1. three spaces\n    - four spaces",
  "- a\n\n  para in item\n\n- b\n\n\n- c",
  "> ```\n> code in quote\n> ```\n> after",
  "- > quote in list\n  > more\n- ```\n  code\n  ```",
  ":emoji: :not emoji: :a_b1:",
  "**[bold link](u)** [**bold** label](u) *[em](u)*",
  "[x](u)[y](v) [a](b)c",
  "\t- tab list\n\t\tcode?",
  "a\n\nb\n\n\nc",
  "Heading\n=\n\n- \n  a",
  "1. a\n\n   b\n2. c",
  "> a\n>\n> b",
  "* a\n*\n* b",
  "text <span>*in html*</span> more",
  "- a\n  - b\n\n  c",
];

// Random documents built from Markdown-ish fragments, to shake out edge cases.
const fragments = [
  "#", "##", "###", " ", "  ", "    ", "\t", "\n", "\n\n", "-", "- ", "* ", "+ ", "1. ", "2) ", ">", "> ", "*", "**",
  "_", "__", "~", "~~", "^", "`", "```", "~~~", "[", "]", "(", ")", "![", "<", ">", "http://a.b", "www.x.y",
  "a@b.cd", "\\", "&amp;", "|", "---", "===", "***", "[ ] ", "[x] ", ":", "word", "two words", "x", "y", "é",
  "<div>", "</div>", "<!--", "-->", "\"", "'", "[id]: ", "u", ":e:", "  \n", "\\\n",
];

export function randomDoc(rand: () => number): string {
  let s = "";
  const n = 1 + Math.floor(rand() * 30);
  for (let i = 0; i < n; i++) s += fragments[Math.floor(rand() * fragments.length)];
  return s;
}
