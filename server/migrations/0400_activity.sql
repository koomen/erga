-- What people did each day, for the admins' Analytics page (/admin; server/directory/activity.ts): one row for each
-- day, person and kind of thing, with how many. Never a row for each event: a count that grows (an upsert).
--
-- `day`: days since 1970-01-01, UTC. `login`: lowercase; '' for nobody's (a reader who isn't signed in, a model call
-- the server makes by itself). `metric`: view (a document's page opened in the viewer), edit (a version of a document:
-- a burst of edits), and the models' tokens: in:server, out:server (by the server's API keys), in:own, out:own (by the
-- person's own key).
CREATE TABLE IF NOT EXISTS activity_days (
  day INTEGER NOT NULL,
  login TEXT NOT NULL,
  metric TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, login, metric)
);

-- The pages' model calls the log still has (its last 30 days), so their tokens don't start at zero: the server's keys
-- run them. A visitor who isn't a user (signed out) is nobody's.
INSERT OR IGNORE INTO activity_days (day, login, metric, n)
  SELECT at / 86400000, CASE WHEN login IN (SELECT login FROM users) THEN login ELSE '' END, 'in:server', SUM(input_tokens)
  FROM page_llm_use WHERE state != 'started' GROUP BY 1, 2;
INSERT OR IGNORE INTO activity_days (day, login, metric, n)
  SELECT at / 86400000, CASE WHEN login IN (SELECT login FROM users) THEN login ELSE '' END, 'out:server', SUM(output_tokens)
  FROM page_llm_use WHERE state != 'started' GROUP BY 1, 2;
