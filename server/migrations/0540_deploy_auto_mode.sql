-- Auto-deploy mode (releases vs commits) and the latest numbered release tag on the tracked branch.
-- Existing rows keep auto_mode = 'commits' so running instances do not change behavior on upgrade;
-- new setups explicitly write auto = 1, auto_mode = 'releases'.
ALTER TABLE deploy_control ADD COLUMN auto_mode TEXT NOT NULL DEFAULT 'commits';
ALTER TABLE deploy_control ADD COLUMN latest_release TEXT;
