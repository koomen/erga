-- What a new server's setup page (/setup, server/identity/setup.ts) and the setup command (bun erga setup,
-- deploy/own/) say to each other, while the server has no admin: one row. The command can't call the page, and the
-- page can't install a Worker, so the instance's database carries both ways.

-- `deployer`: the deployer's step, as JSON (server/identity/setup-link.ts, DeployerStep). While it waits, it holds
-- the token that the person pasted on the page, sealed with the server's SESSION_SECRET: the command opens it,
-- installs the deployer with it, and writes how that ended. No other state holds the token.
CREATE TABLE setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  deployer TEXT NOT NULL
);
