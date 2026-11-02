-- A document's page may call a model as its signed-in visitor (window.ergaLLM: agents/page-llm.ts). Its owner turns it
-- on in Document settings (set_page_llm) and chooses the model (page_llm_model: a key of shared/models.ts's MODELS,
-- an Anthropic one). 0: off, as every document was before.
ALTER TABLE documents ADD COLUMN page_llm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN page_llm_model TEXT;

-- Each call a page made (server/directory/page-llm.ts): who, for which document, when, with which model, and the tokens
-- it used. The log of the use, and what the limits per visitor and for the whole server count over the last hour.
-- `at`: milliseconds since the epoch. `login`: lowercase. A row is written as the call starts, with no tokens, and gets
-- them when it ends. Rows older than 30 days go (PageLlm.start).
CREATE TABLE IF NOT EXISTS page_llm_use (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_llm_use_at ON page_llm_use (at);
CREATE INDEX IF NOT EXISTS page_llm_use_login_at ON page_llm_use (login, at);
