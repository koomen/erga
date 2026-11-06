-- Each call of a page's model (page_llm_use) has a state (server/directory/page-llm-call.ts): started, with the tokens
-- it reserved; finished, with the tokens it used; failed, with its reservation. The rows from before ended.
ALTER TABLE page_llm_use ADD COLUMN state TEXT NOT NULL DEFAULT 'finished';
