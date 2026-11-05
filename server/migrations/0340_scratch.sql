-- A scratch document (/scratch, create_document's scratch): not on its owner's list, and deleted delete_docs_after_hours
-- after it is made, edited or not (document/document.ts, wake). save_document makes it a saved one: 0, and no expiry.
ALTER TABLE documents ADD COLUMN scratch INTEGER NOT NULL DEFAULT 0;
