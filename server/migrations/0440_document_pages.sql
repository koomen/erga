-- Each document's number of pages (document/pages.ts, pageCount): the
-- documents list shows its chevron, and the viewer its title's page tree,
-- only when it has more than one. The document's object writes it as it
-- opens and at each change. NULL: not counted yet; it shows as more than
-- one until the object opens. The kind column (0200) stays, and nothing
-- reads it.
ALTER TABLE documents ADD COLUMN pages INTEGER;
UPDATE documents SET pages = 1 WHERE kind = 'document';
