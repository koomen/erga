-- The custom domains that a deploy took from the server (`bun erga deploy <host> --remove-domain <domain>` writes each
-- row, through the platform's database API). The server's scheduled run unpublishes the document that was published
-- to each, and deletes its row (server/sites/domains.ts, unpublishRemoved).
CREATE TABLE removed_domains (
  domain TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
