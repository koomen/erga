-- A person's archive: a document they archived is off their list (/docs) and on /docs/archived (the operations
-- archive_document, unarchive_document). Each person's own: the time they archived it, on their permission; NULL: not.
ALTER TABLE permissions ADD COLUMN archived INTEGER;
