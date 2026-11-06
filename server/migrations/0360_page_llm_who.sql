-- Who may call a document's page model (window.ergaLLM: agents/page-llm.ts): 0, its signed-in viewers; 1, all its
-- viewers, someone signed out too (with the guest limit, by IP address), where they may open it. Its owner chooses in
-- Document settings (share_document page_llm_who). Every document keeps what it had: signed-in viewers, but the
-- homepage (the homepage project, owner -home, or the document the landing_document setting names), whose model took
-- guests already. A new document starts with signed-in viewers.
ALTER TABLE documents ADD COLUMN page_llm_guests INTEGER NOT NULL DEFAULT 0;
UPDATE documents SET page_llm_guests = 1
  WHERE owner = '-home' OR id = (SELECT json_extract(value, '$') FROM server_config WHERE key = 'landing_document' AND json_valid(value));
