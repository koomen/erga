-- Each document's kind (document/pages.ts, DocKind): "document" (one page,
-- index.html, and any other files beside it) or "project" (a folder of
-- pages, each with its own address). The documents list shows it. The
-- document's own object keeps it too, and checks it on every new file.
-- NULL: a document from before this, whose object decides its kind (a
-- project if it has more than one page) the next time it opens, and writes
-- it here. A Worker from before this never reads the column.
ALTER TABLE documents ADD COLUMN kind TEXT;
