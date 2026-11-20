-- A feedback message's status (server/directory/feedback.ts): 'unresolved' as it comes, and for each message kept
-- before; 'resolved' when an admin says so (/admin/feedback, or set_feedback). Feedback opens no issue on GitHub any
-- more: the columns `target`, `issue` and `tried` and the index feedback_open are from before, and nothing uses them.
ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved';
