-- A request for access to a document (the "no access" page's button, the operation request_access): one row for each
-- person and document. The owner sees it on their documents list, and shares the document (the row goes) or declines
-- (`declined` is set: the row stays, so the same person can't ask again).

CREATE TABLE access_requests (
  doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  asked INTEGER NOT NULL,
  declined INTEGER,
  PRIMARY KEY (doc_id, login)
);
