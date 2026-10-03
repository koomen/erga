# To do

- **Switch between editing and viewing easily.** One obvious control (and a
  shortcut) that turns the editor off, so you see the page as a reader would,
  and back on.

- **Who you are shouldn't come from the address.** Opening `/koomen/<id>`
  locally seemed to make me Koomen. It wasn't the address: the local Worker
  signs everyone in as `DEV_LOGIN` from `.dev.vars` (koomen), whoever owns
  the document. There's now one local server and one rule (`worker/auth.ts`,
  `sessionOf`: `?user=`, else the sign-in cookie, else `DEV_LOGIN`), and the
  tab-chosen name stored in the browser is gone. Still to do: show in the
  editor who you are and where that came from.

- **Name documents and open them by slug.** `/<owner>/<slug>` as well as
  `/<owner>/<id>`, e.g. `/koomen/launch-plan`. A slug is unique among one
  owner's documents; the id address keeps working.

- **Let a document extend the editor.** Widen the contract between a document
  and the editor (today mostly `data-erga-noedit` and the rules in
  `DOCUMENT_PROMPT.md`) so a document can add to the editor itself, not just
  mark what it can't touch.
