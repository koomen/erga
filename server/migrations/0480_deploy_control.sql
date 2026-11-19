-- What the app and the deployer in the cloud say to each other (deploy/deployer/control.ts): one row. The deployer has
-- no address, so the instance's database carries both ways. An instance that deploys from a machine has no deployer:
-- its row has no look.

-- The app writes `auto` (1: the deployer deploys each new head of the spec's branch by itself) and an admin's ask:
-- `ask` ('deploy <the commit, 40 hex>' or 'rollback'), who asked (`ask_by`) and when (`ask_at`, in ms). A new ask
-- takes the place of one that waits. The deployer clears the ask when it starts its job.
-- The deployer writes its last look at GitHub: when (`looked`, in ms), the head of the spec's branch (`head`), why
-- the look failed (`error`, else NULL), and the branch's last commits with each one's release (`commits`, JSON).
CREATE TABLE deploy_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto INTEGER NOT NULL DEFAULT 0,
  ask TEXT,
  ask_by TEXT,
  ask_at INTEGER,
  looked INTEGER,
  head TEXT,
  error TEXT,
  commits TEXT NOT NULL DEFAULT '[]'
);
