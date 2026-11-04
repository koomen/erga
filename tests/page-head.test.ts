// A page's head (shared/page-head.ts): its title, description, icon and link picture, read from its <head> and written
// back into it, the rest of the page as it was.

import { expect, test } from "bun:test";
import { headOf, headUrl, tabTitle, withHead } from "../shared/page-head";

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Old &amp; tired</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<h1>Hi</h1>
<svg><title>Not the page's</title></svg>
</body>
</html>
`;

test("reads only the head's tags, decoded, and leaves out what it hasn't", () => {
  expect(headOf(PAGE)).toEqual({ title: "Old & tired" });
  const full = `<head><meta content='A "fine" page' NAME=description><link href="i.png" rel="shortcut icon"><meta property="og:image" content="card.png"></head>`;
  expect(headOf(full)).toEqual({ description: 'A "fine" page', icon: "i.png", image: "card.png" });
  expect(headOf("<body><title>x</title></body>")).toEqual({});
});

test("sets, replaces and removes each tag, with the head's indent, and changes nothing else", () => {
  const set = withHead(PAGE, { title: "New <one>", description: "About it", icon: "favicon.png", image: "card.png" });
  expect(headOf(set)).toEqual({ title: "New <one>", description: "About it", icon: "favicon.png", image: "card.png" });
  expect(set).toContain(
    `  <title>New &lt;one&gt;</title>\n  <meta name="description" content="About it">\n  <link rel="icon" href="favicon.png">\n  <meta property="og:image" content="card.png">\n  <link rel="stylesheet"`
  );
  expect(set.slice(set.indexOf("<body>"))).toBe(PAGE.slice(PAGE.indexOf("<body>")));
  // "" removes a tag, with its line; what isn't given stays.
  const back = withHead(set, { description: "", icon: "", image: "" });
  expect(headOf(back)).toEqual({ title: "New <one>" });
  expect(back).toBe(PAGE.replace("Old &amp; tired", "New &lt;one&gt;"));
  // The same value changes nothing.
  expect(withHead(PAGE, { title: "Old & tired" })).toBe(PAGE);
});

test("a page with no head, or no title, gets one", () => {
  const bare = "<!doctype html>\n<html>\n<body><p>x</p></body>\n</html>";
  const out = withHead(bare, { title: "T" });
  expect(out).toBe("<!doctype html>\n<html>\n<head>\n<title>T</title>\n</head>\n<body><p>x</p></body>\n</html>");
  expect(headOf(withHead("<p>x</p>", { description: "D" }))).toEqual({ description: "D" });
  expect(withHead("<head><meta charset=utf-8></head>", { title: "T" })).toBe("<head><meta charset=utf-8>\n<title>T</title></head>");
});

test("the tab's title, and the head's addresses as the viewer loads them", () => {
  expect(tabTitle({ title: "Mine" }, "Doc")).toBe("Mine");
  expect(tabTitle({ title: "Untitled" }, "Doc")).toBe("Doc");
  expect(tabTitle({}, "Doc")).toBe("Doc");
  const files = "https://p.example/t/tok/";
  expect(headUrl("favicon.png", "index.html", files)).toBe(files + "favicon.png");
  expect(headUrl("../img/a.png", "blog/post.html", files)).toBe(files + "img/a.png");
  expect(headUrl("/img/a.png", "blog/post.html", files)).toBe(files + "img/a.png");
  expect(headUrl("https://cdn.example/a.png", "index.html", files)).toBe("https://cdn.example/a.png");
  expect(headUrl("data:image/png;base64,AAAA", "index.html", files)).toBe("data:image/png;base64,AAAA");
  expect(headUrl("javascript:alert(1)", "index.html", files)).toBeNull();
});
