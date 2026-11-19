-- The instance's own record of its deploys (deploy/deployer/instance.ts). A machine (`bun erga deploy`) and the
-- deployer in the cloud read and write both tables through the platform's database API, with the platform's own login:
-- never through the server.

-- The instance's spec (deploy/deployer/spec.ts), as JSON: one row. It holds no secret's value.
CREATE TABLE deploy_spec (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spec TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- One row for each deploy or rollback: the job log. The job that runs is the instance's lock: a row whose `state` is
-- 'running' and whose `alive` (its last write, in ms) is not too old. `state`: 'running', 'done' or 'failed: <why>'.
-- `source`: where its command came from. `sha`: the commit, once the job knows it. `log`: its output.
CREATE TABLE deploy_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  source TEXT NOT NULL,
  sha TEXT,
  started INTEGER NOT NULL,
  alive INTEGER NOT NULL,
  state TEXT NOT NULL,
  log TEXT NOT NULL DEFAULT ''
);
