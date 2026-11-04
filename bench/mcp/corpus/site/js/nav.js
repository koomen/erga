// The site's header: marks the link to the page that shows, and opens the nav on small screens.
const page = (path) => path.replace(/\.html$/, "").replace(/\/index$/, "/");
const here = page(location.pathname);
for (const a of document.querySelectorAll(".site-nav a:not(.btn)")) {
  if (page(a.pathname) == here) a.setAttribute("aria-current", "page");
}
const toggle = document.querySelector(".menu-toggle");
toggle?.addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  toggle.setAttribute("aria-expanded", String(open));
});
