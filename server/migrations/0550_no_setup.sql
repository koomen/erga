-- erga: destructive
-- The setup page keeps no token: the server hands a pasted token to its deployer at once, and the deployer keeps it
-- (deploy/deployer/token.ts). The table held only that token, sealed, and how its install ended. A release from
-- before this one read it only on /setup, on a server with no admin.
DROP TABLE IF EXISTS setup;
