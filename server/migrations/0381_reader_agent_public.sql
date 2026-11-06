-- A document shared with anyone with the link ("*") never gives readers their agent, and keeps it off: stopping "*"
-- doesn't turn it on again (server/operations/readers.ts). The documents shared so keep it off from now on.
UPDATE documents SET reader_agent = 0 WHERE EXISTS (SELECT 1 FROM permissions p WHERE p.doc_id = documents.id AND p.login = '*');
