-- Whether the people who may read a document, signed in with their own role on it, may use their own agent there
-- (server/documents/view.ts: the agent's circle in the viewer). Its owner sets it in Document settings
-- (set_reader_agent). Never for a document anyone with the link may open: the operation refuses it then, and the
-- viewer reads it as off while a "*" permission is there. 0: off, as every document was before.
ALTER TABLE documents ADD COLUMN reader_agent INTEGER NOT NULL DEFAULT 0;
