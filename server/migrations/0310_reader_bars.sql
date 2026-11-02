-- Whether the people who view a document, and can't edit it, see Erga's bars over it (server/documents/view.ts): the
-- breadcrumbs and the buttons. Its owner sets it in Document settings (set_reader_bars). Editors always see them.
-- 1: on, as every document was before.
ALTER TABLE documents ADD COLUMN reader_bars INTEGER NOT NULL DEFAULT 1;
