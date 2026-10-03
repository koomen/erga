# To do

- **Switch between editing and viewing easily.** One obvious control (and a
  shortcut) that turns the editor off, so you see the page as a reader would,
  and back on.

- **Who you are shouldn't come from the address.** Opening `/koomen/<id>`
  locally seemed to make me Koomen. The host doesn't read the owner from the
  path: it takes `?user=`, then the sign-in cookie (`/auth/github?as=...`),
  then the first name in git config (`open.ts`, `nameOf`), and the page
  prefers a name saved in browser storage when not signed in
  (`src/page/main.ts`, `myName`). Find out which one did it, check it doesn't
  happen on erga.dev, and make the local identity clear and hard to get
  wrong (show it, and say where it came from).

- **Name documents and open them by slug.** `/<owner>/<slug>` as well as
  `/<owner>/<id>`, e.g. `/koomen/launch-plan`. A slug is unique among one
  owner's documents; the id address keeps working.
