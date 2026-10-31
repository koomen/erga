// Where a link on a document's page goes (client/common/link-target.ts): each link form, from the page about.html of
// /ada/site, framed on its pages origin under its token.
import { expect, test } from "bun:test";
import { linkTarget, type Place } from "../client/common/link-target";

const FRAME = "https://abcd1234-ada.erga-pages.dev",
  PREFIX = "/t/tok.mac/",
  SHELL = "https://erga.dev";
const place = (address: string | null = `${SHELL}/ada/site`): Place => ({
  origin: FRAME,
  prefix: PREFIX,
  page: "about.html",
  shell: SHELL,
  address,
});
const kind = (href: string, p = place()) => {
  const t = linkTarget(new URL(href, `${FRAME}${PREFIX}about.html`), p);
  return t.kind == "page" ? `page ${t.path} ${t.frame} ${t.public}` : t.kind == "erga" || t.kind == "out" ? `${t.kind} ${t.url}` : t.kind;
};

test("each link form gives its kind, and where it goes", () => {
  expect([
    kind("blog/post.html"),
    kind("./"),
    kind("#end"),
    kind("about"),
    kind("/ada/site/about"),
    kind("/ada/site/blog/?x=1#top"),
    kind("/ada/site"),
    kind(`${SHELL}/ada/site/about`),
    kind(`${SHELL}/ada/site/style.css`),
    kind("style.css"),
    kind("/ada/notes"),
    kind("/docs"),
    kind(`${SHELL}/docs`),
    kind("/ada/sitex"),
    kind("/d/abcd1234/about"),
    kind("https://example.com/a?b#c"),
    kind("mailto:ada@example.com"),
  ]).toEqual([
    `page blog/post.html ${FRAME}${PREFIX}blog/post.html ${SHELL}/ada/site/blog/post`,
    `page  ${FRAME}${PREFIX} ${SHELL}/ada/site`,
    `page about.html ${FRAME}${PREFIX}about.html#end ${SHELL}/ada/site/about#end`,
    `page about ${FRAME}${PREFIX}about ${SHELL}/ada/site/about`,
    `page about ${FRAME}${PREFIX}about ${SHELL}/ada/site/about`,
    `page blog/ ${FRAME}${PREFIX}blog/?x=1#top ${SHELL}/ada/site/blog?x=1#top`,
    `page  ${FRAME}${PREFIX} ${SHELL}/ada/site`,
    `page about ${FRAME}${PREFIX}about ${SHELL}/ada/site/about`,
    `erga ${SHELL}/ada/site/style.css`,
    "file",
    `erga ${SHELL}/ada/notes`,
    `erga ${SHELL}/docs`,
    `erga ${SHELL}/docs`,
    `erga ${SHELL}/ada/sitex`,
    `erga ${SHELL}/d/abcd1234/about`,
    "out https://example.com/a?b#c",
    "none",
  ]);
});

test("before the viewer says the document's address, its Erga address is an Erga link, and a page has no public address", () => {
  const p = place(null);
  expect([kind("/ada/site/about", p), kind("blog/", p)]).toEqual([
    `erga ${SHELL}/ada/site/about`,
    `page blog/ ${FRAME}${PREFIX}blog/ null`,
  ]);
});

test("a page's public address leaves out the frame's own parameters (?erga-edit, ?erga-y=)", () => {
  const t = linkTarget(new URL("#rich", `${FRAME}${PREFIX}about.html?erga-edit&erga-y=40&x=1`), place());
  expect(t.kind == "page" && t.public).toBe(`${SHELL}/ada/site/about?x=1#rich`);
});
