-- The API keys nothing reads any more: OpenAI's (Erga never called OpenAI),
-- the Cloudflare deploy token (deploys run on the control Worker's OAuth
-- grant) and the GitHub mirror's token (gone with the mirror). Their stored
-- rows hold secrets that nobody uses, so they go. Only the Anthropic key stays
-- (server/directory/api-keys.ts). It deletes rows; the table stays as it is.
DELETE FROM credentials WHERE name <> 'anthropic';
